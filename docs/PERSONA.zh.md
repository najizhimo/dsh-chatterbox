# 助手人格（persona）移植指南

这份文档说明**两件容易被混为一谈的事**，以及怎么把自己的 agent 角色接进来：

1. **谁在说话** —— 由 DSH 的 **agent 预设**（preset）决定：性格、称呼、语气、妄想癖好都在预设的
   persona 插件里。预设由 DSH 的 bundle 提供（例如示例里的 `my-hero`）。
2. **怎么排版** —— 由插件的 **persona JSON** 决定：几段正文、每段标签、哪段朗读。**不含角色性格。**

插件**只读预设的 id 与元数据**（`agentPresets.list()` / `session.header.agentPreset`），不复制预设正文；
角色的实际文字始终只有一份，在预设里。

---

## 1. 四层职责

| 层 | 放在哪 | 谁维护 | 决定什么 |
|---|---|---|---|
| **机制** | 插件 `src/host/protocol.js` | 插件作者 | 先调 TTS 再发消息、相对路径、非朗读段永不合成、单段 ≤30 s |
| **agent 预设** | DSH 预设（YAML bundle，如 `my-hero` / `standard`） | 用户 | **性格、称呼、口癖、妄想**——回复里「是谁在说」 |
| **回复格式（persona）** | `<插件>\personas\*.json`（**唯一目录**） | 用户 | 段落数、每段标签、哪段朗读、分隔线 |
| **本机偏好** | `~\.dsh\AGENTS.md` | 用户 | 「称呼主人」这类与人格重叠的个人约定（可留可不留） |

配置页里是两个下拉，顺序固定：

```
音色档案（出声）      ← voices\cb_*（声音）
回答用的 agent（预设） ← DSH 预设注册表（性格）   ← 例如选 my-hero；新装默认「跟随目标会话」
回复格式（persona）    ← 段落排版（默认「跟随 agent 预设」）
输出会话 …
```

**绑定规则**：`回复格式` 留空时，插件找 `personas/<预设 id>.json`；找到就用它，找不到用 `deepseek`（两段）。
所以选了 `my-hero` 预设，就自动得到 `personas/my-hero.json` 的三段排版；选了 `standard` 就是两段。

**预设什么时候生效**：插件只在**新建**语音会话时把预设写进 `agentPreset`（`sessionController.create({agentPreset})`）。
已经存在的会话不会被改；配置页只做「显示目标会话当前用的预设 + 你选的是哪个」。
想给已有会话换预设，请在新会话里进行（或在该会话的 DSH 界面里换），不要指望插件改写历史。

---

## 2. 文件格式

```json
{
  "schema": 1,
  "id": "my-hero",
  "display": "示例角色（my-hero 预设）",
  "address": "主人",
  "note": "人读的备注，插件不用",
  "segments": [
    { "id": "translation", "label": "中文译文", "spoken": false,
      "instruction": "把要念的那句日语翻译成中文，只写译文，不加引号、不加「翻译：」。" },
    { "id": "original", "label": "日语原文", "spoken": true, "audio": true },
    { "id": "delusion", "label": "妄想", "spoken": false, "dividerBefore": true,
      "instruction": "中文单独成段，颜文字只放在段首，段尾一律不加。" }
  ]
}
```

| 字段 | 必填 | 作用 |
|---|---|---|
| `id` | 是 | 配置页下拉里显示的值；文件名不同名也可以，但建议一致 |
| `display` | 否 | 下拉里的名字 |
| `preset` | 否 | 绑定的 agent 预设 id（`my-hero` / `standard`）。回复格式留空时按它自动匹配 |
| `private` | 否 | `true` = 私有文件，发布前删除（不影响本机使用，下拉会标注） |
| `address` | 否 | 称呼用户的名词（`主人` / `你`）。留空 = 用「用户」 |
| `segments[].id` | 否 | 自由标识，插件不用 |
| `segments[].label` | 是 | 段落标签，会写进「第 N 段：<label>——…」 |
| `segments[].instruction` | 否 | 这一段额外怎么写（照抄进协议） |
| `segments[].spoken` | 是 | `true` = 会被合成成音频；`false` = **只出文字、永不念** |
| `segments[].audio` | 是 | 恰好一段为 `true`：该段带 `[wav](相对路径)` 与 `[▶ 重放]` 链接 |
| `segments[].dividerBefore` | 否 | 这一段前面插一行 `---`（Markdown 分隔线） |

硬规则（协议里自动生成，不用写在 persona 里）：

