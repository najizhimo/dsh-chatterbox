# -*- coding: utf-8 -*-
"""Resident Irodori-TTS service, shipped inside dsh-chatterbox.

Loads the checkpoint once and answers synthesis requests over HTTP on
127.0.0.1, so a line costs ~4 s instead of ~16 s of model loading per call.

Voice profiles are **scanned from <voices>/cb_*/voice.json** — the folder is the
single source of truth (there is no registry.json). Each folder may carry a
`post` block (breath handling, lead-in/tail padding); missing keys fall back to
POST_DEFAULTS.

  GET  /health              -> {ok, ready, pid, voices, out, default_profile, profiles}
  POST /say   {text, name?, profile?}
                            -> {ok, wav, profile, duration, gen_s, rtf, total_s}
  POST /quit                -> shuts the service down

Spawned by dsh-chatterbox with --parent-pid <dsh pid>; when that process
disappears the service exits on its own, so it never outlives the app it
belongs to. `--voices/--out/--logs/--hf-home/--irodori` make every path an
argument instead of walking up from a workspace layout.
"""
import argparse
import ctypes
import json
import os
import pathlib
import subprocess
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent          # <plugin>/src/tts
PLUGIN = HERE.parent.parent                             # <plugin>


def _early_paths():
    """Pick up path flags before torch is imported (env must be set first)."""
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument('--voices', default=None)
    ap.add_argument('--out', default=None)
    ap.add_argument('--logs', default=None)
    ap.add_argument('--hf-home', default=None)
    ap.add_argument('--irodori', default=None)
    known, _ = ap.parse_known_args()
    return known


EARLY = _early_paths()
VOICE_DIRS = [pathlib.Path(part) for part in str(
    EARLY.voices or os.environ.get('CHATTERBOX_VOICES') or PLUGIN.parent / 'voices').split(';') if part]
VOICES = VOICE_DIRS[0]
OUT = pathlib.Path(EARLY.out or os.environ.get('CHATTERBOX_OUT') or PLUGIN / 'out')
LOGS = pathlib.Path(EARLY.logs or os.environ.get('CHATTERBOX_LOGS') or PLUGIN / 'logs')
HF_HOME_DIR = pathlib.Path(EARLY.hf_home or os.environ.get('CHATTERBOX_HF_HOME') or PLUGIN.parent / 'cache' / 'hf-cache')
IRODORI_DIR = pathlib.Path(EARLY.irodori or os.environ.get('CHATTERBOX_IRODORI') or PLUGIN.parent / 'irodori' / 'Irodori-TTS-main')

# 环境必须在导入 torch / huggingface_hub 之前定好
os.environ.setdefault('HF_HOME', str(HF_HOME_DIR))
os.environ.setdefault('CHATTERBOX_IRODORI', str(IRODORI_DIR))
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_SYMLINKS'] = '1'
os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'
os.environ['PYTHONIOENCODING'] = 'utf-8'
os.environ['NO_PROXY'] = 'localhost,127.0.0.1'

sys.path.insert(0, str(HERE))

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer   # noqa: E402

import synthesize_long as sl                                        # noqa: E402
import soften_breaths as sb                                        # noqa: E402

LOG_PATH = LOGS / 'tts_daemon.log'
_log_lock = threading.Lock()
_synth_lock = threading.Lock()


def log(msg):
    line = f'{time.strftime("%Y-%m-%d %H:%M:%S")} {msg}'
    with _log_lock:
        try:
            with open(LOG_PATH, 'a', encoding='utf-8') as f:
                f.write(line + '\n')
        except OSError:
            pass
        print(line, flush=True)


POST_DEFAULTS = {
    'breaths': 'long',
    'breath_min_pause': 0.60,
    'leading_breath': True,
    'keep_pause': 0.75,
    'keep_pause_short': 0.50,
    'short_line_s': 12.0,
    'mute_pause': 0.50,
    'topic_pause': 0.73,
    'mute_db': -18.0,
    'ramp_s': 0.06,
    'lead_in_s': 0.20,
    'tail_s': 0.12,
}


