# 自己做一个音色档案（开发指引）

面向**第一次上手**的用户：给插件加一个新的说话声音。不训练、不改模型——**音色由参考音决定**，
你只要准备一段干净的参考音，并按约定建好一个文件夹。

> 已装好的两个现成档案、以及公开演示档案 `cb_Demo_CC0`，都可以照抄结构。
> 本文末尾有验收清单，做完照着跑一遍即可。

---

## 1. 一个音色档案长什么样

一个目录就是一个档案，**五个条目缺一不可**：

```
<插件>\deps\voices\cb_<角色>\
├─ SKILL.md                          怎么念：完整命令、念什么、边界、汇报格式
├─ voice.json                        机器可读：id、参考音、post 参数（无 BOM）
├─ MODEL_CARD.md                     人读的说明书：参考音来源、推理参数、禁则、许可
├─ samples\<档案id>_sample.wav       唯一参考音（3–45 秒，44.1 kHz 单声道）
└─ references\
   ├─ usage.md                       参数表
   ├─ boundaries.md                  限制与禁则
   └─ troubleshooting.md             排障
```

**放哪里**：`<插件>\deps\voices\cb_<角色>\`（推荐，随插件走）；
也可以放工作区 `voices\cb_<角色>\`。插件按 `deps\voices` → `..\voices` 的顺序扫描 `cb_*`，
同 id 以先扫描到的为准。放好后**不用填路径**，配置页下拉会自动出现。

**id 命名**：`<角色罗马字>_<语言>`，例如 `My_Hero_ja`、`Demo_CC0_ja`；只允许罗马字/数字/下划线，不带个人标签或私人后缀。
id 一旦定下就别改——插件配置、历史回复里的音频链接都引用它。

---

## 2. 准备参考音（最关键的一步）

| 要求 | 说明 |
|---|---|
| 时长 | **3–45 秒**即可；再长几乎不改变输出（实测 MFCC 余弦 0.9998–0.9999、f0 跨度差 7.5 Hz） |
| 采样率 | 44.1 kHz、单声道、16-bit PCM |
| 内容 | 净语音：**无 BGM、无音效、无第二说话人**；同一场景、同一语速 |
| 处理 | 只允许**裁剪**与「去首尾静音」；不要降噪以外的加工，**不做变调/变速/均衡** |

### 2.1 从一段录音里剪出参考音

装了 Irodori venv 就一定有的 `soundfile` 足够（无需 ffmpeg）：

```powershell
$py = "<插件>\..\irodori\Irodori-TTS-main\.venv\Scripts\python.exe"
& $py - <<'PY'
import soundfile as sf, numpy as np, sys
src, out, start, seconds = "源录音.mp3", "ref.wav", 12.0, 30.0
d, sr = sf.read(src, dtype='float32', always_2d=True)
mono = d.mean(axis=1)
a = int(start * sr); b = a + int(seconds * sr)
clip = mono[a:b]
# 去首尾静音（阈值 −45 dB，最多各裁 0.6 秒）
hop = int(sr * 0.01); n = len(clip) // hop
r = np.array([np.sqrt(clip[i*hop:(i+1)*hop].dot(clip[i*hop:(i+1)*hop]) / hop) for i in range(n)])
loud = np.where(20*np.log10(r + 1e-9) > -45)[0]
if len(loud):
    clip = clip[max(0, loud[0]*hop - int(0.05*sr)): min(len(clip), (loud[-1]+1)*hop + int(0.15*sr))]
