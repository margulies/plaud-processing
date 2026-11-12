#!/usr/bin/env node
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { claudeStatus } from './claude.mjs'
import { loadConfig, REPO } from './config.mjs'
import { Library } from './library.mjs'
import { KINDS, normalizeNotes, transcriptText } from './notes.mjs'
import { Processor } from './processor.mjs'
import { Settings } from './settings.mjs'
import { hostAllowed } from './guard.mjs'
import { transcribeStatus } from './transcriber.mjs'

/**
 * The local server: watches the recordings folder, runs the pipeline, and
 * serves the web page and its small JSON API. No dependencies, no build step.
 *
 * It listens on 127.0.0.1 only, unless HOST says otherwise; to open the page
 * from your phone, put Tailscale in front of it (docs/ACCESS.md) rather than
 * opening it to your network. Requests whose Host isn't this machine are
 * refused (against DNS rebinding), and changes must come from the page itself
 * (Origin check, against other web pages posting to it).
 */

const cfg = loadConfig()
const WEB = path.join(REPO, 'web')
const SCAN_EVERY_MS = 20_000
const PLAUD_STATE = path.join(os.homedir(), '.plaud', 'sync-state.json')
const SYNC_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'local.plaud-processing.sync.plist')

if (!cfg.recordingsDir) {
  console.error('RECORDINGS_DIR is not set. Run `npm run setup`, or put RECORDINGS_DIR=/path/to/folder in .env.')
  process.exit(1)
}
fs.mkdirSync(cfg.recordingsDir, { recursive: true })

const library = new Library(cfg.recordingsDir)
const settings = new Settings(cfg.recordingsDir)
/** Goes up whenever anything changes; the page polls it and refetches when it moves. */
let version = 1
const bump = () => version++
const processor = new Processor(cfg, library, settings, bump)

let lastScanKey = ''
function scan() {
  const list = library.scan()
  const key = list.map((r) => `${r.id}:${r.size}:${r.transcriptMtimeMs}:${r.private}`).join('|')
  if (key !== lastScanKey) {
    lastScanKey = key
    bump()
  }
  processor.auto()
}

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(typeof body === 'object' && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers })
  res.end(data)
}

async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > 1_000_000) throw new HttpError(413, 'Too large.')
    chunks.push(c)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'Not JSON.')
  }
}

function recOr404(id) {
  const rec = library.get(id)
  if (!rec) throw new HttpError(404, 'No such recording (it may have been moved or renamed).')
  return rec
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' }
const AUDIO_MIME = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.webm': 'audio/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime' }

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1))
  const file = path.resolve(WEB, rel)
  if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' })
  send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' })
}

/** The audio, with Range support so the player can seek (Safari insists on it). */
function serveAudio(req, res, rec) {
  const size = fs.statSync(rec.audio).size
  const type = AUDIO_MIME[rec.ext] ?? 'application/octet-stream'
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : size - 1
    start = Math.max(0, start)
    end = Math.min(end, size - 1)
    if (start > end) return send(res, 416, '', { 'Content-Range': `bytes */${size}` })
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' })
    return fs.createReadStream(rec.audio, { start, end }).pipe(res)
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' })
  fs.createReadStream(rec.audio).pipe(res)
}

function syncStatus() {
  let state = null
  try {
    state = JSON.parse(fs.readFileSync(PLAUD_STATE, 'utf8'))
  } catch {}
  const entries = Object.values(state?.synced ?? {})
  return {
    installed: fs.existsSync(SYNC_PLIST),
    loggedIn: fs.existsSync(path.join(os.homedir(), '.plaud', 'tokens.json')),
    lastRun: state?.lastRun ?? null,
    copied: entries.filter((e) => e.file && !e.skipped && !e.found).length,
  }
}

function summary(rec) {
  const state = library.state(rec)
  const n = state.notes ? normalizeNotes(state.notes) : null
  return {
    id: rec.id,
    file: rec.file,
    title: library.title(rec, state),
    recordedAt: rec.recordedAt,
    timeKnown: !!rec.plaudId || /^\d{4}-\d{2}-\d{2}_\d{4} /.test(rec.stem),
    private: rec.private,
    size: rec.size,
    hasTranscript: rec.hasTranscript,
    hasNotes: !!n,
    kind: n?.kind ?? null,
    summary: n?.summary ?? '',
    people: [...new Set(Object.values(library.names(state)))].slice(0, 6),
    errors: state.errors,
    jobs: processor.jobs(rec.id),
    isNew: processor.isNew(rec),
  }
}