def scan_voices(voices_dirs):
    """One profile per <voices>/cb_*/voice.json, scanning every given dir.

    `--voices` may be ';'-separated so a bundled demo (deps/voices) and the
    user's own folders (workspace voices) can coexist; earlier dirs win.
    """
    if isinstance(voices_dirs, (str, pathlib.Path)):
        voices_dirs = [voices_dirs]
    profiles = {}
    folders_all = []
    for voices_dir in voices_dirs:
        voices_dir = pathlib.Path(voices_dir)
        if not voices_dir.is_dir():
            log(f'voices dir missing: {voices_dir}')
            continue
        folders_all.extend(sorted(voices_dir.glob('cb_*')))
    for folder in folders_all:
        manifest = folder / 'voice.json'
        if not manifest.is_file():
            continue
        try:
            data = json.loads(manifest.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as exc:
            log(f'skip {folder.name}: bad voice.json ({exc})')
            continue
        profile = data.get('profile') or folder.name
        if profile in profiles:
            continue
        ref = data.get('ref') or ''
        ref_path = pathlib.Path(ref)
        if not ref_path.is_absolute():
            ref_path = folder / ref
        if not ref_path.is_file():
            log(f'skip {folder.name}: ref missing ({ref_path})')
            continue
        post = dict(POST_DEFAULTS)
        if isinstance(data.get('post'), dict):
            post.update({k: v for k, v in data['post'].items() if not k.startswith('_')})
        profiles[profile] = {
            'display': data.get('display') or profile,
            'cv': data.get('cv'),
            'work': data.get('work'),
            'names': data.get('names'),
            'ref_path': str(ref_path),
            'ref_seconds': data.get('ref_seconds'),
            'version': data.get('version') or data.get('notes'),
            'folder': str(folder),
            'post': post,
        }
    if not profiles:
        log('no usable voice folders under ' + '; '.join(str(d) for d in voices_dirs))
    return profiles


def load_profiles(default_hint=None):
    profiles = scan_voices(VOICE_DIRS)
    recipe = {
        'cfg_scale_speaker': float(os.environ.get('CHATTERBOX_CFG_SPEAKER', '6.0')),
        'seed': int(os.environ.get('CHATTERBOX_SEED', '777')),
    }
    if default_hint in profiles:
        default = default_hint
    elif profiles:
        default = next(iter(profiles))
    else:
        default = None
    return {'profiles': profiles, 'default': default, 'recipe': recipe}


def parent_alive(pid):
    """True while the given process still exists."""
    if not pid:
        return True
    SYNCHRONIZE = 0x00100000
    WAIT_TIMEOUT = 0x00000102
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
    if not handle:
        return False
    try:
        return kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
    finally:
        kernel32.CloseHandle(handle)


def exe_running(image):
    """True while any process with this image name exists (tasklist, no psutil)."""
    try:
        out = subprocess.run(['tasklist', '/FI', f'IMAGENAME eq {image}', '/FO', 'CSV', '/NH'],
                             capture_output=True, text=True, timeout=10).stdout
        return image.lower() in out.lower()
    except Exception:
        return True        # 判定失败就别乱杀自己


class Worker:
    def __init__(self, registry, default_profile, spk_cfg, seed):
        self.registry = registry
        self.default_profile = default_profile
        self.spk_cfg = spk_cfg
        self.seed = seed
        self.ready = False
        self.load_s = None
        self.runtime = None
        self.cfg = None
        self.loaded_at = None

    def load(self):
        t0 = time.time()
        self.runtime, self.cfg = sl.build_runtime(self.spk_cfg, use_caption=True)
        self.load_s = time.time() - t0
        self.loaded_at = time.strftime('%Y-%m-%d %H:%M:%S')
        self.ready = True
        names = ', '.join(self.registry['profiles'])
        log(f'worker ready in {self.load_s:.1f}s  profiles=[{names}]  default={self.default_profile}  '
            f'spk_cfg={self.spk_cfg}  seed={self.seed}')

    def say(self, text, name=None, profile=None, caption=None, breaths=None, raw=False,
            topic_breaths=None):
        profile = profile or self.default_profile
        entry = self.registry['profiles'].get(profile)
        if entry is None:
            raise KeyError(f'unknown profile: {profile}')
        text, chunks = sl.plan_chunks(text)
        if not text:
            raise ValueError('empty text')
        # 没指定名字就按生成时间命名：月-日-时-分-秒
        name = name or time.strftime('%m-%d-%H-%M-%S')
        out_path = OUT / f'{name}.wav'
        t0 = time.time()
        with _synth_lock:
            sr, out, durations, gen_s = sl.synthesize(
                self.runtime, self.cfg, chunks, entry['ref_path'],
                seed0=self.seed, seed_mode='same',
                log=lambda m: log('  ' + m.strip()),
                caption=caption,
            )
        # 停顿里的换气：逐处决定保留或压掉（生成端改不动，只能在输出端做）
        post_info = None
        post = entry.get('post') if isinstance(entry.get('post'), dict) else {}
        if post and not raw:
            keep = post.get('breaths', 'long') if breaths in (None, '') else breaths
            if isinstance(keep, str) and keep not in ('all', 'none', 'long'):
                keep = {int(x) for x in keep.replace(',', ' ').split() if x.strip().isdigit()}
            out, post_info = sb.render(
                out, sr, text, keep=keep,
                leading=bool(post.get('leading_breath', True)),
                keep_pause=float(post.get('keep_pause', 0.75)),
                mute_pause=float(post.get('mute_pause', 0.50)),
                mute_db=float(post.get('mute_db', -18.0)),
                ramp_s=float(post.get('ramp_s', 0.06)),
                keep_pause_short=float(post.get('keep_pause_short', 0.50)),
                short_line_s=float(post.get('short_line_s', 12.0)),
                min_pause=float(post.get('breath_min_pause', 0.60)),
                topic_pause=float(post.get('topic_pause', 0.85)),
                topic_breaths=[int(x) for x in str(topic_breaths or '').replace(',', ' ').split()
                               if x.strip().isdigit()],
            )
            log(f'  breath plan: {post_info["plan"]}  kept={post_info["kept"]} '
                f'muted={post_info["muted"]} removed={post_info["removed_s"]}s')
        # 开头补一小段静音：蓝牙/声卡起播有几十到几百毫秒的启动延迟，
        # 直接从第一个音开始播会把起音吞掉（2026-11-19 主人实测「第一个音被吞半截」）。
        lead_in = float(post.get('lead_in_s', 0.20)) if (post and not raw) else 0.0
        tail = float(post.get('tail_s', 0.12)) if (post and not raw) else 0.0
        if post and not raw:
            override = read_pad_override()
            if override is not None:
                lead_in, tail = override
        if lead_in > 0 or tail > 0:
            import numpy as np
            head = np.zeros(int(sr * max(0.0, lead_in)), dtype=out.dtype)
            back = np.zeros(int(sr * max(0.0, tail)), dtype=out.dtype)
            out = np.concatenate([head, out, back])
            log(f'  pad: lead_in={lead_in:.2f}s tail={tail:.2f}s')

        with _synth_lock:
            sl.write_wav(str(out_path), sr, out, log=log)
        audio_s = len(out) / sr
        return {
            'ok': True,
            'wav': str(out_path),
            'caption': caption,
            'profile': profile,
            'ref': pathlib.Path(entry['ref_path']).name,
            'chunks': len(chunks),
            'chars': len(text),
            'duration': round(audio_s, 3),
            'gen_s': round(gen_s, 3),
            'rtf': round(gen_s / max(audio_s, 1e-6), 3),
            'post': post_info,
            'total_s': round(time.time() - t0, 3),
        }


PAD_OVERRIDE = pathlib.Path(os.environ.get('LOCALAPPDATA', '')) / 'dsh' / 'dsh-chatterbox' / 'audio-pad.json'


def read_pad_override():
    """开头/结尾补静音由 dsh-chatterbox 插件的配置页控制：读它写的小文件。

    返回 (lead_in_s, tail_s)，读不到就返回 None（回落到 registry 里的 post 值）。
    """
    try:
        with open(PAD_OVERRIDE, encoding='utf-8') as handle:
            data = json.load(handle)
        lead = float(data.get('lead_in_s'))
        tail = float(data.get('tail_s'))
        return (max(0.0, min(2.0, lead)), max(0.0, min(2.0, tail)))
    except Exception:                       # noqa: BLE001
        return None


def play_async(path):
    """在服务进程里异步播放：进程常驻，所以声音不会因为客户端退出而中断。"""
    try:
        import winsound
    except ImportError:
        log('play: winsound unavailable, skipping')
        return

    def _run():
        try:
            winsound.PlaySound(None, 0)                       # 先掐掉上一句
            winsound.PlaySound(str(path), winsound.SND_FILENAME | winsound.SND_ASYNC)
            log(f'playing {pathlib.Path(path).name}')
        except Exception as exc:                              # noqa: BLE001
            log(f'play failed: {exc}')
    threading.Thread(target=_run, daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    worker = None
    parent_pid = 0
    started = None

    def log_message(self, fmt, *args):      # keep the console quiet
        pass

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode('utf-8'))

    def do_GET(self):
        path = self.path.split('?')[0]
        if path in ('/health', '/'):
            w = self.worker
            self._json(200, {
                'ok': bool(w and w.ready),
                'pid': os.getpid(),
                'parent_pid': self.parent_pid,
                'ready': bool(w and w.ready),
                'load_s': round(w.load_s, 2) if w and w.load_s else None,
                'voices': str(VOICES),
                'out': str(OUT),
                'loaded_at': w.loaded_at if w else None,
                'default_profile': w.default_profile if w else None,
                'profiles': {
                    pid: {
                        'display': e.get('display'),
                        'cv': e.get('cv'),
                        'ref': pathlib.Path(e['ref_path']).name,
                        'version': e.get('version'),
                    }
                    for pid, e in (w.registry['profiles'].items() if w else [])
                },
                'uptime_s': round(time.time() - self.started, 1) if self.started else None,
            })
            return
        self._json(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        path = self.path.split('?')[0]
        try:
            if path == '/say':
                body = self._body()
                res = self.worker.say(body.get('text', ''), body.get('name') or None,
                                      body.get('profile'), body.get('caption') or None,
                                      body.get('breaths'), bool(body.get('raw')),
                                      body.get('topic_breaths'))
                if body.get('play'):
                    play_async(res['wav'])
                log(f'say [{res["profile"]}] {res["chars"]} chars -> {res["duration"]:.2f}s audio in '
                    f'{res["gen_s"]:.2f}s (RTF {res["rtf"]})'
                    f'{(" caption=" + res["caption"]) if res.get("caption") else ""}  '
                    f'{pathlib.Path(res["wav"]).name}')
                self._json(200, res)
                return
            if path == '/quit':
                self._json(200, {'ok': True, 'bye': True})
                log('quit requested over HTTP')
                threading.Thread(target=lambda: (time.sleep(0.2), os._exit(0)), daemon=True).start()
                return
            self._json(404, {'ok': False, 'error': 'not found'})
        except KeyError as exc:
            log(f'error: {exc}')
            self._json(400, {'ok': False, 'error': str(exc)})
        except Exception as exc:                                  # noqa: BLE001
            log(f'error: {type(exc).__name__}: {exc}')
            self._json(500, {'ok': False, 'error': f'{type(exc).__name__}: {exc}'})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8763)
    ap.add_argument('--parent-pid', type=int, default=0)
    ap.add_argument('--parent-exe', default='DeepSeek Harness.exe',
                    help='没有 --parent-pid 时，按镜像名看住 DSH 主进程')
    ap.add_argument('--voices', default=str(VOICES), help='音色档案根目录（扫描 cb_*/voice.json）')
    ap.add_argument('--out', default=str(OUT), help='wav 输出目录')
    ap.add_argument('--logs', default=str(LOGS), help='日志目录')
    ap.add_argument('--hf-home', default=str(HF_HOME_DIR))
    ap.add_argument('--irodori', default=str(IRODORI_DIR))
    ap.add_argument('--profile', default=None,
                    help='默认音色档案 id（默认取扫描到的第一个）')
    ap.add_argument('--spk-cfg', type=float, default=None)
    ap.add_argument('--seed', type=int, default=None)
    args = ap.parse_args()

    registry = load_profiles(args.profile)
    if not registry['profiles']:
        raise SystemExit(f'no voice folders found under {args.voices}')
    recipe = registry['recipe']
    args.profile = registry['default']
    if args.spk_cfg is None:
        args.spk_cfg = float(recipe['cfg_scale_speaker'])
    if args.seed is None:
        args.seed = int(recipe['seed'])
    OUT.mkdir(parents=True, exist_ok=True)
    LOGS.mkdir(parents=True, exist_ok=True)
    started = time.time()
    log(f'starting pid={os.getpid()} parent_pid={args.parent_pid or "-"} port={args.port} '
        f'profile={args.profile} voices={VOICES} out={OUT}')

    worker = Worker(registry, args.profile, args.spk_cfg, args.seed)
    Handler.worker = worker
    Handler.parent_pid = args.parent_pid
    Handler.started = started

    worker.load()

    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    except OSError as exc:
        log(f'cannot bind 127.0.0.1:{args.port} ({exc}); another instance is probably alive — exiting')
        return
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log(f'listening on http://127.0.0.1:{args.port}')

    if args.parent_pid:
        def watch():
            while True:
                time.sleep(3)
                if not parent_alive(args.parent_pid):
                    log(f'parent {args.parent_pid} gone; exiting')
                    os._exit(0)
        threading.Thread(target=watch, daemon=True).start()
    elif args.parent_exe:
        present = exe_running(args.parent_exe)
        log(f'watching image {args.parent_exe!r} (present={present})')
        if present:
            def watch_exe():
                while True:
                    time.sleep(2)
                    if not exe_running(args.parent_exe):
                        log(f'{args.parent_exe!r} gone; exiting')
                        os._exit(0)
            threading.Thread(target=watch_exe, daemon=True).start()

    while True:
        time.sleep(1)


if __name__ == '__main__':
    main()
