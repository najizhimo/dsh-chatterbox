# Changelog

本文件记录**公开发布**的版本。开发期的 2.x 内部版本不在此列；
公开仓库的版本号从 `1.0.0` 开始，与 `package.json` 的 `version`、`src/host/index.js` 的 `VERSION` 对齐。

格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [语义化版本](https://semver.org/)。

## [1.0.0] - 未发布

首个公开版本。

### Added

- **语音输入**：按住热键说话，或打开「自由麦克风」持续收音；本机 SenseVoice 识别，
  投递进指定的 DSH 会话时不抢焦点。
- **本机 TTS 出声**：日语朗读，服务随插件启动/退出；临时音轨按天清理并移入回收站（`keep_` 豁免）。
- **回复格式（persona）**：段落数、标签、是否朗读由 `personas/*.json` 决定；
  `spoken: false` 的段只出文字、永不合成。默认 `deepseek`（中文译文 + 日语原文+链接，两段）。
- **agent 预设选择**：从 DSH 预设注册表里选由哪个角色作答；留空则跟随目标会话。
- **音色档案**：`cb_<角色>\` 文件夹即一个档案（`SKILL.md` / `voice.json` / `MODEL_CARD.md` / `samples` / `references`）；
  插件按 `deps/voices` → `..\voices` 自动发现。自带公有领域演示档案 `cb_Demo_CC0`。
- **替换词表**：设置页录入易听错的专有名词，拼音自动生成或手动指定（`词=拼音`）。
- **依赖检查页**：外部依赖逐项检查（含 python import 抽查、模型体积下限），可一键下载缺失项；
  路径可手填，保存在插件自己的 `paths.json`。
- **工具**：`tools/bootstrap.ps1` 一键初始化；`tools/latency-report.mjs` 量各段耗时。

### Notes

- 仅支持 Windows + DSH；识别与合成都在本机，不联网（HF 权重需提前下载）。
- 参考音与音色素材的许可由使用者自负；只有公有领域/CC0 素材可随插件分发。
