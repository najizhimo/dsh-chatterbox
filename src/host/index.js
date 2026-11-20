// dsh-chatterbox
//
// Loopback HTTP ingest for push-to-talk transcripts. A voice client (ptt.py)
// POSTs one line of recognized text; this Host plugin admits it as an ordinary
// user prompt of one live Session, so the message appears in the DSH session and
// the agent starts a normal turn -- without window focus, clipboard, or
// synthesized keystrokes.
//
// Delivery uses the public Host service `sessionController.prompt()`, which is
// also the Remote the Web client itself calls when a user presses Send. No
// private field, no protocol re-implementation, no app.asar edit.
//
// Everything is optional-injected at call time (ctx.get(...)) so that a missing
// service produces a diagnosable JSON error instead of a failed plugin mount.

import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_SKILL_PATH,
  DEFAULT_VOICE_FOLDER,
  DEFAULT_VOICES_DIR,
  fillVoice,
  globalVoiceRule,
  DEFAULT_PERSONA_ID,
  protocolText as buildProtocolText,
} from './protocol.js'

const VERSION = '1.0.0'
const BODY_LIMIT_BYTES = 64 * 1024
const MAX_TEXT_CHARS = 4000

const DEFAULTS = {
  port: 18801,
  // Fixed delivery target. Non-empty locks every submit to exactly this Session
  // (the voice chat session); the activity heuristic is then never consulted.
  sessionId: '',
  // Contribute the voice conversation protocol to the locked Session's system
  // prompt, so that Session's agent always answers with speech + the three-part
  // reply. Scope is that agent only; every other agent stays untouched.
  voiceProtocol: true,
  // Override the built-in protocol text (empty means built-in).
  voiceProtocolText: '',
  // Section order inside the system prompt: right after the persona (0) and
  // before plan policy (500).
  voiceProtocolOrder: 50,
  // Optional shared secret: when non-empty, every mutating request must carry it
  // in the `x-ptt-token` header. Empty means "any local process may submit".
  token: '',
  // 'queue' admits the text as the next user message; 'steer' inserts it into a
  // running turn. 'queue' is what pressing Send does.
  mode: 'queue',
  // Used by POST /submit {newSession:true} when the request names no directory.
  defaultCwd: '',
  // Empty: %LOCALAPPDATA%\dsh\dsh-chatterbox\logs\chatterbox.log
  logFile: '',
  maxLogBytes: 1_000_000,
  // Upper bound for one admission (cold Session resume included).
  admitTimeoutMs: 30_000,
}

/**
 * Host config. `speakSkillPath` is volatile: the Plugins settings page renders it
 * as an editable path field and applies a change in place, so the injected
 * protocol switches voice skills without reloading the plugin.
 */
export const Config = z.object({
  port: z.number().step(1).min(1).max(65535).default(18801).description('本机监听端口'),
  sessionId: z.string()
    .default('')
    .description('投递目标会话（配置页下拉选择；留空则按活跃度推断）')
    .volatile(),
  token: z.string().role('secret').default('').description('可选共享口令；非空时请求必须带 x-ptt-token'),
  mode: z.string().default('queue').description('投递模式：queue 或 steer'),
  defaultCwd: z.string().default('').description('newSession 未指定目录时使用'),
  logFile: z.string().default('').description('日志文件路径（留空用默认位置）'),
  maxLogBytes: z.number().step(1).min(1024).default(1000000).description('日志轮转阈值'),
  admitTimeoutMs: z.number().step(1).min(1000).default(30000).description('单次投递超时'),
  voiceProtocol: z.boolean().default(true).description('向锁定会话注入语音会话约定'),
  voiceProtocolOrder: z.number().default(50).description('约定在系统提示中的位次'),
  voiceProtocolText: z.string().default('').description('覆盖内置约定文本（留空用内置）'),
  freeMicIdleMinutes: z.number().min(1).default(30).description('自由麦克风空闲多少分钟后自动关闭'),
  voiceClient: z.object({
    autoStart: z.boolean().default(true).description('随 DSH 启动语音客户端'),
    hotkey: z.string().default('printscreen').description('按住说话的热键'),
    python: z.string().default('').description('pythonw.exe 路径（留空用语音 venv 里的那个）'),
    script: z.string().default('').description('ptt.py 路径（留空用插件内的 src/voice/ptt.py）'),
  }).description('语音客户端：按键录音 → 本地识别 → 投递到本插件'),
  audioDir: z.string().default('').description('音频输出目录（留空用插件根目录下的 out\\）'),
  audioRetentionDays: z.number()
    .min(0)
    .max(365)
    .step(1)
    .default(3)
    .description('音频保留天数：超过这么多天的 out\\*.wav 会被移入回收站（0 = 不清理，keep_ 前缀永不清理）')
    .volatile(),
  ttsAutoStart: z.boolean()
    .default(true)
    .description('随插件启动本机 TTS 服务（8763 已有人在跑就复用，不重复启动）'),
  ttsPort: z.number()
    .min(1024)
    .max(65535)
    .step(1)
    .default(8763)
    .description('本机 TTS 服务端口'),
  audioDir: z.string().default('').description('音频输出目录（留空用插件根目录下的 out\\）'),
  audioRetentionDays: z.number()
    .min(0)
    .max(365)
    .step(1)
    .default(3)
    .description('音频保留天数：超过这么多天的 out\\*.wav 会被移入回收站（0 = 不清理，keep_ 前缀永不清理）')
    .volatile(),
  ttsAutoStart: z.boolean()
    .default(true)
    .description('随插件启动本机 TTS 服务（8763 已有人在跑就复用，不重复启动）'),
  ttsPort: z.number()
    .min(1024)
    .max(65535)
    .step(1)
    .default(8763)
    .description('本机 TTS 服务端口'),
  ttsPython: z.string()
    .default('')
    .description('跑 TTS 服务的 python.exe（留空用工作区 irodori 的 .venv）')
    .volatile(),
  audioDir: z.string().default('').description('音频输出目录（留空用插件根目录下的 out\\）'),
  audioRetentionDays: z.number()
    .min(0)
    .max(365)
    .step(1)
    .default(3)
    .description('音频保留天数：超过这么多天的 out\\*.wav 会被移入回收站（0 = 不清理，keep_ 前缀永不清理）')
    .volatile(),
  ttsAutoStart: z.boolean()
    .default(true)
    .description('随插件启动本机 TTS 服务（8763 已有人在跑就复用，不重复启动）'),
  ttsPort: z.number()
    .min(1024)
    .max(65535)
    .step(1)
    .default(8763)
    .description('本机 TTS 服务端口'),
  ttsPython: z.string()
    .default('')
    .description('跑 TTS 服务的 python.exe（留空用工作区 irodori 的 .venv）')
    .volatile(),
  hfHome: z.string()
    .default('')
    .description('模型权重缓存目录（留空用 <插件>\\..\\cache\\hf-cache）')
    .volatile(),
  agentPreset: z.string()
    .default('')
    .description('回答用的 agent 预设 id（来自 DSH 预设注册表；留空=平台默认，新建语音会话时生效）')
    .volatile(),
  agentPersona: z.string()
    .default('')
    .description('回复格式 persona（personas/*.json 的 id；留空=跟随 agent 预设，找不到则用 deepseek）')
    .volatile(),
  speakSkillPath: z.string()
    .default('')
    .description('音色档案文件夹（voices\\cb_*，里面有 SKILL.md 与 voice.json）')
    .volatile(),
  leadInSeconds: z.number()
    .min(0)
    .max(2)
    .step(0.01)
    .default(0.2)
    .description('开头补静音（秒）：蓝牙/声卡起播有启动延迟，不补会吞掉第一个音')
    .volatile(),
  tailSeconds: z.number()
    .min(0)
    .max(2)
    .step(0.01)
    .default(0.12)
    .description('结尾补静音（秒）')
    .volatile(),
  asrLanguage: z.string()
    .default('auto')
    .description('语音识别语言：auto / zh / en / ja / ko / yue（改完自动重开语音端）')
    .volatile(),
  hotkey: z.string()
    .default('printscreen')
    .description('按住说话的热键，可用组合键：ctrl+alt+space、shift+f9、mouse4 …（改完自动重开语音端）')
    .volatile(),
  replyMaxChars: z.number()
    .step(1)
    .min(0)
    .max(500)
    .default(0)
    .description('语音文本字数上限（0 = 不限）')
    .volatile(),
  vadSilenceSeconds: z.number()
    .min(0.3)
    .max(600)
    .step(0.1)
    .default(2.0)
    .description('投送延迟：静默多久算一句说完（秒，0.3–600，1 位小数）')
    .volatile(),
})

// The voice client this plugin supervises: ptt.py records on the hotkey,
// recognizes locally, and POSTs the text back into /submit on this plugin's own
// port. It is spawned with --parent-pid so it also exits if the Host dies hard.
const HOME_DIR = process.env.USERPROFILE ?? ''
const LOCAL_DIR = process.env.LOCALAPPDATA ?? path.join(HOME_DIR, 'AppData', 'Local')

const VOICE_CLIENT_DEFAULTS = {
  autoStart: true,
  hotkey: 'printscreen',
  // Empty: <LOCALAPPDATA>/dsh/dsh-chatterbox/venv/Scripts/pythonw.exe
  python: '',
  // Empty: <plugin>/src/voice/ptt.py
  script: '',
}

const defaultVoicePython = () => path.join(LOCAL_DIR, 'dsh', 'dsh-chatterbox', 'venv', 'Scripts', 'pythonw.exe')
// The voice client ships inside this package (src/voice/ptt.py).
const PLUGIN_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const defaultVoiceScript = () => path.join(PLUGIN_DIR, 'src', 'voice', 'ptt.py')

function defaultLogPath() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(base, 'dsh', 'dsh-chatterbox', 'logs', 'chatterbox.log')
}

