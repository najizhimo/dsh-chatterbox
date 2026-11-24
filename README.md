# dsh-chatterbox

按住说话（或打开「自由麦克风」持续收音）→ 本机识别 → **不抢焦点**地投进一个固定的 DSH 会话；
那边的 agent 按配置里选的 **agent 预设**与**音色档案**，用本机 TTS 念出声音回你，回复本身按
选定的**回复格式（persona）**排版。

- 包名 / 正式 id：`dsh-chatterbox`（行 id `chatterbox`，监听 `127.0.0.1:18801`）
- 一个插件全包：托管语音客户端（按键录音 + 自由麦克风）、接收投递、注入语音会话约定
- 替换词表：在设置页补「容易听错的专有名词」，拼音自动生成，同音误识别会被改回来
- 自带 TTS 运行时：`src/tts/`（服务 + 客户端 + 两个处理模块）与 `tools/play_media.ps1`，
  音频写在插件根目录的 `out/`，按配置的「音频保留天数」自动移入回收站
- 自带一个公有领域演示音色 `cb_Demo_CC0`：依赖装完就能出声，不需要私有素材

## 安装

前置：Windows 10/11、DSH、Python 3.10+、[uv](https://github.com/astral-sh/uv)、约 10 GB 磁盘、端口 18801/8763 空闲；**推荐 PowerShell 7**（脚本在 5.1 下也能跑，7 更稳）。

**从 GitHub 安装**：插件管理器 → 安装 bundle → 填 `github:najizhimo/dsh-chatterbox`，重启 DSH。
也可以 `git clone` 后用 `link:<插件目录>` 安装（见安装指南）。

装好后按 [`docs/INSTALL.zh.md`](docs/INSTALL.zh.md) 走：跑 `tools\bootstrap.ps1` →
两段联网命令（Irodori venv、HF 权重）→ 音色文件夹放进 `deps\voices\` → 依赖页检测全绿。
依赖的准确名称、官方地址与体积见 [`docs/DEPENDENCIES.zh.md`](docs/DEPENDENCIES.zh.md)。

## 文档

| 想看什么 | 打开 |
|---|---|
| **安装与验收**（6 步、排错对照） | [`docs/INSTALL.zh.md`](docs/INSTALL.zh.md) |
| **怎么用**（两种输入、配置页、自由麦克风、自动关、排障） | [`docs/USAGE.zh.md`](docs/USAGE.zh.md) |
| **外部依赖**（模型 / venv / 权重 / 路径优先级） | [`docs/DEPENDENCIES.zh.md`](docs/DEPENDENCIES.zh.md) |
| **换人格**（agent 预设 + 回复格式） | [`docs/PERSONA.zh.md`](docs/PERSONA.zh.md) |
| **自己做一个音色档案** | [`docs/VOICE_PROFILE.zh.md`](docs/VOICE_PROFILE.zh.md) |
| 插件管理页里显示的那张图 | `docs/DETAIL.zh.md`（DSH 自动读取） |

## 音色档案

声音来自成品音色文件夹 `cb_<角色>\`：插件按 `<插件>\deps\voices` → `<插件>\..\voices` 的顺序扫描。
自带演示档案 `cb_Demo_CC0`（公开领域），也可以照 [`docs/VOICE_PROFILE.zh.md`](docs/VOICE_PROFILE.zh.md)
做一个自己的。配置页「音色档案（出声）」下拉切换；在任意会话说「念出来」会按当前档案用日语念，
明确点名别的角色时才换。

## 一分钟上手

```bash
curl -s http://127.0.0.1:18801/health          # 插件与语音客户端是否在跑
curl -s http://127.0.0.1:18801/voice/state     # 自由麦克风状态
curl -s http://127.0.0.1:18801/voice/deps      # 外部依赖自检（设置页点「开始检测」也可）
```

输入框左侧、Computer Use 右边那个「自由麦克风」就是总控开关：灰点=关（按住 `PrintScreen` 说话），
绿/深绿交替=在听。详见 [`docs/USAGE.zh.md`](docs/USAGE.zh.md)。

## 许可证

本插件以 **GPL-3.0** 发布（见 `LICENSE`）。例外：`deps/voices/cb_Demo_CC0/` 的参考音取自 LibriVox，
以 Public Domain Mark 1.0 释出，不适用 GPL，详见该目录的 `MODEL_CARD.md`。