sf.write(out, clip, sr, subtype='PCM_16')
print('wrote', out, '%.2f s' % (len(clip)/sr), 'peak %.1f dBFS' % (20*np.log10(np.abs(clip).max()+1e-9)))
PY
```

挑片段的小技巧：先用 0.1 秒窗口算一遍 RMS，选「静音占比最低」的 30 秒窗口；目标峰值约 −6 dBFS。

### 2.2 授权（分发前必看）

| 用途 | 允许的来源 |
|---|---|
| 只在本机用 | 你自购素材、自己的录音都行（不外传） |
| 要公开分发 | 只能用**公有领域 / CC0**（例如 LibriVox 录音、Mozilla Common Voice 的 ja 数据）；JSUT 这类「研究用」素材**不行** |

`MODEL_CARD.md` 里必须写清来源、许可与片段位置。

---

## 3. 建文件夹

```powershell
$id = "My_Hero_ja"; $name = "My_Hero"
$dir = "<插件>\deps\voices\cb_$name"
New-Item -ItemType Directory -Force "$dir\samples", "$dir\references" | Out-Null
Copy-Item "<插件>\deps\voices\cb_Demo_CC0\SKILL.md"          "$dir\SKILL.md"
Copy-Item "<插件>\deps\voices\cb_Demo_CC0\voice.json"        "$dir\voice.json"
Copy-Item "<插件>\deps\voices\cb_Demo_CC0\MODEL_CARD.md"     "$dir\MODEL_CARD.md"
Copy-Item "<插件>\deps\voices\cb_Demo_CC0\references\*"      "$dir\references\"
Copy-Item ".\ref.wav" "$dir\samples\${id}_sample.wav"
```

然后用编辑器逐个改内容（不要用 PowerShell 改 UTF-8 源码，容易坏）。

---

## 4. 写 `voice.json`

**无 BOM**，UTF-8。模板：

```json
{
  "schema": 1,
  "plugin": "dsh-chatterbox",
  "folder": "cb_My_Hero",
  "profile": "My_Hero_ja",
  "display": "マイヒーロー",
  "names": { "zh-Hans": "我的英雄", "ja": "マイヒーロー" },
  "cv": "（声优/朗读者，可留空）",
  "work": "（出处，可留空）",
  "ref": "samples/My_Hero_ja_sample.wav",
  "ref_seconds": 30.0,
  "ref_sample_rate": 44100,
  "description": "（日语一句话描述音色）",
  "description_zh": "（中文一句话描述）",
  "notes": "参考音来源与许可说明",
  "skill": "SKILL.md",
  "model_card": "MODEL_CARD.md",
  "speak_py": "<插件>\\src\\tts\\speak.py",
  "python": "<Irodori venv>\\Scripts\\python.exe",
  "post": {
    "breaths": "long",
    "breath_min_pause": 0.6,
    "leading_breath": true,
    "keep_pause": 0.75,
    "keep_pause_short": 0.5,
    "short_line_s": 12,
    "mute_pause": 0.5,
    "topic_pause": 0.73,
    "mute_db": -18,
    "ramp_s": 0.06,
    "lead_in_s": 0.2,
    "tail_s": 0.12
  },
  "created": "2026-11-21"
}
```

| 字段 | 注意 |
|---|---|
| `profile` | 全局唯一，命令里 `--profile` 用它 |
| `ref` | **相对本目录**（`samples/...`），不要写绝对路径 |
| `post` | 直接抄上面的值——停顿与换气是全局定稿，不要为新档案另调 |
| `speak_py` / `python` | 机器相关，只有这两处允许绝对路径；换机器时改这两行 |

---

## 5. 写 `SKILL.md`

这是 **agent 用 read 工具读的说明书**（不是 DSH 技能）。必须包含：

1. 标题与档案名、id、参考音（文件名 + 秒数）；
2. 触发词：「念出来」「念一下」「用这个声音说」；
3. **完整命令**（每条都带 `--profile My_Hero_ja`）：

   ```powershell
   & "<Irodori venv python>" "<插件>\src\tts\speak.py" -t "読む文" --profile My_Hero_ja
   ```

4. 边界：只念日语、不改写、不做后期、单段 ≤30 秒；
5. 汇报格式：两样（日语原文 + 音频链接）。

可直接复用 `cb_Demo_CC0\SKILL.md` 的骨架，替换 id、`$P`、参考音与出处即可。

---

## 6. 写 `MODEL_CARD.md` 与 `references\`

- `MODEL_CARD.md`：参考音表格（来源 / 文件 / 取样区间 / 许可 / 处理方式 / 落点）、推理参数、禁则、已知限制；
- `references\usage.md`：参数表（`--no-play` `--sync` `--name` `--smile` `--caption` `--breaths` `--raw` `--keep`）；
- `references\boundaries.md`：不可为之事（变调、冒充真人、商业宣称）；
- `references\troubleshooting.md`：常见故障与处理。

这三份可以直接从 `cb_Demo_CC0\references\` 抄，改标题与档案名。

---

## 7. 让服务认出来

```powershell
$py  = "<Irodori venv>\Scripts\python.exe"
$say = "<插件>\src\tts\speak.py"

