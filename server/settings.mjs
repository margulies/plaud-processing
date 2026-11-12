import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_RULES } from './notes.mjs'

/**
 * The settings you change on the web page. They live in the recordings folder
 * (`.processing/settings.json`), so a new Mac pointed at the same Dropbox
 * folder picks them up.
 */

export const TRANSCRIBE_MODELS = ['turbo', 'large', 'parakeet']
export const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku']

export function defaults() {
  return {
    /** Your name, so the notes can tell your tasks from everyone else's. */
    myName: '',
    /** A line or two about you and your work, so the notes know what matters. */
    aboutMe: '',
    /** Names and terms the transcriber should expect (Whisper only), one per line or comma-separated. */
    glossary: '',
    /** How Claude should write the notes, in your words. */
    rules: DEFAULT_RULES,
    autoTranscribe: true,
    autoNotes: true,
    transcribeModel: 'turbo',
    /** "" detects it; "en", "fr", … skips detection (Whisper only). */
    language: '',
    claudeModel: 'sonnet',
    /**
     * Recordings older than this are left for you to start by hand, so pointing
     * the server at a folder with years of audio doesn't queue days of work.
     * Set on first run.
     */
    autoSince: new Date().toISOString(),
  }
}

const str = (max) => (v) => (typeof v === 'string' ? v.slice(0, max) : undefined)
const bool = (v) => (typeof v === 'boolean' ? v : undefined)
const oneOf = (list) => (v) => (list.includes(v) ? v : undefined)

const FIELDS = {
  myName: str(100),
  aboutMe: str(2000),
  glossary: str(4000),
  rules: str(8000),
  autoTranscribe: bool,
  autoNotes: bool,
  transcribeModel: oneOf(TRANSCRIBE_MODELS),
  language: (v) => (typeof v === 'string' && /^[a-z]{0,3}$/i.test(v.trim()) ? v.trim().toLowerCase() : undefined),
  claudeModel: (v) => (typeof v === 'string' && /^[a-z0-9.\-[\]]{1,60}$/i.test(v.trim()) ? v.trim() : undefined),
  autoSince: (v) => (typeof v === 'string' && !isNaN(Date.parse(v)) ? v : undefined),
}

/** Only known fields, each checked; anything else is dropped. */
export function clean(input) {
  const out = {}
  for (const [k, check] of Object.entries(FIELDS)) {
    if (input && k in input) {
      const v = check(input[k])
      if (v !== undefined) out[k] = v
    }
  }
  return out
}

export class Settings {
  constructor(recordingsDir) {
    this.file = path.join(recordingsDir, '.processing', 'settings.json')
    this.value = this.load()
  }

  load() {
    let saved = null
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {}
    const value = { ...defaults(), ...clean(saved ?? {}) }
    if (!saved) this.write(value) // the first run fixes autoSince
    return value
  }

  get() {
    return this.value
  }

  update(patch) {
    this.value = { ...this.value, ...clean(patch) }
    this.write(this.value)
    return this.value
  }

  write(value) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
    fs.renameSync(tmp, this.file)
  }
}
