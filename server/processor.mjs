import path from 'node:path'
import { claudeStatus, runClaude } from './claude.mjs'
import { KINDS, NOTES_SCHEMA, cutTranscript, normalizeNotes, notesPrompt, processPrompt, renderTranscript } from './notes.mjs'
import { runTranscribe, transcribeStatus, whisperPrompt } from './transcriber.mjs'

/**
 * Two queues, one job running in each: transcription (the GPU does one
 * recording at a time) and Claude (notes and your own requests). A new
 * recording goes through both on its own: transcribe, then notes, unless it
 * is private, auto is off in Settings, or it is older than the day the
 * server first ran (those wait for your click).
 */

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

export class Processor {
  constructor(cfg, library, settings, onChange) {
    this.cfg = cfg
    this.lib = library
    this.settings = settings
    this.onChange = onChange
    /** id → { stage, state: queued|running, startedAt, … } for transcription */
    this.t = new Map()
    /** id → the same for Claude work */
    this.c = new Map()
    this.tQueue = []
    this.cQueue = []
    this.tRunning = null
    this.cRunning = null
  }

  jobs(id) {
    const t = this.t.get(id)
    const c = this.c.get(id)
    return { transcribe: t ? { state: t.state, startedAt: t.startedAt ?? null, model: t.opts?.model ?? null } : null, claude: c ? { state: c.state, startedAt: c.startedAt ?? null, what: c.what } : null }
  }

  busy() {
    return { transcribing: this.tRunning, transcribeQueue: this.tQueue.length, reading: this.cRunning, claudeQueue: this.cQueue.length }
  }

  // ---------- transcription ----------

  transcribe(id, opts = {}) {
    const rec = this.lib.get(id)
    if (!rec) throw new Error('No such recording.')
    if (this.t.has(id)) throw new Error('It is already being transcribed.')
    const st = transcribeStatus(this.cfg)
    if (!st.available) throw new Error(st.why)
    const s = this.settings.get()
    const state = this.lib.state(rec)
    const model = opts.model || s.transcribeModel
    // Plaud's default names are only a date and time: no help to Whisper.
    const title = state.title || (/\d{4}-\d{2}-\d{2}|^[\d\s:_-]+$/.test(rec.nameTitle) ? '' : rec.nameTitle)
    const full = {
      model,
      speakers: opts.speakers || null,
      minSpeakers: opts.minSpeakers || null,
      maxSpeakers: opts.maxSpeakers || null,
      language: opts.language ?? s.language ?? '',
      prompt: [whisperPrompt({ title, names: Object.values(this.lib.names(state)), glossary: s.glossary }), opts.prompt?.trim()].filter(Boolean).join(' '),
      thenNotes: opts.thenNotes ?? false,
    }
    this.lib.patchState(rec, (st) => {
      delete st.errors.transcribe
    })
    this.t.set(id, { state: 'queued', opts: full })
    this.tQueue.push(id)
    this.onChange()
    this.pumpT()
  }

  stop(id) {
    let any = false
    for (const [map, queue] of [
      [this.t, this.tQueue],
      [this.c, this.cQueue],
    ]) {
      const job = map.get(id)
      if (!job) continue
      any = true
      if (job.state === 'running') job.stop?.()
      else {
        map.delete(id)
        queue.splice(queue.indexOf(id), 1)
      }
    }
    if (any) this.onChange()
    return any
  }

  async pumpT() {
    if (this.tRunning || !this.tQueue.length) return
    const id = this.tQueue.shift()
    const job = this.t.get(id)
    const rec = this.lib.get(id)
    if (!job || !rec) {
      this.t.delete(id)
      return this.pumpT()
    }
    this.tRunning = id
    job.state = 'running'
    job.startedAt = new Date().toISOString()
    const logFile = path.join(this.cfg.logsDir, 'transcribe', `${rec.stem}.log`)
    const run = runTranscribe(this.cfg, rec.audio, job.opts, logFile)
    job.stop = run.stop
    this.onChange()
    try {
      await run.done
      this.lib.scan()
      const fresh = this.lib.get(id)
      // A new transcript: names and notes from the old one may no longer fit the labels.
      if (fresh) {
        this.lib.patchState(fresh, (st) => {
          st.lastTranscribe = { at: new Date().toISOString(), model: job.opts.model }
        })
        if (job.opts.thenNotes || this.autoNotesFor(fresh)) this.queueNotes(id, {}, true)
      }
    } catch (e) {
      if (rec && e.message !== 'Stopped.') {
        this.lib.patchState(rec, (st) => {
          st.errors.transcribe = { message: e.message, at: new Date().toISOString(), log: logFile }
        })
      }
    } finally {
      this.t.delete(id)
      this.tRunning = null
      this.onChange()
      this.pumpT()
    }
  }

  // ---------- Claude ----------

  /** Notes for a recording. kind: auto|meeting|memo|talk|interview; direction: your note for this reading. */
  notes(id, { kind, direction } = {}) {
    const rec = this.lib.get(id)
    if (!rec) throw new Error('No such recording.')
    if (rec.private) throw new Error('Private recordings are never sent to Claude.')
    if (!rec.hasTranscript) throw new Error('Transcribe it first.')
    if (this.c.has(id)) throw new Error('Claude is already working on it.')
    const cs = claudeStatus(this.cfg)
    if (!cs.available) throw new Error(cs.why)
    this.lib.patchState(rec, (st) => {
      if (kind !== undefined) st.kind = kind === 'auto' || KINDS[kind] ? kind : 'auto'
      if (direction !== undefined) st.direction = String(direction).slice(0, 2000)
      delete st.errors.notes
    })
    this.queueNotes(id, {}, false)
  }

