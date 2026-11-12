import fs from 'node:fs'
import path from 'node:path'
import { notesMarkdown, normalizeNotes, transcriptText } from './notes.mjs'

/**
 * The recordings folder is the database. Every audio file in it (and in its
 * Private subfolder) is a recording; what has been made from it sits next to
 * it, so you can read it in Dropbox on any device:
 *
 *   2026-10-08_2132 Team sync [ab12cd34].mp3              the audio (plaud-sync names it)
 *   2026-10-08_2132 Team sync [ab12cd34].transcript.txt   readable transcript
 *   2026-10-08_2132 Team sync [ab12cd34].transcript.json  the same, structured
 *   2026-10-08_2132 Team sync [ab12cd34].notes.md         Claude's notes
 *   .transcripts/…                                        earlier transcripts, kept
 *   .processing/recordings/<name>.json                    speaker names, notes data, outputs
 *   .processing/settings.json                             the settings page
 */

export const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac', '.webm', '.mp4', '.mov'])
export const PRIVATE_DIR = 'Private'
export const ARCHIVE_DIR = '.transcripts'
const SIDECARS = ['.transcript.json', '.transcript.txt', '.notes.md', '.json']

/**
 * "2026-10-08_2132 Team sync [ab12cd34]" → the time (UTC, as plaud-sync
 * writes it), the title and Plaud's id. Any other name: the whole name is the
 * title and the time is unknown.
 */
export function parseName(stem) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})\s+(.*?)(?:\s+\[([^\]\s]{1,16})\])?$/.exec(stem)
  if (!m) return { recordedAt: null, title: stem, plaudId: null }
  const [, y, mo, d, h, mi, title, id] = m
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi))
  return { recordedAt: isNaN(date) ? null : date, title: title.trim() || stem, plaudId: id ?? null }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

function emptyState() {
  return { title: '', speakers: {}, suggested: {}, kind: 'auto', direction: '', notes: null, notesMeta: null, outputs: [], errors: {} }
}

export class Library {
  constructor(root) {
    this.root = root
    this.byId = new Map()
    this.sizes = new Map()
    this.searchCache = new Map()
  }

  stateFile(rec) {
    return path.join(this.root, '.processing', 'recordings', `${rec.stem}.json`)
  }

  /** Looks at the folder again. Returns the recordings, newest first. */
  scan() {
    const found = new Map()
    for (const [sub, isPrivate] of [['', false], [PRIVATE_DIR, true]]) {
      const dir = path.join(this.root, sub)
      let names
      try {
        names = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (name.startsWith('.')) continue
        const ext = path.extname(name).toLowerCase()
        if (!AUDIO_EXTS.has(ext)) continue
        const audio = path.join(dir, name)
        let st
        try {
          st = fs.statSync(audio)
        } catch {
          continue
        }
        if (!st.isFile()) continue
        const stem = name.slice(0, -ext.length)
        if (found.has(stem)) continue // the same name in both places: the first wins
        const parsed = parseName(stem)
        const transcript = path.join(dir, `${stem}.transcript.json`)
        let tStat = null
        try {
          tStat = fs.statSync(transcript)
        } catch {}
        const prevSize = this.sizes.get(audio)
        this.sizes.set(audio, st.size)
        found.set(stem, {
          id: stem,
          stem,
          file: name,
          dir,
          audio,
          ext,
          private: isPrivate,
          size: st.size,
          mtimeMs: st.mtimeMs,
          // Settled: Dropbox or the sync isn't still writing it.
          settled: prevSize === st.size && Date.now() - st.mtimeMs > 20_000,
          recordedAt: (parsed.recordedAt ?? new Date(Math.min(st.birthtimeMs || st.mtimeMs, st.mtimeMs))).toISOString(),
          nameTitle: parsed.title,
          plaudId: parsed.plaudId,
          transcriptPath: transcript,
          hasTranscript: !!tStat,
          transcriptMtimeMs: tStat?.mtimeMs ?? null,
          notesPath: path.join(dir, `${stem}.notes.md`),
        })
      }
    }
    this.byId = found
    return this.list()
  }

  list() {
    return [...this.byId.values()].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
  }

  get(id) {
    return this.byId.get(id) ?? null
  }

  state(rec) {
    return { ...emptyState(), ...(readJson(this.stateFile(rec)) ?? {}) }
  }

  saveState(rec, state) {
    writeJson(this.stateFile(rec), state)
  }

  patchState(rec, fn) {
    const s = this.state(rec)
    const next = fn(s) ?? s
    this.saveState(rec, next)
    return next
  }

  /** The title to show: yours, else Claude's, else the file's. */
  title(rec, state = this.state(rec)) {
    return state.title || state.notes?.title || rec.nameTitle
  }

  /** Your speaker names over the ones Claude suggested. */
  names(state) {
    const out = { ...(state.suggested ?? {}) }
    for (const [k, v] of Object.entries(state.speakers ?? {})) if (v) out[k] = v
    return out
  }

  transcript(rec) {
    if (!rec.hasTranscript) return null
    const t = readJson(rec.transcriptPath)
    if (!t || !Array.isArray(t.utterances)) return null
    return t
  }

  /** Rewrites the transcript files (after an edit or new speaker names): the .json as data, the .txt with names. */
  writeTranscript(rec, t, names) {
    writeJson(rec.transcriptPath, t)
    fs.writeFileSync(path.join(rec.dir, `${rec.stem}.transcript.txt`), transcriptText(t, names))
    this.searchCache.delete(rec.id)
  }

