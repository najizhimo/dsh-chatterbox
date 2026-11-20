# MODEL_CARD — Demo_CC0_ja（公開デモ音声）

## 用途

本机 TTS 的**公开演示 / 可分发示例档案**：证明「塞一个 `cb_*` 文件夹 → 插件就能用它出声」。
音色由参考音决定，不做训练、不做微调。

## 参考音

| 项 | 值 |
|---|---|
| 来源 | LibriVox《眼鏡》（島崎藤村）item `megane_1407_librivox` |
| 文件 | 第 2 章 `megane_02_shimazaki_128kb.mp3`（44.1 kHz mono） |
| 取样 | 158.8–188.8 秒，去首尾静音后 30.00 秒 |
| 许可 | Public Domain Mark 1.0 — https://creativecommons.org/publicdomain/mark/1.0/ |
| 处理 | 仅裁剪；无降噪、无变调、无变速 |
| 落点 | `samples\Demo_CC0_ja_sample.wav`（44.1 kHz / 16-bit / 单声道） |

## 推理参数（全局统一，不因档案改变）

| 参数 | 值 |
|---|---|
| 基座 | Irodori-TTS `Aratako/Irodori-TTS-v4.1-Small` |
| 服务 | `127.0.0.1:8763`（`src/tts/tts_daemon.py`） |
| 分段上限 | 30 秒/段 |
| 停顿处理 | 见 `voice.json` 的 `post`（补静音、换气、句间收短） |
| 采样率 | 44.1 kHz 单声道输出 |

## 禁则

- 不把参考音做变调／变速／均衡；
- 不拿本档案冒充真人配音，也不用于对外声称「某声优的声音」；
- 分发时保留本卡片与 `MODEL_CARD.md` 中的许可信息。

## 已知限制

- 参考音来自 MP3 编码的朗读录音，频响比录音室素材窄，输出可能略「薄」；
- 朗读腔较重，不适合口语化的短句闲聊；
- 与商业档案相比，情绪起伏更平。
