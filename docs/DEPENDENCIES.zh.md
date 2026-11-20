# 外部依赖指南（dsh-chatterbox）

这份文档给**换机器 / 分发 / 排错**用：列出插件之外必须存在的每一样东西，给出**准确的名称、
官方地址、体积、装到哪里**，以及怎么验证。附带的 `deps/manifest.json` 是同一份数据的机器可读版本，
插件依赖页的「下载并安装缺失」直接按它执行。

> 约定：插件只从**官方发布页**取文件（GitHub Releases / Hugging Face），不碰第三方中转站。
> 自动按钮只下载**可校验的小件**（合计约 165 MB）；venv 与 HF 权重需要你自己跑命令（见 §6、§7）。

---

## 1. 一张表看懂

| # | 名称（准确名） | 官方来源 | 体积 | 装到哪（默认） | 谁来装 |
|---|---|---|---|---|---|
| 1 | **CPython 3.10** venv + 6 个 pip 包 | python.org / PyPI | 约 136 MB | `%LOCALAPPDATA%\dsh\dsh-chatterbox\venv` | `tools\setup-voice-venv.ps1` |
| 2 | **sherpa-onnx** `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2` | https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models | 155.5 MB（解压 228 MB） | `<插件>\deps\models\sensevoice-onnx\` | **自动** |
| 3 | **Silero VAD v4** `silero_vad_v4.onnx` | 同上 | 1.8 MB | `<插件>\deps\models\silero\silero_vad.onnx` | **自动** |
| 4 | **Irodori-TTS** 源码（`Aratako/Irodori-TTS`，main 分支快照） | https://github.com/Aratako/Irodori-TTS | 约 3 MB | `<插件>\deps\irodori\` | **自动** |
| 5 | **Irodori-TTS venv**（含 `torch 2.10.0+cu128`） | PyPI（uv） | 5.2 GB | `<Irodori 源码>\.venv` | 手动（§6） |
| 6 | HF 权重 **`Aratako/Irodori-TTS-v4.1-Small`** | https://huggingface.co/Aratako/Irodori-TTS-v4.1-Small | 约 4.6 GB（含编解码） | `<HF 缓存>\hub\models--Aratako--Irodori-TTS-v4.1-Small` | 手动（§7） |
| 7 | HF 编解码 **`Aratako/Semantic-DACVAE-Japanese-32dim`** | https://huggingface.co/Aratako/Semantic-DACVAE-Japanese-32dim | 小 | `<HF 缓存>\hub\models--Aratako--Semantic-DACVAE-Japanese-32dim` | 手动（§7） |

pip 包（第 1 行）的准确名：`sherpa-onnx`、`sounddevice`、`soundfile`、`pypinyin`、`keyboard`、`numpy`。

---

## 2. 插件怎么找这些路径

优先级：**依赖页里手填的路径（`paths.json`）→ 环境变量 → 默认值**。

| 键 | 环境变量 | 默认值 |
|---|---|---|
| `asrPython` | `CHATTERBOX_ASR_PYTHON` | `%LOCALAPPDATA%\dsh\dsh-chatterbox\venv\Scripts\pythonw.exe` |
| `asrModelDir` | `CHATTERBOX_ASR_MODELS` | `~\.dsh\speech-to-text\sensevoice\models` |
| `ttsIrodori` | `CHATTERBOX_IRODORI` | `<插件>\..\irodori\Irodori-TTS-main` |
| `ttsPython` | `CHATTERBOX_TTS_PYTHON` | `<Irodori>\.venv\Scripts\python.exe` |
| `hfHome` | `CHATTERBOX_HF_HOME` | `<插件>\..\cache\hf-cache` |

`paths.json` 在 `%LOCALAPPDATA%\dsh\dsh-chatterbox\paths.json`，依赖页可以编辑；空串表示用默认。
**把东西装在别处的话，只要把这几个键填上就行**，检测与运行都会跟着走。

默认布局（自动安装后）：

```
<插件>\deps\
├─ manifest.json              下载清单（下面 §3 的机器可读版）
├─ models\
│  ├─ sensevoice-onnx\        model.int8.onnx (228 MB) + tokens.txt
│  └─ silero\silero_vad.onnx  (1.8 MB)
└─ irodori\                   Irodori-TTS 源码
```

---

## 3. 自动下载（依赖页按钮）

设置 → 插件 → 「chatterbox 依赖」→ **下载并安装缺失**。

- 装到 `<插件>\deps\`（可用依赖页的路径框改到别处）；
- 已存在的项**自动跳过**，不会重复下载；
- 进度显示当前项与已下载 MB；完成后自动跑一次检测；
- 对应接口：`POST /voice/deps/install`（可带 `{"ids":["asr-model"],"root":"<自定义目录>"}`）、
  `GET /voice/deps/install` 看进度。

> 为什么 ASR 模型用 **int8** 那个包：完整版是 999 MB（含 fp32），我们只需要 int8（155 MB）。下载后用
> `tar -xjf` 解开，取 `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` 目录里的
> `model.int8.onnx` 与 `tokens.txt`。

---

## 4. 识别侧（ASR）——手动装法

### 4.1 Python + 包

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<插件>\tools\setup-voice-venv.ps1"
```

脚本会建 venv 并装那 6 个包；装完在依赖页填「识别用 Python」= `<venv>\Scripts\pythonw.exe`（默认已在那个位置）。