- **有且只有一段 `audio: true`**，且它必须是 `spoken: true`——链接跟着朗读走；
- `spoken: false` 的段永远只出文字，**任何人格都一样**（「不念妄想」属于机制，不需要每个角色自己声明）；
- 段落顺序就是回复顺序；段数会写进「一次性把下面 N 段发出去」「N 段照给」等文案。

---

## 3. 从现有 agent 移植（五步）

### 第一步：盘点现状里「角色专属」的字句

在插件里搜角色名、称呼、专属段落名：

```bash
grep -rn "示例角色\|妄想\|主人" "<插件>\src" "<插件>\docs" "<插件>\locale"
```

把命中的地方分成两类：

- **会进模型上下文的**（`protocol.js`、`globalVoiceRule`）→ 必须变成 persona 字段；
- **只是注释/文档**（`cordis.patch.yml`、README）→ 改成中性措辞。

### 第二步：确认预设 id，再写 persona 文件

```bash
curl -s http://127.0.0.1:18801/voice/presets | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).items.map(i=>i.id+' '+(i.name||'')).join('\n')))"
curl -s http://127.0.0.1:18801/voice/sessions      # 目标会话；再用 /voice/presets 看 targetPreset
```

文件名用 `<预设 id>.json`（例如 `my-hero.json`），`preset` 字段写同一个 id。

写在 `<插件>\personas\<预设 id>.json`（例：`<插件>\personas\my-hero.json`），照 §2 的字段填，
并加上 `"private": true` 标注它不随公开发布。

### 第三步：在配置页选中它

设置 → 插件 → **助手人格（persona）** → 选 `my-hero` → 保存。
（这个下拉就在「音色档案（出声）」下面；选项来自两个 persona 目录。）

### 第四步：预览并比对

```bash
# 看当前生效的
curl -s http://127.0.0.1:18801/voice/protocol | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).text))"

# 只看某个人格的效果（不改配置）
curl -s "http://127.0.0.1:18801/voice/protocol?persona=my-hero" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).text))"
```

检查四件事：

1. 「一次性把下面 **N** 段发出去」的 N 对不对；
2. 每段标签、以及 `---` 出现在第几段之前；
3. `spoken: false` 的段后面有没有「这段只写在文字里，永不念、永不合成」；
4. 称呼用的是 `address`（没填则是「用户」）。

### 第五步：同步本机偏好（可选）

`~\.dsh\AGENTS.md` 里如果写了「三段回复」「不念妄想」这类**格式**约定，改成「按插件注入的段落格式」，
只保留性格与称呼。否则人格声明两段、AGENTS 还要求三段，模型会纠结。

---

## 4. 验收清单

| 检查 | 命令 / 位置 | 期望 |
|---|---|---|
| 预设被读到 | `curl -s http://127.0.0.1:18801/voice/presets` | `available:true`，列表里有 `my-hero`/`standard`，`targetPreset` 是目标会话实际用的 |
| 人格被识别 | `curl -s http://127.0.0.1:18801/voice/personas` | 列表里有你的 id，`source` 是「本机」 |
| 配置生效 | `curl -s http://127.0.0.1:18801/voice/protocol` | `persona` 字段 = 你选的 id |
| 段数与标签 | 同上的 `text` | 与 persona 一致 |
| 朗读行为 | 实际说一句 | 只有 `audio` 段被念，其余只出文字 |
| 全套自检 | `node tests/check-mappings.mjs --offline` | 全过 |

---

## 5. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 下拉里没有新人格 | 文件名不是 `.json`，或 JSON 解析失败 | 看 `<插件>\logs\chatterbox.log` 里的 `persona unreadable` |
| 选了没变 | 保存没成功，或 id 写错 | `/voice/protocol` 的 `preset` / `persona` 是否变成新值 |
| 排版和预设对不上 | 没有同名 persona 文件 | 建 `personas/<预设 id>.json`，或在「回复格式」里显式选一个 |
| 段落数不对 | `segments` 为空数组 | 空数组会回落到默认两段 |
| 没有音频链接 | 没有 `audio: true` 的段 | 必须恰好一段 |
| 出现了两处 `---` | 多个段都写了 `dividerBefore` | 只保留最后一个非朗读段那一个 |
| 角色名进了公开发布包 | 私有 persona 没标 `private` | 见 §7 的发布前清单 |

---

## 6. 分发注意事项

- 插件包**只应带** `personas\deepseek.json`（中性、两段、无称呼）；
- 私有 persona 就放在同一个目录里，用 `"private": true` 标好，发布前删掉即可——
  **不需要**为了隔离而发明第二个目录或环境变量；
- 音色档案同理：公有领域的 `cb_Demo_CC0` 随包，版权素材留在工作区 `voices\`；
- 发布前想清理私有件的细节，属内部流程，不在本文展开。