  writeNotesMarkdown(rec, state, myName) {
    if (!state.notes) return
    const md = notesMarkdown(normalizeNotes(state.notes), { file: rec.file, recordedAt: new Date(rec.recordedAt), names: this.names(state), myName })
    fs.writeFileSync(rec.notesPath, md)
  }

  /** Earlier transcripts kept in .transcripts/, newest first. */
  earlier(rec) {
    const dir = path.join(rec.dir, ARCHIVE_DIR)
    let names
    try {
      names = fs.readdirSync(dir)
    } catch {
      return []
    }
    const prefix = `${rec.stem}.`
    const out = []
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.transcript.json')) continue
      const when = name.slice(prefix.length, -'.transcript.json'.length)
      if (!/^\d{8}T\d{6}(-\d+)?$/.test(when)) continue
      const t = readJson(path.join(dir, name))
      out.push({
        name,
        made: `${when.slice(0, 4)}-${when.slice(4, 6)}-${when.slice(6, 8)} ${when.slice(9, 11)}:${when.slice(11, 13)}`,
        model: t?.model ?? null,
        speakers: t?.speakers ?? null,
        words: Array.isArray(t?.utterances) ? t.utterances.reduce((n, u) => n + String(u.text).split(/\s+/).length, 0) : null,
      })
    }
    return out.sort((a, b) => b.name.localeCompare(a.name))
  }

  /** Moves the current transcript into .transcripts/ (as transcribe.py does) and puts an earlier one back. */
  restore(rec, name) {
    const chosen = this.earlier(rec).find((e) => e.name === name)
    if (!chosen) throw new Error('That earlier transcript is not there any more.')
    const dir = path.join(rec.dir, ARCHIVE_DIR)
    const when = name.slice(rec.stem.length + 1, -'.transcript.json'.length)
    this.archiveCurrent(rec)
    for (const suffix of ['.transcript.json', '.transcript.txt']) {
      const from = path.join(dir, `${rec.stem}.${when}${suffix}`)
      if (fs.existsSync(from)) fs.renameSync(from, path.join(rec.dir, `${rec.stem}${suffix}`))
    }
    this.searchCache.delete(rec.id)
  }

  archiveCurrent(rec) {
    const dir = path.join(rec.dir, ARCHIVE_DIR)
    for (const suffix of ['.transcript.json', '.transcript.txt']) {
      const cur = path.join(rec.dir, `${rec.stem}${suffix}`)
      if (!fs.existsSync(cur)) continue
      const d = new Date(fs.statSync(cur).mtimeMs)
      const p = (n) => String(n).padStart(2, '0')
      const made = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
      fs.mkdirSync(dir, { recursive: true })
      let dest = path.join(dir, `${rec.stem}.${made}${suffix}`)
      for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `${rec.stem}.${made}-${n}${suffix}`)
      fs.renameSync(cur, dest)
    }
  }

  /** Into the Private folder or out of it, with everything made from it. */
  setPrivate(rec, makePrivate) {
    if (rec.private === makePrivate) return
    const to = makePrivate ? path.join(this.root, PRIVATE_DIR) : this.root
    fs.mkdirSync(to, { recursive: true })
    if (fs.existsSync(path.join(to, rec.file))) throw new Error(`There is already a ${rec.file} there.`)
    fs.renameSync(rec.audio, path.join(to, rec.file))
    for (const suffix of SIDECARS) {
      const from = path.join(rec.dir, `${rec.stem}${suffix}`)
      if (fs.existsSync(from)) fs.renameSync(from, path.join(to, `${rec.stem}${suffix}`))
    }
    const archive = path.join(rec.dir, ARCHIVE_DIR)
    for (const e of this.earlier(rec)) {
      fs.mkdirSync(path.join(to, ARCHIVE_DIR), { recursive: true })
      for (const suffix of ['.transcript.json', '.transcript.txt']) {
        const base = e.name.replace(/\.transcript\.json$/, suffix)
        if (fs.existsSync(path.join(archive, base))) fs.renameSync(path.join(archive, base), path.join(to, ARCHIVE_DIR, base))
      }
    }
    this.scan()
  }

  /** The words a search looks in: title, notes, transcript. Cached until the transcript or state changes. */
  searchText(rec) {
    const stateMtime = (() => {
      try {
        return fs.statSync(this.stateFile(rec)).mtimeMs
      } catch {
        return 0
      }
    })()
    const key = `${rec.transcriptMtimeMs}:${stateMtime}`
    const hit = this.searchCache.get(rec.id)
    if (hit?.key === key) return hit
    const state = this.state(rec)
    const names = this.names(state)
    const t = this.transcript(rec)
    const n = state.notes ? normalizeNotes(state.notes) : null
    const head = [this.title(rec, state), rec.file, Object.values(names).join(' '), n?.summary, n?.write_up, ...(n?.action_items ?? []).map((a) => a.task)].filter(Boolean).join('\n')
    const lines = t ? t.utterances.map((u) => ({ at: u.start, text: `${names[u.speaker] || u.speaker}: ${u.text}` })) : []
    const entry = { key, head: head.toLowerCase(), lines, lower: lines.map((l) => l.text.toLowerCase()) }
    this.searchCache.set(rec.id, entry)
    return entry
  }

  /** Every word of the query somewhere in the recording; up to three transcript lines that hold the first. */
  search(rec, query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return { match: true, hits: [] }
    const s = this.searchText(rec)
    const all = `${s.head}\n${s.lower.join('\n')}`
    if (!words.every((w) => all.includes(w))) return { match: false, hits: [] }
    const hits = []
    for (let i = 0; i < s.lines.length && hits.length < 3; i++) if (s.lower[i].includes(words[0])) hits.push(s.lines[i])
    return { match: true, hits }
  }
}
