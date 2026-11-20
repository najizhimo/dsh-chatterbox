# -*- coding: utf-8 -*-
"""只处理停顿：把气口压低、按「哪几句换气」逐处决定留或压、把过长的停顿收短。

语音样本一个都不动。命令行入口：

  python scripts\\soften_breaths.py in.wav out.wav --plan "1k,2m,4k" --keep-pause 0.75 --mute-pause 0.50
  python scripts\\soften_breaths.py in.wav x --list-pauses          # 只列停顿，不改文件

服务端入口：`render()`——服务合成完自动调用。
"""
import argparse
import pathlib
import re

import numpy as np
import soundfile as sf

FRAME, HOP = 0.010, 0.005


# ---------------------------------------------------------------- 基础测量

def frame_table(x, sr):
    """按 10 ms 帧 / 5 ms 跳取电平，返回 (dB 数组, 跳长采样, 帧长采样)。"""
    n, h = int(FRAME * sr), int(HOP * sr)
    count = 1 + max(0, len(x) - n) // h
    idx = np.arange(n)[None, :] + h * np.arange(count)[:, None]
    fr = x[idx] if count > 0 else np.zeros((0, n), dtype=np.float32)
    db = 20 * np.log10(np.sqrt(np.mean(fr ** 2, axis=1)) + 1e-10) if count else np.zeros(0)
    return db, h, n


def find_pauses(db, h, n, total, sr, drop=22.0, min_len=0.10, edge_skip=0.05):
    """低于语音 p90 的 -drop dB 且持续 >=min_len 的区间判为停顿。返回 [(帧a,帧b,采样s0,采样s1)]。"""
    speech = np.percentile(db, 90)
    quiet = db < speech - drop
    regions, start = [], None
    for i, q in enumerate(quiet):
        if q and start is None:
            start = i
        elif not q and start is not None:
            regions.append((start, i))
            start = None
    if start is not None:
        regions.append((start, len(quiet)))

    out = []
    for a, b in regions:
        if (b - a) * HOP < min_len:
            continue
        s0, s1 = a * h, min(total, b * h + n)
        if s0 < edge_skip * sr or (total - s1) < edge_skip * sr:
            continue
        out.append((a, b, s0, s1))
    return out, speech


def breath_events(db, pause):
    """停顿内「高于本底 +6 dB」的帧区间 = 吸气（或残留音响）。"""
    a, b = pause[0], pause[1]
    seg = db[a:b]
    if not len(seg):
        return []
    floor = np.percentile(seg, 10)
    active = seg > floor + 6.0
    events, start = [], None
    for i, v in enumerate(active):
        if v and start is None:
            start = i
        elif not v and start is not None:
            events.append((a + start, a + i))
            start = None
    if start is not None:
        events.append((a + start, b))
    return events


# ---------------------------------------------------------------- 处理