function detail(rec) {
  const state = library.state(rec)
  const t = library.transcript(rec)
  return {
    ...summary(rec),
    nameTitle: rec.nameTitle,
    customTitle: state.title,
    speakers: state.speakers,
    suggested: state.suggested,
    kind: state.kind,
    direction: state.direction,
    notes: state.notes ? normalizeNotes(state.notes) : null,
    notesMeta: state.notesMeta,
    outputs: state.outputs ?? [],
    transcript: t ? { engine: t.engine ?? null, model: t.model ?? null, speakers: t.speakers ?? null, utterances: t.utterances } : null,
    earlier: library.earlier(rec),
    lastTranscribe: state.lastTranscribe ?? null,
  }
}

function download(res, name, body, type = 'text/markdown; charset=utf-8') {
  send(res, 200, body, { 'Content-Type': type, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` })
}

// ---------- routes ----------

async function api(req, res, url) {
  const parts = url.pathname.split('/').slice(2).map(decodeURIComponent) // after /api
  const m = req.method
  const [a, id, b, c] = parts

  if (a === 'status' && m === 'GET') {
    return send(res, 200, {
      version,
      dir: cfg.recordingsDir,
      dirExists: fs.existsSync(cfg.recordingsDir),
      transcribe: transcribeStatus(cfg),
      claude: claudeStatus(cfg),
      sync: syncStatus(),
      busy: processor.busy(),
      settings: settings.get(),
      kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, { name: v.name, when: v.when }])),
    })
  }
  if (a === 'settings') {
    if (m === 'GET') return send(res, 200, settings.get())
    if (m === 'PUT') {
      const v = settings.update(await readBody(req))
      bump()
      scan()
      return send(res, 200, v)
    }
  }
  if (a === 'scan' && m === 'POST') {
    scan()
    return send(res, 200, { ok: true })
  }
  if (a === 'transcribe-waiting' && m === 'POST') return send(res, 200, { queued: processor.transcribeWaiting() })

  if (a === 'recordings' && !id && m === 'GET') {
    const q = (url.searchParams.get('q') ?? '').trim()
    const out = []
    for (const rec of library.list()) {
      if (!q) {
        out.push(summary(rec))
        continue
      }
      const hit = library.search(rec, q)
      if (hit.match) out.push({ ...summary(rec), hits: hit.hits })
    }
    return send(res, 200, { recordings: out })
  }

  if (a !== 'recordings' || !id) throw new HttpError(404, 'Not found.')
  const rec = recOr404(id)

  if (!b && m === 'GET') return send(res, 200, detail(rec))
  if (b === 'audio' && m === 'GET') return serveAudio(req, res, rec)

  if (b === 'download' && m === 'GET') {
    const state = library.state(rec)
    const names = library.names(state)
    if (c === 'transcript.txt') {
      const t = library.transcript(rec)
      if (!t) throw new HttpError(404, 'No transcript yet.')
      return download(res, `${rec.stem}.transcript.txt`, transcriptText(t, names), 'text/plain; charset=utf-8')
    }
    if (c === 'notes.md') {
      if (!fs.existsSync(rec.notesPath)) throw new HttpError(404, 'No notes yet.')
      return download(res, `${rec.stem}.notes.md`, fs.readFileSync(rec.notesPath, 'utf8'))
    }
    const out = (state.outputs ?? []).find((o) => o.id === c)
    if (out) return download(res, `${rec.stem} (${out.request.slice(0, 40).replace(/[\/\\:*?"<>|]/g, '-')}).md`, out.text)
    throw new HttpError(404, 'Nothing by that name.')
  }

  if (m === 'POST' || m === 'PUT' || m === 'DELETE') {
    const body = m === 'DELETE' ? {} : await readBody(req)
    const num = (v) => (Number.isInteger(v) && v >= 1 && v <= 30 ? v : null)
    switch (b) {
      case 'transcribe':
        if (body.speakers && (body.minSpeakers || body.maxSpeakers)) throw new HttpError(400, 'Give an exact number of speakers or a range, not both.')
        processor.transcribe(rec.id, {
          model: ['turbo', 'large', 'parakeet'].includes(body.model) ? body.model : null,
          speakers: num(body.speakers),
          minSpeakers: num(body.minSpeakers),
          maxSpeakers: num(body.maxSpeakers),
          language: typeof body.language === 'string' && /^[a-z]{0,3}$/i.test(body.language.trim()) ? body.language.trim().toLowerCase() : undefined,
          prompt: typeof body.prompt === 'string' ? body.prompt.slice(0, 400) : null,
          thenNotes: body.thenNotes === true,
        })
        return send(res, 200, { ok: true })
      case 'stop':
        return send(res, 200, { stopped: processor.stop(rec.id) })
      case 'notes':
        processor.notes(rec.id, { kind: typeof body.kind === 'string' ? body.kind : undefined, direction: typeof body.direction === 'string' ? body.direction : undefined })
        return send(res, 200, { ok: true })
      case 'process':
        processor.process(rec.id, String(body.request ?? ''))
        return send(res, 200, { ok: true })
      case 'outputs':
        if (m !== 'DELETE') break
        library.patchState(rec, (st) => {
          st.outputs = (st.outputs ?? []).filter((o) => o.id !== c)
        })
        bump()
        return send(res, 200, { ok: true })
      case 'title':
        library.patchState(rec, (st) => {
          st.title = String(body.title ?? '').trim().slice(0, 200)
        })
        bump()
        return send(res, 200, { ok: true })
      case 'speakers': {
        const next = library.patchState(rec, (st) => {
          for (const [label, name] of Object.entries(body.speakers ?? {})) {
            if (typeof name !== 'string' || label.length > 40) continue
            st.speakers[label] = name.trim().slice(0, 80)
            if (!st.speakers[label]) delete st.speakers[label]
          }
        })
        const t = library.transcript(rec)
        if (t) library.writeTranscript(rec, t, library.names(next))
        library.writeNotesMarkdown(rec, next, settings.get().myName)
        bump()
        return send(res, 200, { ok: true })
      }
      case 'utterance': {
        const t = library.transcript(rec)
        if (!t) throw new HttpError(400, 'No transcript.')
        const i = body.index
        if (!Number.isInteger(i) || !t.utterances[i]) throw new HttpError(400, 'No such line.')
        const text = String(body.text ?? '').trim()
        if (!text) throw new HttpError(400, 'A line needs words.')
        t.utterances[i].text = text.slice(0, 20_000)
        if (typeof body.speaker === 'string' && body.speaker.trim()) t.utterances[i].speaker = body.speaker.trim().slice(0, 40)
        t.edited = new Date().toISOString()
        library.writeTranscript(rec, t, library.names(library.state(rec)))
        scan()
        return send(res, 200, { ok: true })
      }
      case 'restore':
        library.restore(rec, String(body.name ?? ''))
        scan()
        return send(res, 200, { ok: true })
      case 'private':
        processor.stop(rec.id)
        library.setPrivate(rec, body.private === true)
        scan()
        return send(res, 200, { ok: true })
      case 'dismiss':
        library.patchState(rec, (st) => {
          delete st.errors[String(body.what)]
        })
        bump()
        return send(res, 200, { ok: true })
    }
  }
  throw new HttpError(404, 'Not found.')
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostAllowed(req.headers.host, cfg.allowedHosts)) return send(res, 403, 'This host name is not allowed. Add it to ALLOWED_HOSTS in .env.', { 'Content-Type': 'text/plain' })
    const url = new URL(req.url, 'http://local')
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin
      if (origin && !hostAllowed(new URL(origin).host, cfg.allowedHosts)) return send(res, 403, { error: 'Changes must come from this page.' })
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url)
    if (req.method === 'GET') return serveStatic(req, res, url.pathname)
    send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' })
  } catch (e) {
    const status = e.status ?? 400
    if (!res.headersSent) send(res, status, { error: e.message })
    if (status >= 500) console.error(e)
  }
})

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.join(REPO, 'server', 'main.mjs')
if (isMain) {
  scan()
  setInterval(scan, SCAN_EVERY_MS)
  server.listen(cfg.port, cfg.host, () => {
    console.log(`plaud-processing: http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`)
    console.log(`Watching ${cfg.recordingsDir}`)
    const t = transcribeStatus(cfg)
    const c = claudeStatus(cfg)
    console.log(`Transcription: ${t.available ? `ready (${t.runner})` : t.why}`)
    console.log(`Claude notes: ${c.available ? `ready (${c.bin})` : c.why}`)
    if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.host)) console.log(`Note: listening on ${cfg.host}, so other machines on the network can reach this page. There is no password.`)
  })
}
