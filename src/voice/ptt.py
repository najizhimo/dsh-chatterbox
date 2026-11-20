# -*- coding: utf-8 -*-
"""dsh-chatterbox 的语音客户端。

两种输入：
  · 按住热键（默认 PrintScreen）说话，松手识别投递；
  · 自由麦克风：宿主插件把开关状态放 /voice/state，本进程持续收音，静默超过
    vadSilence 秒切出一句，识别后 POST /submit。

  python ptt.py                       # 常驻（由插件托管时用 --parent-pid）
  python ptt.py --hotkey f9           # 换热键
  python ptt.py --preview             # 只识别不投递
  python ptt.py --test-asr x.wav      # 只验证识别链路
  python ptt.py --list-devices        # 列输入设备
  python ptt.py --no-free-mic         # 只保留按键说话（排障）
"""
import argparse
import collections
import traceback
import json
import os
import pathlib
import queue
import sys
import threading
import time
import urllib.request
import wave

import numpy as np

from glossary import Glossary

SAMPLE_RATE = 16000
MAX_SECONDS = 60.0
MIN_SECONDS = 0.25
INGEST = os.environ.get("PTT_INGEST_BASE", "http://127.0.0.1:18801")
# Loopback must never go through HTTP_PROXY/Clash: an empty ProxyHandler keeps
# these calls direct even when the environment carries proxy settings.
LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
BASE = pathlib.Path(os.environ["LOCALAPPDATA"]) / "dsh" / "dsh-chatterbox"
LOG = BASE / "logs" / "ptt.log"
TMP = pathlib.Path(os.environ["TEMP"]) / "dsh-chatterbox"
MODEL_DIR = (pathlib.Path(os.environ["USERPROFILE"]) / ".dsh" / "speech-to-text"
             / "sensevoice" / "models" / "sensevoice-onnx")
VAD_MODEL = MODEL_DIR.parent / "silero" / "silero_vad.onnx"


# ---------------------------------------------------------------- 日志与登记

def log(msg):
    line = f'{time.strftime("%Y-%m-%d %H:%M:%S")} {msg}'
    print(line, flush=True)
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        if LOG.exists() and LOG.stat().st_size > 5 * 1024 * 1024:
            LOG.replace(LOG.with_suffix(".1.log"))
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def register_artifact(path, kind, expiry, delete, self_cleaning):
    """按 skill-authoring/artifacts.md 的格式登记产物；失败不阻断主流程。"""
    try:
        reg = pathlib.Path(os.environ["LOCALAPPDATA"]) / "dsh" / "artifacts" / "dsh-chatterbox.jsonl"
        reg.parent.mkdir(parents=True, exist_ok=True)
        rec = {
            "path": str(path), "kind": kind, "skill": "dsh-chatterbox",
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "expiry": expiry,
            "delete": delete, "selfCleaning": self_cleaning,
        }
        with open(reg, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass


# ---------------------------------------------------------------- 识别

def load_recognizer(model, tokens, language, threads):
    import sherpa_onnx
    return sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=model, tokens=tokens, language=language, use_itn=True, num_threads=threads,
    )


def recognize(rec, samples):
    stream = rec.create_stream()
    stream.accept_waveform(SAMPLE_RATE, samples)
    rec.decode_stream(stream)
    text = stream.result.text.strip()
    return text


def read_wav_mono(path):
    with wave.open(str(path), "rb") as w:
        sr, ch, width, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = w.readframes(n)
    if width != 2:
        raise SystemExit(f"only 16-bit PCM supported, got {width*8}-bit")
    data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    if sr != SAMPLE_RATE:                       # 线性重采样，够验证用
        idx = np.linspace(0, len(data) - 1, int(len(data) * SAMPLE_RATE / sr))
        data = np.interp(idx, np.arange(len(data)), data).astype(np.float32)
    return data


# ---------------------------------------------------------------- 录音

def meaningful(text):
    """只剩标点/空白的识别结果算空——纯噪声时 SenseVoice 会吐一个「。」。"""
    import re
    return bool(re.search(r"[0-9A-Za-z\u3040-\u30ff\u4e00-\u9fff]", text or ""))


