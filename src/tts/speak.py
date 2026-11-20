# -*- coding: utf-8 -*-
"""说话客户端（dsh-chatterbox 自带）：把一句话交给常驻 TTS 服务，取回 wav 并播放。

  python <plugin>\\src\\tts\\speak.py "また今更ながら気づいた。"
  python <plugin>\\src\\tts\\speak.py -t "..." --name clip1 --no-play
  python <plugin>\\src\\tts\\speak.py --status | --list | --stop | --start

服务未启动时会自行拉起（首次付 ~15 秒装载），之后每句话只付生成时间。
输出目录固定为 <plugin>\\out；音色档案来自 <voices>\\cb_*\\voice.json。
"""
import argparse
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.request

# 控制台可能是 GBK（Windows 默认），打印日文或带「・」的名字会炸：统一转 UTF-8。
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

HERE = pathlib.Path(__file__).resolve().parent          # <plugin>/src/tts
PLUGIN = HERE.parent.parent                             # <plugin>
DAEMON = HERE / 'tts_daemon.py'
PLAYER = PLUGIN / 'tools' / 'play_media.ps1'
OUT = PLUGIN / 'out'
LOGS = PLUGIN / 'logs'
# 音色档案根目录：工作区 voices 与插件自带 deps/voices 都扫，可用 --voices 覆盖（; 分隔）
VOICE_DIRS = [pathlib.Path(part) for part in str(
    os.environ.get('CHATTERBOX_VOICES') or (str(PLUGIN.parent / 'voices') + ';' + str(PLUGIN / 'deps' / 'voices'))
).split(';') if part]
VOICES = VOICE_DIRS[0]
HF_HOME_DIR = pathlib.Path(os.environ.get('CHATTERBOX_HF_HOME') or PLUGIN.parent / 'cache' / 'hf-cache')
IRODORI_DIR = pathlib.Path(os.environ.get('CHATTERBOX_IRODORI') or PLUGIN.parent / 'irodori' / 'Irodori-TTS-main')


def base(port):
    return f'http://127.0.0.1:{port}'


def health(port, timeout=2):
    try:
        with urllib.request.urlopen(base(port) + '/health', timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))
    except Exception:
        return None