  queueNotes(id, extra, auto) {
    if (this.c.has(id)) return
    this.c.set(id, { state: 'queued', what: 'notes', auto, ...extra })
    this.cQueue.push(id)
    this.onChange()
    this.pumpC()
  }

  /** Your own request over the transcript ("a blog post from this"); the answer is kept with the recording. */
  process(id, request) {
    const rec = this.lib.get(id)
    if (!rec) throw new Error('No such recording.')
    if (rec.private) throw new Error('Private recordings are never sent to Claude.')
    if (!rec.hasTranscript) throw new Error('Transcribe it first.')
    if (this.c.has(id)) throw new Error('Claude is already working on it.')
    if (!request?.trim()) throw new Error('Say what you would like done.')
    const cs = claudeStatus(this.cfg)
    if (!cs.available) throw new Error(cs.why)
    this.c.set(id, { state: 'queued', what: 'process', request: request.trim().slice(0, 4000) })
    this.cQueue.push(id)
    this.onChange()
    this.pumpC()
  }

  async pumpC() {
    if (this.cRunning || !this.cQueue.length) return
    const id = this.cQueue.shift()
    const job = this.c.get(id)
    const rec = this.lib.get(id)
    if (!job || !rec || rec.private) {
      this.c.delete(id)
      return this.pumpC()
    }
    this.cRunning = id
    job.state = 'running'
    job.startedAt = new Date().toISOString()
    const controller = new AbortController()
    job.stop = () => controller.abort()
    this.onChange()
    const s = this.settings.get()
    try {
      const state = this.lib.state(rec)
      const t = this.lib.transcript(rec)
      if (!t) throw new Error('The transcript could not be read.')
      const names = this.lib.names(state)
      const ctx = { myName: s.myName, aboutMe: s.aboutMe, rules: s.rules, recordedAt: new Date(rec.recordedAt), timeZone: TIME_ZONE, title: state.title || rec.nameTitle, speakerNames: state.speakers, kind: state.kind, direction: state.direction }
      const text = cutTranscript(renderTranscript(t.utterances, names))
      if (job.what === 'notes') {
        const r = await runClaude(this.cfg, { prompt: notesPrompt(text, ctx), model: s.claudeModel, schema: NOTES_SCHEMA, signal: controller.signal })
        if (!r.structured) throw new Error('Claude answered without notes. Try again.')
        const notes = normalizeNotes(r.structured)
        const next = this.lib.patchState(rec, (st) => {
          st.notes = notes
          st.notesMeta = { at: new Date().toISOString(), model: r.model, cost: r.cost, kind: st.kind, transcriptModel: t.model ?? null }
          // Names Claude worked out, for the labels you haven't named yourself.
          st.suggested = {}
          for (const p of notes.participants) if (p.name && p.speaker_label && !st.speakers[p.speaker_label]) st.suggested[p.speaker_label] = p.name
        })
        this.lib.writeNotesMarkdown(rec, next, s.myName)
        if (Object.keys(next.suggested).length) this.lib.writeTranscript(rec, t, this.lib.names(next))
      } else {
        const r = await runClaude(this.cfg, { prompt: processPrompt(text, job.request, ctx), model: s.claudeModel, signal: controller.signal })
        this.lib.patchState(rec, (st) => {
          st.outputs = [{ id: Date.now().toString(36), request: job.request, text: r.text.trim(), at: new Date().toISOString(), model: r.model }, ...(st.outputs ?? [])].slice(0, 50)
        })
      }
    } catch (e) {
      if (e.message !== 'Stopped.') {
        this.lib.patchState(rec, (st) => {
          st.errors[job.what === 'notes' ? 'notes' : 'process'] = { message: e.message, at: new Date().toISOString() }
        })
      }
    } finally {
      this.c.delete(id)
      this.cRunning = null
      this.onChange()
      this.pumpC()
    }
  }

  // ---------- on its own ----------

  isNew(rec) {
    const since = Date.parse(this.settings.get().autoSince)
    return Math.max(rec.mtimeMs, Date.parse(rec.recordedAt)) >= since
  }

  autoNotesFor(rec) {
    const s = this.settings.get()
    if (!s.autoNotes || rec.private || !rec.hasTranscript || !claudeStatus(this.cfg).available) return false
    const st = this.lib.state(rec)
    return !st.notes && !st.errors.notes
  }

  /** After each look at the folder: start what is new. */
  auto() {
    const s = this.settings.get()
    const canT = s.autoTranscribe && transcribeStatus(this.cfg).available
    for (const rec of this.lib.list()) {
      if (this.t.has(rec.id) || this.c.has(rec.id)) continue
      if (!rec.hasTranscript) {
        if (!canT || !rec.settled || !this.isNew(rec)) continue
        if (this.lib.state(rec).errors.transcribe) continue
        try {
          this.transcribe(rec.id, {})
        } catch {}
      } else if (this.isNew(rec) && this.autoNotesFor(rec)) {
        this.queueNotes(rec.id, {}, true)
      }
    }
  }

  /** Transcribe every recording that has no transcript yet (the button on the list). */
  transcribeWaiting() {
    let n = 0
    for (const rec of this.lib.list()) {
      if (rec.hasTranscript || this.t.has(rec.id)) continue
      try {
        this.transcribe(rec.id, { thenNotes: this.settings.get().autoNotes && !rec.private })
        n++
      } catch {}
    }
    return n
  }
}
