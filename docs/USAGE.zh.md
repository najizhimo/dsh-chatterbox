# dsh-chatterbox 使用说明

按住说话 → 识别文本 → **不抢焦点**地投进**固定那一个** DSH 会话；那边的 agent 按**配置里选的 agent 预设**（谁在说话）与**回复格式 persona**（怎么排版），用**配置里指定的出声技能**念出声音回你。

- 包名 `dsh-chatterbox`（行 id `chatterbox`，显示名 **`dsh-chatterbox`**）
- 目录 `<插件>`
- 监听 `127.0.0.1:18801`
- 锁定会话 `session-00000000-0000-0000-0000-000000000000`
- **一个插件全包**：既托管语音客户端（按键录音 → 本地识别，原独立的 ptt-daemon 插件已并进来），也接收它投回来的文本
- **两种输入**：按住热键说话（默认 `PrintScreen`），或者打开输入框上的「自由麦克风」总控开关持续收音

投递走的是 Web 客户端「按发送」用的同一个公开服务方法 `sessionController.prompt()`：文本作为普通用户消息进入会话日志，智能体照常开一轮回复。不碰窗口焦点、不碰剪贴板、不模拟键鼠、不改 `app.asar`、不复刻 typert 协议。

---

## 1. 配置

配置有两处来源，**都在同一个 Config schema 里**（`src/host/index.js` 的 `export const Config`）：

| 字段 | 说明 |
|---|---|
| `sessionId` | **输出会话**，UI 里的下拉框（列出当前会话，带标题与「未打开」标记；第一项「自动」= 按最近活跃）；选完保存**立刻切换**协议注入与投递目标（volatile） |
| `speakSkillPath` | **音色档案（出声）**，UI 里是下拉框（`voices\cb_*` 成品音色文件夹，默认 `cb_Demo_CC0`）；换档案 = 换声音，**下一轮就生效**（volatile） |
| `hotkey` | **按住说话按键**，默认 `printscreen`（界面上的「按住说话按键」）。支持组合键：`ctrl+alt+space`、`shift+f9`、`ctrl+shift+mouse4`…<br>点「录制按键」再按一下要用的键即可（Esc 取消）；改完约 1 秒重开语音端 |
| `vadSilenceSeconds` | **投送延迟**（默认 `2.0`，范围 0.3–600，最多 1 位小数），UI 里的数字输入框，**改完约 1 秒内生效**（volatile） |
| `leadInSeconds` | **开头补静音（秒）**（默认 `0.2`，0–2，两位小数）。为什么存在：模型生成的音频从第一个采样点就出声，而蓝牙耳机/声卡「起播」有几十到几百毫秒的启动延迟，不补就会**吞掉第一个音**。改完下一句生效（插件写 `audio-pad.json`，TTS 服务每次合成前读它） |
| `tailSeconds` | **结尾补静音（秒）**（默认 `0.12`，0–2，两位小数）：末尾留一点静音，避免最后一个音被切断 |
| `asrLanguage` | **识别语言**（下拉：自动 / 普通话 / English / 日本語 / 한국어 / 粵語，默认 `auto`）。SenseVoice 是多语种模型，auto 会自动判断；固定语言更准。<br>改完插件会自动重开语音端（约 1 秒），下一句生效 |
| `replyMaxChars` | **回复长度上限（字）**（整数，默认 `0` = 不限，范围 0–500），UI 里的数字输入框；>0 时会把上限写进会话约定 |
| `voiceClient.autoStart` / `python` / `script` | 语音客户端：是否随 DSH 启动、`pythonw.exe` 与 `ptt.py` 路径（留空用默认）。热键见上面的 `hotkey` |
| `voiceProtocol` / `voiceProtocolOrder` / `voiceProtocolText` | 是否注入约定、插入位次、覆盖文本 |
| `port` / `token` / `mode` / `logFile` / `maxLogBytes` / `admitTimeoutMs` / `defaultCwd` | 端口、口令、投递模式、日志与超时 |

## 音色档案（成品）

出声不再依赖全局技能，而是由**成品音色文件夹**提供——每个档案一个目录：

```
voice_train\voices\
├─ （无 registry：每个档案的 voice.json 就是定义）
├─ cb_Demo_CC0\              公開デモ音声（LibriVox・PD）
│  ├─ SKILL.md                怎么念：命令、参数、边界、汇报格式
│  ├─ voice.json              档案 id / 显示名 / 参考音路径（插件读它）
│  ├─ MODEL_CARD.md           音色说明书（参考音来源、推理参数）
│  ├─ samples\               参考音 wav（这个档案专属）
│  └─ references\            用法 / 限制 / 排障细则
└─ cb_My_Hero\                你自己的档案
```