### 4.2 模型

```powershell
$deps = "<插件>\deps"
New-Item -ItemType Directory -Force "$deps\models","$deps\models\silero" | Out-Null
curl.exe -L -o "$env:TEMP\sv.tar.bz2" `
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2
tar -xjf "$env:TEMP\sv.tar.bz2" -C "$env:TEMP"
Copy-Item "$env:TEMP\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17\*" "$deps\models\sensevoice-onnx\" -Recurse
curl.exe -L -o "$deps\models\silero\silero_vad.onnx" `
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad_v4.onnx
```

> VAD 必须是 **`silero_vad_v4.onnx`**（1,807,522 字节）改名为 `silero_vad.onnx`；不要用同列表里的
> `silero_vad.onnx`（643 KB，那是另一个版本）或 `silero_vad_v5.onnx`（2.3 MB，行为和现有配置不同）。

---

## 5. 出声侧（TTS）——源码

自动按钮已经能下 `Aratako/Irodori-TTS` 的 main 快照；手动等价命令：

```powershell
git clone --depth 1 https://github.com/Aratako/Irodori-TTS "<插件>\deps\irodori"
```

装到别处时，把依赖页「Irodori 源码目录」填成那个目录（里面必须有 `irodori_tts\inference_runtime.py`）。

---

## 6. 出声侧——Irodori venv（5.2 GB，手动）

需要 `uv`（https://github.com/astral-sh/uv）。**这一步不能由插件代跑**（体积大、要选 GPU 版 torch）：

```powershell
cd "<插件>\deps\irodori"
uv sync --extra cu128 --frozen      # 无 GPU 就删掉 --extra cu128
```

得到 `.venv\Scripts\python.exe`，在依赖页填「合成用 Python」。验证：

```powershell
& "<插件>\deps\irodori\.venv\Scripts\python.exe" -c "import torch; print(torch.__version__, torch.cuda.is_available())"
# 期望：2.10.0+cu128 True
```

---

## 7. 出声侧——HF 权重（约 4.6 GB，手动）

两个仓库都要：基座 **`Aratako/Irodori-TTS-v4.1-Small`** 与编解码 **`Aratako/Semantic-DACVAE-Japanese-32dim`**。

```powershell
$hf = "<插件>\..\cache\hf-cache"
$env:HF_HOME = $hf
& "<任意装了 huggingface_hub 的 python>" -m huggingface_hub.commands.huggingface_cli download `
  Aratako/Irodori-TTS-v4.1-Small --local-dir "$hf\hub\models--Aratako--Irodori-TTS-v4.1-Small"
& "<同一个 python>" -m huggingface_hub.commands.huggingface_cli download `
  Aratako/Semantic-DACVAE-Japanese-32dim --local-dir "$hf\hub\models--Aratako--Semantic-DACVAE-Japanese-32dim"
```

装到别处就把依赖页「HF 缓存目录」填成那个 `<hf>` 目录。检测页要求存在
`<hf>\hub\models--Aratako--Irodori-TTS-v4.1-Small`。

---

## 8. 验收

```powershell
# 1) 依赖页点「开始检测」：应当 15 项全绿
# 2) 识别链路
& "<识别 pythonw 同目录的 python.exe>" "<插件>\src\voice\ptt.py" --test-asr "<一段 wav>"
# 3) 合成链路（先确认 8763 服务在跑）
curl.exe -s http://127.0.0.1:8763/health
```

或直接跑插件自带检查：

```bash
node "<插件>\tests\check-mappings.mjs"
```

---

## 8.1 首次使用要不要手动做什么

**不需要。** 依赖齐全后，插件启动时会自己拉起 TTS 服务并装载模型：第一次约 **12–19 秒**，
之后常驻热态（每句只付生成时间）。`out\`、`logs\` 也会自动创建，无需手动建目录。

唯一需要手动重建的是 **venv 被搬动 / 换机器** 之后（venv 里存的是绝对路径）：

```powershell
cd "<插件>\deps\irodori"        # 或你原来的 Irodori 源码目录
Remove-Item -Recurse -Force .venv
uv sync --extra cu128 --frozen
```

注意：插件**不会**在缓存缺失时自动下载权重（运行期强制 `HF_HUB_OFFLINE=1`），见 §7。

## 9. 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 依赖页「合成用 Python」红叉 | Irodori venv 没建，或 `uv sync` 失败 | 见 §6；确认 `torch` 能 import |
| 「HF 模型缓存」红叉 | 缓存里没有 `models--Aratako--Irodori-TTS-v4.1-Small` | 见 §7 |
| 「ASR 模型」提示疑似损坏 | 下载中断，文件远小于 228 MB | 删掉重下（自动按钮会跳过非空的错文件，需先删目录） |
| 自动安装后识别仍失败 | `paths.json` 里 `asrModelDir` 被手填成了旧路径 | 依赖页把那格清空，再点检测 |
| 换机器后 8763 起不来 | venv 里是绝对路径 | 在源码目录删 `.venv` 后重新 `uv sync` |
| 日志报找不到 Irodori 模型 | 插件强制 `HF_HUB_OFFLINE=1`，缓存缺失不会自动下载 | 按 §7 手动拉取，或检查「HF 缓存目录」指向 |