& $py $say --list                 # 新 id 是否出现（带 * 的是默认档案）
& $py $say --stop                 # 常驻服务会缓存档案列表：改完 restart 一次
& $py $say --start                # 重新装载（约 12–17 秒）
& $py $say -t "おはようございます。" --profile My_Hero_ja --no-play   # 只生成不播
```

`--no-play` 返回的 JSON 里检查 `profile` 是新 id、`audio_s` 大于 0、`wav` 落在 `<插件>\out\`。

听感确认：加上 `--play` 或直接打开 `out\<时间>.wav`。如果听着不像参考音，先换参考音，
**不要**去调 `post` 或加后期。

---

## 8. 在插件里选中它

设置 → 插件 → **音色档案（出声）** → 选 `My_Hero_ja` → 保存。
选完可以：

```bash
curl -s http://127.0.0.1:18801/voice/profiles   # items 里应有新档案，current 是它
```

之后在任何会话里说「念出来」，默认就用这个音色；语音会话里的回复也会用它出声。

---

## 9. 验收清单

- [ ] 五个条目齐全，`voice.json` 的 `folder` / `profile` 与目录名、id 一致
- [ ] `ref` 指向本目录 `samples\` 且文件存在，3–45 秒、44.1 kHz、单声道
- [ ] `voice.json` 是**无 BOM** UTF-8（有 BOM 时服务会跳过或回退默认档案）
- [ ] `speak.py --list` 能看到新 id；`--profile` 合成返回正确 `profile`、`audio_s > 0`
- [ ] 配置页下拉能选中并保存；`/voice/profiles` 的 `current` 是它
- [ ] `node tests/check-mappings.mjs --offline` 全过（会校验每个 `cb_*` 的必备文件）
- [ ] `MODEL_CARD.md` 写清来源与许可（要公开分发时必须是 PD/CC0）

---

## 10. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 下拉里没有新档案 | 目录名不以 `cb_` 开头，或缺 `voice.json.profile` | 改名 / 补字段，再 `--stop` `--start` |
| 选了没换声 | 没带 `--profile`，走了默认档案 | 每条命令都带 `--profile <id>` |
| 声音不对、发闷 | 参考音本身有 BGM/噪声，或太短 | 换一段干净、同说话人的 30 秒左右 |
| 日志报 `bad voice.json` | 写成了带 BOM 或 JSON 语法错 | 用编辑器另存为 UTF-8 无 BOM，`python -m json.tool` 验证 |
| 控制台打印乱码/报错 | Windows 控制台是 GBK | 插件已把输出改成 UTF-8；自己写脚本时加 `PYTHONIOENCODING=utf-8` |
| 换了参考音没变声 | 服务没重启，缓存里还是旧档案 | `speak.py --stop` 后重新合成 |
| 搬机器后全部报错 | venv 里是绝对路径 | 删 `.venv` → `uv sync --extra cu128 --frozen`，再改 `voice.json` 的 `python` |

---

## 11. 能不能分发？

| 内容 | 能不能进公开仓库 |
|---|---|
| 公有领域 / CC0 参考音做的档案（如 `cb_Demo_CC0`） | ✅ 可以，`MODEL_CARD.md` 保留许可说明 |
| 自购素材 / 声优商业录音 | ❌ 只限本机私用，发布前移出 `deps\voices` |
| 伪造真人身份、商用宣称 | ❌ 禁止 |

自购素材与声优商业录音请勿随插件公开分发。
