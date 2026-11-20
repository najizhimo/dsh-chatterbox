// Voice conversation protocol injected into the locked Session's agent.
//
// Written as an array of lines so that backticks and backslashes stay literal.
// `{{skill}}` is replaced with the configured 出声 skill directory at assembly
// time, so changing the path in the plugin settings takes effect on the next
// turn without reloading the plugin.
//
// The mechanical part of the reply shape is fixed (2026-11-19): the first block
// is the Chinese translation, the second is the Japanese line with the audio
// link, then a `---` rule, and the optional last block is whatever the persona
// declares. The number of blocks, their labels and whether a block is spoken
// come from a persona file (`personas/*.json`) — see docs/PERSONA.zh.md.
//
// Ordering matters as much as the shape: the model used to answer in text (with
// a GUESSED wav name) and only then call the skill, so the chat showed two
// messages and two audio cards. The procedure therefore comes FIRST, before any
// description of the format.

/** Legacy name kept for older configs; empty means "no built-in fallback". */
export const DEFAULT_VOICE_FOLDER = ''
/** Backwards-compatible alias (older configs and docs used this name). */
export const DEFAULT_SKILL_PATH = DEFAULT_VOICE_FOLDER

/** Legacy name kept for older configs; empty means "discover at runtime". */
export const DEFAULT_VOICES_DIR = ''

/** The persona used when nothing is configured: neutral, two blocks. */
export const DEFAULT_PERSONA_ID = 'deepseek'

/**
 * Fallback persona. Mirrors personas/deepseek.json so the plugin still produces
 * a sane protocol when the file is missing.
 */
const FALLBACK_PERSONA = {
  id: DEFAULT_PERSONA_ID,
  display: 'DeepSeek（标准）',
  address: '',
  segments: [
    {
      id: 'translation',
      label: '中文译文',
      spoken: false,
      instruction: '把要念的那句日语翻译成中文，只写译文，不加引号、不加「翻译：」。',
    },
    { id: 'original', label: '日语原文', spoken: true, audio: true },
  ],
}

const CN_NUM = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十']
const countWord = (value) => CN_NUM[value] ?? String(value)

/**
 * Coerce a persona file into the shape the protocol needs.
 * @param persona - parsed persona JSON (may be null).
 */
export function normalizePersona(persona) {
  const source = persona !== null && typeof persona === 'object' ? persona : {}
  const segments = Array.isArray(source.segments) ? source.segments.filter((entry) => entry !== null && typeof entry === 'object') : []
  return {
    id: typeof source.id === 'string' && source.id.length > 0 ? source.id : DEFAULT_PERSONA_ID,
    display: typeof source.display === 'string' ? source.display : '',
    address: typeof source.address === 'string' ? source.address : '',
    segments: segments.length > 0 ? segments.map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : '',
      label: typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : '正文',
      instruction: typeof entry.instruction === 'string' ? entry.instruction : '',
      spoken: entry.spoken === true,
      audio: entry.audio === true,
      dividerBefore: entry.dividerBefore === true,
    })) : FALLBACK_PERSONA.segments,
  }
}

const DIVIDER_TEMPLATE = (before, after) => '第' + before + '段与第' + after + '段之间插一行 `---`（Markdown 分隔线）当分界：'
  + '那一行只有 `---`，不带任何文字，也不要换成「***」「___」「——以上——」。'

/**
 * Turn the persona's segment list into the "第 N 段：…" block.
 * @param persona - normalized persona.
 */