- **切换**：配置页「音色档案（出声）」下拉里选一个，下一轮生效；下拉数据来自 `GET /voice/profiles`。
- **任意会话念出来**：插件向所有 agent 注入一条全局规则——说「念出来 / 念一下 / 用她的声音」时，
  按当前档案的 `SKILL.md` 用日语念，并带 `--profile <id>`；明确点名别的角色（如「让风莉说」）时才换档案。
- **语音会话**：同一个档案，但正文按三段时间格式交付（见 §4）。
- **新增档案**：复制 `cb_Demo_CC0` 改成 `cb_<角色>\`，改 `voice.json` 与 `SKILL.md` 里的 profile，
  服务启动时扫描 `cb_*` 文件夹，所以新档案保存后重启语音端就会出现在下拉里。

### 语音客户端（原独立的 ptt-daemon 插件，已并入）

插件启动并监听成功后，会拉起 `pythonw.exe <skill>\scripts\ptt.py --hotkey <热键> --parent-pid <DSH pid>`：

- `pythonw` + `windowsHide`：不弹黑窗；`--parent-pid`：DSH 崩溃被强杀时它自己也会退出；
- 停用/卸载插件、或 DSH 正常退出时，`taskkill /PID <pid> /T /F` 连「venv 的 pythonw 转发壳 + 真实解释器」一起收；
- 运行状态看 `GET /health` 的 `voiceClient`（`running` / `pid` / `hotkey` / `script`）；
- 语音端自己的日志仍是 `%LOCALAPPDATA%\dsh\dsh-chatterbox\logs\ptt.log`（与插件日志分开放）；
- 想换热键或换 venv，改 `voiceClient` 配置后**停用再启用**一次插件（重开子进程）。

**改法 A（UI，推荐日常用）**：**Plugins（插件）→ 已安装 → `dsh-chatterbox` → 点开它的页面 → 那一行 `chatterbox` 上的「配置 chatterbox」按钮 → 进入配置页**，里面就是「音色档案（出声）」下拉框。

> 这一页由本包的浏览器半侧 `src/client/index.js` 提供（注册插槽 `plugins.row.config`，键 `dsh-chatterbox#chatterbox`）。
> DSH 自带的 Plugins 页只是把这个插槽留出来，**没有**内置的自动表单——所以插件必须自带这一小块界面。
> 装上/改过 `src/client/index.js` 后需要**刷新一次页面**（F5）才会加载；之后改路径点「保存」即可。

`speakSkillPath` 与 `vadSilenceSeconds` 都是 volatile 字段：改完不用重启、不用停用插件。
路径在下一次投递时生效；停顿秒数由语音端每 0.6 秒轮询 `/voice/state` 取到，**约 1 秒内**按新值重建 VAD（日志 `free-mic: silence threshold -> 1.5s`）。

**改法 B（配置文件）**：本包 `cordis.patch.yml`（会随包层加载）：

```yaml
- insert:
    - id: chatterbox
      name: 'dsh-chatterbox'
      config:
        port: 18801
        # sessionId: session-00000000-0000-0000-0000-000000000000
        voiceProtocol: true
        # speakSkillPath: <插件>\..\voices\cb_My_Hero
        voiceClient:
          autoStart: true
          hotkey: printscreen
```

改完**停用再启用**一次插件生效（`link:` 安装不会热替换已加载模块）。

自检：

```
curl -s http://127.0.0.1:18801/health
{"ok":true,"version":"1.4.0","locked":"session-00000000-…",
 "voiceClient":{"running":true,"pid":9992,"hotkey":"printscreen", …},
 "speakSkillPath":"<插件>\\deps\\voices\\cb_Demo_CC0","voiceProfile":"Demo_CC0_ja", …}
```

`speakSkillPathLive: true` 表示这一项确实是 volatile 引用，UI 改动会即时生效；
`voiceClient.running: true` 表示语音客户端正被本插件托管着。

### 换一个声音

