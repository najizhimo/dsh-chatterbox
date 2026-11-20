# -*- coding: utf-8 -*-
"""Long-form speech with Irodori-TTS: split text, synthesize per chunk with one
loaded model, then concatenate with small gaps and normalize loudness.

Also importable: `build_runtime()` + `synthesize()` are reused by
`server/tts_daemon.py` so the resident service shares this exact recipe.
"""
import os, sys, re, math, time, pathlib, warnings

T0 = time.time()

os.environ["NO_PROXY"] = "localhost,127.0.0.1"
os.environ["no_proxy"] = "localhost,127.0.0.1"
os.environ["HF_HUB_DISABLE_SYMLINKS"] = "1"
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
warnings.filterwarnings("ignore")

import numpy as np
import soundfile as sf

REPO = pathlib.Path(os.environ.get('CHATTERBOX_IRODORI') or '').expanduser() if os.environ.get('CHATTERBOX_IRODORI') \
    else pathlib.Path(__file__).resolve().parent.parent / 'irodori' / 'Irodori-TTS-main'
sys.path.insert(0, str(REPO))

from irodori_tts.inference_runtime import (
    InferenceRuntime, RuntimeKey, SamplingRequest,
    download_hf_checkpoint, resolve_cfg_scales,
)

CHARS_PER_SEC = 5.6          # rough speaking rate, used only for chunk sizing
MAX_CHUNK_SECONDS = float(os.environ.get('SPEAK_MAX_CHUNK', '26.0'))
MAX_SECONDS = float(os.environ.get('SPEAK_MAX_SECONDS', str(MAX_CHUNK_SECONDS + 4)))
MAX_TEXT_LEN = os.environ.get('SPEAK_MAX_TEXT_LEN', '')
GAP_SECONDS = float(os.environ.get('SPEAK_GAP_BASE', '0.45'))
GAP_SLOPE = float(os.environ.get('SPEAK_GAP_SLOPE', '0.50'))
USE_CAPTION = os.environ.get('SPEAK_USE_CAPTION', '0') == '1'
CFG_CAPTION = float(os.environ.get('SPEAK_CFG_CAPTION', '3.0'))


def split_sentences(text):
    parts = re.split(r'(?<=[。！？!?…])', text)
    out = []
    for p in parts:
        p = p.strip()
        if p:
            out.append(p)
    return out


def chunk_text(text, max_chars):
    sents = split_sentences(text)
    chunks, cur = [], ''
    for s in sents:
        if len(cur) + len(s) <= max_chars:
            cur += s
            continue
        if cur:
            chunks.append(cur)
        while len(s) > max_chars:            # a single very long sentence
            cut = s.rfind('、', 0, max_chars)
            if cut < max_chars // 2:
                cut = max_chars
            chunks.append(s[:cut])
            s = s[cut:]
        cur = s
    if cur:
        chunks.append(cur)
    return chunks


def normalize_text(text):
    return re.sub(r'\s+', '', text.replace('\n', ''))


def plan_chunks(text):
    text = normalize_text(text)
    return text, chunk_text(text, int(MAX_CHUNK_SECONDS * CHARS_PER_SEC))


def build_runtime(spk_cfg=6.0, use_caption=None):
    """Load the checkpoint and build the runtime once; returns (runtime, cfg trio)."""
    if use_caption is None:
        use_caption = USE_CAPTION
    ckpt = download_hf_checkpoint('Aratako/Irodori-TTS-v4.1-Small')
    runtime = InferenceRuntime.from_key(RuntimeKey(
        checkpoint=ckpt,
        model_device='cuda',
        codec_repo='Aratako/Semantic-DACVAE-Japanese-32dim',
        model_precision='bf16',
        codec_precision='fp32',
        codec_device='cuda',
        codec_deterministic_encode=True,
        codec_deterministic_decode=True,
        compile_model=False,
        compile_dynamic=False,
        split_rare_tokens=True,
    ))
    cfg_t, cfg_c, cfg_s, msgs = resolve_cfg_scales(
        cfg_guidance_mode='independent',
        cfg_scale_text=3.0,
        cfg_scale_caption=CFG_CAPTION,
        cfg_scale_speaker=spk_cfg,
        cfg_scale=None,
        use_caption_condition=bool(use_caption),
        use_speaker_condition=True,
    )
    return runtime, (cfg_t, cfg_c, cfg_s)