function segmentBlock(persona) {
  const lines = []
  let divider = ''
  persona.segments.forEach((segment, index) => {
    const nth = index + 1
    if (segment.dividerBefore) {
      divider = DIVIDER_TEMPLATE(nth - 1, nth)
      lines.push(divider)
      lines.push('')
    }
    if (segment.audio) {
      lines.push('第' + nth + '段：日语原文 + 一个空格 + markdown 链接 + 一个空格 + 重放链接，写在同一行，形如：')
      lines.push('　<日语原文> [<wav 文件名>]({{out_dir}}/<wav 文件名>) [▶ 重放]({{ingest}}/voice/play?name=<wav 文件名>)')
      lines.push('　两个链接都用 speech 返回的文件名。文件链接**必须**是按会话工作目录算的相对路径 `{{out_dir}}/<文件名>`（不要贴 speak.py 返回的绝对路径）——相对路径右键才有「使用默认应用打开」「另存为」；重放链接是 {{ingest}}/voice/play?name=<文件名>，点它直接重播，自由麦开着时会自动暂停收音。'
        + String.fromCharCode(10) + '　**两个链接缺一不可**：只有文件链接、没有 ▶ 重放链接，就算格式错误。'
        + String.fromCharCode(10) + '　日语必须与念出去的一字不差，且只在第' + nth + '段出现一次。')
      return
    }
    const parts = ['第' + nth + '段：' + segment.label]
    if (segment.instruction !== '') parts.push('——' + segment.instruction)
    if (segment.spoken !== true && !parts.join('').includes('永不念')) parts.push('这段只写在文字里，永不念、永不合成。')
    lines.push(parts.join(''))
  })
  return { text: lines.join(String.fromCharCode(10)), count: persona.segments.length, divider }
}

const LINES = [
  '【语音会话·出声约定】这是一场语音闲聊，{{user}}的每条消息都是说话识别来的。你每轮都要**用声音回答**，而且**整轮只发一条消息**。',
  '{{persona}}',
  '',
  '每一轮严格按三步走，不许颠倒、不许多出一步：',
  '1. **先调工具，台词写在参数里**：把这一轮要说的日语**直接写进 TTS 命令参数**（speak.py 的 -t），并且**带上 `--profile {{profile}}`**（音色档案 {{voice}}；本会话就用这一个，{{user}}没**明确点名**别的角色时不要换）。先读 `{{skill}}\\SKILL.md` 拿到完整命令（用 read 工具，它不再是 DSH 技能）。默认就会播，除非{{user}}说留，否则不加 --keep。台词写进参数，不要写进消息——这一步之前不要输出任何正文，一个字的正文都不要。',
  '2. **取文件名**：从技能返回的 JSON 里取 `wav` 字段，那就是音频文件名——只能用这个名字，绝不能自己编时间戳、日期或文件名。',
  '3. **发一条**：拿到文件名后，一次性把下面{{segcount}}段发出去（只发这一条）。',
  '',
  '{{segments}}',
  '',
  '**禁止**：',
  '· 在技能返回之前输出任何文字，尤其是 `.wav` 链接。那时你不可能知道文件名，写出来必然是坏链接，{{user}}会看到两张音频卡。哪怕只想先纠正{{user}}念错的词，也先调工具。',
  '· 把补充说明另发一条消息：并进第{{lastseg}}段写。{{user}}只要一份{{segcount}}段回复。',
  '· 序号或小标题（「（1）」「语音文本：」「原文：」）、`/` 与 `∧` 断句标注、字数/时长/生成耗时汇报、「3 天内有效」「keep_ 前缀不过期」这类注记。' + String.fromCharCode(10) + '· 第{{audioseg}}段只给一个链接——文件链接和 ▶ 重放链接都要有。',
  '· 照抄历史里「先发一段中文 + 链接、再补{{segcount}}段」的旧消息——那是早期版本的错误，不要学。',
  '',
  '{{user}}说「别出声」「只打字」时停用语音，等他说恢复。技能缺失或合成失败要如实说明原因，{{segcount}}段照给，不许假装念过。',
]

/**
 * Substitute the voice placeholders.
 * @param text - template text.
 * @param voice - { folder, profile, display, python, script } resolved from voice.json.
 */
export function fillVoice(text, voice) {
  const folder = typeof voice?.folder === 'string' && voice.folder.trim().length > 0
    ? voice.folder.trim()
    : DEFAULT_VOICE_FOLDER
  return String(text)
    .split('{{skill}}').join(folder)
    .split('{{profile}}').join(typeof voice?.profile === 'string' ? voice.profile : '')
    .split('{{voice}}').join(typeof voice?.display === 'string' ? voice.display : '')
    .split('{{python}}').join(typeof voice?.python === 'string' ? voice.python : '')
    .split('{{speak_py}}').join(typeof voice?.script === 'string' ? voice.script : '')
    .split('{{ingest}}').join(typeof voice?.ingest === 'string' ? voice.ingest : 'http://127.0.0.1:18801')
    .split('{{out_dir}}').join(typeof voice?.outDir === 'string' ? voice.outDir : 'dsh-chatterbox/out')
}