def trim_silence(samples, ratio_tail=0.06, ratio_head=0.02, frame=320,
                 pad_head=0.20, pad_tail=0.12):
    """掐掉首尾静音。

    首端单独放宽：`ratio_head` 比尾端低、保留量 `pad_head` 更长，
    否则「看」这种清音/短促起音会被当成静音切掉——实测曾把「看一下」切成「一下」。
    """
    if len(samples) < frame * 2:
        return samples
    n = len(samples) // frame
    rms = np.array([np.sqrt(np.mean(samples[i * frame:(i + 1) * frame] ** 2)) for i in range(n)])
    peak = rms.max()
    if peak <= 1e-5:
        return np.zeros(0, dtype=np.float32)
    head = np.where(rms > peak * ratio_head)[0]
    tail = np.where(rms > peak * ratio_tail)[0]
    if not len(head) or not len(tail):
        return np.zeros(0, dtype=np.float32)
    a = max(0, head[0] * frame - int(pad_head * SAMPLE_RATE))
    b = min(len(samples), (tail[-1] + 1) * frame + int(pad_tail * SAMPLE_RATE))
    return samples[a:b]


class MicStream(threading.Thread):
    """常开麦克风。

    启动即打开设备并持续读，空闲时只保留最近 PRE_ROLL 秒；按下时把这些预录一并接上。
    目的是消灭「打开设备」那 50–150 ms 的延迟——之前它会把第一个音节吃掉
    （实测「看一下」被识别成「一下」）。
    """

    def __init__(self, device=None, preroll_s=0.40, block=1024):
        super().__init__(daemon=True)
        self.device = device
        self.block = block
        self.max_ring = max(1, int(preroll_s * SAMPLE_RATE / block))
        self.ring = collections.deque(maxlen=self.max_ring)
        self.capture = []
        self.active = False
        self.stop_flag = threading.Event()
        self.error = None
        self.ready = threading.Event()
        # 自由麦克风模式：设成 queue.Queue 时，每一块原始音频都复制一份进去；
        # None 表示不采集（暂停/关闭时音频直接丢掉，不排队、不留存）。
        self.listen_queue = None

    def run(self):
        import sounddevice as sd
        try:
            with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16",
                                blocksize=self.block, device=self.device) as stream:
                self.ready.set()
                while not self.stop_flag.is_set():
                    block, _overflow = stream.read(self.block)
                    if self.active:
                        self.capture.append(block.copy())
                    else:
                        self.ring.append(block.copy())
                    sink = self.listen_queue
                    if sink is not None:
                        try:
                            sink.put_nowait(block.copy())
                        except queue.Full:
                            pass
        except Exception as exc:                       # noqa: BLE001
            self.error = exc
            self.ready.set()
            log(f"mic error: {exc}")

    def begin(self):
        """开始一次录音：把预录的尾巴一起带上。"""
        self.capture = [b.copy() for b in self.ring]
        self.active = True

    def end(self):
        """结束并返回整段（float32，-1..1）。"""
        self.active = False
        chunks, self.capture = self.capture, []
        self.ring.clear()
        if not chunks:
            return np.zeros(0, dtype=np.float32)
        data = np.concatenate(chunks).reshape(-1).astype(np.float32) / 32768.0
        return data

    def close(self):
        self.stop_flag.set()
        self.join(timeout=2)


# ---------------------------------------------------------------- Windows 窗口与键盘

def find_window(title_keyword):
    """按标题关键字找可见窗口，返回 hwnd 或 None。"""
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.windll.user32
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        if title_keyword.lower() in buf.value.lower():
            found.append(hwnd)
            return False
        return True

    user32.EnumWindows(cb, 0)
    return found[0] if found else None


def activate(hwnd):
    """把窗口提到前台，同时**不改变窗口大小**（最大化就保持最大化）。

    Windows 有前台锁：后台进程调 SetForegroundWindow 常常只换来任务栏闪烁。
    这里按三级递进：① 直接调；② AttachThreadInput 接到当前前台线程后再调；
    ③ 兜底 SwitchToThisWindow。日志会写明走了哪一级。
    """
    import ctypes
    user32 = ctypes.windll.user32
    k32 = ctypes.windll.kernel32
    SW_RESTORE, SW_SHOW, SW_SHOWMAXIMIZED = 9, 5, 3
    SWP_NOSIZE, SWP_NOMOVE, SWP_SHOWWINDOW = 0x0001, 0x0002, 0x0040

    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
    elif user32.IsZoomed(hwnd):
        user32.ShowWindow(hwnd, SW_SHOWMAXIMIZED)     # 保持最大化，不缩回
    else:
        user32.ShowWindow(hwnd, SW_SHOW)

    if user32.GetForegroundWindow() == hwnd:
        return "already"

    # ① 直接抢
    user32.SetForegroundWindow(hwnd)
    if user32.GetForegroundWindow() == hwnd:
        return "direct"

    # ② AttachThreadInput：借前台线程的输入状态
    fg = user32.GetForegroundWindow()
    tid_fg = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    tid_me = k32.GetCurrentThreadId()
    attached = False
    if tid_fg and tid_fg != tid_me:
        attached = bool(user32.AttachThreadInput(tid_me, tid_fg, True))
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
        user32.SetFocus(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(tid_me, tid_fg, False)
    if user32.GetForegroundWindow() == hwnd:
        return "attach"

    # ③ 兜底
    user32.SwitchToThisWindow(hwnd, True)
    if user32.GetForegroundWindow() == hwnd:
        return "switch"
    user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW)
    user32.SetWindowPos(hwnd, -2, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW)
    return "topmost" if user32.GetForegroundWindow() == hwnd else "failed"