def synthesize(runtime, cfg, chunks, ref_path, seed0=100, seed_mode='vary', log=print,
               caption=None, ref_paths=None, lora_adapter=None, duration_scale=1.0):
    """Synthesize pre-chunked text; returns (sample_rate, float32 waveform, durations, gen_seconds).

    caption:    风格/情绪描述（需要 build_runtime(use_caption=True)）。None = 不加 caption 条件。
    ref_paths:  多段参考音（按顺序拼接，超上限后后面的无效）。给定时忽略 ref_path。
    duration_scale: <1 让整段更紧凑（停顿随之变短，气口也更少更轻）。
    """
    cfg_t, cfg_c, cfg_s = cfg
    pieces = []
    sr = None
    durations = []
    t_load = time.time()
    log(f'model ready after {t_load - T0:.1f}s')
    for idx, chunk in enumerate(chunks):
        req = SamplingRequest(
            text=chunk,
            caption=caption,
            ref_wav=None if ref_paths else str(ref_path),
            ref_wavs=[str(p) for p in ref_paths] if ref_paths else None,
            ref_latent=None,
            ref_latents=None,
            ref_embed=None,
            no_ref=False,
            ref_normalize_db=-16.0,
            ref_ensure_max=True,
            num_candidates=1,
            decode_mode='sequential',
            seconds=None,
            max_seconds=MAX_SECONDS,
            min_seconds=0.5,
            duration_scale=duration_scale,
            max_ref_seconds=45.0,
            max_text_len=(int(MAX_TEXT_LEN) if MAX_TEXT_LEN else None),
            max_caption_len=None,
            num_steps=None,
            cfg_scale_text=cfg_t,
            cfg_scale_caption=cfg_c,
            cfg_scale_speaker=cfg_s,
            cfg_guidance_mode='independent',
            cfg_scale=None,
            cfg_min_t=0.5,
            cfg_max_t=1.0,
            truncation_factor=None,
            rescale_k=None,
            rescale_sigma=None,
            context_kv_cache=True,
            speaker_kv_scale=None,
            speaker_kv_min_t=None,
            speaker_kv_max_layers=None,
            speaker_uncond_mode='mask',
            seed=seed0 if seed_mode == 'same' else seed0 + idx,
            t_schedule_mode='linear',
            sway_coeff=-1.0,
            trim_tail=True,
            tail_window_size=20,
            tail_std_threshold=0.05,
            tail_mean_threshold=0.1,
            lora_adapter=(str(lora_adapter) if lora_adapter else None),
        )
        res = runtime.synthesize(req)
        audio = res.audio
        if hasattr(audio, 'detach'):
            audio = audio.detach().cpu().numpy()
        audio = np.asarray(audio, dtype=np.float32)
        if audio.ndim == 2 and audio.shape[0] <= 8:
            audio = audio.mean(axis=0)
        audio = audio.reshape(-1)
        sr = res.sample_rate
        log(f'  chunk {idx+1}: {len(audio)/sr:.2f}s (seed {seed0+idx})')
        durations.append(len(audio)/sr)
        pieces.append(audio)
        if idx < len(chunks) - 1:          # 最后一段之后不留缝：那段静音纯属多余
            gap = GAP_SECONDS + GAP_SLOPE * min(1.0, durations[-1] / MAX_CHUNK_SECONDS)
            pieces.append(np.zeros(int(sr * gap), dtype=np.float32))
            log(f'    gap after chunk {idx+1}: {gap:.2f}s')

    out = np.concatenate(pieces)
    t_gen = time.time()
    log(f'synthesis {t_gen - t_load:.2f}s for {sum(durations):.2f}s of audio '
        f'(RTF {(t_gen - t_load) / max(sum(durations), 1e-6):.3f})')
    peak = float(np.max(np.abs(out))) or 1.0
    out = out / peak * 0.89
    return sr, out, durations, t_gen - t_load


def write_wav(path, sr, out, log=print):
    sf.write(path, out, sr, subtype='PCM_16')
    log(f'saved {path}  {len(out)/sr:.1f}s  sr={sr}')


def main():
    # SPEAK_STDOUT=1: 把 WAV 字节直接写到 stdout（由 cmd 重定向落盘），
    # 用于本机 python 被 360 沙箱降为 Low IL、无法写普通目录的场合。
    stdout_bin = sys.stdout.buffer if os.environ.get('SPEAK_STDOUT') == '1' else None
    if stdout_bin is not None:
        sys.stdout = sys.stderr

    text_path, out_path, ref_path = sys.argv[1], sys.argv[2], sys.argv[3]
    spk_cfg = float(sys.argv[4]) if len(sys.argv) > 4 else 6.0
    seed0 = int(sys.argv[5]) if len(sys.argv) > 5 else 100
    seed_mode = sys.argv[6] if len(sys.argv) > 6 else 'vary'

    text = pathlib.Path(text_path).read_text(encoding='utf-8')
    text, chunks = plan_chunks(text)
    print(f'text {len(text)} chars -> {len(chunks)} chunks')
    for i, c in enumerate(chunks, 1):
        print(f'  [{i}] {len(c):>3} chars  {c[:28]}...')

    runtime, cfg = build_runtime(spk_cfg)
    caption = os.environ.get('SPEAK_CAPTION') or None
    sr, out, durations, gen_s = synthesize(runtime, cfg, chunks, ref_path, seed0, seed_mode,
                                           caption=caption)
    if stdout_bin is not None:
        sf.write(stdout_bin, out, sr, format='WAV', subtype='PCM_16')
        stdout_bin.flush()
        print(f'streamed wav to stdout  {len(out)/sr:.1f}s  sr={sr}')
    else:
        write_wav(out_path, sr, out)


if __name__ == '__main__':
    main()
