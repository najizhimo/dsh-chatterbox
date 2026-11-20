// Where did the seconds go? Per-utterance and per-turn latency from the logs.
//
//   node tools/latency-report.mjs                 # uses the locked Session
//   node tools/latency-report.mjs --session <id>  # explicit Session
//   node tools/latency-report.mjs --turns 6       # how many turns to show
//
// Reads: the Session log (zstd), ptt.log (speech side), chatterbox.log (Host side).
// No dependencies; safe to run while the plugin is live.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const HOME = process.env.USERPROFILE ?? os.homedir()
const LOCAL = process.env.LOCALAPPDATA ?? path.join(HOME, 'AppData', 'Local')
const DATA = path.join(LOCAL, 'dsh', 'dsh-chatterbox', 'logs')
const SESSIONS = path.join(HOME, '.dsh', 'sessions')
const INGEST = 'http://127.0.0.1:18801'

const wanted = Number(arg('turns', 5))

async function lockedSession() {
  try {
    const response = await fetch(`${INGEST}/voice/state`, { signal: AbortSignal.timeout(3000) })
    const body = await response.json()
    return body.sessionId ?? null
  } catch {
    return null
  }
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name === 'session.v4.jsonl.zstd') yield full
  }
}

function findSessionFile(id) {
  for (const file of walk(SESSIONS)) {
    if (path.basename(path.dirname(file)) === id) return file
  }
  return null
}

const clock = (ms) => (typeof ms === 'number' ? new Date(ms).toISOString().slice(11, 19) : '?')
const plus = (base, ms) => (typeof base === 'number' && typeof ms === 'number' ? `+${((ms - base) / 1000).toFixed(2)}s` : '?')
const textOf = (data) => (data?.content ?? []).filter((part) => part?.type === 'text').map((part) => part.text).join('')

function speechSection() {
  const file = path.join(DATA, 'ptt.log')
  if (!fs.existsSync(file)) {
    console.log(`(no ptt.log at ${file})`)
    return
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const interesting = lines.filter((line) => /free-mic \d|free-mic \d.*→ asr|delivered|hotkey press|record \d|free-mic: listening\b/.test(line))
  console.log('== 语音段（ptt.log）==')
  for (const line of interesting.slice(-Math.max(6, wanted * 2))) console.log('  ' + line)
}

function turnSection(file) {
  const text = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8')
  const turns = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const data = record.data ?? {}
    const type = record.type ?? data.type
    const time = data.time ?? record.time
    if (type === 'turn/start') { turns.push({ turn: data.turn, marks: [] }); continue }
    const current = turns[turns.length - 1]
    if (!current) continue
    if (type === 'user/message') current.userAt = time
    if (type === 'turn/end') current.endAt = time
    if (type === 'assistant/message') current.replyAt = time
    if (type === 'tool/result') {
      const body = textOf(data.message)
      const gen = /"gen_s":\s*([0-9.]+)/.exec(body)
      const audio = /"audio_s":\s*([0-9.]+)/.exec(body)
      if (gen) current.tts = { gen: Number(gen[1]), audio: audio ? Number(audio[1]) : null, at: time }
    }
    if (type === 'tool/call') current.firstCallAt ??= time
  }

  console.log(`\n== 会话轮次（${path.basename(file)}）==`)
  for (const turn of turns.slice(-wanted)) {
    const base = turn.userAt ?? turn.marks?.[0]
    if (typeof base !== 'number') continue
    const parts = [
      `turn ${turn.turn}`,
      `prompt ${clock(base)}`,
      turn.firstCallAt ? `模型首调用 ${plus(base, turn.firstCallAt)}` : '模型首调用 ?',
      turn.tts ? `TTS 合成 ${turn.tts.gen.toFixed(2)}s（音频 ${turn.tts.audio ?? '?'}s）` : 'TTS ?',
      turn.replyAt ? `文本落定 ${plus(base, turn.replyAt)}` : '',
      turn.endAt ? `turn/end ${plus(base, turn.endAt)}` : '',
    ].filter(Boolean)
    console.log(`  ${parts.join('  |  ')}`)
  }
}

const session = arg('session', null) ?? (await lockedSession())
console.log(`data: ${DATA}`)
console.log(`session: ${session ?? '(unknown — plugin not reachable)'}`)
speechSection()
if (session) {
  const file = findSessionFile(session)
  if (file) turnSection(file)
  else console.log(`\n(no log found for session ${session})`)
}
const hostLog = path.join(DATA, 'chatterbox.log')
if (fs.existsSync(hostLog)) {
  const lines = fs.readFileSync(hostLog, 'utf8').split('\n').filter((line) => /free-mic|submit ok/.test(line))
  console.log('\n== Host 侧（chatterbox.log）==')
  for (const line of lines.slice(-Math.max(6, wanted * 3))) console.log('  ' + line)
}