def wait_foreground(hwnd, timeout=1.6):
    """等窗口真的成为前台（有动画与激活延迟），返回是否等到。"""
    import ctypes
    user32 = ctypes.windll.user32
    t0 = time.time()
    while time.time() - t0 < timeout:
        if user32.GetForegroundWindow() == hwnd:
            return True
        time.sleep(0.05)
    return False


def send_text(text, title_keyword=None, strip_keystroke=False, preview=False):
    """把一行文本投进当前 DSH 会话（经 dsh-chatterbox 插件，127.0.0.1:18801）。

    不抢焦点、不进剪贴板、不模拟按键——旧的那套（find_window/activate/Ctrl+V）已废弃，
    只在插件不可用时作为排障参考留在文件里。
    返回 True/False；失败原因写进日志。
    """
    if preview:
        log(f"preview: {text}")
        return True
    body = json.dumps({"text": text}, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    token = os.environ.get("PTT_INGEST_TOKEN")
    if token:
        headers["x-ptt-token"] = token
    req = urllib.request.Request(f"{INGEST}/submit", data=body, method="POST", headers=headers)
    try:
        with LOCAL_OPENER.open(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:                       # noqa: BLE001  连接失败 / 超时 / 非 2xx
        log(f"ingest failed: {exc}")
        return False
    if data.get("ok"):
        log(f"delivered session={data.get('sessionId')} source={data.get('targetSource')} "
            f"{data.get('elapsedMs')}ms")
        return True
    err = data.get("error") or {}
    log(f"ingest rejected: {err.get('code')}: {err.get('message')}")
    return False


# 自由麦克风模式下的语音命令：说这些就把功能自己关掉（不再投给会话）。
# 判定要同时出现「自由麦克风」这 5 个字和一个关闭词；设备名不做同义扩展，
# 带疑问/否定语气的句子一律放过，避免把闲聊误判成命令。
# 只认这 5 个字，别的念法一律不匹配（防呆：闲聊里说「麦克风」不会被当成命令）。
MIC_WORDS = ("自由麦克风",)
OFF_WORDS = ("关闭", "关掉", "关了", "关上", "停用", "停止", "退出", "收起", "别听", "不用听", "别录")
QUESTION_WORDS = ("吗", "么", "是不是", "有没有", "没有", "没", "怎么", "为什么", "要不要", "能不能", "会不会")
FILLERS = ("请", "帮我", "麻烦", "一下", "好吗", "谢谢", "吧", "啊", "呀", "了", "呢")


def normalize_command(text):
    """只留 CJK/字母数字，去掉标点、空白与常见语气词。"""
    kept = []
    for ch in text or "":
        if ch.isalnum() or ("\u4e00" <= ch <= "\u9fff"):
            kept.append(ch)
    raw = "".join(kept).lower()
    for filler in FILLERS:
        if len(raw) > len(filler) + 1:
            raw = raw.replace(filler, "")
    return raw


def is_off_command(text):
    """True when the utterance is a "turn the free microphone off" command."""
    raw = (text or "").strip()
    normalized = normalize_command(raw)
    if not normalized or len(normalized) > 24:
        return False
    for word in QUESTION_WORDS:
        if word in raw:
            return False
    # 必须同时出现完整的「自由麦克风」与一个关闭词：
    # 「自由麦」「麦克风」「别听了」都不算——那些要么是同义扩展，要么是日常用语。
    has_mic = any(word in raw for word in MIC_WORDS)
    has_off = any(word in raw for word in OFF_WORDS)
    return has_mic and has_off


def disable_free_mic(tag):
    """POST /voice/free-mic {"enabled": false}; the Host owns the actual state."""
    try:
        body = json.dumps({"enabled": False}).encode("utf-8")
        req = urllib.request.Request(f"{INGEST}/voice/free-mic", data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
        with LOCAL_OPENER.open(req, timeout=2) as resp:
            resp.read()
        log(f"{tag}: voice command matched — free microphone turned OFF by the plugin")
        return True
    except Exception as exc:                   # noqa: BLE001
        log(f"{tag}: voice command matched but the Host refused the switch-off: {exc}")
        return False


_GLOSSARY = None


def glossary_for(args):
    """One Glossary instance per configured path (reloaded on mtime change)."""
    global _GLOSSARY
    path = pathlib.Path(args.glossary)
    if _GLOSSARY is None or _GLOSSARY.path != path:
        _GLOSSARY = Glossary(path, log)
    return _GLOSSARY


def deliver(audio, tag, args, rec_engine):
    """把一段音频投出去：门限 → 识别 → 投递。两个入口共用。"""
    dur = len(audio) / SAMPLE_RATE
    peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
    if dur < MIN_SECONDS or peak < 0.02:
        log(f"{tag} discard: {dur:.2f}s peak={peak:.3f} (too short / too quiet)")
        return False
    t1 = time.time()
    text = recognize(rec_engine, audio)
    asr_s = time.time() - t1
    log(f"{tag} {dur:.2f}s → asr {asr_s:.2f}s → {text!r}")
    text = glossary_for(args).apply(text)
    if not meaningful(text):
        log(f"{tag} empty transcript (no letters), not sending")
        return False
    if tag == "free-mic" and is_off_command(text):
        disable_free_mic(tag)
        return False
    okay = send_text(text, preview=args.preview)
    log(f"{tag} sent={okay} preview={args.preview} chars={len(text)}")
    return okay


# ---------------------------------------------------------------- 自由麦克风

def build_vad(silence_s=2.0, threshold=0.5):
    """silero VAD：连续人声，静默超过 silence_s 才判定一句话说完。"""
    import sherpa_onnx
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = str(VAD_MODEL)
    config.silero_vad.threshold = float(threshold)
    config.silero_vad.min_silence_duration = float(silence_s)
    config.silero_vad.min_speech_duration = 0.25
    config.sample_rate = SAMPLE_RATE
    return sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=60)


def report_listening(listening):
    """Best-effort: tell the host whether we are actually capturing."""
    try:
        body = json.dumps({"listening": bool(listening)}).encode("utf-8")
        req = urllib.request.Request(f"{INGEST}/voice/listening", data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
        LOCAL_OPENER.open(req, timeout=2).read()
    except Exception:                       # noqa: BLE001
        pass


def drain(q):
    while True:
        try:
            q.get_nowait()
        except queue.Empty:
            return


class FreeMicController(threading.Thread):
    """按宿主插件的「自由麦克风」总控开关驱动持续收音。

    freeMic=off          → 什么都不做，热键流程照旧
    freeMic=on, 不再暂停  → 持续收音；VAD 等到超过 2 秒静默才切出一句话
    freeMic=on, paused    → 受理的一轮还在思考/回复/出声：不收音（音频直接丢弃）

    一句话送回宿主后先等它把 paused 置位，再等它恢复，才重新收音；
    所以本机自己的朗读声永远不会被录进来。
    """

    POLL_SECONDS = 0.25

    def __init__(self, mic, rec_engine, args, state):
        super().__init__(daemon=True)
        self.mic = mic
        self.rec_engine = rec_engine
        self.args = args
        self.state = state
        self.stop_flag = threading.Event()
        self.vad = None
        self.queue = queue.Queue(maxsize=512)
        self.listening = False
        self.sending = False
        self.busy_seen = False
        self.sent_at = 0.0
        self.host_down_logged = False
        self.last_enabled = None
        self.last_paused = None
        self.silence = float(args.vad_silence)
        self.last_tick = time.time()
        self.last_heartbeat = time.time()
        self.last_report = time.time()
        self.stalled_logged = False
        self.host_down_since = 0.0
        self.host_down_logged_at = 0.0

    @staticmethod
    def _stacks():
        """Every thread's stack, so a stalled loop names its own blocking frame."""
        frames = sys._current_frames()
        chunks = []
        for thread_id, frame in frames.items():
            chunks.append(f"--- thread {thread_id} ---\n")
            chunks.extend(traceback.format_stack(frame))
        return "".join(chunks)

    def _watchdog(self):
        """Say something when the loop stops looping, and prove it every minute."""
        while not self.stop_flag.is_set():
            time.sleep(2.0)
            if self.stop_flag.is_set():
                return
            gap = time.time() - self.last_tick
            if gap > 5.0 and not self.stalled_logged:
                self.stalled_logged = True
                log(f"free-mic: control loop stalled for {gap:.0f}s; stacks:\n{self._stacks()}")
            elif gap < 1.0:
                self.stalled_logged = False
            # Proof of life for the Host: a stale report is how it notices a
            # stuck loop even though this process still exists.
            if self.listening and time.time() - self.last_report > 20.0:
                self.last_report = time.time()
                report_listening(True)
            if self.listening and time.time() - self.last_heartbeat > 60.0:
                self.last_heartbeat = time.time()
                log(
                    f"free-mic: alive (listening, silence>{self.silence:g}s, "
                    f"enabled={self.state.get('free_mode')})"
                )

    def _host_state(self):
        try:
            with LOCAL_OPENER.open(f"{INGEST}/voice/state", timeout=2) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            self.host_down_since = 0.0
            return body
        except Exception as exc:                # noqa: BLE001
            now = time.time()
            if self.host_down_since == 0.0:
                self.host_down_since = now
            # Keep saying it while it lasts: one silent line is easy to miss.
            if now - self.host_down_logged_at > 60.0:
                self.host_down_logged_at = now
                log(
                    f"free-mic: /voice/state unavailable for {now - self.host_down_since:.0f}s ({exc}); "
                    "waiting for the plugin"
                )
            return None

    def _stop(self):
        self.mic.listen_queue = None
        drain(self.queue)
        if self.listening:
            self.listening = False
            log("free-mic: listening stopped")
            report_listening(False)

    def _ensure_vad(self):
        if self.vad is not None:
            return
        t0 = time.time()
        self.vad = build_vad(self.silence, self.args.vad_threshold)
        log(f"free-mic: VAD ready in {time.time() - t0:.2f}s (silence>{self.silence:g}s)")

    def _start(self):
        self._ensure_vad()
        self.vad.reset()
        drain(self.queue)
        self.mic.listen_queue = self.queue
        self.listening = True
        log(f"free-mic: listening (silence>{self.silence:g}s)")
        report_listening(True)

    def _log_transition(self, enabled, paused):
        if enabled == self.last_enabled and (not enabled or paused == self.last_paused):
            return
        if not enabled:
            log("free-mic: host says off")
        elif paused:
            log("free-mic: host says on + paused")
        else:
            log("free-mic: host says on")
        self.last_enabled = enabled
        self.last_paused = paused

    def _step(self, current, last_poll):
        """One loop iteration. Returns the (state, last_poll) pair."""
        now = time.time()
        if now - last_poll >= self.POLL_SECONDS:
            fresh = self._host_state()
            if fresh is not None:
                current = fresh
            last_poll = now
        enabled = current.get("enabled") is True
        paused = current.get("paused") is True
        reported = current.get("vadSilence")
        if isinstance(reported, (int, float)) and abs(float(reported) - self.silence) > 0.01:
            self.silence = max(0.3, min(600.0, round(float(reported), 1)))
            self.vad = build_vad(self.silence, self.args.vad_threshold)
            if self.listening:
                self._stop()
            log(f"free-mic: silence threshold -> {self.silence:g}s")
        self.state["free_mode"] = enabled
        self._log_transition(enabled, paused)
        if not enabled:
            self._stop()
            self.sending = False
            self.busy_seen = False
            time.sleep(0.3)
            return current, last_poll
        if paused:
            self._stop()
            if self.sending:
                self.busy_seen = True
            time.sleep(0.3)
            return current, last_poll
        if self.sending:
            if self.busy_seen or (self.sent_at and time.time() - self.sent_at > 5.0):
                saw_pause = self.busy_seen
                self.sending = False
                self.busy_seen = False
                if not saw_pause:
                    log("free-mic: resuming after a delivery the Host never paused for")
            else:
                time.sleep(0.2)
                return current, last_poll
        if not self.listening:
            self._start()
        try:
            block = self.queue.get(timeout=0.2)
        except queue.Empty:
            return current, last_poll
        self.vad.accept_waveform(block.reshape(-1).astype(np.float32) / 32768.0)
        while not self.vad.empty():
            segment = self.vad.front
            audio = np.array(segment.samples, dtype=np.float32)
            self.vad.pop()
            if len(audio) / SAMPLE_RATE < 0.3:
                continue
            self._stop()
            self.sending = True
            self.sent_at = time.time()
            log(f"free-mic: utterance {len(audio) / SAMPLE_RATE:.2f}s -> transcribing")
            deliver(trim_silence(audio), "free-mic", self.args, self.rec_engine)
            break
        return current, last_poll

    def run(self):
        # Build the VAD before the first toggle so the first activation is never
        # delayed by model loading, and keep the loop alive through any error:
        # an unhandled traceback in pythonw is invisible, a logged one is not.
        try:
            self._ensure_vad()
        except Exception:                       # noqa: BLE001
            log("free-mic: VAD build failed:\n" + traceback.format_exc())
        threading.Thread(target=self._watchdog, daemon=True, name="free-mic-watchdog").start()
        current = {}
        last_poll = 0.0
        while not self.stop_flag.is_set():
            try:
                self.last_tick = time.time()
                current, last_poll = self._step(current, last_poll)
            except Exception:                   # noqa: BLE001
                log("free-mic: tick failed:\n" + traceback.format_exc())
                time.sleep(1.0)


# ---------------------------------------------------------------- 主循环

def parse_hotkey(spec):
    parts = [p.strip().lower() for p in spec.split("+") if p.strip()]
    return parts[-1], parts[:-1]


# ---------------------------------------------------------------- 鼠标侧键（Win32 低层钩子）

WM_XBUTTONDOWN = 0x020B
WM_XBUTTONUP = 0x020C
VK_SHIFT = 0x10
XBUTTON = {"mouse4": 1, "x1": 1, "side4": 1, "back": 1,
           "mouse5": 2, "x2": 2, "side5": 2, "forward": 2}
# 单独按的键：走 WH_KEYBOARD_LL 低层钩子并吞掉，避免触发系统动作
VKKEYS = {"printscreen": 0x2C, "print": 0x2C, "prtsc": 0x2C,
          "scrolllock": 0x91, "pause": 0x13, "f13": 0x7C}


def start_key_hook(vk, on_press, on_release):
    """WH_KEYBOARD_LL：只截指定虚拟键，按下/抬起各触发一次，并吞掉按键本身。

    用它可以处理 `keyboard` 库抓不稳的键（PrintScreen、Pause、ScrollLock…），
    同时也防止 PrintScreen 触发截图工具。
    """
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    user32.SetWindowsHookExW.restype = wintypes.HHOOK
    user32.CallNextHookEx.restype = ctypes.c_ssize_t
    user32.CallNextHookEx.argtypes = [wintypes.HHOOK, ctypes.c_int,
                                      wintypes.WPARAM, wintypes.LPARAM]

    class KBDLLHOOKSTRUCT(ctypes.Structure):
        _fields_ = [("vkCode", wintypes.DWORD), ("scanCode", wintypes.DWORD),
                    ("flags", wintypes.DWORD), ("time", wintypes.DWORD),
                    ("dwExtraInfo", ctypes.c_void_p)]

    HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int,
                                  wintypes.WPARAM, wintypes.LPARAM)
    WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP = 0x0100, 0x0101, 0x0104, 0x0105

    def handler(code, wparam, lparam):
        if code == 0:
            info = ctypes.cast(lparam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
            if info.vkCode == vk:
                if wparam in (WM_KEYDOWN, WM_SYSKEYDOWN):
                    on_press()
                elif wparam in (WM_KEYUP, WM_SYSKEYUP):
                    on_release()
                return 1                       # 吞掉：不让 PrintScreen 去截图
        return user32.CallNextHookEx(None, code, wparam, lparam)

    proc = HOOKPROC(handler)
    hook = user32.SetWindowsHookExW(13, proc, None, 0)      # 13 = WH_KEYBOARD_LL
    if not hook:
        log("keyboard hook install failed")
        return
    log(f"keyboard hook installed (vk=0x{vk:02X})")

    class MSG(ctypes.Structure):
        _fields_ = [("hwnd", wintypes.HWND), ("message", wintypes.UINT),
                    ("wParam", wintypes.WPARAM), ("lParam", wintypes.LPARAM),
                    ("time", wintypes.DWORD), ("pt", wintypes.POINT)]

    msg = MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))


def start_mouse_hook(button, need_shift, on_press, on_release):
    """在独立线程里装 WH_MOUSE_LL，只截指定侧键；返回 1 表示吞掉，不传给浏览器。"""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    user32.SetWindowsHookExW.restype = wintypes.HHOOK
    user32.CallNextHookEx.restype = ctypes.c_ssize_t
    user32.CallNextHookEx.argtypes = [wintypes.HHOOK, ctypes.c_int,
                                      wintypes.WPARAM, wintypes.LPARAM]

    class MSLLHOOKSTRUCT(ctypes.Structure):
        _fields_ = [("pt", wintypes.POINT), ("mouseData", wintypes.DWORD),
                    ("flags", wintypes.DWORD), ("time", wintypes.DWORD),
                    ("dwExtraInfo", ctypes.c_void_p)]

    HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int,
                                  wintypes.WPARAM, wintypes.LPARAM)
    want = XBUTTON.get(button, 2)

    def shift_down():
        return bool(user32.GetAsyncKeyState(VK_SHIFT) & 0x8000)

    def handler(code, wparam, lparam):
        if code == 0:
            info = ctypes.cast(lparam, ctypes.POINTER(MSLLHOOKSTRUCT)).contents
            xbutton = (info.mouseData >> 16) & 0xFFFF
            if xbutton == want and (not need_shift or shift_down()):
                if wparam == WM_XBUTTONDOWN:
                    on_press()
                elif wparam == WM_XBUTTONUP:
                    on_release()
                return 1                      # 吞掉：不让它变成浏览器的「前进」
        return user32.CallNextHookEx(None, code, wparam, lparam)

    proc = HOOKPROC(handler)                   # 必须保引用，否则回调被回收
    hook = user32.SetWindowsHookExW(14, proc, None, 0)   # 14 = WH_MOUSE_LL
    if not hook:
        log("mouse hook install failed")
        return

    log(f"mouse hook installed (button={button}, shift={need_shift})")

    class MSG(ctypes.Structure):
        _fields_ = [("hwnd", wintypes.HWND), ("message", wintypes.UINT),
                    ("wParam", wintypes.WPARAM), ("lParam", wintypes.LPARAM),
                    ("time", wintypes.DWORD), ("pt", wintypes.POINT)]

    msg = MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))