1. 在 `voice_train\voices\` 下新建 `cb_<角色名>\`（照 `cb_Demo_CC0` 的结构：`SKILL.md` + `voice.json` + `samples\` + `MODEL_CARD.md` + `references\`）；
2. 写这个档案的 `voice.json`（id、参考音、`post` 参数），重启语音端；
3. 插件设置页的「音色档案（出声）」下拉里选它；
3. 下一句语音投递就会按新技能念。

技能怎么用由那段 `SKILL.md` 决定，插件只把目录交给 agent。

## 2. 接口

全部在 `127.0.0.1:18801`，`Content-Type: application/json`。

| 端点 | 作用 |
|---|---|
| `GET /health` | 存活、版本、锁定会话、约定挂到哪些 agent、当前出声技能路径 |
| `GET /target` | 锁定目标与候选列表（`targetSource` 恒为 `locked`） |
| `POST /submit` | 投递一行文本：`{"text":"...", "mode":"queue\|steer", "clientTimeZone":"可选"}` |
| `POST /target` | 锁定时只接受 `{"sessionId": null}`；别的 id 返回 409 `ptt/target-locked` |
| `GET /session?id=<id>&match=<文本>` | 只读核对：消息条数、`match` 命中、最后一条文本片段、`lastAssistantHasAudio` |

成功：`{"ok":true,"sessionId":"…","requestId":"…","mode":"queue","targetSource":"locked","elapsedMs":8,"version":"1.2.0"}`

失败：`{"ok":false,"error":{"code":"…","message":"…"}}`（4xx/5xx）。
自有过错码：`ptt/empty-text`、`ptt/text-too-long`、`ptt/target-locked`、`ptt/service-unavailable`、
`ptt/unauthorized`、`ptt/bad-request`、`ptt/not-found`；宿主错误（`session/not-found`、`session/agent-busy`…）原样透传。

## 3. 投递目标：配置页下拉选择

`config.sessionId` 非空时，**每一次投递都只去这一个会话**：不看 sticky、不看活跃度、不看 workspace，
`newSession: true` 直接 409。会话冷着也能投——`prompt()` 内部会先把 agent 恢复起来。

在配置页「输出会话」下拉里换一个，保存后：

- 下一次投递立刻改投新会话（目标值每次投递前重新读取，不重载插件）；
- 语音约定从旧 agent 上摘掉、挂到新 agent 上（日志 `voice target changed -> …`、`voice protocol attached to agent …`）；
- 下拉列表由 `GET /voice/sessions` 提供：最多 50 个，排除子 agent 与会话里没有任何内容的空会话，按「活着的优先 + 最近更新」排序。

选「自动」= 清空该值，退回按最近活跃推断（sticky → 活跃度 → workspace）。

## 4. 语音会话约定（自动注入，只作用于当前输出会话的 agent）

插件在该 agent 装配时用 `agent.ctx` 注册系统提示小节 `ptt:voice-conversation`（order 50，紧跟人格之后），
**只在这个 agent 的作用域里生效**。正文格式在这里定死（2026-11-19 定案，`src/host/protocol.js`）：

```
中文译文

<日语台词> <音频链接>

---