def post(port, path, payload, timeout=300):
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(base(port) + path, data=body, method='POST',
                                 headers={'Content-Type': 'application/json; charset=utf-8'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def ensure_daemon(port, quiet=False):
    h = health(port)
    if h and h.get('ready'):
        return h
    if not (h and h.get('ready')):
        if h is None:
            OUT.mkdir(parents=True, exist_ok=True)
            LOGS.mkdir(parents=True, exist_ok=True)
            subprocess.Popen(
                [sys.executable, str(DAEMON), '--port', str(port),
                 '--voices', ';'.join(str(d) for d in VOICE_DIRS), '--out', str(OUT), '--logs', str(LOGS),
                 '--hf-home', str(HF_HOME_DIR), '--irodori', str(IRODORI_DIR)],
                cwd=str(PLUGIN),
                creationflags=0x08000000,      # CREATE_NO_WINDOW
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        t0 = time.time()
        if not quiet:
            print('loading model...', file=sys.stderr)
        while time.time() - t0 < 300:
            time.sleep(0.7)
            h = health(port)
            if h and h.get('ready'):
                if not quiet:
                    print(f'ready in {time.time() - t0:.1f}s (load {h.get("load_s")}s)', file=sys.stderr)
                return h
        raise SystemExit('daemon did not become ready; see logs\\tts_daemon.log')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-t', '--text', help='要念的文本；省略则读取 stdin')
    ap.add_argument('--name', default=None,
                    help='输出文件名（不含扩展名）；省略则用生成时间 月-日-时-分-秒')
    ap.add_argument('--keep', action='store_true',
                    help='长期保留：文件名加 keep_ 前缀，每日清扫不会删它')
    ap.add_argument('--profile', default=None, help='音色档案 id（默认取 voices/registry.json 的 default）')
    ap.add_argument('--caption', default=None,
                    help='风格/情绪描述（日文），如「囁くように静かな女性話者」；省略则不加 caption 条件')
    ap.add_argument('--port', type=int, default=8763)
    ap.add_argument('--voices', default=None, help='音色档案根目录（默认 <plugin>/../voices）')
    ap.add_argument('--no-play', action='store_true', help='只生成，不播放')
    ap.add_argument('--sync', action='store_true',
                    help='等音频播完再返回；默认异步（服务端播放，命令立刻返回）')
    ap.add_argument('--smile', action='store_true',
                    help='句尾（引号内）加一个 ♪：实测能让语气明显带笑意')
    ap.add_argument('--breaths', default=None,
                    help='哪几个句号之后换气：如 "1,3"（第 1、3 句后），或 all / none；省略则用档案默认')
    ap.add_argument('--raw', action='store_true',
                    help='跳过停顿处理，保留模型原样生成（含每处吸气）')
    ap.add_argument('--topic-breath', default=None,
                    help='把第几个保留的换气当作「话题转换」：那处停顿放长（如 "2"）。从 1 数。')
    ap.add_argument('--player', choices=['mf', 'winsound'], default='mf',
                    help='播放器：mf=Media Foundation（默认，长音轨不会拉断蓝牙链路）；winsound=旧方式')
    ap.add_argument('--status', action='store_true')
    ap.add_argument('--list', action='store_true', help='列出音色档案')
    ap.add_argument('--stop', action='store_true')
    ap.add_argument('--start', action='store_true', help='只装载服务，不合成')
    args = ap.parse_args()

    if args.voices:
        global VOICE_DIRS, VOICES
        VOICE_DIRS = [pathlib.Path(part) for part in str(args.voices).split(';') if part]
        VOICES = VOICE_DIRS[0]

    if args.list:
        h = ensure_daemon(args.port, quiet=True)
        for pid, info in (h.get('profiles') or {}).items():
            mark = ' *' if pid == h.get('default_profile') else ''
            print(f"{pid}{mark}\n    display={info.get('display')}  cv={info.get('cv')}  "
                  f"ref={info.get('ref')}  version={info.get('version')}")
        return

    if args.status:
        h = health(args.port)
        print(json.dumps(h, ensure_ascii=False, indent=2) if h else f'not running on port {args.port}')
        return
    if args.stop:
        try:
            post(args.port, '/quit', {}, timeout=3)
        except Exception:
            pass
        print('stopped')
        return
    if args.start:
        ensure_daemon(args.port)
        return

    text = args.text if args.text is not None else sys.stdin.read()
    if not text.strip():
        raise SystemExit('empty text')
    if args.smile:
        # 在最后一个引号内追加 ♪；若无引号则加在句尾
        s = text.rstrip()
        if s.endswith('」') or s.endswith('』'):
            text = s[:-1] + '♪' + s[-1]
        else:
            text = s + '♪'
    ensure_daemon(args.port)

    t0 = time.time()
    # keep_ 前缀 = 长期保留，清扫会跳过；主人要求保留时自动加
    name = args.name
    if not (name and name.lower().startswith('keep_')) and args.keep:
        name = 'keep_' + (name or time.strftime('%m-%d-%H-%M-%S'))
    payload = {'text': text, 'profile': args.profile, 'play': False}
    if args.caption:
        payload['caption'] = args.caption
    if args.breaths:
        payload['breaths'] = args.breaths
    if args.raw:
        payload['raw'] = True
    if args.topic_breath:
        payload['topic_breaths'] = args.topic_breath
    if name:
        payload['name'] = name
    res = post(args.port, '/say', payload)
    net = time.time() - t0

    # 播放放在客户端。默认走 Media Foundation（play_media.ps1）：
    # winsound 走老的 waveOut 路径，12 秒以上的音轨会把蓝牙耳机整条链路拉断（2026-11-18 实测）。
    if not args.no_play:
        if args.sync:
            import winsound
            winsound.PlaySound(res['wav'], winsound.SND_FILENAME)
        elif args.player == 'mf':
            subprocess.Popen(
                ['powershell', '-NoProfile', '-STA', '-WindowStyle', 'Hidden',
                 '-ExecutionPolicy', 'Bypass',
                 '-File', str(PLAYER),
                 '-Path', res['wav']],
                creationflags=0x08000000,               # CREATE_NO_WINDOW
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
        else:
            player = pathlib.Path(sys.executable).with_name('pythonw.exe')
            exe = str(player) if player.exists() else sys.executable
            subprocess.Popen(
                [exe, '-c',
                 'import sys, winsound; winsound.PlaySound(sys.argv[1], winsound.SND_FILENAME)',
                 res['wav']],
                creationflags=0x08000000,               # CREATE_NO_WINDOW
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )

    wall = time.time() - t0
    out = {
        'profile': res['profile'], 'ref': res['ref'], 'caption': res.get('caption'),
        'chars': res['chars'], 'chunks': res['chunks'],
        'audio_s': res['duration'], 'gen_s': res['gen_s'], 'rtf': res['rtf'],
        'net_s': round(net, 2), 'wall_s': round(wall, 2), 'wav': res['wav'],
    }
    if res.get('swept'):
        out['swept'] = res['swept']
    if res.get('post'):
        out['breaths'] = res['post']
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