def watch_parent(pid):
    """父进程（DSH）消失就自己退出：正常退出由插件的 dispose 处理，这里兜崩溃/强杀。"""
    import ctypes
    SYNCHRONIZE, WAIT_TIMEOUT = 0x00100000, 0x00000102
    k32 = ctypes.windll.kernel32
    handle = k32.OpenProcess(SYNCHRONIZE, False, pid)
    if not handle:
        log(f"parent {pid} already gone; exiting")
        os._exit(0)
    while True:
        time.sleep(3)
        if k32.WaitForSingleObject(handle, 0) != WAIT_TIMEOUT:
            log(f"parent {pid} gone; exiting")
            os._exit(0)


def run(args):
    import keyboard

    model = args.model
    tokens = args.tokens
    if not pathlib.Path(model).exists() or not pathlib.Path(tokens).exists():
        raise SystemExit(f"model/tokens 不存在：{model} / {tokens}")
    log(f"loading model ... ({pathlib.Path(model).name})")
    if args.parent_pid:
        threading.Thread(target=watch_parent, args=(args.parent_pid,), daemon=True).start()
        log(f"watching parent pid={args.parent_pid}")
    t0 = time.time()
    rec_engine = load_recognizer(model, tokens, args.language, args.threads)
    log(f"model ready in {time.time() - t0:.2f}s, host={os.environ.get('COMPUTERNAME')}, device={args.device}")

    TMP.mkdir(parents=True, exist_ok=True)
    register_artifact(TMP, "temp-dir", "run-end", "safe", True)

    state = {"active": False, "recorder": None, "n": 0}
    t_start = {"t": 0.0}

    mic = MicStream(device=args.device)
    mic.start()
    if not mic.ready.wait(timeout=5):
        log("mic open timeout")
    if mic.error:
        log(f"mic unavailable: {mic.error} — 录音会失败，先检查输入设备")

    state["free_mode"] = False
    if not args.no_free_mic:
        FreeMicController(mic, rec_engine, args, state).start()

    def start():
        if state["active"] or mic.error:
            return
        if state.get("free_mode"):
            log("hotkey ignored — 自由麦克风正接管（再点一次总控开关可回到按键说话）")
            return
        mic.begin()
        state["active"] = True
        t_start["t"] = time.time()
        log(f"hotkey press — recording ({args.hotkey})")

    def finish():
        # 低层钩子回调有 ~300 ms 超时（LowLevelHooksTimeout），回调里一阻塞，
        # 整个系统的键盘/鼠标都会跟着卡住。所以这里只起线程，立刻返回。
        if not state["active"]:
            return
        state["active"] = False
        threading.Thread(target=process, daemon=True).start()

    def process():
        state["n"] += 1
        raw = mic.end()                     # 含按下前 0.4 s 预录
        audio = trim_silence(raw)
        dur = len(audio) / SAMPLE_RATE
        peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
        # 幅度闸门：纯环境噪声会被 SenseVoice 脑补成 "Yeah." / "。"，这类一律不发
        if mic.error or dur < MIN_SECONDS or peak < 0.02:
            log(f"discard: {dur:.2f}s peak={peak:.3f} (too short / too quiet / mic error)")
            if args.once:
                os._exit(0)
            return
        path = None
        try:
            import soundfile
            path = TMP / f"utt-{state['n']:03d}-{int(time.time())}.wav"
            soundfile.write(str(path), audio, SAMPLE_RATE, subtype="PCM_16")
        except Exception:                                   # noqa: BLE001
            path = None
        deliver(audio, "record", args, rec_engine)
        if path is not None and not args.keep_audio:
            try:
                path.unlink()
            except OSError:
                pass
        if args.once:
            os._exit(0)

    key, mods = parse_hotkey(args.hotkey)

    if key in XBUTTON:
        threading.Thread(target=start_mouse_hook,
                         args=(key, "shift" in mods, start, finish),
                         daemon=True).start()
        log(f"ready — 按住 {args.hotkey} 说话（侧键事件已被吞掉，不会触发浏览器前进）。")
    elif key in VKKEYS and not mods:
        threading.Thread(target=start_key_hook,
                         args=(VKKEYS[key], start, finish), daemon=True).start()
        log(f"ready — 按住 {args.hotkey} 说话（该键已被吞掉，不会触发系统截图）。")
    else:
        def on_press(event):
            if state["active"] or event.name != key:
                return
            if any(not keyboard.is_pressed(m) for m in mods):
                return
            start()

        def on_release(event):
            if event.name == key and state["active"]:
                finish()

        keyboard.on_press(on_press, suppress=False)
        keyboard.on_release(on_release, suppress=False)
        log(f"ready — 按住 {args.hotkey} 说话。")

    try:
        while True:
            time.sleep(0.2)
    except KeyboardInterrupt:
        log("bye")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hotkey", default="printscreen",
                    help="printscreen（PrintScreen 单键，默认）/ mouse5（鼠标前进键）/ f9 / ctrl+alt+space")
    ap.add_argument("--model", default=str(MODEL_DIR / "model.int8.onnx"))
    ap.add_argument("--tokens", default=str(MODEL_DIR / "tokens.txt"))
    ap.add_argument("--language", default="auto", choices=["auto", "zh", "en", "ja", "ko", "yue"])
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--device", default=None)
    ap.add_argument("--window-title", default="DeepSeek Harness")
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--no-strip", action="store_true")
    ap.add_argument("--keep-audio", action="store_true")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--test-asr", default=None, metavar="WAV")
    ap.add_argument("--list-devices", action="store_true")
    ap.add_argument("--vad-silence", type=float, default=2.0,
                    help="自由麦克风：静默超过这么多秒就算一句话说完（0.3–600，1 位小数；运行中以插件配置为准）")
    ap.add_argument("--vad-threshold", type=float, default=0.5,
                    help="自由麦克风：silero VAD 的语音判定阈值（默认 0.5）")
    ap.add_argument("--glossary", default=str(BASE / "glossary.json"),
                    help="替换词表（JSON，Host 写入；改完下一句生效）")
    ap.add_argument("--test-glossary", default=None, metavar="TEXT",
                    help="只检查这句话经过词表之后会变成什么")
    ap.add_argument("--test-command", default=None, metavar="TEXT",
                    help="只检查这句话会不会被当成「关闭自由麦克风」命令")
    ap.add_argument("--no-free-mic", action="store_true",
                    help="不启动自由麦克风控制器（只保留按住说话，排障用）")
    ap.add_argument("--parent-pid", type=int, default=0,
                    help="父进程 pid：它消失时自己也退出（由 DSH 生命周期插件传入）")
    args = ap.parse_args()

    if args.test_glossary is not None:
        glossary = Glossary(pathlib.Path(args.glossary), log=None)
        print(glossary.apply(args.test_glossary), flush=True)
        return 0
    if args.test_command is not None:
        # 命令行自检：不碰麦克风，只看这句话会不会被当成关闭命令。
        matched = is_off_command(args.test_command)
        print(f"normalized={normalize_command(args.test_command)!r} match={matched}", flush=True)
        return 0


    if args.list_devices:
        import sounddevice as sd
        print(sd.query_devices())
        return
    if args.test_asr:
        audio = read_wav_mono(args.test_asr)
        engine = load_recognizer(args.model, args.tokens, args.language, args.threads)
        t0 = time.time()
        text = recognize(engine, audio)
        print(f"{len(audio)/SAMPLE_RATE:.2f}s → {time.time()-t0:.2f}s → {text!r}")
        return
    run(args)


if __name__ == "__main__":
    main()