妄想
```

1. **第一段：中文译文**——把要念的那句日语翻成中文，只写译文，不加「翻译：」之类的标签。
2. **第二段：日语原文 + 音频链接**——同一行，日文与链接之间一个空格；日语与念出去的**一字不差**，且只出现这一次。
   链接是按会话工作目录算的**相对路径** `dsh-chatterbox/out/<文件名>`（右键才有「使用默认应用打开」「另存为」），
   另加一个 `[▶ 重放](http://127.0.0.1:18801/voice/play?name=<文件名>)`。
3. **第三段：妄想**——中文单独成段，颜文字只放在段首，**永不念、永不合成**。
   （这一段由人格决定：示例预设 `my-hero` 有三段；标准人格 `deepseek` 只有两段，见 `docs/PERSONA.zh.md`。）

第二段与第三段之间固定插一行 **`---`**（Markdown 横向分隔线），用非文字元素把「念出来的话」和「妄想」分开；
分界线不写任何文字，也不换成 `***`、`___` 或「——以上——」。

**顺序也是格式的一部分**（2026-11-19 定，2.21.0 起改成「台词写进参数」）：

1. 这一轮**先调用出声技能**，把要说的日语**写进命令参数**（`speak.py -t "…"`）——台词不写进消息；
2. 从技能返回的 JSON 取 `wav` 文件名；
3. 再一次性发三段正文。

为什么这样定：模型原本会先写第一段译文、再想起要合成，于是中途调工具，聊天里就多出半条消息和一个**臆造的文件名**（它当时不可能知道文件名）。
把台词放进工具参数后，它的第一个动作就是工具调用，没有可「先写」的正文。

出问题时的判读：`chatterbox.log` 出现 `voice reply linked a missing wav (<文件名>)`，说明又在工具返回前编了文件名。

**不许出现**：序号/小标题/标签（「（1）」「语音文本：」「出声：」「妄想：」）、「原文：」与 `/`、`∧` 断句标注、
字数/时长/生成耗时汇报、「3 天内有效」「keep_ 前缀不过期」这类注记。

> 为什么以前会冒出这些：老版出声技能（`speak-asuka`，已整合进音色档案）的模板要求「汇报行 + 原文断句行 + 链接注记」，
> 和这里的约定打架。2026-11-19 已把技能改成「语音会话里只负责念，不写汇报/原文/断句」，冲突解除。

另外约定：不写思考过程；技能缺失或合成失败要如实说明原因，照样给三段；主人说「别出声」就停用语音。

若配置页的「回复长度上限（字）」> 0，日语台词还要压在该字数以内（0 = 不加这条限制）。

为什么台词是日语：本机 TTS 只支持日语，中文会被念成怪音。

## 4.5 重放（点一下就再听一遍）

回复的第二段里，音频链接后面紧跟一个 **▶ 重放** 链接：

```
<日语原文> [11-19-09-25-21.wav](http://127.0.0.1:18801/voice/audio/11-19-09-25-21.wav) [▶ 重放](http://127.0.0.1:18801/voice/play?name=11-19-09-25-21.wav)
```

点它会**直接在插件里播放**这段音频（走与正常出声相同的 `play_media.ps1`），**不会打开侧边栏或新标签页**：浏览器半侧截获了这个点击，右下角弹一个「▶ 正在重放…」的提示就结束。

> 如果插件没在运行（浏览器半侧没载入），链接会退回到打开一个极简重放页——那个页面同样会让插件播放。

- **自由麦开着时**：点重放会先暂停收音（和回复播放时的规则相同），播完再留 300ms 缓冲才恢复；
  日志里是 `free-mic paused for replay …` → `playback finished after …ms` → `free-mic re-armed (replay finished)`。
- **补静音**：补静音是在**合成时**写进 wav 的（开头 0.2s / 结尾 0.12s），所以重放同一文件天然带着它；
  改配置只影响之后新合成的音频，不会给旧文件再叠一层。
- 只接受 `out\` 下真实存在的 wav（`MM-DD-HH-MM-SS.wav` 或 `keep_*.wav`），其它名字一律 404。
- 重放页面回传状态：`POST /voice/replay {"name":"…"}` 立刻返回（播放是异步的），页面提示「播完会自动恢复收音」。

## 4.55 音频落在哪、多久清一次

- 音频写在**插件根目录的 `out\`**（`dsh-chatterbox\out`），回复里的音频链接是
  `http://127.0.0.1:18801/voice/audio/<文件名>`——由插件直接给文件，跟会话工作目录无关。
- 配置页最下面还有一个「**音频保留天数**」（默认 3）：插件每 6 小时扫一次，
  把 `out\` 里更旧的 wav 移入回收站；`keep_` 开头的不清；设 0 表示不清理。
- 手动触发一次：`curl -X POST http://127.0.0.1:18801/voice/sweep`。
- 本机 TTS 服务（127.0.0.1:8763）也由插件托管：启动时若端口已有人应答就沿用，
  否则自己拉起；插件退出时一并结束。相关配置：`ttsAutoStart` / `ttsPort` / `ttsPython`。

> 新机器安装顺序见 `docs/INSTALL.zh.md`；自己新建音色档案见 `docs/VOICE_PROFILE.zh.md`；音色文件夹放在 `<插件>\deps\voices\` 或工作区 `voices\` 会被自动发现。

**自带演示档案 `cb_Demo_CC0`**（`Demo_CC0_ja`，30 s，LibriVox《眼鏡》· Public Domain Mark 1.0）随插件放在
`<插件>\deps\voices\`：新用户装完就有可用音色，可公开分发。私人档案放工作区 `voices\`，两处都会被扫描
（同名 id 以先扫到的为准）。

## 4.58 第 2 页：依赖检查（分发排错）

设置 → **插件 → 「chatterbox 依赖」**。这一页**不会自动检测**：点「开始检测」才去查（约 3–5 秒，
含 python import 抽查与模型体积校验），再点「重新检测」刷新。

每一项显示：名称、✓/✗、体积、**路径来源**（配置 / 环境变量 / 默认）、完整路径、完整性结论、缺失提示。

**下载并安装缺失**：按 `deps/manifest.json` 从官方发布页下载 ASR 模型（int8，155 MB）、
Silero VAD（1.8 MB）、Irodori 源码，默认装到 `<插件>\deps\`（可在依赖页改）；
已存在的项自动跳过，装完自动写 `paths.json`（不会覆盖你手填的路径）并重跑检测。

venv（含 torch，5.2 GB）与 HF 权重（4.6 GB）体积太大，按钮不代跑；准确名称、官方地址与命令见
**`docs/DEPENDENCIES.zh.md`**（分发/换机器时把这份文档交给 agent 即可让它自己决定装在哪里）。

| 项 | 怎么算「完整」 |
|---|---|
| 识别用 Python（venv） | 跑一次 `python -c "import sherpa_onnx, sounddevice, soundfile, pypinyin, keyboard, numpy"`，打印出版本 |
| sherpa-onnx / pypinyin / sounddevice / soundfile | 在该 venv 的 `site-packages` 里找到对应 dist-info |
| 合成用 Python（Irodori venv） | 跑 `import torch`，打印 torch 版本与 CUDA 是否可用 |
| Irodori-TTS 源码 | 目录里存在 `irodori_tts/inference_runtime.py` |
| HF 模型缓存 | 存在 `hub/models--Aratako--Irodori-TTS-v4.1-Small` |
| ASR 模型 / tokens / VAD | 文件存在且体积不小于下限（模型 100 MB、tokens 10 KB、VAD 100 KB），过小判「疑似下载中断」 |
| 播放脚本 / 回收站脚本 | 插件自带 |

**路径在这一页手动填写**（顶部「外部依赖路径」一节，留空即用默认；保存在 `%LOCALAPPDATA%\dsh\dsh-chatterbox\paths.json`，不塞进插件配置）：

| 路径项 | 作用 | 留空时 |
|---|---|---|
| `asrPython` | 识别用的 python.exe | `%LOCALAPPDATA%\dsh\dsh-chatterbox\venv\Scripts\pythonw.exe` |
| `asrModelDir` | ASR 模型目录 | `~/.dsh/speech-to-text/sensevoice/models` |
| `ttsIrodori` | Irodori 源码目录 | `<插件>\..\irodori\Irodori-TTS-main` |
| `ttsPython` | 跑 TTS 服务的 python.exe | `<Irodori>\.venv\Scripts\python.exe` |
| `hfHome` | 模型权重缓存 | `<插件>\..\cache\hf-cache` |

优先级：**配置 → 环境变量（`CHATTERBOX_ASR_PYTHON` / `CHATTERBOX_ASR_MODELS` / `CHATTERBOX_IRODORI` /
`CHATTERBOX_TTS_PYTHON` / `CHATTERBOX_HF_HOME`）→ 默认值**；每行都会标明当前用的是哪一种。
把外部组件装在别处时，填一次配置即可——检测与运行（TTS 服务的 `--irodori` / `--hf-home`）都会跟着走。

## 4.6 替换词表（让专有名词听得对）

识别器偶尔会把专名听成同音字：`钉宫病` → `丁宫病`、`灼眼的夏娜` → `着眼的夏娜`。
设置页最下面的「替换词表（语音识别纠错）」可以自己补词：

1. 在多行输入框里写中文词，**空格或回车分隔**（例如 `钉宫病 灼眼的夏娜`）；
2. 点「添加到词表」——拼音由语音端用 pypinyin 自动生成，**不用手写拼音**；
3. 想钉死读音就写 `词=拼音`，例如 `阿倍=abai`（声调可加可不加：`ding1gong1bing4` 与 `dinggongbing` 等价）。
   音节数必须等于字数，否则整条被拒；词条里**只能是汉字**（`K-ON` 这类会被拒，请改用中文写法）；
4. 加完**下一句就生效**（语音端按文件 mtime 重读，不用重启插件）。

工作方式：识别结果先按汉字切段，算出每个字的（无声调）拼音，再拿词表里的拼音串做等长窗口匹配；
命中就把那段字符换成词表里的写法。所以 `丁宫病`、`钉工病`、`顶宫病` 都会被改回 `钉宫病`。

- 词表文件：`%LOCALAPPDATA%\dsh\dsh-chatterbox\glossary.json`（可以手动编辑，格式 `{"terms":[{"text":"钉宫病"}]}`）
- 词条上限 500 个、每条 ≤24 字；同词同拼音跳过，**同词不同拼音会更新**（改成你钉的那条）
- 列表里每个词显示成 `词=拼音`（如 `钉宫病=dinggongbing`），方便核对注音对不对；拼音是后台解析出来的，手写的和自动生成的都会显示
- 页面上**只显示最近添加的 10 个**（避免词表变长后页面臃肿），完整列表在 `glossary.json` 里
- 词条右侧的 `×` 从词表删除（误加的可以随时删）
- 只在**汉字**上匹配：日文假名、英文、数字原样保留
- 日志里每次替换会留一行 `glossary: '丁宫病' → '钉宫病'`，方便确认

## 5. 日志与排障

日志：`%LOCALAPPDATA%\dsh\dsh-chatterbox\logs\chatterbox.log`（超过 `maxLogBytes` 轮转为 `.1`）。

| 现象 | 查什么 | 处理 |
|---|---|---|
| 连不上 18801 | 日志末尾 `listen failed … EADDRINUSE` | 改 `port`（UI 或配置），停用/启用插件一次 |
| `409 ptt/target-locked` | 是否调了 `newSession` 或想钉别的会话 | 预期行为：目标已锁死，改 `sessionId` 才换会话 |
| 回复没声音 | 日志里 `submit ok` 之后那轮；`GET /health` 的 `speakSkillPath`；TTS 服务 `speak.py --status` | 档案目录不对或没有 `voice.json`：改「音色档案（出声）」 |

## 6. 停用、卸载、回滚

- **停用**：插件管理里关掉 `dsh-chatterbox`，或
  `plugin_manager { action: "set_bundle", target: "dsh-chatterbox", enabled: false }`。
  端口立即关闭、约定摘除、**语音客户端一并被杀**（按住说话随之停摆）。
- **卸载**：`plugin_manager { action: "remove_bundle", target: "dsh-chatterbox" }`（只动 profile，不删目录）。
- **改代码后**：停用再启用一次（HMR 通常会自动重载 `src/host/index.js` 并重开子进程；改 `src/client/index.js` 则要 F5 刷页面）。
- **回滚**：用上一版 `src/host/index.js`/`src/host/protocol.js`/`src/client/index.js`/`cordis.patch.yml` 覆盖回来再停用/启用。

## 7. 语音客户端（随插件分发）

语音端 **已经打包进插件**，不再依赖任何技能目录：

| 项 | 位置 |
|---|---|
| 客户端脚本 | `dsh-chatterbox\src\voice\ptt.py` |
| 独立 venv | `%LOCALAPPDATA%\dsh\dsh-chatterbox\venv`（sherpa-onnx / sounddevice / keyboard / numpy / soundfile） |
| venv 重建 | `dsh-chatterbox\tools\setup-voice-venv.ps1`（幂等，默认走清华镜像） |
| 日志 | `%LOCALAPPDATA%\dsh\dsh-chatterbox\logs\ptt.log` |
| 识别模型 | `%USERPROFILE%\.dsh\speech-to-text\sensevoice\models\sensevoice-onnx\`（DSH 自带，只读） |
| VAD 模型 | `…\models\silero\silero_vad.onnx` |

插件启动时用它拉起：`pythonw.exe src\voice\ptt.py --hotkey … --vad-silence … --parent-pid <host pid>`，
停用时 `taskkill /T /F` 连「venv 转发壳 + 真正解释器」一起收。

> 运行数据统一放在 `%LOCALAPPDATA%\dsh\dsh-chatterbox\`（venv / logs / 产物登记），
> 2026-11-18 从旧的 `voice-push-to-talk` 目录迁入。

## 8. 维护须知

- 目录布局：`src/host/index.js`（Host 插件：投递服务 + 语音客户端托管 + 约定注入）、`src/host/protocol.js`（注入给会话的约定文本，`{{skill}}` 会被替换）、
  `src/client/index.js`（浏览器半侧：`plugins.row.config` 里的路径输入框）、`cordis.patch.yml`（默认配置）、
  `locale/*.json`（显示名与描述）、`docs/`（详情页图片）、`node_modules/`（`@deepseek-ai/schemastery`，Config schema 用）。
- 原独立的 ptt-daemon 插件已于 2026-11-18 合并进本插件（`startVoiceClient` / `stopVoiceClient`），
  它的目录连同 bundle 一起去掉了；日志也合并到 `chatterbox.log`。
- `src/client/index.js` 必须是 DSH 客户端模块系统的 lazy-CJS 形态：`window.__ModuleLoader__.load({ id, factory })`，
  factory 里 `return load("client/index.js")`，入口模块导出 `name` / `inject` / `apply`。改完按 F5 刷页面才生效。
- 依赖 `@deepseek-ai/schemastery@3.19.0` 是必需项：没有它就导出不了 `Config`，也就没有可写的表单值。
  升级 DSH 后如报 `ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`，在插件目录重装同版本即可：
  `node <DSH 内置 pnpm> add @deepseek-ai/schemastery@3.19.0`
- 每轮协议由 `agent.ctx` 上的动态 `text()` 提供，所以改路径、换技能不需要重启。

## 9. 已知限制

- 台词只能是日语（当前声卡 TTS 限制）；妄想与说明是中文，不发声。
- 端口只绑 `127.0.0.1` 但默认无鉴权；需要收紧就设 `token`。
- 约定是系统提示层的一段文字，模型仍可能偶尔多说一句；跑偏就停用/启用插件重新装配。
- 音频按出声技能的规则 3 天内有效（`keep_` 前缀不过期）。

## 10. 自由麦克风（输入框上的总控开关）

位置：**输入框左侧工具行、Computer Use 按钮右边**。样式是「小圆点 + 麦克风图标 + 自由麦克风」，**默认关**。

| 状态 | 圆点 | 含义 |
|---|---|---|
| 关 | 灰，常亮 | 按住热键说话，行为和以前完全一样 |
| 开、在听 | **绿／深绿，每 0.8 秒互换一次**（硬切，不做渐变） | 持续收音；静默达到「投送延迟」就切成一句话，自动识别并投递 |
| 开、暂停 | 绿，常亮但压暗到 40% | 已投递的那一轮还在思考/回复/出声，暂时不听 |

两种绿交替是提醒你别忘了关；深绿用 `color-mix` 从主题绿压暗，浅色/深色主题都看得清。
系统打开「减少动态效果」时退化成常亮绿点（不交替）。

**空闲自动关**：连续 `freeMicIdleMinutes`（默认 **30** 分钟）没有任何一次收音（= 没有一次成功投递的语音），
总控开关会自动关掉、圆点回到灰色，日志写 `free-mic auto-off`。计时从「打开开关」或「上一次投递」起算，
暂停等回复的时间也算空闲。

点击即开/关，状态存在 Host 里（刷新页面不会丢，DSH 重启回到默认关）。

### 一轮的完整顺序

1. 持续收音，silero VAD 判定人声；
2. 静默达到「投送延迟」（即 `vad-silence`，默认 2.0 秒，范围 0.3–600、最多 1 位小数）→ 这一句结束；
3. 立刻停止收音（音频不再进队列），走与按键完全相同的流程：去首尾静音 → 门限 → SenseVoice 识别 → `POST /submit`；
4. Host 把它标记为 `paused`，语音端从下一次轮询起不再收音；
5. 等该会话**这一轮彻底结束**（`turn/end`）**并且回复里的音频播放完**，Host 才解除 `paused`；
6. 语音端重新开始收音，回到第 1 步。

第 5 步是「非本机输出」的关键：回复本身是 TTS 念出来的，提前开麦就会把自己的声音当成你说的话。
Host 的做法是：`turn/end` 之后去 `audioDir`（默认插件根目录的 `out\`）找本轮最新生成的 wav，读文件头（采样率/声道/位深）算出播放时长，
取 `文件时间 + 时长 + 0.8 秒` 与 `现在 + 1.2 秒` 里更晚的那个作为解除时刻。

### 状态接口

```
GET  /voice/state                → {"ok":true,"enabled":true,"paused":false,"mode":"free",...}
POST /voice/free-mic {"enabled":true|false}
```

按钮就是靠这两个接口工作（浏览器直接访问 `127.0.0.1:18801`，插件已开 CORS）。
语音端每 0.6 秒轮询一次 `/voice/state`：`enabled=false` 时它就是原来的按键模式，`paused=true` 期间直接丢弃音频、不排队、不留存。

### 相关配置与参数

| 项 | 默认 | 说明 |
|---|---|---|
| `audioDir`（插件配置） | `dsh-chatterbox\out` | 找回复音频用；换目录时改这里 |
| `freeMicIdleMinutes`（插件配置） | `30` | 空闲多久自动关掉总控开关；调成 `1` 可以做短测 |
| `--vad-silence`（ptt.py） | `2.0` | 启动时的初始值（0.3–600）；**运行中以配置页「投送延迟」为准**，改了不用重启 |
| `--vad-threshold`（ptt.py） | `0.5` | silero VAD 语音判定阈值，环境吵就调高 |
| `--no-free-mic`（ptt.py） | 关 | 只保留按键说话，排障用 |

### 排查：开关是绿的但没反应

语音端会把每一步写进 `ptt.log`（`%LOCALAPPDATA%\dsh\dsh-chatterbox\logs\ptt.log`），按顺序看这几行：

| 日志 | 含义 |
|---|---|
| `free-mic: VAD ready in 0.02s` | 启动时就把 VAD 建好（旧版本是第一次开关时才建，可能卡住一两分钟） |
| `free-mic: host says on` / `off` / `on + paused` | 这一侧确实收到了开关的每一次变化 |
| `free-mic: listening (silence>2s)` / `listening stopped` | 麦克风真的开/关了 |
| `free-mic: tick failed:` + traceback | 控制器内部异常（以前在 pythonw 下会被静默吞掉） |

Host 侧 `GET /voice/state` 里的 `clientListening` 是语音端回报的“我真的在收音”，
开关打开但它为 `false` 时，按钮的悬浮提示会写「语音端还没开始收音」——这时先看 `ptt.log`。

另外：所有 `127.0.0.1` 的调用都绕开系统代理（`HTTP_PROXY`/Clash），因为本机回环走代理只会更慢或者超时。

自由麦克风开着时，热键会被忽略（日志里写 `hotkey ignored`），再点一次开关回到按键模式。

## 10.5 语音命令：说「关闭自由麦克风」就自己关掉

自由麦克风开着时，这句话**不会被投进会话**，而是由插件直接把开关关掉
（`ptt.log` 记 `voice command matched — free microphone turned OFF by the plugin`，Host 记 `free-mic off`）。

判定有两个硬条件，缺一不可：

1. **完整出现「自由麦克风」这 5 个字**（设备名不做同义扩展：`自由麦`、`麦克风`、`收音`、`语音输入`、`录音` 都不算）；
2. **出现一个关闭词**：关闭 / 关掉 / 关了 / 关上 / 停用 / 停止 / 退出 / 收起。

| 算 | 不算 |
|---|---|
| 关闭自由麦克风 | 关掉自由麦（设备名不全） |
| 关掉自由麦克风。 | 把麦克风关了（没这 5 个字） |
| 请帮我关闭自由麦克风 | 停止收音 / 关闭语音输入（设备名不对） |
| 自由麦克风关了 | 自由麦克风（只有设备名，没有动作） |
| | 别听了 / 不用听了 / 别录了（没设备名） |
| | 今天自由麦克风有点小声（有设备名，没关闭词） |

另外：带疑问/否定语气的句子（吗 / 么 / 是不是 / 有没有 / 没有 / 没 / 怎么 / 为什么 / 要不要 / 能不能 / 会不会）
和超过 24 字的长句，一律不算——宁可漏判也不误判。

这是刻意做的**防呆设计**：设备名只认这 5 个字，闲聊里说「麦克风」之类不会被当成命令。

排障：`ptt.log` 里有 `→ asr … → '原文'`，看它到底听到了什么；也可以直接测匹配器：

```powershell
& "%LOCALAPPDATA%\dsh\dsh-chatterbox\venv\Scripts\python.exe" "<插件>\src\voice\ptt.py" --test-command "关闭自由麦克风"
```

## 11. 已知限制（自由麦克风）

- 暂停期间麦克风**设备**仍保持打开（避免每次重开 50–150 ms 的延迟），但音频不排队、不进 VAD、不留存——所以不会录到任何东西；
- 只挡「本插件自己这一轮的 TTS」。同时播放音乐/视频时，那些人声仍会被当成输入；要避免请用耳机或暂停播放；
- `audioDir` 里找不到本轮 wav 时（例如 TTS 失败），按固定 1.2 秒的宽限恢复收音；
- 空闲计时只认「成功投递的语音」。说话但没被识别出文字（太轻、被 VAD 判成噪声）不会重置计时，
  所以极端情况下可能聊着聊着被自动关掉——点一下开关就回来了。