def duck_events(x, events, sr, duck_db, ramp_s, db=None, speech=None,
                extend_s=0.12, extend_rel=-16.0):
    """按吸气事件下包络压低。

    两条硬约束（都是踩过的坑）：
      1. 包络**不许越出事件本身**——越过后面的 20 ms 帧长或前面的 60 ms 前导过渡，
         就会压到相邻字的起音或元音尾巴，听起来那个字被吞掉 `[本机实测 2026-11-18]`；
         过渡一律往事件内侧收。
      2. 往字尾方向最多延伸 extend_s，且只碰低于语音 extend_rel 的帧——
         吸气开头常压在字尾上，不延伸会剩半截。
    """
    gain = np.ones(len(x), dtype=np.float32)
    g = 10 ** (duck_db / 20.0)
    h = int(HOP * sr)
    ramp = max(1, int(ramp_s * sr))
    max_ext = int(extend_s / HOP)
    for a, b in events:
        start = a
        if db is not None and speech is not None:
            k = 0
            while start > 0 and k < max_ext and (db[start - 1] - speech) < extend_rel:
                start -= 1
                k += 1
        s0 = max(0, start * h)
        s1 = min(len(x), b * h)
        if s1 - s0 < 2 * ramp:
            ramp_i = max(1, (s1 - s0) // 2)
        else:
            ramp_i = ramp
        seg = np.full(s1 - s0, g, dtype=np.float32)
        t = np.linspace(0, 1, ramp_i)
        ease = (1 + np.cos(np.pi * t)) / 2
        seg[:ramp_i] = 1 - (1 - g) * (1 - ease)      # 过渡在事件内部完成
        seg[-ramp_i:] = g + (1 - g) * (1 - ease)
        gain[s0:s1] = np.minimum(gain[s0:s1], seg)
    return x * gain


def shorten_pause(x, s0, s1, target_s, sr, win_s=0.06):
    """把停顿收到 target_s：只在**最安静的窗口**里删，不穿过吸气，15 ms 交叉淡化。

    两端各留 win_s（默认 60 ms）的余量：削得太贴字头，15 ms 淡化会落在爆破音的起音上，
    听起来就是那个字被吞掉了。
    """
    target = int(target_s * sr)
    remove = (s1 - s0) - target
    if remove <= 0:
        return x, 0
    win = max(1, int(win_s * sr))
    xf = max(1, int(0.015 * sr))
    best_k, best_e = s0, None
    lo, hi = s0 + win, max(s0 + win, s1 - remove - win)
    step = max(1, win // 2)
    for k in range(lo, hi + 1, step):
        e = float(np.sum(x[k:k + remove] ** 2))
        if best_e is None or e < best_e:
            best_e, best_k = e, k
    k = best_k
    head = x[:k]
    tail_start = k + remove
    fade_out = x[k - xf:k] if k >= xf else x[:k]
    fade_in = x[tail_start:tail_start + xf]
    m = min(len(fade_out), len(fade_in))
    ramp = np.linspace(0, 1, m, dtype=np.float32)
    blend = fade_out[-m:] * (1 - ramp) + fade_in[:m] * ramp
    out = np.concatenate([head[:-m] if m else head, blend, x[tail_start + m:]])
    return out, remove


# ---------------------------------------------------------------- 断句对齐

def sentence_ends(text):
    """每句累计到结尾的字数。丢掉纯标点碎片——`……` 会把 「そうですね……」 切成三段。"""
    ends, cum = [], 0
    for part in re.split(r'(?<=[。！？!?…])', text):
        part = part.strip()
        if not part:
            continue
        if not re.search(r'[\u3040-\u30ff\u4e00-\u9fff]', part):
            continue
        cum += len(part)
        ends.append(cum)
    if not ends or ends[-1] < len(text.strip()):
        ends.append(len(text.strip()))
    return ends


def align_boundaries(exp, centers, gap_pen=1.0, penalty=None):
    """句界预期时刻与停顿实际时刻按顺序配对（Needleman-Wunsch，允许跳过）。

    penalty[j] 给第 j 个停顿加额外代价，用来压低「短停顿被当成句界」的概率：
    句号处通常 >=0.45 s，逗号处常只有 0.2 s 出头，长度比时间比例更可靠。
    返回 {句界下标: 停顿下标}。
    """
    n, m = len(exp), len(centers)
    INF = float('inf')
    pen = list(penalty) if penalty else [0.0] * m
    dp = [[INF] * (m + 1) for _ in range(n + 1)]
    bt = [[None] * (m + 1) for _ in range(n + 1)]
    dp[0][0] = 0.0
    for i in range(n + 1):
        for j in range(m + 1):
            cur = dp[i][j]
            if cur == INF:
                continue
            if i < n and j < m:
                c = cur + abs(exp[i] - centers[j]) + pen[j]
                if c < dp[i + 1][j + 1]:
                    dp[i + 1][j + 1] = c
                    bt[i + 1][j + 1] = (i, j, 1)
            if i < n:
                c = cur + gap_pen
                if c < dp[i + 1][j]:
                    dp[i + 1][j] = c
                    bt[i + 1][j] = (i, j, 0)
            if j < m:
                c = cur + gap_pen
                if c < dp[i][j + 1]:
                    dp[i][j + 1] = c
                    bt[i][j + 1] = (i, j, 0)

    mapping = {}
    i, j = n, m
    while i > 0 or j > 0:
        step = bt[i][j]
        if step is None:
            break
        pi, pj, kind = step
        if kind == 1:
            mapping[pi] = pj
        i, j = pi, pj
    return mapping


def speech_time_positions(pauses, sr, total_len):
    """把停顿位置换算到「语音时间」轴（扣掉停顿长度），返回 (停顿列表, 语音总时长)。"""
    converted = []
    acc = 0.0
    for _a, _b, s0, s1 in pauses:
        t0 = s0 / sr - acc
        t1 = s1 / sr - acc
        converted.append((t0, t1))
        acc += (s1 - s0) / sr
    return converted, max(0.1, total_len / sr - acc)


def build_plan(text, pauses, speech_total, keep='all', leading=True, min_pause=0.60,
               max_breaths=0):
    """把换气决定翻成逐停顿计划（k=保留吸气，m=压掉）。

    keep:
      'long'  —— 只在够长的停顿（>= min_pause）处换气，最后一处不算。**默认**：
                 句号处的停顿通常 0.7–1.1 s，逗号处 0.1–0.5 s，长度本身就够分辨；
                 不必再算「第几句是句号」，也就没有配错的可能 `[本机实测 2026-11-18]`。
      'all'   —— 每个句界都换（旧行为，需要对齐句界）。
      'none'  —— 除起头呼びかけ外不换。
      集合    —— 句子序号（1 起），按单调对齐落在句界上。

    pauses / speech_total 用语音时间坐标。
    """
    text = text.strip()
    ends = sentence_ends(text)
    total = max(1, len(text))
    first_clause = text.split('、')[0] + ('、' if '、' in text else '')
    centers = [(s0 + s1) / 2.0 for s0, s1 in pauses]

    if keep == 'long':
        plan = []
        long_idx = [i for i, (t0, t1) in enumerate(pauses) if (t1 - t0) >= min_pause]
        tail_i = len(pauses) - 1          # 只有最末那一处算「段尾」，不换气
        cands = [i for i in long_idx if i != tail_i]
        if max_breaths and len(cands) > max_breaths:
            # 句号处最长、逗号处次之：按长度取前 N 处，N 由整段时长决定（见 render）
            cands = sorted(sorted(cands, key=lambda i: pauses[i][1] - pauses[i][0],
                                  reverse=True)[:max_breaths])
        for i, (s0, s1) in enumerate(pauses):
            t = (s0 + s1) / 2.0
            if leading and i == 0 and t < 0.18 * speech_total and len(first_clause) <= 7:
                plan.append('k')
                continue
            plan.append('k' if i in cands else 'm')
        return plan

    exp = [c / total * speech_total for c in ends]
    # 短停顿几乎不可能是句号处，加代价让它让给逗号
    penalty = [2.0 * max(0.0, 1.0 - (t1 - t0) / 0.50) for t0, t1 in pauses]
    matched = align_boundaries(exp, centers, penalty=penalty)      # 句界下标 -> 停顿下标
    if len(matched) < max(1, len(ends) // 2):
        # 兜底：字比例估的时间会被语速起伏带偏（短句尤甚），DP 会判「全都对不上」把吸气全压掉。
        # 退回最朴素的顺序配对：够长的停顿（>=0.30 s）按顺序依次配给句界。
        long_idx = [i for i, (t0, t1) in enumerate(pauses) if (t1 - t0) >= 0.30]
        matched = {j: i for j, i in enumerate(long_idx[:len(ends)])}
    pause_to_sentence = {p: s for s, p in matched.items()}

    plan = []
    for i, (s0, s1) in enumerate(pauses):
        t = (s0 + s1) / 2.0
        if leading and i == 0 and t < 0.18 * speech_total and len(first_clause) <= 7:
            plan.append('k')
            continue
        j = pause_to_sentence.get(i)
        if j is None:
            plan.append('m')
            continue
        if keep == 'all':
            plan.append('k')
        elif keep == 'none':
            plan.append('m')
        else:
            plan.append('k' if (j + 1) in keep else 'm')
    return plan


# ---------------------------------------------------------------- 应用计划

def apply_plan(x, sr, plan, keep_pause, mute_pause, mute_db=-18.0, ramp_s=0.06,
               drop=22.0, min_len=0.10, keep_targets=None):
    """'k' 保留吸气并收到 keep_pause；'m' 压掉吸气并收到 mute_pause。未列出的按 'm'。

    keep_targets: {停顿下标: 秒} 逐处覆盖保留处的长度——话题转换那种停顿要比平时长一点。
    """
    db, h, n = frame_table(x, sr)
    pauses, speech = find_pauses(db, h, n, len(x), sr, drop, min_len)
    events = [breath_events(db, p) for p in pauses]

    keep_idx = [i for i, c in enumerate(plan) if c == 'k']
    muted = [ev for i, evs in enumerate(events)
             if (i >= len(plan) or plan[i] != 'k') for ev in evs]
    kept_events = [ev for i in keep_idx if i < len(events) for ev in events[i]]

    if muted:
        x = duck_events(x, muted, sr, mute_db, ramp_s, db=db, speech=speech)

    # 收短：该处根本没有吸气（例如两块之间的拼接缝是纯数字静音）时一律按 mute_pause——
    # 留 0.75 秒的空洞只会发空。
    targets = []
    for i, (a, b, s0, s1) in enumerate(pauses):
        want_keep = (i < len(plan) and plan[i] == 'k' and bool(events[i]))
        target = keep_pause if want_keep else mute_pause
        if want_keep and keep_targets and i in keep_targets:
            target = keep_targets[i]
        if target > 0:
            targets.append((s0, s1, target))

    removed_total = 0
    offset = 0
    for s0, s1, target in targets:
        if (s1 - s0) / sr <= target + 0.05:
            continue
        s0b, s1b = s0 - offset, s1 - offset
        if s1b > len(x) or s1b <= s0b:
            continue
        x, removed = shorten_pause(x, s0b, s1b, target, sr)
        offset += removed
        removed_total += removed

    return x, speech, len(pauses), len(muted), len(kept_events), removed_total


def render(x, sr, text, keep='long', leading=True, keep_pause=0.75, mute_pause=0.50,
           mute_db=-18.0, ramp_s=0.06, drop=22.0, min_len=0.10, peak=0.89,
           keep_pause_short=0.50, short_line_s=12.0, min_pause=0.60,
           topic_pause=0.85, topic_breaths=()):
    """服务端入口：按文本与「哪几句换气」处理整段音频，返回 (音频, 摘要)。

    短句（<= short_line_s 秒）用 keep_pause_short：对话里 0.75 秒的停顿太长，
    一句话只有十秒的时候，那 0.75 秒听起来像在等对方开口。

    topic_breaths: 第几个「保留的换气」属于话题转换（1 起）。那处停顿用 topic_pause，
    比平时的呼吸停顿长——人类换话题要先停一下再开口 `[主人 2026-11-18]`。
    """
    audio_s = len(x) / sr
    if keep_pause_short and audio_s <= short_line_s:
        keep_pause = keep_pause_short
    cap = max(1, int(round(audio_s / 7.0)))      # 约每七秒一次换气：10 s→1，15 s→2，20 s→3
    db, h, n = frame_table(x, sr)
    pauses, _speech = find_pauses(db, h, n, len(x), sr, drop, min_len)
    pauses_s, speech_total = speech_time_positions(pauses, sr, len(x))
    plan = build_plan(text, pauses_s, speech_total, keep, leading, min_pause, cap)
    # 话题转换处：把第 N 个保留的换气换成更长的停顿
    keep_targets = {}
    if topic_breaths and topic_pause > 0:
        k_pos = [i for i, c in enumerate(plan) if c == 'k']
        for n in topic_breaths:
            if 1 <= int(n) <= len(k_pos):
                keep_targets[k_pos[int(n) - 1]] = topic_pause
    y, _sp, n_pause, n_muted, n_kept, removed = apply_plan(
        x, sr, plan, keep_pause, mute_pause, mute_db, ramp_s, drop, min_len, keep_targets)
    if peak:
        p = float(np.max(np.abs(y))) or 1.0
        y = (y / p * peak).astype(np.float32)
    return y, {
        'pauses': n_pause, 'kept': n_kept, 'muted': n_muted,
        'removed_s': round(removed / sr, 3), 'plan': ''.join(plan),
        # 保留的吸气在**原始音频**里的时间区间：报位置用这个，别再让人去数 kmmm
        'kept_at': [f'{pauses_s[i][0]:.2f}-{pauses_s[i][1]:.2f}s'
                    for i, c in enumerate(plan) if c == 'k'],
        'keep_pause': keep_pause, 'mute_pause': mute_pause, 'mute_db': mute_db,
        'topic_pause': topic_pause,
    }


# ---------------------------------------------------------------- 命令行

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--plan', default='',
                    help='逐停顿计划，逗号分隔，k=保留吸气 m=压掉；如 1k,2m,4k')
    ap.add_argument('--keep-pause', type=float, default=0.75)
    ap.add_argument('--mute-pause', type=float, default=0.50)
    ap.add_argument('--mute-db', type=float, default=-18.0)
    ap.add_argument('--duck', type=float, default=-12.0, help='无计划时统一压低多少 dB')
    ap.add_argument('--target-pause', type=float, default=0.0)
    ap.add_argument('--ramp', type=float, default=0.06)
    ap.add_argument('--drop', type=float, default=22.0)
    ap.add_argument('--min-len', type=float, default=0.10)
    ap.add_argument('--list-pauses', action='store_true', help='只列停顿，不动文件')
    args = ap.parse_args()

    x, sr = sf.read(args.src, always_2d=True)
    x = x.mean(axis=1).astype(np.float32)
    before = len(x) / sr

    if args.list_pauses:
        db, h, n = frame_table(x, sr)
        pauses, speech = find_pauses(db, h, n, len(x), sr, args.drop, args.min_len)
        rel = db - speech
        print(f'{pathlib.Path(args.src).name}: {before:.2f}s, 语音 p90 {speech:.1f} dB')
        for i, (a, b, s0, s1) in enumerate(pauses, 1):
            evs = breath_events(db, (a, b, s0, s1))
            pk = max((rel[e0:e1].max() for e0, e1 in evs), default=float('nan'))
            print(f'  [{i}] {s0/sr:6.2f}-{s1/sr:6.2f}s 长 {(s1-s0)/sr:.2f}s '
                  f'吸气{len(evs)}段 峰值 {pk:6.1f} dB')
        return

    if args.plan:
        plan, keep_targets = [], {}
        for part in args.plan.replace(' ', '').split(','):
            if not part:
                continue
            m = re.fullmatch(r'(\d+)([km])(?::?([\d.]+))?', part.lower())
            if not m:
                continue
            idx, flag, sec = int(m.group(1)), m.group(2), m.group(3)
            while len(plan) < idx - 1:
                plan.append('m')
            plan.append('k' if flag == 'k' else 'm')
            if flag == 'k' and sec:
                keep_targets[idx - 1] = float(sec)
        y, speech, n_pause, n_muted, n_kept, removed = apply_plan(
            x, sr, plan, args.keep_pause, args.mute_pause, args.mute_db, args.ramp,
            args.drop, args.min_len, keep_targets)
        desc = (f'计划 {args.plan}（保留 {n_kept} 段吸气 / 压掉 {n_muted} 段），'
                f'保留处 {args.keep_pause:.2f}s，压掉处 {args.mute_pause:.2f}s')
    elif args.duck < 0:
        db, h, n = frame_table(x, sr)
        pauses, speech = find_pauses(db, h, n, len(x), sr, args.drop, args.min_len)
        events = [ev for p in pauses for ev in breath_events(db, p)]
        y = duck_events(x, events, sr, args.duck, args.ramp, db=db, speech=speech) if events else x
        removed = 0
        n_pause, n_muted, n_kept = len(pauses), len(events), 0
        if args.target_pause > 0:
            offset = 0
            for a, b, s0, s1 in pauses:
                if (s1 - s0) / sr <= args.target_pause + 0.10:
                    continue
                s0b, s1b = s0 - offset, s1 - offset
                if s1b > len(y) or s1b <= s0b:
                    continue
                y, rem = shorten_pause(y, s0b, s1b, args.target_pause, sr)
                offset += rem
                removed += rem
        desc = f'统一压低 {args.duck:.0f} dB' + (
            f'，长停顿收到 {args.target_pause:.2f}s' if args.target_pause else '')
    else:
        y, removed, n_pause, n_muted, n_kept = x, 0, 0, 0, 0
        desc = '不做处理'

    peak = float(np.max(np.abs(y))) or 1.0
    y = y / peak * 0.89
    sf.write(args.dst, y, sr, subtype='PCM_16')
    print(f'{pathlib.Path(args.src).name}: {before:.2f}s, 停顿 {n_pause} 处')
    print(f'  {desc}, 共删 {removed/sr:.2f}s')
    print(f'  -> {pathlib.Path(args.dst).name}  {before:.2f}s -> {len(y)/sr:.2f}s')


if __name__ == '__main__':
    main()
