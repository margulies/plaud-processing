import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { childEnv, REPO, which } from './config.mjs'

/**
 * Runs transcribe/transcribe.py on one recording: `uv run` with the script's
 * own cached environment (declared at the top of the file), or the Python you
 * name in TRANSCRIBE_PYTHON. The script writes <name>.transcript.json and
 * .txt next to the audio, and moves any earlier transcript into .transcripts/.
 *
 * Everything happens on this Mac: Whisper or Parakeet on the GPU (MLX) for
 * the words, pyannote for who spoke when. Apple Silicon only.
 */

export const SCRIPT = path.join(REPO, 'transcribe', 'transcribe.py')
/** Whisper keeps only the last couple of hundred tokens of a prompt; about this much text. */
export const PROMPT_CHARS = 800

export function transcribeStatus(cfg) {
  if (process.platform !== 'darwin' || os.arch() !== 'arm64') return { available: false, why: 'Transcribing needs a Mac with Apple Silicon (M1 or later).', runner: null }
  if (!which('ffmpeg')) return { available: false, why: 'ffmpeg is missing: brew install ffmpeg', runner: null }
  if (cfg.transcribePython) {
    return fs.existsSync(cfg.transcribePython) ? { available: true, why: null, runner: 'python' } : { available: false, why: `TRANSCRIBE_PYTHON points at ${cfg.transcribePython}, which isn't there.`, runner: null }
  }
  if (!which('uv')) return { available: false, why: 'uv is missing: brew install uv', runner: null }
  return { available: true, why: null, runner: 'uv' }
}

/** opts: { model: turbo|large|parakeet, speakers, minSpeakers, maxSpeakers, language, prompt } → the script's flags. Exported for the tests. */
export function scriptArgs(audio, opts = {}) {
  const a = [audio, '--overwrite']
  if (opts.model === 'parakeet') a.push('--engine', 'parakeet')
  else {
    a.push('--engine', 'whisper', '--whisper-model', opts.model === 'large' ? 'large' : 'turbo')
    if (opts.language) a.push('--language', opts.language)
    if (opts.prompt) a.push('--prompt', opts.prompt.slice(0, PROMPT_CHARS))
  }
  if (opts.speakers) a.push('--speakers', String(opts.speakers))
  else {
    if (opts.minSpeakers) a.push('--min-speakers', String(opts.minSpeakers))
    if (opts.maxSpeakers) a.push('--max-speakers', String(opts.maxSpeakers))
  }
  return a
}

/** The words Whisper should expect: the title, the speakers' names, your glossary. */
export function whisperPrompt({ title, names = [], glossary = '' }) {
  const terms = glossary
    .split(/\n|,/)
    .map((s) => s.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean)
  const all = [...new Set([...names.filter(Boolean), ...terms])]
  const parts = [title ? `${title}.` : '', all.length ? `Names and terms: ${all.join(', ')}.` : '']
  return parts.filter(Boolean).join(' ').slice(0, PROMPT_CHARS)
}

/**
 * Starts the script. Returns { done: Promise, stop() }; done rejects with the
 * log's last lines when it fails.
 */
export function runTranscribe(cfg, audio, opts, logFile) {
  const status = transcribeStatus(cfg)
  if (!status.available) return { done: Promise.reject(new Error(status.why)), stop() {} }
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const log = fs.createWriteStream(logFile, { flags: 'w' })
  const args = scriptArgs(audio, opts)
  const [cmd, argv] = status.runner === 'python' ? [cfg.transcribePython, [SCRIPT, ...args]] : [which('uv'), ['run', '--quiet', '--script', SCRIPT, ...args]]
  log.write(`$ ${cmd} ${argv.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ')}\n\n`)
  const child = spawn(cmd, argv, { env: childEnv({ PYTHONUNBUFFERED: '1' }), stdio: ['ignore', 'pipe', 'pipe'] })
  let tail = ''
  const keep = (d) => {
    log.write(d)
    tail = (tail + d.toString()).slice(-4000)
  }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  let stopped = false
  const done = new Promise((resolve, reject) => {
    child.on('error', (e) => {
      log.end()
      reject(e)
    })
    child.on('close', (code) => {
      log.end()
      if (stopped) return reject(new Error('Stopped.'))
      if (code === 0) return resolve()
      const last = tail.trim().split('\n').slice(-6).join('\n')
      reject(new Error(`Transcription failed (exit ${code}).${last ? `\n${last}` : ''}`))
    })
  })
  return {
    done,
    stop() {
      stopped = true
      child.kill('SIGTERM')
    },
  }
}
