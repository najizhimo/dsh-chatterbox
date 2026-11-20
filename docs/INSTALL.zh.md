# 安装指南（dsh-chatterbox）

面向**新电脑 / 新用户**。全部命令在 PowerShell 里跑；`<插件>` 指 `dsh-chatterbox\` 所在目录。

> 依赖的准确名称、官方地址与体积见 `DEPENDENCIES.zh.md`；本页只管「按顺序做哪几步」。

---

## 0. 先看清哪些会自动、哪些要你动手

| 步骤 | 自动？ | 说明 |
|---|---|---|
| 识别 venv（6 个包，136 MB） | 半自动 | 跑一次 `tools\bootstrap.ps1` 或 `setup-voice-venv.ps1`，没有 Python 时会提示你装 |
| ASR 模型 + VAD + Irodori 源码（160 MB） | **自动** | 依赖页点「下载并安装缺失」，或 bootstrap 脚本代点 |
| Irodori venv（5.2 GB，含 torch） | 手动 | `uv sync`；`bootstrap.ps1 -WithTtsVenv` 可代跑 |
| HF 权重（4.6 GB） | 手动 | 两段 `huggingface-cli`；脚本会打印现成命令 |
| 音色文件夹 | 手动拷贝 | 放进 `<插件>\deps\voices\`（或工作区 `voices\`），插件自动发现，**不用填路径** |
| 服务拉起 / 模型装载 / 日志 / 音频清理 | **自动** | 插件启动时自己完成，首次装载 12–19 秒 |

---

## 1. 放进插件并启用

1. 把 `dsh-chatterbox\` 放到任意目录（建议随工作区）；
2. 在 DSH 里安装（二选一）：
   - 插件管理器 → 安装 bundle → 目标填 `link:<插件目录的绝对路径>`；
   - 或手工：profile 的 `package.json` 加 `"@local/dsh-chatterbox": "link:<插件目录>"`，`cordis.patch.yml` 末尾用 `insert:` 加一行：

     ```yaml
     - insert:
         - id: chatterbox
           name: dsh-chatterbox
           config:
             port: 18801
     ```
3. 重启 DSH 或重载插件。

---

## 2. 跑一次初始化脚本

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<插件>\tools\bootstrap.ps1"
```

它做四件事：

1. 建识别 venv（自动找 `py -3` / `python` / `uv python find`，找不到会告诉你装 Python）；
2. 调插件的 `/voice/deps/install`，把 **ASR 模型 + Silero VAD + Irodori 源码**下到 `<插件>\deps\`（约 165 MB，带进度）；
3. 提醒 Irodori venv（加 `-WithTtsVenv` 就顺手跑 `uv sync`）；
4. 打印 HF 权重的两条下载命令。

插件此时没启动也没关系：脚本会提示你到依赖页手动点。

---

## 3. 装 Irodori venv（手动，5.2 GB）

```powershell
cd "<插件>\deps\irodori"
uv sync --extra cu128 --frozen      # 无 NVIDIA GPU 时去掉 --extra cu128
```

装完插件会自动发现 `deps\irodori\.venv\Scripts\python.exe` 并填进 `paths.json`
（检测页「合成用 Python」会变成 ✓），不用手填。

---

## 4. 拉 HF 权重（手动，4.6 GB）

```powershell
$env:HF_HOME = "<插件>\deps\hf-cache"
python -m huggingface_hub.commands.huggingface_cli download Aratako/Irodori-TTS-v4.1-Small `
  --local-dir "$env:HF_HOME\hub\models--Aratako--Irodori-TTS-v4.1-Small"
python -m huggingface_hub.commands.huggingface_cli download Aratako/Semantic-DACVAE-Japanese-32dim `
  --local-dir "$env:HF_HOME\hub\models--Aratako--Semantic-DACVAE-Japanese-32dim"
```

（`python` 是任意装了 `huggingface_hub` 的解释器；Irodori venv 里就有。）

---

## 5. 放音色文件夹

把 `cb_<角色>\`（含 `SKILL.md`、`voice.json`、`samples\`、`MODEL_CARD.md`、`references\`）放到：

```
<插件>\deps\voices\cb_<角色>\
```

插件**自带**一个公有领域演示档案 `cb_Demo_CC0`（`Demo_CC0_ja`，30 秒，LibriVox《眼鏡》· Public Domain Mark 1.0），装完就能出声；自己做一个新档案的完整步骤见 `docs/VOICE_PROFILE.zh.md`。插件会按 `<插件>\deps\voices` → `<插件>\..\voices` → 旧默认目录 的顺序**自动发现**第一个可用档案；
配置页「音色档案（出声）」里也能手动改选。

> 音色文件夹不随插件分发（参考音多为版权物，仅限本机私用）。要么自己放进去，要么用你有权使用的参考音另建一个档案。

---

## 6. 验收

```powershell
# 依赖自检（15 项应全绿）
curl.exe -s http://127.0.0.1:18801/voice/deps | ConvertFrom-Json | Select-Object -ExpandProperty missing
# 合成服务
curl.exe -s http://127.0.0.1:8763/health
# 插件整体检查
node "<插件>\tests\check-mappings.mjs"
```

再打开 DSH → 设置 → 插件 →「chatterbox 依赖」→ **开始检测**；最后按热键说一句话。

---

## 7. 装不上时先看哪

| 症状 | 先查 |
|---|---|
| 依赖页「识别用 Python」红叉 | `bootstrap.ps1` 是否找到 Python；重跑 `setup-voice-venv.ps1 -BootstrapPython <python.exe>` |
| 「合成用 Python」红叉 | `deps\irodori\.venv` 有没有建好；`python -c "import torch"` 通不通 |
| 「HF 模型缓存」红叉 | §4 的两个目录是否到位（`models--Aratako--Irodori-TTS-v4.1-Small`） |
| 说话没反应 | 插件 `/health` 的 `voiceClient.running`；`%LOCALAPPDATA%\dsh\dsh-chatterbox\logs\ptt.log` |
| 没有声音 | `http://127.0.0.1:8763/health` 的 `ready`；`<插件>\logs\tts_daemon.log` 尾部 |
| 换了机器，venv 报错 | venv 里是绝对路径：删 `.venv` 后重新 `uv sync`（识别侧则重跑 setup 脚本） |