function makeLogger(file, maxBytes) {
  let ready = false
  return function log(message) {
    try {
      if (!ready) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        ready = true
      }
      try {
        if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`)
      } catch {
        /* first write, or rotation raced another process: keep logging */
      }
      fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
    } catch {
      /* logging must never break the Host */
    }
  }
}

/** Last time this Session carried a user-authored message, or 0. */
function lastUserMessageAt(session) {
  let events
  try {
    events = session.ownEvents()
  } catch {
    return 0
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
      return typeof event.time === 'number' ? event.time : 0
    }
  }
  return 0
}

/** Last committed event time of this Session, or its creation time. */
function lastEventAt(session) {
  try {
    const events = session.ownEvents()
    if (events.length > 0) {
      const time = events[events.length - 1]?.time
      if (typeof time === 'number') return time
    }
  } catch {
    /* fall through to the header */
  }
  const created = session?.header?.createdAt
  return typeof created === 'number' ? created : 0
}

/** Ordinary live Sessions only: subagent Sessions are never a PTT target. */
function liveSessions(ctx) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.list !== 'function') return []
  let list
  try {
    list = sessions.list()
  } catch {
    return []
  }
  return list.filter((session) => session?.header?.origin !== 'subagent')
}

/**
 * Session ids the user can actually see in the sidebar, or null when the
 * Workspace registry is unavailable or empty. A conversation the user opened in
 * DSH belongs to a Workspace; sessions created by tooling often do not.
 */
function workspaceSessionIds(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry || typeof registry.list !== 'function') return null
  try {
    const attached = new Set()
    for (const workspace of registry.list()) {
      const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
      for (const id of ids) attached.add(id)
    }
    return attached.size > 0 ? attached : null
  } catch {
    return null
  }
}

/**
 * Rank live Sessions by "the user most recently talked here", preferring
 * Workspace conversations and never the throwaway Sessions this plugin created
 * for acceptance runs.
 */
function rankTargets(ctx, state) {
  const attached = workspaceSessionIds(ctx)
  return liveSessions(ctx)
    .filter((session) => !state.created.has(session.id))
    .map((session) => ({
      sessionId: session.id,
      inWorkspace: attached === null ? true : attached.has(session.id),
      lastUserMessageAt: lastUserMessageAt(session),
      lastEventAt: lastEventAt(session),
    }))
    .sort((left, right) => (Number(right.inWorkspace) - Number(left.inWorkspace))
      || (right.lastUserMessageAt - left.lastUserMessageAt)
      || (right.lastEventAt - left.lastEventAt))
}

function resolution(state, ranked, explicitId, lockedId) {
  if (typeof lockedId === 'string' && lockedId.length > 0) {
    return { sessionId: lockedId, targetSource: 'locked' }
  }
  if (typeof explicitId === 'string' && explicitId.length > 0) {
    return { sessionId: explicitId, targetSource: 'request' }
  }
  const live = new Set(ranked.map((entry) => entry.sessionId))
  if (state.pinned !== null && live.has(state.pinned)) {
    return { sessionId: state.pinned, targetSource: 'pinned' }
  }
  if (state.sticky !== null && live.has(state.sticky)) {
    return { sessionId: state.sticky, targetSource: 'sticky' }
  }
  if (ranked.length > 0) {
    return { sessionId: ranked[0].sessionId, targetSource: 'activity' }
  }
  return { sessionId: null, targetSource: 'none' }
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Concatenate the text blocks of one message content array. */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

function snippet(value, maximum = 160) {
  if (typeof value !== 'string') return null
  return value.length > maximum ? `${value.slice(0, maximum)}…` : value
}

const REMOTE_STATUS = {
  'session/not-found': 404,
  'session/agent-busy': 409,
  'session/attachment-invalid': 400,
  'gateway/bad-request': 400,
  'gateway/cancelled': 499,
}

function statusOf(error) {
  if (error instanceof ApiError) return error.status
  if (typeof error?.code === 'string' && REMOTE_STATUS[error.code] !== undefined) return REMOTE_STATUS[error.code]
  return 500
}

function describe(error) {
  const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'ptt/internal'
  const message = typeof error?.message === 'string' ? error.message : String(error)
  return { code, message }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > BODY_LIMIT_BYTES) {
        reject(new ApiError(413, 'ptt/body-too-large', `request body exceeds ${BODY_LIMIT_BYTES} bytes`))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('error', (error) => reject(new ApiError(400, 'ptt/bad-request', String(error))))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new ApiError(400, 'ptt/bad-request', 'body must be a JSON object'))
          return
        }
        resolve(parsed)
      } catch (error) {
        reject(new ApiError(400, 'ptt/bad-request', `body is not valid JSON: ${String(error)}`))
      }
    })
  })
}

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...(config || {}) }
  const log = makeLogger(options.logFile || defaultLogPath(), options.maxLogBytes)
  // `created` holds the throwaway Sessions this plugin minted for acceptance
  // runs: they must never become a delivery target.
  const state = { sticky: null, pinned: null, created: new Set(), disposed: false, admitted: 0, failed: 0 }
  // Session ids whose agent carries the voice protocol section, -> disposer.
  const protocolOwners = new Map()
  const lockedSessionId = () => {
    const reference = config?.sessionId
    const value = reference !== null && typeof reference === 'object' && typeof reference.get === 'function'
      ? reference.get()
      : reference
    return typeof value === 'string' ? value.trim() : ''
  }
  let server = null

  const voiceOptions = { ...VOICE_CLIENT_DEFAULTS, ...(config?.voiceClient ?? {}) }
  const voicePython = typeof voiceOptions.python === 'string' && voiceOptions.python.trim().length > 0
    ? voiceOptions.python.trim()
    : defaultVoicePython()
  const voiceScript = typeof voiceOptions.script === 'string' && voiceOptions.script.trim().length > 0
    ? voiceOptions.script.trim()
    : defaultVoiceScript()
  const voiceState = { child: null, pid: null, exited: null }
  // Free-microphone mode: the voice client records continuously instead of on a
  // hotkey. While a turn admitted from here is still running (thinking + reply +
  // speech), it must not listen, so /voice/state reports paused.
  const freeMicState = {
    enabled: false,
    replayBusy: false,
    replayStartedAt: 0,
    notListeningSince: 0,
    lastClientRestartAt: 0,
    busy: false,
    pendingRequestId: null,
    ourMessageAt: null,
    lastSubmitAt: 0,
    listeningSince: 0,
    releaseAt: 0,
    enabledAt: 0,
    lastActivityAt: 0,
    clientListening: false,
    clientListeningAt: 0,
  }

  const idleTimeoutMs = () => {
    const minutes = Number(options.freeMicIdleMinutes)
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60_000
  }

  /** When the idle switch flips off, or null when nothing is armed. */
  function autoOffAt() {
    if (!freeMicState.enabled) return null
    return Math.max(freeMicState.enabledAt, freeMicState.lastActivityAt) + idleTimeoutMs()
  }

  function freeMicReport() {
    return {
      ok: true,
      enabled: freeMicState.enabled,
      paused: freeMicState.enabled && freeMicState.busy,
      mode: freeMicState.enabled ? 'free' : 'hotkey',
      busy: freeMicState.busy,
      sessionId: lockedSessionId() === '' ? null : lockedSessionId(),
      voiceClientRunning: voiceState.child !== null,
      lastSubmitAt: freeMicState.lastSubmitAt || null,
      idleTimeoutMs: idleTimeoutMs(),
      autoOffAt: autoOffAt(),
      clientListening: freeMicState.clientListening,
      clientListeningAt: freeMicState.clientListeningAt || null,
      vadSilence: vadSilence(),
      asrLanguage: asrLanguage(),
      hotkey: hotkeySpec(),
      replaying: freeMicState.replayBusy,
      replyMaxChars: replyMaxChars(),
      leadInSeconds: leadInSeconds(),
      tailSeconds: tailSeconds(),
    }
  }

  function setFreeMic(enabled) {
    const next = enabled === true
    if (freeMicState.enabled === next) return freeMicReport()
    freeMicState.enabled = next
    const now = Date.now()
    freeMicState.enabledAt = next ? now : 0
    freeMicState.lastActivityAt = next ? now : 0
    freeMicState.busy = false
    freeMicState.replayBusy = false
    freeMicState.replayStartedAt = 0
    freeMicState.pendingRequestId = null
    freeMicState.ourMessageAt = null
    freeMicState.listeningSince = next ? Date.now() : 0
    freeMicState.releaseAt = 0
    log(`free-mic ${next ? 'on' : 'off'}`)
    return freeMicReport()
  }

  // Reading the reply's own audio keeps the listener from recording our TTS:
  // the last spoken line is still playing when the turn ends, so its file mtime
  // plus its header-declared duration is when the room goes quiet again.
  // 音频落在插件根目录的 out\，由插件自己清扫（配置页的「音频保留天数」）。
  const audioDir = () => (typeof options.audioDir === 'string' && options.audioDir.trim().length > 0
    ? options.audioDir.trim()
    : path.join(PLUGIN_DIR, 'out'))
  const retentionDays = () => {
    const value = Number(options.audioRetentionDays)
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 3
  }

  function wavDurationMs(file, size) {
    try {
      const fd = fs.openSync(file, 'r')
      const head = Buffer.alloc(64)
      fs.readSync(fd, head, 0, 64, 0)
      fs.closeSync(fd)
      if (head.toString('ascii', 0, 4) !== 'RIFF') return null
      let offset = 12
      while (offset + 24 <= head.length) {
        const id = head.toString('ascii', offset, offset + 4)
        const size_ = head.readUInt32LE(offset + 4)
        if (id === 'fmt ') {
          const channels = head.readUInt16LE(offset + 10)
          const rate = head.readUInt32LE(offset + 12)
          const bits = head.readUInt16LE(offset + 22)
          if (channels === 0 || rate === 0 || bits === 0) return null
          return ((size - 44) / (rate * channels * (bits / 8))) * 1000
        }
        offset += 8 + size_ + (size_ % 2)
      }
      return null
    } catch {
      return null
    }
  }

  /** When the newest spoken audio in the reply should have finished playing. */
  function estimateSpeechEnd(sinceMs) {
    try {
      const dir = audioDir()
      let newest = null
      for (const name of fs.readdirSync(dir)) {
        if (!name.toLowerCase().endsWith('.wav')) continue
        const full = path.join(dir, name)
        const stat = fs.statSync(full)
        if (stat.mtimeMs < sinceMs - 2_000) continue
        if (newest === null || stat.mtimeMs > newest.mtimeMs) {
          newest = { full, mtimeMs: stat.mtimeMs, size: stat.size }
        }
      }
      if (newest === null) return null
      const duration = wavDurationMs(newest.full, newest.size)
      if (duration === null || !Number.isFinite(duration)) return newest.mtimeMs
      return newest.mtimeMs + duration
    } catch {
      return null
    }
  }

  // The reply is spoken by a detached player process. Its exit is the only
  // honest "the audio is over" signal: file mtime + duration misses player
  // start-up latency and the buffered tail, so the microphone used to re-arm
  // while the last syllable was still in the room.
  const playbackState = { child: null, startedAt: 0 }

  function stopPlaybackWatch() {
    if (playbackState.child === null) return
    try {
      playbackState.child.kill()
    } catch {
      /* already gone */
    }
    playbackState.child = null
  }

  /** Wait for every speaker process to exit, then schedule the re-arm. */
  function waitForPlayback() {
    stopPlaybackWatch()
    const helper = path.join(PLUGIN_DIR, 'tools', 'wait-playback.ps1')
    freeMicState.releaseAt = 0
    log('free-mic: waiting for playback to finish')
    let child
    try {
      child = spawn('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', helper, '-TimeoutSeconds', '150',
      ], { windowsHide: true, stdio: 'ignore' })
    } catch (error) {
      log(`free-mic: playback watcher failed to start: ${error?.message ?? error}`)
      const speechEnd = estimateSpeechEnd(freeMicState.lastSubmitAt)
      freeMicState.releaseAt = Math.max(Date.now() + 1_500, (speechEnd ?? 0) + 1_000)
      return
    }
    playbackState.child = child
    playbackState.startedAt = Date.now()
    child.on('error', (error) => {
      log(`free-mic: playback watcher error: ${error?.message ?? error}`)
    })
    child.on('exit', (code) => {
      if (playbackState.child === child) playbackState.child = null
      if (!freeMicState.enabled || !freeMicState.busy) {
        freeMicState.replayBusy = false
        freeMicState.replayStartedAt = 0
        return
      }
      if (code === 0) {
        // Playback really ended. The player exits at duration-0.05s, so 300ms
        // is enough cushion for the device buffer; the watchdog tick would add
        // up to 400ms more, so release from a timer instead.
        const cushion = 300
        const releaseAt = Date.now() + cushion
        freeMicState.releaseAt = releaseAt
        log(`free-mic: playback finished after ${releaseAt - playbackState.startedAt}ms; release in ${cushion}ms`)
        const timer = setTimeout(() => {
          if (state.disposed || !freeMicState.enabled || !freeMicState.busy) return
          releaseFreeMic(freeMicState.replayBusy ? 'replay finished' : 'turn end + playback finished')
        }, cushion)
        if (typeof timer.unref === 'function') timer.unref()
      } else {
        const speechEnd = estimateSpeechEnd(freeMicState.lastSubmitAt)
        const releaseAt = Math.max(Date.now() + 2_000, (speechEnd ?? 0) + 1_500)
        freeMicState.releaseAt = releaseAt
        log(`free-mic: playback watcher exit=${code}; falling back to the wav estimate`)
      }
    })
  }

  /** A turn we admitted finished: hand the microphone back to the listener. */
  function releaseFreeMic(reason) {
    if (!freeMicState.busy) return
    freeMicState.busy = false
    freeMicState.replayBusy = false
    freeMicState.replayStartedAt = 0
    freeMicState.pendingRequestId = null
    freeMicState.ourMessageAt = null
    log(`free-mic re-armed (${reason})`)
  }

  const voiceStatus = () => ({
    autoStart: voiceOptions.autoStart !== false,
    running: voiceState.child !== null,
    pid: voiceState.pid,
    hotkey: String(voiceOptions.hotkey),
    python: voicePython,
    script: voiceScript,
    ...(voiceState.exited === null ? {} : { lastExit: voiceState.exited }),
  })

  function startVoiceClient() {
    if (voiceState.child !== null) return
    try {
      const child = spawn(voicePython, [
        voiceScript,
        '--hotkey', hotkeySpec(),
        '--vad-silence', String(vadSilence()),
        '--language', asrLanguage(),
        '--parent-pid', String(process.pid),
      ], {
        cwd: path.dirname(voiceScript),
        stdio: 'ignore',
        windowsHide: true,
        detached: false,
      })
      voiceState.child = child
      voiceState.pid = child.pid ?? null
      voiceState.exited = null
      child.on('exit', (code, signal) => {
        voiceState.exited = { code, signal, at: Date.now() }
        log(`voice client exited code=${code} signal=${signal ?? ''}`)
        if (voiceState.child === child) {
          voiceState.child = null
          voiceState.pid = null
        }
        // While the free microphone is armed, a dead client means the button
        // lies: bring it back instead of waiting for the user to notice.
        if (!state.disposed && freeMicState.enabled && voiceOptions.autoStart !== false) {
          log('voice client died while free mic is on; respawning')
          const timer = setTimeout(() => {
            if (!state.disposed && freeMicState.enabled) startVoiceClient()
          }, 800)
          if (typeof timer.unref === 'function') timer.unref()
        }
      })
      child.on('error', (error) => {
        log(`voice client spawn error: ${error?.message ?? error}`)
        voiceState.child = null
        voiceState.pid = null
      })
      log(`voice client spawned pid=${voiceState.pid} hotkey=${voiceOptions.hotkey} parent_pid=${process.pid}`)
    } catch (error) {
      log(`voice client start failed: ${error?.message ?? error}`)
    }
  }

  function stopVoiceClient() {
    const child = voiceState.child
    const pid = voiceState.pid
    if (child === null) return
    log(`voice client stopping pid=${pid}`)
    // The venv's pythonw.exe is a shim: kill the interpreter it re-executed too.
    if (pid !== null) {
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } catch (error) {
        log(`voice client taskkill failed: ${error?.message ?? error}`)
      }
    }
    try {
      child.kill()
    } catch (error) {
      log(`voice client kill failed: ${error?.message ?? error}`)
    }
    voiceState.child = null
    voiceState.pid = null
  }

  const readVolatile = (name, fallback) => {
    const reference = config?.[name]
    const value = reference !== null && typeof reference === 'object' && typeof reference.get === 'function'
      ? reference.get()
      : reference
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
  }
  // ---- 助手人格（persona）: 分段格式与是否朗读由它决定，插件不带角色名 ----
  // 唯一地址：<插件>\personas\*.json（私有文件用 "private": true 标记，分发前删掉）
  const personaDirs = () => [path.join(PLUGIN_DIR, 'personas')]

  /** [{ id, display, file, source }] from both persona dirs (plugin first, then local). */
  function listPersonaFiles() {
    const items = []
    const seen = new Set()
    for (const dir of personaDirs()) {
      let entries = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch (error) {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const file = path.join(dir, entry.name)
        let data = null
        try {
          data = JSON.parse(fs.readFileSync(file, 'utf8'))
        } catch (error) {
          log('persona unreadable: ' + file + ' — ' + (error?.message ?? error))
          continue
        }
        const id = typeof data?.id === 'string' && data.id !== '' ? data.id : entry.name.replace(/\.json$/, '')
        if (seen.has(id)) continue
        seen.add(id)
        items.push({
          id,
          private: data?.private === true,
          display: typeof data?.display === 'string' && data.display !== '' ? data.display : id,
          file,
          source: data?.private === true ? '私有（分发前删除）' : '插件自带',
        })
      }
    }
    return items
  }

  /** Parsed persona for an id, or null. */
  function readPersona(id) {
    const wanted = typeof id === 'string' && id.trim() !== '' ? id.trim() : DEFAULT_PERSONA_ID
    const found = listPersonaFiles().find((item) => item.id === wanted)
    if (found === undefined) return null
    try {
      return JSON.parse(fs.readFileSync(found.file, 'utf8'))
    } catch (error) {
      log('persona parse failed: ' + found.file + ' — ' + (error?.message ?? error))
      return null
    }
  }

  /** DSH's own preset registry, when the service is mounted. */
  function presetService() {
    try {
      const service = ctx.get('agentPresets')
      return service !== undefined && service !== null && typeof service.list === 'function' ? service : null
    } catch (error) {
      return null
    }
  }

  /** The agent preset recorded for a Session (undefined when unknown). */
  function sessionPreset(sessionId) {
    const service = presetService()
    if (service === null || typeof sessionId !== 'string' || sessionId === '') return undefined
    const sessions = ctx.get('sessions')
    const session = sessions !== undefined && sessions !== null && typeof sessions.get === 'function'
      ? sessions.get(sessionId)
      : undefined
    if (session === undefined || session === null) return undefined
    try {
      const fromService = typeof service.presetForSession === 'function' ? service.presetForSession(session) : null
      if (typeof fromService === 'string' && fromService !== '') return fromService
    } catch (error) {
      log('presetForSession failed: ' + (error?.message ?? error))
    }
    return typeof session.header?.agentPreset === 'string' ? session.header.agentPreset : undefined
  }

  /** Presets as rows for the settings page (id/name/description/default/broken). */
  async function listPresets() {
    const service = presetService()
    if (service === null) return []
    let presets = []
    try {
      presets = await service.list()
    } catch (error) {
      log('preset list failed: ' + (error?.message ?? error))
      return []
    }
    const rows = []
    for (const preset of Array.isArray(presets) ? presets : []) {
      if (preset === null || typeof preset !== 'object' || typeof preset.id !== 'string') continue
      rows.push({
        id: preset.id,
        name: typeof preset.name === 'string' ? preset.name : preset.id,
        description: typeof preset.description === 'string' ? preset.description : '',
        isDefault: preset.isDefault === true,
        broken: typeof preset.broken === 'string' ? preset.broken : '',
      })
    }
    rows.sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.id.localeCompare(right.id))
    return rows
  }

  /** The preset the voice conversation will use: configured → the target session's → default. */
  const agentPresetId = () => {
    const configured = configuredPath(readVolatile('agentPreset', ''))
    if (configured !== '') return configured
    const target = lockedSessionId() !== '' ? lockedSessionId() : (state.sticky ?? '')
    return typeof sessionPreset(target) === 'string' ? sessionPreset(target) : ''
  }

  /** The persona in effect: explicit → the preset's own file → deepseek → null. */
  function activePersona() {
    const configured = configuredPath(readVolatile('agentPersona', ''))
    if (configured !== '') {
      const persona = readPersona(configured)
      if (persona !== null) return persona
      log('persona missing: ' + configured + '; falling back')
    }
    const preset = agentPresetId()
    if (preset !== '') {
      const bound = readPersona(preset)
      if (bound !== null) return bound
    }
    return readPersona(DEFAULT_PERSONA_ID)
  }

  /** Where voice folders may live, most specific first. Nothing hardcoded to one machine. */
  const voiceSearchDirs = () => [
    path.join(PLUGIN_DIR, 'deps', 'voices'),
    path.join(PLUGIN_DIR, '..', 'voices'),
    ...(DEFAULT_VOICES_DIR === '' ? [] : [DEFAULT_VOICES_DIR]),
  ]

  /** First cb_* folder (with voice.json) under the search dirs, or ''. */
  function discoverVoiceFolder() {
    for (const dir of new Set(voiceSearchDirs())) {
      let entries = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch (error) {
        continue
      }
      const folders = entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('cb_'))
        .map((entry) => path.join(dir, entry.name))
        .sort()
      for (const folder of folders) {
        if (fs.existsSync(path.join(folder, 'voice.json'))) return folder
      }
    }
    return ''
  }

  const speakSkillPath = () => {
    const configured = readVolatile('speakSkillPath', '')
    if (configured !== '' && fs.existsSync(path.join(configured, 'voice.json'))) return configured
    const discovered = discoverVoiceFolder()
    if (discovered !== '') {
      if (configured !== '' && !state.staleVoicePathLogged) {
        state.staleVoicePathLogged = true
        log('speakSkillPath points at a folder without voice.json (' + configured + '); discovered ' + discovered)
      }
      return discovered
    }
    return configured
  }

  /** Folder -> { folder, profile, display, python, script }; cached on mtime. */
  const voiceCache = new Map()
  function voiceInfo(folder = speakSkillPath()) {
    try {
      const file = path.join(folder, 'voice.json')
      const stat = fs.statSync(file)
      const cached = voiceCache.get(folder)
      if (cached && cached.mtimeMs === stat.mtimeMs) return cached.info
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      const info = {
        folder,
        profile: typeof data.profile === 'string' ? data.profile : '',
        display: typeof data.display === 'string' ? data.display : '',
        python: typeof data.python === 'string' && data.python !== '' ? data.python : ttsPythonPath(),
        script: typeof data.speak_py === 'string' && data.speak_py !== '' ? data.speak_py : path.join(PLUGIN_DIR, 'src', 'tts', 'speak.py'),
      }
      voiceCache.set(folder, { mtimeMs: stat.mtimeMs, info })
      return info
    } catch (error) {
      return { folder, profile: '', display: '', python: '', script: '', error: String(error?.message ?? error) }
    }
  }

  /** Every finished profile in the voices folder (cb_* with voice.json). */
  function listVoiceProfiles() {
    const folder = speakSkillPath()
    const root = folder === '' ? '' : path.dirname(folder)
    const dirs = []
    const seen = new Set()
    for (const candidate of new Set([root, ...voiceSearchDirs()].filter((dir) => dir !== ''))) {
      try {
        for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith('cb_')) continue
          const full = path.join(candidate, entry.name)
          const info = voiceInfo(full)
          if (!info.profile || seen.has(info.profile)) continue
          seen.add(info.profile)
          dirs.push({ folder: full, label: info.display || entry.name, profile: info.profile, current: full === folder })
        }
      } catch {
        /* a missing voices folder is not an error */
      }
    }
    if (dirs.length === 0) {
      const info = voiceInfo(folder)
      dirs.push({ folder, label: info.display || path.basename(folder), profile: info.profile, current: true })
    }
    return dirs
  }
  const vadSilence = () => {
    const reference = config?.vadSilenceSeconds
    const value = reference !== null && typeof reference === 'object' && typeof reference.get === 'function'
      ? reference.get()
      : reference
    const seconds = Number(value)
    if (!Number.isFinite(seconds) || seconds < 0.3) return 2.0
    return Math.min(600, Math.max(0.3, Math.round(seconds * 10) / 10))
  }
  const leadInSeconds = () => {
    const reference = config?.leadInSeconds
    const value = reference !== null && typeof reference === 'object' && typeof reference.get === 'function'
      ? reference.get()
      : reference
    const seconds = Number(value)
    if (!Number.isFinite(seconds)) return 0.2
    return Math.min(2, Math.max(0, Math.round(seconds * 100) / 100))
  }

  const tailSeconds = () => {
    const reference = config?.tailSeconds
    const value = reference !== null && typeof reference === 'object' && typeof reference.get === 'function'
      ? reference.get()
      : reference
    const seconds = Number(value)
    if (!Number.isFinite(seconds)) return 0.12
    return Math.min(2, Math.max(0, Math.round(seconds * 100) / 100))
  }

  // The TTS daemon owns synthesis; it reads this file on every utterance, so a
  // settings change applies immediately without restarting the 17 s service.
  const padFile = () => path.join(LOCAL_DIR, 'dsh', 'dsh-chatterbox', 'audio-pad.json')

  // ---- 替换词表（语音识别纠错）：一个 JSON，语音端按 mtime 重读 ----
  const glossaryFile = () => path.join(LOCAL_DIR, 'dsh', 'dsh-chatterbox', 'glossary.json')
  const GLOSSARY_MAX_TERMS = 500
  const GLOSSARY_MAX_CHARS = 24
  const HANZI_ONLY = /^[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]+$/u
  const pinyinTool = () => path.join(PLUGIN_DIR, 'src', 'voice', 'pinyin_tool.py')

  /** pythonw.exe has no console; run the helper with the console interpreter. */
  function consolePython() {
    const configured = typeof voiceOptions.python === 'string' && voiceOptions.python.trim().length > 0
      ? voiceOptions.python.trim()
      : defaultVoicePython()
    return /pythonw\.exe$/i.test(configured) ? configured.replace(/pythonw\.exe$/i, 'python.exe') : configured
  }

  /**
   * Ask pypinyin (inside the voice venv) for one toneless syllable per
   * character. `manual` maps a term to the reading the user pinned.
   */
  function resolvePinyin(texts, manual) {
    const payload = JSON.stringify({ texts, manual })
    const result = spawnSync(consolePython(), [pinyinTool()], {
      cwd: path.join(PLUGIN_DIR, 'src', 'voice'),
      input: payload,
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true,
    })
    if (result.error !== undefined && result.error !== null) {
      throw new ApiError(500, 'ptt/pinyin-tool', 'pinyin helper failed: ' + (result.error?.message ?? result.error))
    }
    if (result.status !== 0) {
      const detail = String(result.stderr ?? '').trim().split('\n').slice(-2).join(' | ')
      throw new ApiError(500, 'ptt/pinyin-tool', 'pinyin helper exited ' + result.status + ': ' + detail)
    }
    let parsed = {}
    try {
      parsed = JSON.parse(String(result.stdout ?? '') || '{}')
    } catch (error) {
      throw new ApiError(500, 'ptt/pinyin-tool', 'pinyin helper returned junk: ' + String(error?.message ?? error))
    }
    return {
      pinyin: parsed && typeof parsed.pinyin === 'object' && parsed.pinyin !== null ? parsed.pinyin : {},
      errors: parsed && typeof parsed.errors === 'object' && parsed.errors !== null ? parsed.errors : {},
    }
  }

  function readGlossaryTerms() {
    try {
      const data = JSON.parse(fs.readFileSync(glossaryFile(), 'utf8') || '{}')
      const list = Array.isArray(data?.terms) ? data.terms : []
      return list
        .map((item) => (typeof item === 'string' ? { text: item } : item))
        .filter((item) => item && typeof item.text === 'string' && item.text.trim().length > 0)
        .map((item) => {
          const record = { text: item.text.trim(), added: typeof item.added === 'string' ? item.added : '' }
          if (Array.isArray(item.pinyin) && item.pinyin.length === record.text.length) {
            record.pinyin = item.pinyin.map((part) => String(part).toLowerCase())
          }
          if (typeof item.source === 'string' && item.source !== '') record.source = item.source
          return record
        })
    } catch (error) {
      if (error?.code !== 'ENOENT') log('glossary read failed: ' + (error?.message ?? error))
      return []
    }
  }

  function writeGlossaryTerms(terms) {
    const target = glossaryFile()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temp = target + '.tmp'
    fs.writeFileSync(temp, JSON.stringify({ version: 1, terms }, null, 2) + '\n', 'utf8')
    fs.renameSync(temp, target)
  }

  /** Split on spaces / newlines / Chinese punctuation; parse `词=拼音`. */
  function splitGlossaryInput(input) {
    const raw = Array.isArray(input) ? input.join('\n') : String(input ?? '')
    const parts = raw.split(/[\s,，、;；]+/u).map((part) => part.trim()).filter((part) => part.length > 0)
    const items = []
    const rejected = []
    const seen = new Set()
    for (const part of parts) {
      const eq = part.indexOf('=')
      const text = (eq >= 0 ? part.slice(0, eq) : part).trim()
      const pinned = eq >= 0 ? part.slice(eq + 1).trim() : ''
      if (text === '') { rejected.push({ text: part, reason: '缺少词条' }); continue }
      if (text.length > GLOSSARY_MAX_CHARS) { rejected.push({ text, reason: '超过 ' + GLOSSARY_MAX_CHARS + ' 字' }); continue }
      if (!HANZI_ONLY.test(text)) { rejected.push({ text, reason: '含非汉字字符，请改用中文写法' }); continue }
      if (seen.has(text)) continue
      seen.add(text)
      const item = { text }
      if (pinned !== '') item.pinned = pinned
      items.push(item)
    }
    return { items, rejected }
  }

  /** Fill in any missing pinyin (legacy records) and persist the result. */
  function hydrateGlossary() {
    const terms = readGlossaryTerms()
    const missing = terms.filter((item) => !Array.isArray(item.pinyin)).map((item) => item.text)
    if (missing.length === 0) return terms
    const { pinyin, errors } = resolvePinyin(missing, {})
    let changed = false
    for (const item of terms) {
      if (Array.isArray(item.pinyin)) continue
      if (Array.isArray(pinyin[item.text])) {
        item.pinyin = pinyin[item.text]
        item.source = item.source ?? 'auto'
        changed = true
      } else if (typeof errors[item.text] === 'string') {
        log('glossary: cannot resolve ' + item.text + ' — ' + errors[item.text])
      }
    }
    if (changed) writeGlossaryTerms(terms)
    return terms
  }

  /**
   * Append one record to %LOCALAPPDATA%\dsh\artifacts\dsh-chatterbox.jsonl so the
   * artifact-cleanup skill can see what this plugin leaves behind. Best effort:
   * a failed write must never block the plugin.
   */
  function registerArtifact(kind, target, expiry, mode, selfCleaning) {
    try {
      const registry = path.join(LOCAL_DIR, 'dsh', 'artifacts', 'dsh-chatterbox.jsonl')
      fs.mkdirSync(path.dirname(registry), { recursive: true })
      const record = {
        path: target,
        kind,
        skill: 'dsh-chatterbox',
        createdAt: new Date().toISOString(),
        expiry,
        delete: mode,
        selfCleaning,
      }
      fs.appendFileSync(registry, JSON.stringify(record) + '\n', 'utf8')
    } catch (error) {
      log(`artifact registry write failed: ${error?.message ?? error}`)
    }
  }

  function writePadFile() {
    try {
      const file = padFile()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ lead_in_s: leadInSeconds(), tail_s: tailSeconds() }, null, 2) + '\n', 'utf8')
    } catch (error) {
      log(`audio pad write failed: ${error?.message ?? error}`)
    }
  }

  const HOTKEY_MODIFIERS = ['ctrl', 'alt', 'shift', 'win', 'windows']
  const HOTKEY_KEYS = new Set([
    'space', 'enter', 'tab', 'esc', 'escape', 'backspace', 'delete', 'insert',
    'home', 'end', 'page up', 'page down', 'pageup', 'pagedown',
    'up', 'down', 'left', 'right', 'printscreen', 'prtsc', 'print', 'scrolllock', 'pause',
    'mouse4', 'mouse5', 'x1', 'x2', 'back', 'forward', '-', '=', '`', '[', ']', ';', "'", ',', '.', '/', '\\',
    ...Array.from({ length: 24 }, (_, index) => 'f' + String(index + 1)),
  ])

  /** Accepts `f9`, `ctrl+alt+space`, `mouse4`; anything else falls back to printscreen. */
  const normalizeHotkey = (raw) => {
    const text = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    const parts = text.split('+').map((part) => part.trim()).filter((part) => part.length > 0)
    if (parts.length === 0) return { spec: 'printscreen', ok: false, reason: 'empty' }
    const key = parts[parts.length - 1]
    const mods = parts.slice(0, -1)
    const keyOk = /^[a-z0-9]$/.test(key) || HOTKEY_KEYS.has(key)
    const modsOk = mods.every((mod) => HOTKEY_MODIFIERS.includes(mod))
    if (!keyOk || !modsOk) return { spec: 'printscreen', ok: false, reason: text }
    const canonical = [...new Set(mods.map((mod) => (mod === 'windows' ? 'win' : mod)))]
    return { spec: [...canonical, key].join('+'), ok: true, reason: '' }
  }
  const hotkey = () => {
    const reference = config?.hotkey
    const value = reference !== null && typeof reference === 'object' && typeof reference.get === 'function'
      ? reference.get()
      : reference
    return normalizeHotkey(value)
  }
  const hotkeySpec = () => {
    const result = hotkey()
    if (!result.ok && !state.badHotkeyLogged) {
      state.badHotkeyLogged = true
      log('hotkey "' + String(config?.hotkey) + '" is not usable; using printscreen')
    }
    return result.spec
  }

  const ASR_LANGUAGES = ['auto', 'zh', 'en', 'ja', 'ko', 'yue']
  const asrLanguage = () => {
    const reference = config?.asrLanguage
    const value = reference !== null && typeof reference === 'object' && typeof reference.get === 'function'
      ? reference.get()
      : reference
    const language = typeof value === 'string' ? value.trim().toLowerCase() : ''
    return ASR_LANGUAGES.includes(language) ? language : 'auto'
  }

  /** Restart the voice client so a new --language takes effect. */
  function restartVoiceClient(reason) {
    if (voiceState.child === null) return
    log('voice client restarting (' + reason + ')')
    stopVoiceClient()
    const timer = setTimeout(() => {
      if (!state.disposed && voiceOptions.autoStart !== false) startVoiceClient()
    }, 400)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const replyMaxChars = () => {
    const reference = config?.replyMaxChars
    const value = reference !== null && typeof reference === 'object' && typeof reference.get === 'function'
      ? reference.get()
      : reference
    const chars = Math.floor(Number(value))
    if (!Number.isFinite(chars) || chars <= 0) return 0
    return Math.min(500, chars)
  }

  const ingestBase = () => 'http://127.0.0.1:' + String(options.port ?? 18801)

  /** Relative path from `fromDir` to `target`, always with forward slashes. */
  function relativePath(fromDir, target) {
    const from = path.resolve(fromDir).split(/[\\/]+/).filter(Boolean)
    const to = path.resolve(target).split(/[\\/]+/).filter(Boolean)
    let i = 0
    while (i < from.length && i < to.length && from[i].toLowerCase() === to[i].toLowerCase()) i += 1
    return [...new Array(from.length - i).fill('..'), ...to.slice(i)].join('/')
  }

  /** The locked session's working directory, when the controller knows it. */
  function lockedSessionCwd() {
    const fallback = () => (typeof options.defaultCwd === 'string' && options.defaultCwd.trim().length > 0
      ? options.defaultCwd.trim()
      : null)
    const id = lockedSessionId()
    if (id === '') return fallback()
    // The live Session carries its own header: that is the most reliable cwd,
    // and it works even when the controller list omits the session.
    try {
      const live = ctx.get('sessions')?.get?.(id) ?? null
      if (live !== null && typeof live.header?.cwd === 'string' && live.header.cwd.length > 0) {
        return live.header.cwd
      }
    } catch (error) {
      // fall through to the controller list
    }
    const hit = sessionCandidates().find((entry) => entry.sessionId === id)
    if (hit !== undefined && typeof hit.cwd === 'string' && hit.cwd.length > 0) return hit.cwd
    return fallback()
  }

  /** Reply file links are relative so the client offers file actions on them. */
  function outLinkBase() {
    const cwd = lockedSessionCwd()
    if (cwd === null) return audioDir().split('\\').join('/')
    return relativePath(cwd, audioDir())
  }

  const protocolForAgent = () => {
    const voice = { ...voiceInfo(), ingest: ingestBase(), outDir: outLinkBase() }
    const override = options.voiceProtocolText
    if (typeof override === 'string' && override.trim().length > 0) {
      return fillVoice(override, voice)
    }
    return buildProtocolText(voice.folder, replyMaxChars(), voice, activePersona())
  }

  const services = () => ({
    sessionController: ctx.get('sessionController'),
    sessions: ctx.get('sessions'),
    workspaceRegistry: ctx.get('workspaceRegistry'),
  })

  async function createSession(request) {
    const { sessionController, workspaceRegistry } = services()
    if (!sessionController) throw new ApiError(503, 'ptt/service-unavailable', 'sessionController is not mounted')
    const cwd = typeof request.cwd === 'string' && request.cwd.length > 0
      ? request.cwd
      : options.defaultCwd || undefined
    let workspaceId
    if (cwd && workspaceRegistry && typeof workspaceRegistry.resolveByPath === 'function') {
      try {
        const workspace = await workspaceRegistry.resolveByPath(cwd)
        if (workspace && typeof workspace.id === 'string') workspaceId = workspace.id
      } catch {
        /* fall back to an unattached Session */
      }
    }
    const preset = configuredPath(readVolatile('agentPreset', ''))
    const optionsForCreate = {
      ...(workspaceId ? { workspaceId } : (cwd ? { cwd } : {})),
      ...(preset !== '' ? { agentPreset: preset } : {}),
    }
    const created = await sessionController.create(optionsForCreate)
    return created.sessionId
  }

  async function admit(request) {
    const text = typeof request.text === 'string' ? request.text : ''
    if (text.trim().length === 0) {
      throw new ApiError(400, 'ptt/empty-text', 'text must contain non-whitespace characters')
    }
    if (text.length > MAX_TEXT_CHARS) {
      throw new ApiError(413, 'ptt/text-too-long', `text exceeds ${MAX_TEXT_CHARS} characters`)
    }
    const { sessionController } = services()
    if (!sessionController || typeof sessionController.prompt !== 'function') {
      throw new ApiError(503, 'ptt/service-unavailable', 'sessionController.prompt is not mounted')
    }

    const ranked = rankTargets(ctx, state)
    const lockedId = lockedSessionId()
    let sessionId
    let targetSource
    if (lockedId !== '' && request.newSession === true) {
      throw new ApiError(409, 'ptt/target-locked', `this install is locked to Session "${lockedId}"; newSession is unavailable`)
    }
    if (lockedId === '' && request.newSession === true && (typeof request.sessionId !== 'string' || request.sessionId.length === 0)) {
      sessionId = await createSession(request)
      state.created.add(sessionId)
      targetSource = 'created'
    } else {
      const resolved = resolution(state, ranked, request.sessionId, lockedId)
      if (resolved.sessionId === null) {
        throw new ApiError(404, 'ptt/no-live-session', 'no live Session to deliver into; open a conversation in DSH first')
      }
      sessionId = resolved.sessionId
      targetSource = resolved.targetSource
    }

    const mode = request.mode === 'steer' || request.mode === 'queue' ? request.mode : options.mode
    const requestId = randomUUID()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.admitTimeoutMs)
    const startedAt = Date.now()
    try {
      await sessionController.prompt({
        requestId,
        sessionId,
        mode,
        content: [{ type: 'text', text }],
        ...(typeof request.clientTimeZone === 'string' && request.clientTimeZone.length > 0
          ? { clientTimeZone: request.clientTimeZone }
          : {}),
      }, controller.signal)
    } finally {
      clearTimeout(timer)
    }
    if (targetSource !== 'created') state.sticky = sessionId
    if (freeMicState.enabled) {
      freeMicState.pendingRequestId = requestId
      freeMicState.ourMessageAt = null
      freeMicState.lastSubmitAt = Date.now()
      freeMicState.busy = true
      freeMicState.releaseAt = 0
      freeMicState.lastActivityAt = Date.now()
      log(`free-mic paused for turn requestId=${requestId}`)
    }
    state.admitted += 1
    const elapsedMs = Date.now() - startedAt
    log(`submit ok session=${sessionId} source=${targetSource} mode=${mode} chars=${text.length} ${elapsedMs}ms`)
    return { ok: true, sessionId, requestId, mode, targetSource, elapsedMs, version: VERSION }
  }

  function health() {
    const mounted = services()
    return {
      ok: true,
      version: VERSION,
      pid: process.pid,
      port: options.port,
      admitted: state.admitted,
      failed: state.failed,
      locked: lockedSessionId() === '' ? null : lockedSessionId(),
      voiceProtocolAgents: [...protocolOwners.keys()],
      voiceClient: voiceStatus(),
      freeMic: freeMicReport(),
      speakSkillPath: speakSkillPath(),
      voiceProfile: voiceInfo().profile,
      asrLanguage: asrLanguage(),
      hotkey: hotkeySpec(),
      voiceDisplay: voiceInfo().display,
      speakSkillPathLive: config?.speakSkillPath !== null
        && typeof config?.speakSkillPath === 'object'
        && typeof config.speakSkillPath.get === 'function',
      services: {
        sessionController: Boolean(mounted.sessionController),
        sessions: Boolean(mounted.sessions),
      },
    }
  }

  /** Read-only proof of what a Session currently holds, for acceptance runs. */
  function sessionReport(sessionId, match) {
    const sessions = services().sessions
    if (!sessions || typeof sessions.get !== 'function') {
      throw new ApiError(503, 'ptt/service-unavailable', 'sessions service is not mounted')
    }
    const session = sessions.get(sessionId)
    if (!session) {
      return { ok: false, sessionId, live: false, error: { code: 'ptt/session-not-live', message: 'no live Session with that id' } }
    }
    const events = session.ownEvents()
    let userMessages = 0
    let assistantMessages = 0
    let matches = 0
    let lastUserText = null
    let lastAssistantText = null
    let lastAssistantHasAudio = false
    for (const event of events) {
      if (event?.type === 'user/message') {
        userMessages += 1
        const text = textOfContent(event.data?.content)
        if (typeof match === 'string' && match.length > 0 && text.includes(match)) matches += 1
        lastUserText = snippet(text)
      } else if (event?.type === 'assistant/message') {
        assistantMessages += 1
        lastAssistantText = snippet(textOfContent(event.data?.message?.content ?? event.data?.content), 600)
        lastAssistantHasAudio = /\.wav/i.test(lastAssistantText)
      }
    }
    return {
      ok: true,
      sessionId,
      live: true,
      events: events.length,
      userMessages,
      assistantMessages,
      matches,
      lastUserText,
      lastAssistantText,
      lastAssistantHasAudio,
      lastEventAt: lastEventAt(session),
    }
  }

  function targetReport() {
    const ranked = rankTargets(ctx, state)
    const resolved = resolution(state, ranked, undefined, lockedSessionId())
    return {
      ok: true,
      target: resolved.sessionId,
      targetSource: resolved.targetSource,
      locked: lockedSessionId() === '' ? null : lockedSessionId(),
      pinned: state.pinned,
      sticky: state.sticky,
      voiceProtocol: {
        enabled: options.voiceProtocol !== false,
        agents: [...protocolOwners.keys()],
      },
      candidates: ranked.slice(0, 10).map((entry) => ({
        sessionId: entry.sessionId,
        inWorkspace: entry.inWorkspace,
        lastUserMessageAt: entry.lastUserMessageAt,
        lastEventAt: entry.lastEventAt,
      })),
    }
  }

  // ---- Replay: the reply text carries a link to /voice/play?name=<wav>. ----
  const REPLAY_NAME = /^(\d{2}-\d{2}-\d{2}-\d{2}-\d{2}|keep_[0-9A-Za-z_-]+)\.wav$/
  const REPLAY_DEBOUNCE_MS = 450
  let lastReplayName = ''
  let lastReplayAt = 0

  // ---- 外部依赖清单（配置页第 2 页 / 分发排错用） ----
  let depsCache = { at: 0, value: null }

  function sizeOf(target, ignore = []) {
    let bytes = 0
    let files = 0
    const stack = [target]
    while (stack.length > 0 && files < 200_000) {
      const current = stack.pop()
      let stat = null
      try {
        stat = fs.statSync(current)
      } catch (error) {
        continue
      }
      if (stat.isDirectory()) {
        let entries = []
        try {
          entries = fs.readdirSync(current, { withFileTypes: true })
        } catch (error) {
          continue
        }
        for (const entry of entries) {
          if (ignore.includes(entry.name)) continue
          stack.push(path.join(current, entry.name))
        }
      } else {
        bytes += stat.size
        files += 1
      }
    }
    return { bytes, files, truncated: files >= 200_000 }
  }

  const humanSize = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024
      unit += 1
    }
    return (unit === 0 ? String(value) : value.toFixed(value >= 100 ? 0 : 1)) + ' ' + units[unit]
  }

  /** Run a short python probe; returns {ok, detail}. */
  function runPythonCheck(python, code, timeoutMs = 25000) {
    if (!fs.existsSync(python)) return { ok: false, detail: 'python 不存在' }
    let exe = python
    if (/pythonw\.exe$/i.test(exe)) {
      const consoleExe = exe.replace(/pythonw\.exe$/i, 'python.exe')
      if (fs.existsSync(consoleExe)) exe = consoleExe
      else return { ok: false, detail: '只有 pythonw.exe，无法运行探测命令' }
    }
    const result = spawnSync(exe, ['-c', code], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    if (result.error !== undefined && result.error !== null) {
      return { ok: false, detail: String(result.error?.message ?? result.error) }
    }
    const stdout = String(result.stdout ?? '').trim()
    if (result.status !== 0) {
      const stderr = String(result.stderr ?? '').trim().split('\n').filter(Boolean).slice(-2).join(' | ')
      return { ok: false, detail: stderr === '' ? ('退出码 ' + result.status) : stderr }
    }
    return { ok: true, detail: stdout.split('\n').slice(-1)[0] || 'ok' }
  }

  const IMPORT_PROBE = "import sherpa_onnx, sounddevice, soundfile, pypinyin, keyboard, numpy\n"
    + "print('sherpa-onnx', sherpa_onnx.__version__, '| numpy', numpy.__version__, '| pypinyin', pypinyin.__version__)"
  const TORCH_PROBE = "import torch\nprint('torch', torch.__version__, '| cuda', torch.cuda.is_available())"

  function dependencyEntries() {
    const asrPython = asrPythonPath()
    const venvRoot = path.dirname(path.dirname(asrPython))
    const sitePackages = path.join(venvRoot, 'Lib', 'site-packages')
    const asrRoot = asrModelDirPath()
    const irodori = ttsIrodoriPath()
    const hfHome = hfHomePath()
    const asrSource = asrPythonEntry().source
    const asrModelSource = asrModelEntry().source
    const irodoriSource = ttsIrodoriEntry().source
    const ttsPySource = ttsPythonEntry().source
    const hfSource = hfHomeEntry().source
    const rows = [
      { id: 'venv-python', label: '识别用 Python（venv）', kind: 'file', target: asrPython, sizeTarget: venvRoot, source: asrSource,
        probe: 'imports',
        hint: '缺失就跑 tools\\setup-voice-venv.ps1 重建（含 6 个 pip 包）；装在别处请在配置页填「识别用 Python」' },
      { id: 'pkg-sherpa', label: 'sherpa-onnx（识别运行时）', kind: 'glob', target: sitePackages, match: 'sherpa_onnx-', source: asrSource,
        sizeTarget: path.join(sitePackages, 'sherpa_onnx'),
        hint: 'venv 里没这个包：重跑 setup 脚本，或手动 pip install sherpa-onnx' },
      { id: 'pkg-pypinyin', label: 'pypinyin（词表注音）', kind: 'glob', target: sitePackages, match: 'pypinyin-', source: asrSource,
        sizeTarget: path.join(sitePackages, 'pypinyin'),
        hint: '没有它替换词表无法工作：pip install pypinyin' },
      { id: 'pkg-sounddevice', label: 'sounddevice（录音）', kind: 'glob', target: sitePackages, match: 'sounddevice-', source: asrSource,
        sizeTarget: path.join(sitePackages, 'sounddevice.py'),
        hint: '录音依赖它：pip install sounddevice' },
      { id: 'pkg-soundfile', label: 'soundfile（音频文件）', kind: 'glob', target: sitePackages, match: 'soundfile-', source: asrSource,
        sizeTarget: path.join(sitePackages, 'soundfile.py'),
        hint: '读写 wav 依赖它：pip install soundfile' },
      { id: 'asr-model', label: 'ASR 模型 model.int8.onnx', kind: 'file', source: asrModelSource,
        target: path.join(asrRoot, 'sensevoice-onnx', 'model.int8.onnx'), minBytes: 100 * 1024 * 1024,
        hint: '228 MB 的模型不在插件里：放到 ASR 模型目录，或在配置页改「ASR 模型目录」' },
      { id: 'asr-tokens', label: 'ASR tokens.txt', kind: 'file', source: asrModelSource,
        target: path.join(asrRoot, 'sensevoice-onnx', 'tokens.txt'), minBytes: 10 * 1024,
        hint: '与模型同目录，缺了模型加载会失败' },
      { id: 'vad-model', label: 'Silero VAD', kind: 'file', source: asrModelSource,
        target: path.join(asrRoot, 'silero', 'silero_vad.onnx'), minBytes: 100 * 1024,
        hint: '断句用的 VAD，缺了自由麦克风无法切句' },
      { id: 'irodori-src', label: 'Irodori-TTS 源码', kind: 'dir', target: irodori, ignore: ['.venv'], source: irodoriSource,
        requireFile: path.join(irodori, 'irodori_tts', 'inference_runtime.py'),
        hint: '需要含 irodori_tts/inference_runtime.py；装在别处请在配置页填「Irodori 源码」' },
      { id: 'tts-python', label: '合成用 Python（Irodori venv）', kind: 'file', target: ttsPythonPath(), source: ttsPySource,
        probe: 'torch',
        hint: '缺了就先建 Irodori venv（约 5.2 GB）；装在别处请在配置页填「合成用 Python」' },
      { id: 'hf-cache', label: 'HF 模型缓存', kind: 'dir', target: hfHome, source: hfSource,
        requireDir: path.join(hfHome, 'hub', 'models--Aratako--Irodori-TTS-v4.1-Small'),
        hint: '需要含 hub\\models--Aratako--Irodori-TTS-v4.1-Small；插件强制 HF_HUB_OFFLINE=1，缺了不会自动下载，按 docs\\DEPENDENCIES.zh.md §7 手动拉取；装在别处请填「HF 缓存目录」' },
      { id: 'play-media', label: '播放脚本', kind: 'file',
        target: path.join(PLUGIN_DIR, 'tools', 'play_media.ps1'),
        hint: '插件自带，缺失说明安装不完整（重新安装 bundle）' },
      { id: 'recycle-ps1', label: '回收站脚本', kind: 'file',
        target: path.join(PLUGIN_DIR, 'tools', 'recycle.ps1'),
        hint: '音频自清理用；缺失时清理会被跳过，不会永久删除' },
      { id: 'out-dir', label: '音频输出目录', kind: 'dir', target: audioDir(), optional: true,
        hint: '插件会在需要时自动创建' },
      { id: 'logs-dir', label: '日志目录', kind: 'dir', target: path.join(PLUGIN_DIR, 'logs'), optional: true,
        hint: '插件会自动创建' },
    ]
    return rows.map((row) => {
      let exists = false
      let stat = null
      if (row.kind === 'glob') {
        try {
          exists = fs.readdirSync(row.target).some((name) => name.startsWith(row.match))
        } catch (error) {
          exists = false
        }
      } else {
        try {
          stat = fs.statSync(row.target)
          exists = row.kind === 'dir' ? stat.isDirectory() : stat.isFile()
        } catch (error) {
          exists = false
        }
      }
      const sizeTarget = row.sizeTarget !== undefined && fs.existsSync(row.sizeTarget) ? row.sizeTarget : row.target
      const size = exists ? sizeOf(sizeTarget, row.ignore ?? []) : { bytes: 0, files: 0, truncated: false }
      // ---- 完整性：只有存在时才继续探测 ----
      let integrity = { ok: exists, detail: '' }
      if (exists && row.minBytes !== undefined && size.bytes < row.minBytes) {
        integrity = { ok: false, detail: '文件偏小（' + humanSize(size.bytes) + '），疑似下载中断' }
      } else if (exists && row.requireFile !== undefined && !fs.existsSync(row.requireFile)) {
        integrity = { ok: false, detail: '缺少 ' + path.basename(row.requireFile) }
      } else if (exists && row.requireDir !== undefined && !fs.existsSync(row.requireDir)) {
        integrity = { ok: false, detail: '缓存里没有 Irodori-TTS-v4.1-Small 权重' }
      } else if (exists && row.probe === 'imports') {
        integrity = runPythonCheck(row.target, IMPORT_PROBE)
      } else if (exists && row.probe === 'torch') {
        integrity = runPythonCheck(row.target, TORCH_PROBE)
      } else if (exists) {
        integrity = { ok: true, detail: row.kind === 'glob' ? '已安装' : '存在' }
      }
      return {
        id: row.id,
        label: row.label,
        kind: row.kind,
        path: row.target,
        source: row.source ?? '插件自带',
        exists,
        ok: exists && integrity.ok,
        optional: row.optional === true,
        bytes: size.bytes,
        size: humanSize(size.bytes),
        files: size.files,
        truncated: size.truncated,
        integrity,
        hint: row.hint,
      }
    })
  }

  function dependencyReport() {
    adoptDiscoveredPaths()
    const now = Date.now()
    if (depsCache.value !== null && now - depsCache.at < 30_000) return depsCache.value
    const items = dependencyEntries()
    const missing = items.filter((item) => item.optional !== true && item.ok === false)
    const value = {
      ok: true,
      checkedAt: new Date().toISOString(),
      version: VERSION,
      missing: missing.map((item) => item.id),
      items,
    }
    depsCache = { at: now, value }
    return value
  }

  // ---- 外部依赖下载安装（依赖页的「下载并安装缺失」） ----
  const depsManifestPath = () => path.join(PLUGIN_DIR, 'deps', 'manifest.json')
  const depsDefaultRoot = () => path.join(PLUGIN_DIR, 'deps')
  const depsState = {
    running: false,
    root: '',
    current: '',
    label: '',
    received: 0,
    total: 0,
    done: [],
    failed: [],
    error: '',
    startedAt: 0,
    finishedAt: 0,
  }

  function readDepsManifest() {
    try {
      return JSON.parse(fs.readFileSync(depsManifestPath(), 'utf8'))
    } catch (error) {
      log('deps manifest unreadable: ' + (error?.message ?? error))
      return { items: [], manual: [] }
    }
  }

  /** Download one URL to a file, following redirects and reporting progress. */
  function downloadToFile(url, dest, onProgress, redirects = 0) {
    return new Promise((resolve, reject) => {
      if (redirects > 5) {
        reject(new Error('too many redirects'))
        return
      }
      let client = null
      try {
        client = url.startsWith('https:') ? https : http
      } catch (error) {
        reject(error)
        return
      }
      const request = client.get(url, { headers: { 'user-agent': 'dsh-chatterbox/' + VERSION } }, (response) => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume()
          const next = new URL(response.headers.location, url).toString()
          downloadToFile(next, dest, onProgress, redirects + 1).then(resolve, reject)
          return
        }
        if (status !== 200) {
          response.resume()
          reject(new Error('HTTP ' + status + ' for ' + url))
          return
        }
        const total = Number(response.headers['content-length'] ?? 0)
        let received = 0
        const sink = fs.createWriteStream(dest)
        response.on('data', (chunk) => {
          received += chunk.length
          onProgress(received, total)
        })
        response.on('error', (error) => {
          sink.destroy()
          reject(error)
        })
        sink.on('error', reject)
        sink.on('finish', () => resolve({ bytes: received, total }))
        response.pipe(sink)
      })
      request.on('error', reject)
      request.setTimeout(60_000, () => request.destroy(new Error('download timeout')))
    })
  }

  function extractArchive(archive, targetDir, kind) {
    fs.mkdirSync(targetDir, { recursive: true })
    const args = kind === 'tar.bz2' ? ['-xjf', archive, '-C', targetDir] : ['-xf', archive, '-C', targetDir]
    const result = spawnSync('tar', args, { encoding: 'utf8', timeout: 300_000, windowsHide: true })
    if (result.error !== undefined && result.error !== null) {
      throw new Error('解压失败：' + String(result.error?.message ?? result.error))
    }
    if (result.status !== 0) {
      throw new Error('解压失败：' + String(result.stderr ?? '').trim().split('\n').slice(-1)[0])
    }
  }

  function moveInto(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    try {
      fs.rmSync(to, { recursive: true, force: true })
    } catch (error) {
      // target may not exist
    }
    fs.renameSync(from, to)
  }

  function recordInstalledPaths(root, item) {
    if (!Array.isArray(item.paths) || item.paths.length === 0) return
    const current = readExternalPaths()
    const patch = {}
    for (const entry of item.paths) {
      if (typeof entry.key !== 'string' || typeof entry.value !== 'string') continue
      if (current[entry.key] !== '') continue          // never overwrite a user choice
      patch[entry.key] = path.join(root, entry.value)
    }
    if (Object.keys(patch).length > 0) writeExternalPaths(patch)
  }

  /** Fill empty ttsPython/hfHome once the files actually exist. */
  function adoptDiscoveredPaths() {
    const current = readExternalPaths()
    const patch = {}
    if (current.ttsPython === '') {
      const python = firstExisting(ttsPythonCandidates())
      if (fs.existsSync(python)) patch.ttsPython = python
    }
    if (current.hfHome === '') {
      const home = firstExisting(hfHomeCandidates())
      if (fs.existsSync(path.join(home, 'hub', 'models--Aratako--Irodori-TTS-v4.1-Small'))) patch.hfHome = home
    }
    if (Object.keys(patch).length > 0) {
      writeExternalPaths(patch)
      log('deps: adopted ' + JSON.stringify(patch))
    }
  }

  async function installOne(root, item) {
    const target = path.join(root, item.installTo)
    // Already there? Never re-download 155 MB just because the button was clicked again.
    try {
      const stat = fs.statSync(target)
      const present = item.kind === 'file' ? stat.size > 1024 : stat.isDirectory() && fs.readdirSync(target).length > 0
      if (present) {
        depsState.done.push(item.id + '（已存在）')
        log('deps install: ' + item.id + ' already at ' + target)
        return
      }
    } catch (error) {
      // not there yet
    }
    depsState.current = item.id
    depsState.label = item.label
    depsState.received = 0
    depsState.total = Number(item.sizeBytes) || 0
    const work = path.join(root, '.tmp')
    fs.mkdirSync(work, { recursive: true })
    const archive = path.join(work, item.id + (item.kind === 'file' ? '.bin' : '.' + item.kind.replace('.', '')))
    try {
      const outcome = await downloadToFile(item.url, archive, (received, total) => {
        depsState.received = received
        if (total > 0) depsState.total = total
      })
      depsState.received = outcome.bytes
      if (item.kind === 'file') {
        moveInto(archive, target)
      } else {
        const unpacked = path.join(work, item.id)
        extractArchive(archive, unpacked, item.kind)
        const source = item.archiveRoot ? path.join(unpacked, item.archiveRoot) : unpacked
        if (!fs.existsSync(source)) throw new Error('压缩包里没有 ' + (item.archiveRoot ?? '根目录'))
        moveInto(source, target)
        try {
          fs.rmSync(unpacked, { recursive: true, force: true })
        } catch (error) {
          // leftover temp dir is harmless
        }
      }
      try {
        fs.rmSync(archive, { force: true })
      } catch (error) {
        // ignore
      }
      recordInstalledPaths(root, item)
      depsState.done.push(item.id)
      log('deps install: ' + item.id + ' -> ' + target)
    } catch (error) {
      depsState.failed.push(item.id)
      depsState.error = String(error?.message ?? error)
      log('deps install failed: ' + item.id + ' — ' + depsState.error)
    }
  }

  async function runDepsInstall(ids, root) {
    if (depsState.running) return
    const manifest = readDepsManifest()
    const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null
    const installRoot = configuredPath(root) !== '' ? configuredPath(root) : depsDefaultRoot()
    depsState.running = true
    depsState.root = installRoot
    depsState.current = ''
    depsState.label = ''
    depsState.received = 0
    depsState.total = 0
    depsState.done = []
    depsState.failed = []
    depsState.error = ''
    depsState.startedAt = Date.now()
    depsState.finishedAt = 0
    try {
      for (const item of Array.isArray(manifest.items) ? manifest.items : []) {
        if (wanted !== null && !wanted.has(item.id)) continue
        await installOne(installRoot, item)
      }
    } finally {
      depsState.running = false
      depsState.current = ''
      depsState.finishedAt = Date.now()
      log('deps install finished: done=' + JSON.stringify(depsState.done)
        + ' failed=' + JSON.stringify(depsState.failed))
      adoptDiscoveredPaths()
      depsCache = { at: 0, value: null }             // force the next check to be fresh
    }
  }

  // ---- 音频自清理：超过 N 天的 out\*.wav 移入回收站（keep_ 豁免） ----
  function sweepAudio() {
    const days = retentionDays()
    if (days <= 0) return { moved: 0, skipped: 'disabled' }
    const dir = audioDir()
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch (error) {
      return { moved: 0, skipped: 'no-dir' }
    }
    const cutoff = Date.now() - days * 86400 * 1000
    const targets = []
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.wav')) continue
      if (name.toLowerCase().startsWith('keep_')) continue
      const file = path.join(dir, name)
      try {
        if (fs.statSync(file).mtimeMs < cutoff) targets.push(file)
      } catch (error) {
        // A file that vanished between readdir and stat needs no cleanup.
      }
    }
    if (targets.length === 0) return { moved: 0 }
    const script = path.join(PLUGIN_DIR, 'tools', 'recycle.ps1')
    if (!fs.existsSync(script)) {
      log('audio sweep skipped: tools/recycle.ps1 is missing')
      return { moved: 0, skipped: 'no-script' }
    }
    const result = spawnSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Paths', ...targets,
    ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
    const detail = String(result.stdout ?? '').trim() || String(result.stderr ?? '').trim() || ('rc=' + result.status)
    log(`audio sweep: ${targets.length} file(s) older than ${days}d — ${detail}`)
    return { moved: targets.length }
  }

  // ---- 本机 TTS 服务：插件自己拉起、看护、退出时收掉 ----
  const ttsState = { child: null, timer: null, attempts: 0 }

  /** Every dir the daemon should scan: the active profile's parent + discoverable ones. */
  const ttsVoicesDir = () => {
    const folder = speakSkillPath()
    const dirs = [
      folder === '' ? '' : path.dirname(folder),
      ...voiceSearchDirs(),
    ].filter((dir) => dir !== '' && fs.existsSync(dir))
    return [...new Set(dirs)].join(';')
  }
  const ttsPort = () => String(options.ttsPort ?? 8763)
  const configuredPath = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : '')

  // ---- 外部依赖路径：插件自己的 JSON（配置页第 2 页写，不塞进 Config） ----
  const PATHS_FILE = 'paths.json'
  const PATH_KEYS = ['asrPython', 'asrModelDir', 'ttsIrodori', 'ttsPython', 'hfHome']
  const pathsFile = () => path.join(LOCAL_DIR, 'dsh', 'dsh-chatterbox', PATHS_FILE)

  function readExternalPaths() {
    const empty = Object.fromEntries(PATH_KEYS.map((key) => [key, '']))
    try {
      const data = JSON.parse(fs.readFileSync(pathsFile(), 'utf8') || '{}')
      const out = { ...empty }
      for (const key of PATH_KEYS) {
        if (typeof data[key] === 'string' && data[key].trim() !== '') out[key] = data[key].trim()
      }
      return out
    } catch (error) {
      if (error?.code !== 'ENOENT') log('paths read failed: ' + (error?.message ?? error))
      return empty
    }
  }

  function writeExternalPaths(patch) {
    const current = readExternalPaths()
    for (const key of PATH_KEYS) {
      if (typeof patch[key] !== 'string') continue
      current[key] = patch[key].trim()
    }
    const target = pathsFile()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temp = target + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(current, null, 2) + '\n', 'utf8')
    fs.renameSync(temp, target)
    return current
  }


  /** Resolve one external path: explicit config, then environment, then default. */
  function resolveExternal(configValue, envName, fallback) {
    const configured = configuredPath(configValue)
    if (configured !== '') return { value: configured, source: '配置' }
    const fromEnv = configuredPath(process.env[envName])
    if (fromEnv !== '') return { value: fromEnv, source: '环境变量 ' + envName }
    return { value: fallback, source: '默认' }
  }

  /** First existing candidate, else the first one (so hints show where it would go). */
  function firstExisting(candidates) {
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate
    }
    return candidates[0]
  }

  const irodoriCandidates = () => [
    path.join(PLUGIN_DIR, 'deps', 'irodori'),
    path.join(PLUGIN_DIR, '..', 'irodori', 'Irodori-TTS-main'),
  ]
  const hfHomeCandidates = () => [
    path.join(PLUGIN_DIR, 'deps', 'hf-cache'),
    path.join(PLUGIN_DIR, '..', 'cache', 'hf-cache'),
  ]
  const ttsPythonCandidates = () => irodoriCandidates().map((dir) => path.join(dir, '.venv', 'Scripts', 'python.exe'))

  const ttsPythonEntry = () => resolveExternal(readExternalPaths().ttsPython, 'CHATTERBOX_TTS_PYTHON',
    firstExisting(ttsPythonCandidates()))
  const ttsIrodoriEntry = () => resolveExternal(readExternalPaths().ttsIrodori, 'CHATTERBOX_IRODORI',
    firstExisting(irodoriCandidates()))
  const hfHomeEntry = () => resolveExternal(readExternalPaths().hfHome, 'CHATTERBOX_HF_HOME',
    firstExisting(hfHomeCandidates()))
  const asrPythonEntry = () => resolveExternal(readExternalPaths().asrPython, 'CHATTERBOX_ASR_PYTHON',
    path.join(LOCAL_DIR, 'dsh', 'dsh-chatterbox', 'venv', 'Scripts', 'pythonw.exe'))
  const asrModelEntry = () => resolveExternal(readExternalPaths().asrModelDir, 'CHATTERBOX_ASR_MODELS',
    path.join(process.env.USERPROFILE || HOME_DIR, '.dsh', 'speech-to-text', 'sensevoice', 'models'))
  const ttsPythonPath = () => ttsPythonEntry().value
  const ttsIrodoriPath = () => ttsIrodoriEntry().value
  const hfHomePath = () => hfHomeEntry().value
  const asrPythonPath = () => asrPythonEntry().value
  const asrModelDirPath = () => asrModelEntry().value

  async function ttsHealth(timeoutMs = 1500) {
    try {
      const response = await fetch('http://127.0.0.1:' + ttsPort() + '/health', {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) return null
      const body = await response.json()
      return body && body.ok === true ? body : null
    } catch (error) {
      return null
    }
  }

  async function ensureTts() {
    if (options.ttsAutoStart === false) return
    if (ttsState.child !== null) return
    const live = await ttsHealth()
    if (live !== null) {
      log('tts: reusing the service already on 127.0.0.1:' + ttsPort())
      return
    }
    const script = path.join(PLUGIN_DIR, 'src', 'tts', 'tts_daemon.py')
    const python = ttsPythonPath()
    if (!fs.existsSync(script)) { log('tts: daemon script missing: ' + script); return }
    if (!fs.existsSync(python)) { log('tts: python not found: ' + python); return }
    try {
      fs.mkdirSync(audioDir(), { recursive: true })
      fs.mkdirSync(path.join(PLUGIN_DIR, 'logs'), { recursive: true })
    } catch (error) {
      log('tts: cannot prepare dirs: ' + (error?.message ?? error))
    }
    const child = spawn(python, [
      script,
      '--port', ttsPort(),
      '--voices', ttsVoicesDir(),
      '--out', audioDir(),
      '--logs', path.join(PLUGIN_DIR, 'logs'),
      '--hf-home', hfHomePath(),
      '--irodori', ttsIrodoriPath(),
      '--parent-pid', String(process.pid),
    ], { cwd: PLUGIN_DIR, stdio: 'ignore', windowsHide: true })
    ttsState.child = child
    ttsState.attempts += 1
    log('tts: spawned daemon pid=' + child.pid + ' port=' + ttsPort() + ' voices=' + ttsVoicesDir())
    child.on('error', (error) => log('tts: spawn failed: ' + (error?.message ?? error)))
    child.on('exit', (code) => {
      if (ttsState.child === child) ttsState.child = null
      log('tts: daemon exited code=' + code)
      if (state.disposed || options.ttsAutoStart === false || ttsState.attempts >= 3) return
      const timer = setTimeout(() => {
        if (!state.disposed) ensureTts().catch(() => {})
      }, 5000)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  /** Resolve a replay name to a file inside audioDir (no traversal, no guessing). */
  function resolveReplayFile(name) {
    const base = path.basename(String(name ?? ''))
    if (!REPLAY_NAME.test(base)) return null
    const target = path.join(audioDir(), base)
    return fs.existsSync(target) ? target : null
  }

  /**
   * Play one stored wav. While the free microphone is on, it is paused first and
   * re-armed by the same watcher used for spoken replies (300ms after the player
   * exits), so the speaker output never lands in the recording.
   */
  function replayAudio(target) {
    const base = path.basename(target)
    const now = Date.now()
    if (base === lastReplayName && now - lastReplayAt < REPLAY_DEBOUNCE_MS) {
      log('replay ignored (duplicate) ' + base)
      return { name: base, deduped: true }
    }
    lastReplayName = base
    lastReplayAt = now
    const player = path.join(PLUGIN_DIR, 'tools', 'play_media.ps1')
    if (!fs.existsSync(player)) throw new ApiError(500, 'ptt/no-player', 'play_media.ps1 not found: ' + player)
    if (freeMicState.enabled) {
      freeMicState.busy = true
      freeMicState.replayBusy = true
      freeMicState.replayStartedAt = Date.now()
      freeMicState.pendingRequestId = null
      freeMicState.ourMessageAt = null
      log('free-mic paused for replay ' + path.basename(target))
    }
    spawn('powershell', [
      '-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', player, '-Path', target,
    ], { windowsHide: true, stdio: 'ignore' })
    waitForPlayback()
    return { name: base, deduped: false }
  }
  /**
   * Register the voice protocol section on ONE agent's scope. A global
   * registration would leak into every conversation, so this only ever runs on
   * agent.ctx of the locked Session.
   */
  /** Candidate delivery targets for the settings dropdown. */
  function sessionCandidates() {
    const controllers = services()
    const rows = []
    const seen = new Set()
    const push = (entry) => {
      if (!entry || typeof entry.sessionId !== 'string' || entry.sessionId.length === 0) return
      if (seen.has(entry.sessionId) || state.created.has(entry.sessionId)) return
      if (entry.origin === 'subagent') return
      seen.add(entry.sessionId)
      rows.push(entry)
    }
    const controller = controllers.sessionController
    if (controller && typeof controller.list === 'function') {
      try {
        const listed = controller.list({})
        for (const item of listed?.items ?? []) {
          push({
            sessionId: item.sessionId,
            cwd: typeof item.cwd === 'string' ? item.cwd : null,
            updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : null,
            running: item.running === true,
            live: item.agentAvailable === true,
            blank: item.blank === true,
            origin: item.origin ?? null,
            title: null,
          })
        }
      } catch (error) {
        log(`session list failed, falling back to live Sessions: ${error?.message ?? error}`)
      }
    }
    if (rows.length === 0) {
      const sessions = ctx.get('sessions')
      if (sessions && typeof sessions.list === 'function') {
        for (const session of sessions.list()) {
          push({
            sessionId: session.id,
            cwd: typeof session.header?.cwd === 'string' ? session.header.cwd : null,
            updatedAt: null,
            running: true,
            live: true,
            blank: false,
            origin: null,
            title: null,
          })
        }
      }
    }
    // The configured target must always be selectable, even when the list does
    // not report it (closed Session, different workspace, ...).
    const current = lockedSessionId()
    if (current !== '' && !seen.has(current)) {
      let liveSession = null
      try {
        liveSession = ctx.get('sessions')?.get?.(current) ?? null
      } catch {
        liveSession = null
      }
      push({
        sessionId: current,
        cwd: typeof liveSession?.header?.cwd === 'string' ? liveSession.header.cwd : null,
        updatedAt: null,
        running: liveSession !== null,
        live: liveSession !== null,
        blank: false,
        origin: null,
        title: null,
      })
    }

    // Fill titles for live Sessions (the title service folds the Session log).
    const titles = ctx.get('sessionTitle')
    const sessions = ctx.get('sessions')
    if (titles && typeof titles.get === 'function' && sessions && typeof sessions.get === 'function') {
      for (const row of rows) {
        if (!row.live) continue
        try {
          const session = sessions.get(row.sessionId)
          if (!session) continue
          const snapshot = titles.get(session)
          if (snapshot && typeof snapshot.title === 'string' && snapshot.title.length > 0) row.title = snapshot.title
        } catch {
          /* a missing title is not an error */
        }
      }
    }
    const label = (row) => {
      if (row.title) return row.title
      const base = row.cwd ? path.basename(row.cwd) : ''
      const stamp = row.updatedAt ? new Date(row.updatedAt) : null
      const when = stamp === null ? '' : `${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')} ${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`
      return [base, when, row.sessionId.slice(8, 16)].filter((part) => part.length > 0).join(' · ')
    }
    return rows
      .filter((row) => row.blank !== true)
      .sort((left, right) => {
        if (left.live !== right.live) return left.live ? -1 : 1
        return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      })
      .slice(0, 50)
      .map((row) => ({ ...row, label: label(row) + (row.sessionId === lockedSessionId() ? '（当前）' : '') }))
  }

  /**
   * Keep protocol attachments aligned with the current target: attach to the
   * new Session (if live) and detach every other one.
   */
  function syncProtocols() {
    const target = lockedSessionId()
    for (const [id, disposer] of [...protocolOwners.entries()]) {
      if (id === target) continue
      protocolOwners.delete(id)
      try {
        Promise.resolve(disposer()).catch(() => {})
      } catch {
        /* the agent may already be gone */
      }
    }
    if (target === '') return
    const agents = ctx.get('agents')
    if (!agents || typeof agents.list !== 'function') return
    try {
      for (const agent of agents.list()) {
        if (agent && agent.id === target) attachProtocol(agent)
      }
    } catch (error) {
      log(`protocol sync failed: ${error?.message ?? error}`)
    }
  }

  function attachProtocol(agent) {
    const target = lockedSessionId()
    if (target === '' || options.voiceProtocol === false) return
    if (!agent || agent.id !== target) return
    if (protocolOwners.has(agent.id)) return
    const agentCtx = agent.ctx
    if (!agentCtx || typeof agentCtx.effect !== 'function') {
      log(`voice protocol: agent ${agent.id} exposes no ctx; skipped`)
      return
    }
    try {
      const disposer = agentCtx.effect(() => {
        const prompt = agentCtx.get('systemPrompt')
        if (!prompt || typeof prompt.section !== 'function') return () => {}
        return prompt.section({
          name: 'ptt:voice-conversation',
          order: Number.isFinite(Number(options.voiceProtocolOrder)) ? Number(options.voiceProtocolOrder) : 50,
          text: () => protocolForAgent(),
          interpolate: false,
        })
      })
      protocolOwners.set(agent.id, disposer)
      log(`voice protocol attached to agent ${agent.id}`)
    } catch (error) {
      log(`voice protocol attach failed for ${agent.id}: ${error?.message ?? error}`)
    }
  }

  function detachProtocols() {
    for (const [sessionId, disposer] of protocolOwners) {
      try {
        disposer?.()
      } catch (error) {
        log(`voice protocol detach failed for ${sessionId}: ${error?.message ?? error}`)
      }
    }
    protocolOwners.clear()
  }

  function authorized(request) {
    if (options.token === '') return true
    return request.headers['x-ptt-token'] === options.token
  }

  function send(response, status, payload) {
    const body = JSON.stringify(payload)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-ptt-token',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    })
    response.end(body)
  }

  async function route(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const routeName = `${request.method} ${url.pathname}`

    if (request.method === 'OPTIONS') {
      // Preflight: headers only, no body (a 204 must carry no payload).
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, x-ptt-token',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-max-age': '600',
      })
      response.end()
      return
    }
    if (routeName === 'GET /' || routeName === 'GET /ptt') {
      send(response, 200, {
        ok: true,
        service: 'dsh-chatterbox',
        version: VERSION,
        routes: [
          'GET /health', 'GET /target', 'POST /target', 'POST /submit',
          'GET /session?id=&match=', 'GET /voice/state', 'POST /voice/free-mic',
          'POST /voice/listening', 'POST /voice/check-path', 'GET /voice/sessions', 'GET /voice/profiles', 'GET /voice/play?name=', 'POST /voice/replay', 'GET /voice/glossary', 'POST /voice/glossary', 'DELETE /voice/glossary', 'POST /voice/sweep', 'GET /voice/deps', 'GET /voice/paths', 'POST /voice/paths', 'GET /voice/deps/install', 'POST /voice/deps/install', 'GET /voice/personas', 'GET /voice/presets', 'GET /voice/protocol',
        ],
      })
      return
    }
    if (routeName === 'GET /health' || routeName === 'GET /ptt/health') {
      send(response, 200, health())
      return
    }
    if (routeName === 'GET /target' || routeName === 'GET /ptt/target') {
      send(response, 200, targetReport())
      return
    }
    if (request.method === 'GET' && url.pathname.startsWith('/voice/audio/')) {
      // The reply links to this URL: it works from any page and any working
      // directory, unlike a relative file path under voice_train\out.
      const name = decodeURIComponent(url.pathname.slice('/voice/audio/'.length))
      const target = resolveReplayFile(name)
      if (target === null) throw new ApiError(404, 'ptt/no-audio', 'unknown audio: ' + name)
      let stat = null
      try {
        stat = fs.statSync(target)
      } catch (error) {
        throw new ApiError(404, 'ptt/no-audio', 'cannot stat: ' + name)
      }
      response.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': stat.size,
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      })
      fs.createReadStream(target).pipe(response)
      return
    }
    if (routeName === 'GET /voice/play') {
      const name = url.searchParams.get('name') ?? ''
      const target = resolveReplayFile(name)
      if (target === null) throw new ApiError(404, 'ptt/no-audio', 'unknown audio: ' + name)
      // fetch needs a JSON *string*: JSON.stringify twice, once for the wire
      // format and once to embed it as a JS string literal in the page.
      const bodyLiteral = JSON.stringify(JSON.stringify({ name: path.basename(target) })).replace(/</g, '\\u003c')
      const page = [
        '<!doctype html><meta charset="utf-8"><title>重放</title>',
        '<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;',
        'font:14px system-ui;background:#111;color:#ddd">',
        '<div id=s>▶ 正在重放…</div>',
        '<script>',
        'const box=document.getElementById("s");',
        'fetch("/voice/replay",{method:"POST",headers:{"content-type":"application/json"},body:' + bodyLiteral + '})',
        '  .then(r=>r.json()).then(b=>{if(!b||b.ok!==true)throw new Error((b&&b.error&&b.error.message)||"Host 拒绝了重放");',
        '    box.textContent="▶ 重放中…播完会自动恢复收音，本页可以关掉";})',
        '  .catch(e=>{box.textContent="重放失败："+((e&&e.message)||e);});',
        '</sc' + 'ript>',
      ].join('')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(page)
      return
    }
    if (routeName === 'POST /voice/replay') {
      const body = await readJsonBody(request)
      const target = resolveReplayFile(body.name)
      if (target === null) throw new ApiError(404, 'ptt/no-audio', 'unknown audio: ' + String(body.name))
      const outcome = replayAudio(target)
      log(outcome.deduped ? 'replay deduped ' + outcome.name : 'replay ' + outcome.name)
      send(response, 200, { ok: true, name: outcome.name, playing: true, deduped: outcome.deduped })
      return
    }
    if (routeName === 'GET /voice/deps/install') {
      send(response, 200, {
        ok: true,
        running: depsState.running,
        root: depsState.root || depsDefaultRoot(),
        current: depsState.current,
        label: depsState.label,
        received: depsState.received,
        total: depsState.total,
        done: depsState.done,
        failed: depsState.failed,
        error: depsState.error,
        startedAt: depsState.startedAt,
        finishedAt: depsState.finishedAt,
        manifest: readDepsManifest(),
      })
      return
    }
    if (routeName === 'POST /voice/deps/install') {
      const body = await readJsonBody(request)
      if (depsState.running) {
        send(response, 202, { ok: true, running: true, message: '已有安装在跑' })
        return
      }
      const ids = Array.isArray(body.ids) ? body.ids : undefined
      const root = typeof body.root === 'string' ? body.root : ''
      runDepsInstall(ids, root).catch((error) => log('deps install crashed: ' + (error?.message ?? error)))
      send(response, 202, { ok: true, running: true, root: configuredPath(root) || depsDefaultRoot() })
      return
    }
    if (routeName === 'GET /voice/presets') {
      const items = await listPresets()
      const target = lockedSessionId() !== '' ? lockedSessionId() : null
      send(response, 200, {
        ok: true,
        configured: readVolatile('agentPreset', ''),
        current: agentPresetId(),
        target,
        targetPreset: target === null ? null : (sessionPreset(target) ?? null),
        available: presetService() !== null,
        items,
      })
      return
    }
    if (routeName === 'GET /voice/personas') {
      const configured = readVolatile('agentPersona', DEFAULT_PERSONA_ID)
      const items = listPersonaFiles()
      const current = items.find((item) => item.id === configured) ?? items.find((item) => item.id === DEFAULT_PERSONA_ID) ?? null
      send(response, 200, {
        ok: true,
        current: current === null ? DEFAULT_PERSONA_ID : current.id,
        configured,
        items,
      })
      return
    }
    if (routeName === 'GET /voice/protocol') {
      // ?persona=<id> previews a persona without touching the saved setting.
      const preview = url.searchParams.get('persona')
      const configured = readVolatile('agentPersona', DEFAULT_PERSONA_ID)
      if (typeof preview === 'string' && preview !== '') {
        const voice = { ...voiceInfo(), ingest: ingestBase(), outDir: outLinkBase() }
        send(response, 200, {
          ok: true,
          persona: preview,
          configured,
          preview: true,
          text: buildProtocolText(voice.folder, replyMaxChars(), voice, readPersona(preview)),
        })
        return
      }
      const persona = activePersona()
      send(response, 200, {
        ok: true,
        persona: persona === null ? DEFAULT_PERSONA_ID : (persona.id ?? DEFAULT_PERSONA_ID),
        configured: readVolatile('agentPersona', ''),
        preset: agentPresetId(),
        text: protocolForAgent(),
      })
      return
    }
    if (routeName === 'GET /voice/paths') {
      const values = readExternalPaths()
      send(response, 200, {
        ok: true,
        file: pathsFile(),
        values,
        resolved: {
          asrPython: asrPythonEntry(),
          asrModelDir: asrModelEntry(),
          ttsIrodori: ttsIrodoriEntry(),
          ttsPython: ttsPythonEntry(),
          hfHome: hfHomeEntry(),
        },
      })
      return
    }
    if (routeName === 'POST /voice/paths') {
      const body = await readJsonBody(request)
      const saved = writeExternalPaths(body ?? {})
      log('external paths saved: ' + JSON.stringify(saved))
      send(response, 200, { ok: true, file: pathsFile(), values: saved })
      return
    }
    if (routeName === 'GET /voice/deps') {
      send(response, 200, dependencyReport())
      return
    }
    if (routeName === 'POST /voice/sweep') {
      const outcome = sweepAudio()
      send(response, 200, {
        ok: true,
        retentionDays: retentionDays(),
        out: audioDir(),
        ...outcome,
      })
      return
    }
    if (routeName === 'GET /voice/glossary') {
      const terms = hydrateGlossary()
      send(response, 200, { ok: true, file: glossaryFile(), count: terms.length, terms })
      return
    }
    if (routeName === 'POST /voice/glossary') {
      const body = await readJsonBody(request)
      const { items, rejected } = splitGlossaryInput(body.text ?? body.terms)
      if (items.length === 0 && rejected.length === 0) {
        throw new ApiError(400, 'ptt/bad-request', 'send {"text":"钉宫病 灼眼的夏娜=zhuoyandexiana"}')
      }
      const manual = {}
      for (const item of items) if (typeof item.pinned === 'string') manual[item.text] = item.pinned
      const resolved = items.length > 0 ? resolvePinyin(items.map((item) => item.text), manual) : { pinyin: {}, errors: {} }
      const terms = readGlossaryTerms()
      const byText = new Map(terms.map((item) => [item.text, item]))
      const added = []
      const updated = []
      const skipped = []
      for (const item of items) {
        const reason = resolved.errors[item.text]
        if (typeof reason === 'string') { rejected.push({ text: item.text, reason }); continue }
        const pinyin = resolved.pinyin[item.text]
        if (!Array.isArray(pinyin) || pinyin.length !== item.text.length) {
          rejected.push({ text: item.text, reason: '注音失败' })
          continue
        }
        const source = typeof item.pinned === 'string' ? 'manual' : 'auto'
        const current = byText.get(item.text)
        if (current === undefined) {
          if (terms.length >= GLOSSARY_MAX_TERMS) { rejected.push({ text: item.text, reason: '词表已满' }); continue }
          const record = { text: item.text, pinyin, source, added: new Date().toISOString() }
          terms.push(record)
          byText.set(item.text, record)
          added.push(item.text)
          continue
        }
        if (Array.isArray(current.pinyin) && current.pinyin.join('') === pinyin.join('') && current.source === source) {
          skipped.push(item.text)
          continue
        }
        current.pinyin = pinyin
        current.source = source
        updated.push(item.text)
      }
      if (added.length > 0 || updated.length > 0) writeGlossaryTerms(terms)
      log('glossary: added ' + JSON.stringify(added) + ' updated ' + JSON.stringify(updated)
        + (skipped.length > 0 ? ' dupes ' + JSON.stringify(skipped) : '')
        + (rejected.length > 0 ? ' rejected ' + JSON.stringify(rejected) : ''))
      send(response, 200, { ok: true, added, updated, skipped, rejected, count: terms.length, terms })
      return
    }
    if (routeName === 'DELETE /voice/glossary') {
      const body = await readJsonBody(request)
      const parsed = splitGlossaryInput(body.text ?? body.terms)
      const removing = new Set(parsed.items.map((item) => item.text))
      const before = readGlossaryTerms()
      const terms = before.filter((item) => !removing.has(item.text))
      const removed = before.filter((item) => removing.has(item.text)).map((item) => item.text)
      if (removed.length > 0) writeGlossaryTerms(terms)
      log('glossary: removed ' + JSON.stringify(removed))
      send(response, 200, { ok: true, removed, count: terms.length, terms })
      return
    }
    if (routeName === 'GET /voice/state') {
      send(response, 200, freeMicReport())
      return
    }
    if (routeName === 'POST /voice/free-mic') {
      if (!authorized(request)) throw new ApiError(401, 'ptt/unauthorized', 'missing or wrong x-ptt-token')
      const body = await readJsonBody(request)
      if (typeof body.enabled !== 'boolean') {
        throw new ApiError(400, 'ptt/bad-request', 'send {"enabled": true|false}')
      }
      send(response, 200, setFreeMic(body.enabled))
      return
    }
    if (routeName === 'GET /voice/profiles') {
      const items = listVoiceProfiles()
      const current = items.find((item) => item.current) ?? null
      send(response, 200, {
        ok: true,
        current: current === null ? null : current.folder,
        profile: current === null ? null : current.profile,
        items,
      })
      return
    }
    if (routeName === 'GET /voice/sessions') {
      const current = lockedSessionId()
      const items = sessionCandidates()
      send(response, 200, {
        ok: true,
        current: current === '' ? null : current,
        auto: current === '',
        items,
      })
      return
    }
    if (routeName === 'POST /voice/check-path') {
      if (!authorized(request)) throw new ApiError(401, 'ptt/unauthorized', 'missing or wrong x-ptt-token')
      const body = await readJsonBody(request)
      const target = typeof body.path === 'string' ? body.path.trim() : ''
      if (target.length === 0) throw new ApiError(400, 'ptt/bad-request', 'send {"path": "..."}')
      let stat = null
      try {
        stat = fs.statSync(target)
      } catch {
        stat = null
      }
      const exists = stat !== null
      const isDirectory = exists && stat.isDirectory()
      const skillFile = isDirectory ? path.join(target, 'SKILL.md') : null
      const hasSkillFile = skillFile !== null && fs.existsSync(skillFile)
      const hasVoiceJson = isDirectory && fs.existsSync(path.join(target, 'voice.json'))
      send(response, 200, {
        ok: exists && isDirectory && hasSkillFile,
        path: target,
        exists,
        isDirectory,
        hasSkillFile,
        hasVoiceJson,
      })
      return
    }
    if (routeName === 'POST /voice/listening') {
      const body = await readJsonBody(request)
      freeMicState.clientListening = body.listening === true
      freeMicState.clientListeningAt = Date.now()
      send(response, 200, { ok: true })
      return
    }
    if (routeName === 'GET /session' || routeName === 'GET /ptt/session') {
      const sessionId = url.searchParams.get('id') ?? url.searchParams.get('sessionId')
      if (!sessionId) throw new ApiError(400, 'ptt/bad-request', 'pass ?id=<sessionId>')
      send(response, 200, sessionReport(sessionId, url.searchParams.get('match') ?? undefined))
      return
    }
    if (routeName === 'POST /target' || routeName === 'POST /ptt/target') {
      if (!authorized(request)) throw new ApiError(401, 'ptt/unauthorized', 'missing or wrong x-ptt-token')
      const body = await readJsonBody(request)
      const lockedId = lockedSessionId()
      if (typeof body.sessionId === 'string' && lockedId !== '' && body.sessionId !== lockedId) {
        throw new ApiError(409, 'ptt/target-locked', `this install is locked to Session "${lockedId}"`)
      }
      if (body.sessionId === null || body.clear === true) {
        state.pinned = null
        state.sticky = null
      } else if (typeof body.sessionId === 'string' && body.sessionId.length > 0) {
        state.pinned = body.sessionId
      } else {
        throw new ApiError(400, 'ptt/bad-request', 'send {sessionId: "<id>"} to pin or {sessionId: null} to clear')
      }
      log(`pin=${state.pinned ?? 'cleared'} sticky=${state.sticky ?? 'none'}`)
      send(response, 200, targetReport())
      return
    }
    if (routeName === 'POST /submit' || routeName === 'POST /ptt/submit') {
      if (!authorized(request)) throw new ApiError(401, 'ptt/unauthorized', 'missing or wrong x-ptt-token')
      const body = await readJsonBody(request)
      send(response, 200, await admit(body))
      return
    }
    throw new ApiError(404, 'ptt/not-found', `no route for ${routeName}`)
  }

  server = http.createServer((request, response) => {
    route(request, response).catch((error) => {
      const status = statusOf(error)
      const payload = describe(error)
      if (status >= 500) state.failed += 1
      log(`error ${request.method} ${request.url} -> ${status} ${payload.code}: ${payload.message}`)
      if (!response.headersSent) {
        send(response, status, { ok: false, error: payload })
      } else {
        try {
          response.end()
        } catch {
          /* the peer already went away */
        }
      }
    })
  })

  server.on('clientError', (error, socket) => {
    log(`clientError ${error?.code ?? ''} ${error?.message ?? ''}`)
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    } catch {
      /* ignore */
    }
  })

  server.on('error', (error) => {
    log(`listen failed port=${options.port}: ${error?.code ?? ''} ${error?.message ?? ''}`)
  })

  let audioSweepTimer = null

  server.listen(options.port, '127.0.0.1', () => {
    log(`listening on http://127.0.0.1:${options.port} version=${VERSION} pid=${process.pid}`)
    if (voiceOptions.autoStart !== false) startVoiceClient()
    // 本机 TTS：8763 已有人在跑就沿用，否则自己拉起（--parent-pid 兜底）。
    ensureTts().catch((error) => log('tts: startup failed: ' + (error?.message ?? error)))
    // 音频自清理：启动 10 秒后扫一次，之后每 6 小时一次。
    const firstSweep = setTimeout(() => {
      if (!state.disposed) {
        try {
          sweepAudio()
        } catch (error) {
          log('audio sweep failed: ' + (error?.message ?? error))
        }
      }
    }, 10_000)
    if (typeof firstSweep.unref === 'function') firstSweep.unref()
    audioSweepTimer = setInterval(() => {
      if (state.disposed) return
      try {
        sweepAudio()
      } catch (error) {
        log('audio sweep failed: ' + (error?.message ?? error))
      }
    }, 6 * 3600 * 1000)
    if (typeof audioSweepTimer.unref === 'function') audioSweepTimer.unref()
  })

  writePadFile()
  registerArtifact('log', path.join(LOCAL_DIR, 'dsh', 'dsh-chatterbox', 'logs'), 'manual', 'safe', true)
  registerArtifact('state', path.join(LOCAL_DIR, 'dsh', 'dsh-chatterbox', 'audio-pad.json'), 'manual', 'review', false)
  registerArtifact('state', path.join(LOCAL_DIR, 'dsh', 'dsh-chatterbox', 'glossary.json'), 'manual', 'review', false)
  registerArtifact('state', path.join(LOCAL_DIR, 'dsh', 'dsh-chatterbox', 'paths.json'), 'manual', 'review', false)
  registerArtifact('cache', path.join(PLUGIN_DIR, 'deps'), 'manual', 'review', false)
  registerArtifact('cache', path.join(LOCAL_DIR, 'dsh', 'dsh-chatterbox', 'venv'), 'manual', 'review', false)
  registerArtifact('output', path.join(PLUGIN_DIR, 'out'), 'self-cleaning', 'safe', true)
  registerArtifact('log', path.join(PLUGIN_DIR, 'logs'), 'manual', 'safe', true)

  // Remember where the user last talked, so consecutive utterances land in the
  // same conversation even when another Session gains background activity.
  try {
    ctx.on('api-session/activity', (sessionId) => {
      if (typeof sessionId === 'string' && !state.created.has(sessionId)) state.sticky = sessionId
    })
  } catch (error) {
    log(`activity listener failed: ${error?.message ?? error}`)
  }

  // Agents already live when this plugin (re)mounts never emit agent/created.
  try {
    const agents = ctx.get('agents')
    if (agents && typeof agents.list === 'function') {
      for (const agent of agents.list()) attachProtocol(agent)
    }
  } catch (error) {
    log(`initial agent scan failed: ${error?.message ?? error}`)
  }

  // The delivery target is a live setting: follow it when the settings page
  // writes a new value, without reloading the plugin.
  try {
    // Payload: readonly (readonly string[])[] — the config paths that changed.
    ctx.on('loader/volatile-update', (paths) => {
      const changed = Array.isArray(paths) ? paths : []
      const touched = changed.some((entry) => Array.isArray(entry) && entry[entry.length - 1] === 'sessionId')
      if (!touched) {
        const padTouched = changed.some((entry) => Array.isArray(entry)
          && (entry[entry.length - 1] === 'leadInSeconds' || entry[entry.length - 1] === 'tailSeconds'))
        if (padTouched) {
          writePadFile()
          log(`audio pad -> lead_in=${leadInSeconds()}s tail=${tailSeconds()}s`)
        }
        const hotkeyTouched = changed.some((entry) => Array.isArray(entry)
          && entry[entry.length - 1] === 'hotkey')
        if (hotkeyTouched) {
          state.badHotkeyLogged = false
          log('hotkey -> ' + hotkeySpec())
          restartVoiceClient('hotkey changed')
        }
        const languageTouched = changed.some((entry) => Array.isArray(entry)
          && entry[entry.length - 1] === 'asrLanguage')
        if (languageTouched) {
          log('asr language -> ' + asrLanguage())
          restartVoiceClient('asr language changed')
        }
        return
      }
      log(`voice target changed -> ${lockedSessionId() || '(auto)'} (paths=${JSON.stringify(changed)})`)
      syncProtocols()
    })
  } catch (error) {
    log(`volatile listener failed: ${error?.message ?? error}`)
  }

  // Re-arm only after the turn that consumed our own message has ended: the
  // agent has finished thinking and committed the reply by then, so the voice
  // client never records the reply's own speech.
  try {
    ctx.on('session/event', (session, event) => {
      const target = lockedSessionId()
      if (target === '' || session?.id !== target) return
      // Runs even when the free microphone is off: the reply shape must hold.
      if (event?.type === 'assistant/message') {
        const body = Array.isArray(event.data?.message?.content)
          ? event.data.message.content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('')
          : ''
        const names = [...body.matchAll(/([0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{2}\.wav)/g)].map((match) => match[1])
        for (const name of new Set(names)) {
          const file = path.join(audioDir(), name)
          if (!fs.existsSync(file)) {
            log(`voice reply linked a missing wav (${name}) — the filename was invented before the tool result`)
          }
        }
      }
      if (!freeMicState.enabled) return
      if (event?.type === 'user/message' && event.data?.source?.rpcId === freeMicState.pendingRequestId) {
        freeMicState.ourMessageAt = Date.now()
        return
      }
      if (event?.type === 'turn/end' && freeMicState.busy && freeMicState.ourMessageAt !== null) {
        log('free-mic: turn/end; waiting for the spoken reply to finish')
        waitForPlayback()
      }
    })
  } catch (error) {
    log(`session listener failed: ${error?.message ?? error}`)
  }

  try {
    ctx.on('agent/created', (payload) => {
      attachProtocol(payload?.agent)
    })
    ctx.on('agent/disposed', (payload) => {
      const id = payload?.agent?.id
      if (id !== undefined && protocolOwners.has(id)) {
        const disposer = protocolOwners.get(id)
        protocolOwners.delete(id)
        try {
          disposer?.()
        } catch {
          /* the agent scope is already unwinding */
        }
      }
    })
  } catch (error) {
    log(`agent listener failed: ${error?.message ?? error}`)
  }

  const freeMicWatchdog = setInterval(() => {
    if (freeMicState.enabled) {
      const deadline = autoOffAt()
      if (deadline !== null && Date.now() >= deadline) {
        const minutes = Math.round(idleTimeoutMs() / 60_000)
        setFreeMic(false)
        log(`free-mic auto-off: no utterance for ${minutes} minute(s)`)
        return
      }
    }
    if (freeMicState.busy && freeMicState.releaseAt > 0 && Date.now() >= freeMicState.releaseAt) {
      freeMicState.releaseAt = 0
      releaseFreeMic('turn end + speech finished')
      return
    }
    if (!freeMicState.busy) return
    const now = Date.now()
    // A replay is not a turn: it is released by the playback watcher, and only
    // a hard safety timeout applies here.
    if (freeMicState.replayBusy) {
      if (now - freeMicState.replayStartedAt > 300_000) releaseFreeMic('replay timeout')
      return
    }
    if (freeMicState.ourMessageAt === null && now - freeMicState.lastSubmitAt > 30_000) {
      releaseFreeMic('message never committed')
      return
    }
    if (freeMicState.ourMessageAt !== null && now - freeMicState.ourMessageAt > 180_000) {
      releaseFreeMic('turn/end timeout')
    }
    // The button can be green while nothing records (the client crashed, or its
    // polling loop is stuck). Self-heal: one restart per minute, only while idle.
    if (freeMicState.enabled && !freeMicState.busy && now - freeMicState.enabledAt > 8_000) {
      // A report older than a minute means the client's loop stopped ticking.
      const reportFresh = now - (freeMicState.clientListeningAt ?? 0) < 60_000
      if (freeMicState.clientListening && reportFresh) {
        freeMicState.notListeningSince = 0
      } else if (freeMicState.notListeningSince === 0) {
        freeMicState.notListeningSince = now
      } else if (now - freeMicState.notListeningSince > 8_000
        && now - (freeMicState.lastClientRestartAt ?? 0) > 60_000) {
        freeMicState.notListeningSince = 0
        freeMicState.lastClientRestartAt = now
        log('free-mic: voice client reports no listening; restarting it')
        stopVoiceClient()
        const timer = setTimeout(() => {
          if (!state.disposed && freeMicState.enabled) startVoiceClient()
        }, 500)
        if (typeof timer.unref === 'function') timer.unref()
      }
    } else {
      freeMicState.notListeningSince = 0
    }
  }, 400)
  if (typeof freeMicWatchdog.unref === 'function') freeMicWatchdog.unref()

  const dispose = () => {
    state.disposed = true
    clearInterval(freeMicWatchdog)
    clearInterval(audioSweepTimer)
    if (ttsState.child !== null) {
      try {
        ttsState.child.kill()
        log('tts: daemon stopped with the plugin')
      } catch (error) {
        log('tts: cannot stop daemon: ' + (error?.message ?? error))
      }
      ttsState.child = null
    }
    stopPlaybackWatch()
    detachProtocols()
    stopVoiceClient()
    if (!server) return
    try {
      server.close()
    } catch (error) {
      log(`close failed: ${error?.message ?? error}`)
    }
    server = null
    log('disposed')
  }

  // Any Session may be asked to "念出来": register the rule unscoped. It only
  // fires on an explicit request, so it stays out of the way elsewhere.
  try {
    const prompt = ctx.get('systemPrompt')
    if (prompt && typeof prompt.section === 'function') {
      ctx.effect(() => prompt.section({
        name: 'chatterbox:voice',
        order: 55,
        interpolate: false,
        text: () => globalVoiceRule(voiceInfo(), listVoiceProfiles(), ingestBase(), activePersona()),
      }))
      log('global 念出来 rule registered')
    } else {
      log('systemPrompt unavailable: global 念出来 rule skipped')
    }
  } catch (error) {
    log(`global voice rule failed: ${error?.message ?? error}`)
  }

  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => () => dispose())
    else if (typeof ctx.on === 'function') ctx.on('dispose', dispose)
  } catch (error) {
    log(`lifecycle hook failed: ${error?.message ?? error}`)
  }
}