/**
 * The protocol text with the configured voice folder and persona substituted.
 * @param folder - voice profile folder (cb_*), substituted for `{{skill}}`.
 * @param maxChars - spoken-line character cap; 0 or less means "no extra limit".
 * @param voice - profile metadata for `{{profile}}` / `{{voice}}`.
 * @param persona - parsed persona (see personas/*.json); omitted = neutral.
 */
export function protocolText(folder, maxChars = 0, voice = null, persona = null) {
  const resolvedPersona = normalizePersona(persona)
  const blocks = segmentBlock(resolvedPersona)
  const count = countWord(blocks.count)
  const userWord = resolvedPersona.address !== '' ? resolvedPersona.address : '用户'
  const audioIndex = resolvedPersona.segments.findIndex((segment) => segment.audio)
  const audioNth = String(audioIndex >= 0 ? audioIndex + 1 : 2)
  const limit = Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : 0

  let text = LINES.join(String.fromCharCode(10))
  // The persona line only exists when the persona names an address.
  if (resolvedPersona.address !== '') {
    text = text.replace('{{persona}}', '与用户的关系：称呼他「' + resolvedPersona.address + '」。')
  } else {
    text = text.replace('{{persona}}\n', '')
  }
  text = text
    .replace('{{segments}}', (limit > 0 ? '这一轮的日语台词不超过 ' + limit + ' 字：超出先删减到 ' + limit + ' 字以内再念。'
      + String.fromCharCode(10) : '') + blocks.text)
    .split('{{segcount}}').join(count)
    .split('{{lastseg}}').join(String(blocks.count))
    .split('{{audioseg}}').join(audioNth)
    .split('{{user}}').join(userWord)

  const resolved = {
    folder: typeof folder === 'string' && folder.trim().length > 0 ? folder.trim() : DEFAULT_VOICE_FOLDER,
    profile: voice?.profile,
    display: voice?.display,
    python: voice?.python,
    script: voice?.script,
  }
  return fillVoice(text, resolved)
}

/**
 * The global "念出来" rule: any Session's agent may be asked to speak, so this
 * text is registered unscoped (it only fires on an explicit request).
 * @param current - the configured voice profile.
 * @param all - every cb_* profile found in the voices folder.
 * @param ingest - ingest base URL.
 * @param persona - parsed persona (only used for the address line).
 */
export function globalVoiceRule(current, all, ingest, persona = null) {
  const bt = String.fromCharCode(96)
  const base = typeof ingest === 'string' && ingest.length > 0 ? ingest : 'http://127.0.0.1:18801'
  const folder = current?.folder ?? DEFAULT_VOICE_FOLDER
  const profile = current?.profile ?? ''
  const display = current?.display ?? profile
  const address = typeof persona?.address === 'string' && persona.address !== '' ? persona.address : '你'
  const others = (all ?? [])
    .filter((entry) => entry.profile && entry.profile !== profile)
    .map((entry) => `${entry.display || entry.profile}=${entry.profile}（${entry.folder}）`)
    .join('；')
  const lines = [
    '【音色档案·念出来】' + address + '说「念出来」「念一下」「读一下」「用她的声音」「让××说」这类话时：用本机日语 TTS 念出来，**不要**改成中文朗读，也不要做后期。',
    `默认音色档案：${display}（${bt}--profile ${profile}${bt}）。说明与命令在 ${bt}${folder}\\SKILL.md${bt}——用 read 工具读它，照着执行；每条命令都要带 ${bt}--profile ${profile}${bt}。`,
    '念完只给两样：日语原文（照念，一字不改）+ 另起一行的 markdown 音频链接；紧跟一个 [▶ 重放]({{ingest}}/voice/play?name=<文件名>) 链接（点它会重播；自由麦开着时插件会暂停收音）。不写断句/换气标注、不写字数/时长汇报、不写中文翻译。',
    '（在 dsh-chatterbox 的语音会话里，这条让位给「语音会话·出声约定」：那边按该人格的段落格式作答。）',
  ]
  if (others) {
    lines.splice(2, 0, `只有${address}**明确点名**别的角色（例如「让风莉说」「用风莉的声音」）时才换档案：${others}——换之前先读那个目录的 SKILL.md，之后每条命令都带它的 profile。只是随口提到、没点名角色时，一律用默认档案。`)
  }
  return lines.join('\\n').split('{{ingest}}').join(base)
}
