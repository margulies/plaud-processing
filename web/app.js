import { md } from './md.js'

/*
 * The page: a list of recordings, one recording's notes and transcript, and
 * Settings. Plain DOM, no framework. It asks the server for /api/status every
 * few seconds and refetches what it shows when the server's version moves.
 */

// ---------- small helpers ----------

const $ = (sel, root = document) => root.querySelector(sel)

/** h('div.card', {onclick}, child, 'text', …): elements without innerHTML, so text from recordings stays text. */
function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.')
  const el = document.createElement(name || 'div')
  if (classes.length) el.className = classes.join(' ')
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) (children.unshift(attrs), (attrs = null))
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'html') el.innerHTML = v // only ever our own escaped markup (md.js)
    else if (k === 'value') el.value = v
    else if (k === 'checked') el.checked = !!v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c))
  return el
}

async function api(method, path, body) {
  const r = await fetch(`/api/${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text()
  if (!r.ok) throw new Error(data?.error ?? (typeof data === 'string' ? data : `Error ${r.status}`))
  return data
}

let toastTimer
function toast(msg) {
  document.querySelector('.toast')?.remove()
  const t = h('div.toast', msg)
  document.body.append(t)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.remove(), 3500)
}

async function act(fn, ok) {
  try {
    await fn()
    if (ok) toast(ok)
    await refresh(true)
  } catch (e) {
    toast(e.message)
  }
}

const fmtDate = (iso, opts) => new Date(iso).toLocaleString(undefined, opts)
const dayTime = (iso) => fmtDate(iso, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const monthOf = (iso) => fmtDate(iso, { month: 'long', year: 'numeric' })
function stamp(s) {
  const t = Math.max(0, Math.floor(s))
  const p = (n) => String(n).padStart(2, '0')
  return t >= 3600 ? `${Math.floor(t / 3600)}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}` : `${p(Math.floor(t / 60))}:${p(t % 60)}`
}
function parseStamp(s) {
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s ?? '')
  if (!m) return null
  return m[3] === undefined ? +m[1] * 60 + +m[2] : +m[1] * 3600 + +m[2] * 60 + +m[3]
}
function since(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}
const MODEL_NAMES = { turbo: 'Whisper turbo', large: 'Whisper large', parakeet: 'Parakeet' }

// ---------- state ----------

const S = {
  status: null,
  version: 0,
  list: [],
  q: '',
  id: null,
  detail: null,
  tab: 'notes',
  follow: true,
  find: '',
  audio: null, // the <audio> for the open recording, kept across re-renders so playback never stops
  audioFor: null,
  pending: false,
}

function route() {
  const hash = location.hash || '#/'
  if (hash.startsWith('#/settings')) return { page: 'settings' }
  const m = /^#\/r\/(.+)$/.exec(hash)
  return { page: 'recordings', id: m ? decodeURIComponent(m[1]) : null }
}

// ---------- data ----------

async function loadList() {
  const r = await api('GET', `recordings${S.q ? `?q=${encodeURIComponent(S.q)}` : ''}`)
  S.list = r.recordings
}

async function loadDetail() {
  if (!S.id) return (S.detail = null)
  try {
    S.detail = await api('GET', `recordings/${encodeURIComponent(S.id)}`)
  } catch {
    S.detail = null
  }
}

/** True while you are typing in something on the page: a refresh then waits, so it never throws away what you typed. */
function editing() {
  const a = document.activeElement
  return !!a && !!a.closest('#app section, #app main.page') && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a.tagName === 'INPUT' && a.type !== 'checkbox' && a.type !== 'radio'))
}

async function refresh(force = false) {
  try {
    S.status = await api('GET', 'status')
  } catch {
    $('#busy').replaceChildren(h('span.badge.bad', 'Server not answering'))
    return
  }
  renderBusy()
  if (!force && S.status.version === S.version) return
  if (!force && editing()) return void (S.pending = true)
  S.version = S.status.version
  const r = route()
  if (r.page === 'recordings') {
    await Promise.all([loadList(), loadDetail()])
    renderRecordings()
  }
}

document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (S.pending && !editing()) {
      S.pending = false
      refresh(true)
    }
  }, 150)
})

// ---------- header ----------

function renderBusy() {
  const b = S.status.busy
  const bits = []
  if (b.transcribing) bits.push(h('span.badge.accent', h('span.spin'), ' ', h('span.label', 'Transcribing'), b.transcribeQueue ? ` +${b.transcribeQueue}` : ''))
  else if (b.transcribeQueue) bits.push(h('span.badge', `${b.transcribeQueue} to transcribe`))
  if (b.reading) bits.push(h('span.badge.accent', h('span.spin'), ' ', h('span.label', 'Claude'), b.claudeQueue ? ` +${b.claudeQueue}` : ''))
  else if (b.claudeQueue) bits.push(h('span.badge', `${b.claudeQueue} for Claude`))
  $('#busy').replaceChildren(...bits)
}

function setNav(page) {
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('on', a.dataset.nav === page)
}

// ---------- recordings ----------

function badges(r) {
  const out = []
  const j = r.jobs
  if (j.transcribe?.state === 'running') out.push(h('span.badge.accent', h('span.spin'), ' Transcribing'))
  else if (j.transcribe) out.push(h('span.badge.accent', 'Waiting to transcribe'))
  if (j.claude?.state === 'running') out.push(h('span.badge.accent', h('span.spin'), j.claude.what === 'notes' ? ' Writing notes' : ' Claude working'))
  else if (j.claude) out.push(h('span.badge.accent', 'Waiting for Claude'))
  if (r.errors?.transcribe) out.push(h('span.badge.bad', 'Transcription failed'))
  if (r.errors?.notes) out.push(h('span.badge.warn', 'Notes failed'))
  if (!r.hasTranscript && !j.transcribe && !r.errors?.transcribe) out.push(h('span.badge', 'Not transcribed'))
  if (r.private) out.push(h('span.badge', '🔒 Private'))
  if (r.kind && S.status?.kinds[r.kind]) out.push(h('span.badge.good', S.status.kinds[r.kind].name))
  return out
}

function listItem(r) {
  return h(
    'li',
    h(
      'a',
      { href: `#/r/${encodeURIComponent(r.id)}`, class: r.id === S.id ? 'on' : null },
      h('div.t', h('span.title', r.title)),
      h('div.d', dayTime(r.recordedAt), ...badges(r)),
      r.summary ? h('div.s', r.summary) : r.people?.length ? h('div.s', r.people.join(', ')) : null,
      ...(r.hits ?? []).map((x) => h('div.hit', `${stamp(x.at)} ${x.text.length > 140 ? `${x.text.slice(0, 140)}…` : x.text}`)),
    ),
  )
}

function renderList(aside) {
  // The search box stays put across refreshes, so typing in it is never interrupted.
  if ($('.searchbar', aside)) {
    $('.listmeta', aside).replaceWith(listMeta())
    $('ul.list', aside).replaceWith(listUl())
    return
  }
  const search = h('input', { type: 'search', placeholder: 'Search titles, notes and transcripts', value: S.q, 'aria-label': 'Search recordings' })
  let t
  search.addEventListener('input', () => {
    clearTimeout(t)
    t = setTimeout(async () => {
      S.q = search.value.trim()
      await loadList()
      $('ul.list').replaceWith(listUl())
      $('.listmeta').replaceWith(listMeta())
    }, 250)
  })
  aside.replaceChildren(h('div.searchbar', search, h('button.quiet', { title: 'Look in the folder now', onclick: () => act(() => api('POST', 'scan')) }, '↻')), listMeta(), listUl())
}

function listMeta() {
  const waiting = S.list.filter((r) => !r.hasTranscript && !r.jobs.transcribe).length
  return h(
    'div.listmeta',
    `${S.list.length} recording${S.list.length === 1 ? '' : 's'}${S.q ? ' found' : ''}`,
    waiting && S.status?.transcribe.available
      ? h('button.quiet', { title: 'Transcribe every recording that has no transcript yet, one after another', onclick: () => act(async () => toast(`${(await api('POST', 'transcribe-waiting')).queued} queued`)) }, `Transcribe ${waiting} waiting`)
      : null,
  )
}

function listUl() {
  if (!S.list.length) {
    return h(
      'ul.list',
      h(
        'li.empty',
        S.q
          ? 'Nothing matches.'
          : h('div', h('p', 'No recordings yet.'), h('p.small', 'New Plaud recordings appear here within a few minutes. You can also drop any audio file into ', h('span.mono', S.status?.dir ?? 'the recordings folder'), '.')),
      ),
    )
  }
  const items = []
  let month = null
  for (const r of S.list) {
    const m = monthOf(r.recordedAt)
    if (m !== month && !S.q) items.push(h('li.month', (month = m)))
    items.push(listItem(r))
  }
  return h('ul.list', items)
}

function renderRecordings() {
  setNav('recordings')
  const app = $('#app')
  let main = $('main.recordings', app)
  if (!main) {
    main = h('main.recordings', h('aside'), h('section'))
    app.replaceChildren(main)
  }
  main.classList.toggle('has-detail', !!S.id)
  renderList($('aside', main))
  const section = $('section', main)
  const scroll = section.scrollTop
  section.replaceChildren(S.id ? (S.detail ? renderDetail(S.detail) : h('div.empty', 'This recording is not in the folder any more.')) : h('div.empty', S.list.length ? 'Pick a recording.' : ''))
  section.scrollTop = scroll
  if (S.tab === 'transcript') highlightNow()
}

// ---------- one recording ----------

function audioFor(d) {
  if (S.audioFor !== d.id) {
    S.audio?.pause()
    S.audio = h('audio', { controls: true, preload: 'metadata', src: `/api/recordings/${encodeURIComponent(d.id)}/audio` })
    S.audio.addEventListener('timeupdate', highlightNow)
    S.audioFor = d.id
  }
  return S.audio
}

function seek(at) {
  if (!S.audio || at === null) return
  S.audio.currentTime = at
  S.audio.play().catch(() => {})
}

/** Any timestamp button in the page plays from there. */
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-at]')
  if (b) seek(parseStamp(b.dataset.at) ?? Number(b.dataset.at))
})

function renderDetail(d) {
  const enc = encodeURIComponent(d.id)
  const titleEl = h('h1', d.title)
  const editTitle = () => {
    const input = h('input', { type: 'text', value: d.customTitle || d.title, style: 'font-size:20px;width:100%' })
    const save = () => act(() => api('PUT', `recordings/${enc}/title`, { title: input.value }))
    input.addEventListener('keydown', (e) => (e.key === 'Enter' ? save() : e.key === 'Escape' ? refresh(true) : null))
    titleEl.replaceWith(h('div.row', input, h('button.primary', { onclick: save }, 'Save'), h('button.quiet', { onclick: () => act(() => api('PUT', `recordings/${enc}/title`, { title: '' }), 'Title from the notes or file name') }, 'Reset')))
    input.focus()
  }
  const downloads = [
    d.hasTranscript ? h('a', { href: `/api/recordings/${enc}/download/transcript.txt` }, 'Transcript') : null,
    d.hasNotes ? h('a', { href: `/api/recordings/${enc}/download/notes.md` }, 'Notes') : null,
    h('a', { href: `/api/recordings/${enc}/audio`, download: d.file }, 'Audio'),
  ].filter(Boolean)

  return h(
    'div.detail',
    h('a.back', { href: '#/' }, '← All recordings'),
    titleEl,
    h(
      'div.meta',
      dayTime(d.recordedAt),
      h('span.mono', d.file),
      ...badges(d),
      h('button.quiet', { onclick: editTitle, title: 'Rename' }, '✎ Rename'),
      h('button.quiet', {
        title: d.private ? 'Move it out of the Private folder: Claude may read it again' : 'Move it and its files into the Private folder: transcribed on this Mac, never sent to Claude',
        onclick: () => act(() => api('POST', `recordings/${enc}/private`, { private: !d.private }), d.private ? 'No longer private' : 'Private: never sent to Claude'),
      }, d.private ? '🔓 Not private' : '🔒 Make private'),
    ),
    h('div.meta', 'Download:', ...downloads.flatMap((a, i) => (i ? [' · ', a] : [a]))),
    h('div.player', audioFor(d)),
    jobsCard(d),
    ...errorCards(d),
    tabs(d),
    h('div#tab', tabBody(d)),
  )
}

function jobsCard(d) {
  const j = d.jobs
  if (!j.transcribe && !j.claude) return null
  const enc = encodeURIComponent(d.id)
  const lines = []
  if (j.transcribe) {
    lines.push(
      j.transcribe.state === 'running'
        ? h('div', h('span.spin'), ` Transcribing with ${MODEL_NAMES[j.transcribe.model] ?? 'Whisper'}, for `, h('span', { 'data-since': j.transcribe.startedAt }, since(j.transcribe.startedAt)), '. An hour of audio takes roughly 10 to 30 minutes.')
        : h('div', 'Waiting its turn to be transcribed (one recording at a time).'),
    )
  }
  if (j.claude) lines.push(j.claude.state === 'running' ? h('div', h('span.spin'), ` Claude is ${j.claude.what === 'notes' ? 'writing the notes' : 'working on your request'}, for `, h('span', { 'data-since': j.claude.startedAt }, since(j.claude.startedAt)), '.') : h('div', 'Waiting for Claude.'))
  return h('div.card.notice', h('div.row', h('div.grow', lines), h('button', { onclick: () => act(() => api('POST', `recordings/${enc}/stop`), 'Stopped') }, 'Stop')))
}

function errorCards(d) {
  const enc = encodeURIComponent(d.id)
  const out = []
  const card = (what, title, retry) =>
    h(
      'div.card.error',
      h('div.row', h('strong.grow', title), retry, h('button.quiet', { onclick: () => act(() => api('POST', `recordings/${enc}/dismiss`, { what })) }, 'Dismiss')),
      h('pre', d.errors[what].message),
      d.errors[what].log ? h('div.small.muted', 'Full log: ', h('span.mono', d.errors[what].log)) : null,
    )
  if (d.errors?.transcribe) out.push(card('transcribe', 'Transcription failed', h('button', { onclick: () => ((S.tab = 'transcribe'), renderRecordings()) }, 'Try again…')))
  if (d.errors?.notes) out.push(card('notes', 'Claude could not write the notes', h('button', { onclick: () => act(() => api('POST', `recordings/${enc}/notes`, {}), 'Asked Claude again') }, 'Try again')))
  if (d.errors?.process) out.push(card('process', 'Your request to Claude failed', null))
  return out
}

function tabs(d) {
  const t = (id, label) => h('button', { class: S.tab === id ? 'on' : null, onclick: () => ((S.tab = id), renderRecordings()) }, label)
  return h('div.tabs', t('notes', 'Notes'), t('transcript', `Transcript${d.transcript ? ` · ${d.transcript.utterances.length} turns` : ''}`), t('ask', `Ask Claude${d.outputs.length ? ` · ${d.outputs.length}` : ''}`), t('transcribe', 'Transcribe again'))
}

function tabBody(d) {
  if (S.tab === 'transcript') return transcriptTab(d)
  if (S.tab === 'ask') return askTab(d)
  if (S.tab === 'transcribe') return transcribeTab(d)
  return notesTab(d)
}

// ----- notes -----

function kindSelect(value) {
  const kinds = S.status?.kinds ?? {}
  return h('select', { 'aria-label': 'Read it as' }, h('option', { value: 'auto' }, 'Let Claude decide'), ...Object.entries(kinds).map(([k, v]) => h('option', { value: k, selected: value === k ? true : null }, v.name)))
}

function notesForm(d, again) {
  const enc = encodeURIComponent(d.id)
  const kind = kindSelect(d.kind)
  kind.value = d.kind || 'auto'
  const note = h('textarea', { rows: 2, placeholder: 'Optional: a note for Claude about this recording ("It\'s a job interview; I am the interviewer", "Focus on the budget")' }, d.direction ?? '')
  note.value = d.direction ?? ''
  return h(
    'div.form',
    h('div.row', h('span.small', 'Read it as'), kind),
    note,
    h('div.row', h('button.primary', { onclick: () => act(() => api('POST', `recordings/${enc}/notes`, { kind: kind.value, direction: note.value }), 'Claude is on it') }, again ? 'Write the notes again' : 'Write notes with Claude')),
  )
}

function notesTab(d) {
  const st = S.status
  if (d.private) return h('div.empty', '🔒 Private recordings are transcribed on this Mac and never sent to Claude, so they have no notes.', h('br'), 'Read the transcript instead.')
  if (!d.hasTranscript) return h('div.empty', d.jobs.transcribe ? 'The notes come once it is transcribed.' : 'Not transcribed yet. Use “Transcribe again” to start.')
  if (!d.notes) {
    if (!st.claude.available) return h('div.card', h('strong', 'Notes need Claude Code on this Mac. '), st.claude.why)
    if (d.jobs.claude) return h('div.empty', 'Claude is writing the notes…')
    return h('div.card', h('p', 'No notes yet. Claude reads the transcript (text only, never the audio) and writes a summary, action items, decisions and more.'), notesForm(d, false))
  }
  const n = d.notes
  const names = { ...d.suggested, ...d.speakers }
  const ts = (t) => (t && parseStamp(t) !== null ? h('button.ts', { 'data-at': t }, t.replace(/[[\]]/g, '')) : null)
  const section = (title, items, fn) => (items?.length ? [h('h2', title), h('ul', items.map((x) => h('li', fn(x))))] : [])
  const mine = n.action_items.filter((a) => a.is_mine)
  const theirs = n.action_items.filter((a) => !a.is_mine)
  const task = (a) => h('span.task', h('span', '☐'), h('span', a.is_mine ? null : h('span.who', `${a.owner}: `), a.task, a.due ? h('span.muted', ` · due ${a.due}`) : null, ts(a.timestamp)))
  return h(
    'div.notes',
    n.participants.length ? h('p.small.muted', 'With ', n.participants.map((p) => `${names[p.speaker_label] || p.name || p.speaker_label}${p.role ? ` (${p.role})` : ''}`).join(', ')) : null,
    h('p.summary', n.summary),
    n.write_up ? [h('h2', 'Notes'), h('div.md', { html: md(n.write_up) })] : null,
    section(st.settings?.myName ? 'Your tasks' : 'Tasks for you', mine, task),
    section('Tasks for others', theirs, task),
    section('Decisions', n.decisions, (x) => [x.text, ts(x.timestamp)]),
    section('Key points', n.key_points, (x) => [h('strong', `${x.topic}: `), x.point, ts(x.timestamp)]),
    section('Dates', n.dates, (x) => [h('strong', x.what), ` · ${[x.date, x.time].filter(Boolean).join(' ') || 'date to be set'}`, x.confirmed ? '' : h('span.muted', ' (floated)'), ts(x.timestamp), h('div.small.muted', `“${x.as_said}”`)]),
    n.quotes.length ? [h('h2', 'Quotes'), ...n.quotes.map((q) => h('blockquote', `“${q.text}”`, h('div.small.muted', q.who ?? '', ts(q.timestamp))))] : null,
    section('Ideas', n.ideas, (x) => [x.text, ts(x.timestamp)]),
    section('Follow-ups', n.follow_ups, (x) => [h('strong', `${x.who}: `), x.what, x.by ? h('span.muted', ` · by ${x.by}`) : null, ts(x.timestamp)]),
    section('Open questions', n.open_questions, (x) => x),
    h(
      'div.notesfoot',
      h('p.small.muted', `Read as ${S.status.kinds[n.kind]?.name ?? n.kind}${d.notesMeta?.at ? ` · ${dayTime(d.notesMeta.at)}` : ''}${d.notesMeta?.model ? ` · ${d.notesMeta.model}` : ''}${d.notesMeta?.cost ? ` · $${d.notesMeta.cost.toFixed(3)}` : ''}`),
      h('details', h('summary.small', 'Write the notes again (another kind, or with a note for Claude)'), h('div.card', notesForm(d, true))),
    ),
  )
}

// ----- transcript -----

function speakerOrder(t) {
  const seen = []
  for (const u of t.utterances) if (!seen.includes(u.speaker)) seen.push(u.speaker)
  return seen
}

function transcriptTab(d) {
  if (!d.transcript) return h('div.empty', d.jobs.transcribe ? 'Transcribing…' : 'No transcript yet.')
  const enc = encodeURIComponent(d.id)
  const t = d.transcript
  const labels = speakerOrder(t)
  const color = Object.fromEntries(labels.map((l, i) => [l, `sp-${i % 8}`]))
  const names = { ...d.suggested, ...d.speakers }

  // Speaker names
  const inputs = labels.map((l) => h('input', { type: 'text', value: d.speakers[l] ?? '', placeholder: d.suggested[l] ? `${d.suggested[l]} (suggested)` : 'Name', 'data-label': l }))
  const saveNames = () => act(() => api('PUT', `recordings/${enc}/speakers`, { speakers: Object.fromEntries(inputs.map((i) => [i.dataset.label, i.value])) }), 'Names saved')
  const acceptAll = Object.keys(d.suggested).some((l) => !d.speakers[l])
    ? h('button.quiet', { onclick: () => act(() => api('PUT', `recordings/${enc}/speakers`, { speakers: Object.fromEntries(labels.filter((l) => d.suggested[l] && !d.speakers[l]).map((l) => [l, d.suggested[l]])) }), 'Suggested names kept') }, 'Keep the suggested names')
    : null
  const speakers = h(
    'details',
    { open: labels.some((l) => !names[l]) && labels.length > 1 ? true : null },
    h('summary.small', `Speakers (${labels.length})`),
    h('div.card', h('div.speakers', labels.map((l, i) => h('label', h('span', { class: color[l] }, l), inputs[i]))), h('div.row', { style: 'margin-top:10px' }, h('button.primary', { onclick: saveNames }, 'Save names'), acceptAll, h('span.small.muted', 'Names show in the transcript, the notes and the downloaded files.'))),
  )

  // Find + follow
  const find = h('input', { type: 'search', placeholder: 'Find in the transcript', value: S.find })
  const count = h('span.small.muted')
  const follow = h('input', { type: 'checkbox', checked: S.follow })
  follow.addEventListener('change', () => (S.follow = follow.checked))

  const lines = t.utterances.map((u, i) => {
    const say = h('div.say', u.text)
    const line = h(
      'div.line',
      { 'data-i': i, 'data-start': u.start },
      h('div.when', h('button.ts', { 'data-at': String(u.start), title: 'Play from here' }, stamp(u.start))),
      h('div', h('div.who', { class: `who ${color[u.speaker] ?? ''}` }, names[u.speaker] || u.speaker), say),
      h('button.quiet.edit', { title: 'Correct this line', onclick: () => editLine(d, i, u, line, labels, names) }, '✎'),
    )
    return line
  })
  const box = h('div.lines', lines)
  let at = -1
  const applyFind = () => {
    S.find = find.value.trim().toLowerCase()
    let n = 0
    for (const [i, el] of lines.entries()) {
      const hit = !!S.find && t.utterances[i].text.toLowerCase().includes(S.find)
      el.classList.toggle('found', hit)
      if (hit) n++
    }
    count.textContent = S.find ? `${n} found` : ''
  }
  find.addEventListener('input', () => ((at = -1), applyFind()))
  find.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const hits = lines.filter((l) => l.classList.contains('found'))
    if (!hits.length) return
    at = (at + 1) % hits.length
    hits[at].scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
  queueMicrotask(applyFind)
  return h(
    'div',
    h('p.small.muted', `${t.utterances.length} turns · ${labels.length} speaker${labels.length === 1 ? '' : 's'} · ${t.model ?? 'unknown model'}${t.edited ? ' · corrected by hand' : ''}. Click a time to play from there.`),
    speakers,
    h('div.row', { style: 'margin:10px 0' }, find, count, h('span.grow'), h('label.check.small', follow, 'Follow the audio')),
    box,
  )
}

function editLine(d, i, u, line, labels, names) {
  const enc = encodeURIComponent(d.id)
  const text = h('textarea', { rows: Math.min(10, Math.ceil(u.text.length / 80) + 1) }, u.text)
  text.value = u.text
  const who = h('select', labels.map((l) => h('option', { value: l, selected: l === u.speaker ? true : null }, names[l] ? `${names[l]} (${l})` : l)))
  const body = line.children[1]
  body.replaceChildren(h('div.form', who, text, h('div.row', h('button.primary', { onclick: () => act(() => api('PUT', `recordings/${enc}/utterance`, { index: i, text: text.value, speaker: who.value }), 'Line corrected') }, 'Save'), h('button.quiet', { onclick: () => refresh(true) }, 'Cancel'))))
  text.focus()
}

let lastNow = -1
function highlightNow() {
  if (S.tab !== 'transcript' || !S.audio || !S.detail?.transcript) return
  const now = S.audio.currentTime
  const us = S.detail.transcript.utterances
  let lo = 0
  let hi = us.length - 1
  let idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (us[mid].start <= now) (idx = mid), (lo = mid + 1)
    else hi = mid - 1
  }
  if (idx === lastNow && document.querySelector('.line.now')) return
  lastNow = idx
  document.querySelector('.line.now')?.classList.remove('now')
  const el = document.querySelector(`.line[data-i="${idx}"]`)
  if (!el) return
  el.classList.add('now')
  if (S.follow && !S.audio.paused) {
    const r = el.getBoundingClientRect()
    if (r.top < 120 || r.bottom > window.innerHeight - 40) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
}

// ----- ask Claude -----

const PRESETS = [
  ['Clean transcript', 'Rewrite the transcript as clean, readable text: remove filler words, false starts and repetitions, fix obvious mishearings, keep every point and who said it. Keep the original language.'],
  ['Minutes', 'Write formal meeting minutes: date, attendees, each agenda item discussed with the gist of the discussion, decisions, and action items with owners and due dates.'],
  ['Recap email', 'Draft a short, friendly recap email to the other participants: what we discussed, what was decided, and who does what next. Plain text, ready to paste.'],
  ['Blog post', 'Turn this into a well-structured blog post of about 800 words, in the speaker\'s own voice, with a title and headings. Do not invent facts.'],
  ['Key quotes', 'Pick the 5 to 10 most quotable lines, word for word, each with who said it and its timestamp.'],
  ['Questions & answers', 'List every question that was asked, who asked it, and the answer given (or "not answered").'],
  ['Study notes', 'Make study notes: the key concepts with short explanations, then 5 review questions with their answers.'],
  ['Translate to English', 'Translate the whole transcript into English, keeping the speakers and the timestamps.'],
]

function askTab(d) {
  const enc = encodeURIComponent(d.id)
  if (d.private) return h('div.empty', '🔒 Private recordings are never sent to Claude.')
  if (!d.hasTranscript) return h('div.empty', 'Transcribe it first.')
  if (!S.status.claude.available) return h('div.card', S.status.claude.why)
  const req = h('textarea', { rows: 3, placeholder: 'What should Claude do with this recording? e.g. "What did we agree about the budget?" or "Write a LinkedIn post about the main idea"' })
  const run = () => act(() => api('POST', `recordings/${enc}/process`, { request: req.value }), 'Claude is on it')
  req.addEventListener('keydown', (e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && run())
  return h(
    'div',
    h('p.small.muted', 'Claude reads the transcript (with your speaker names) and does what you ask. Answers are kept here with the recording.'),
    h('div.presets', PRESETS.map(([label, text]) => h('button', { onclick: () => ((req.value = text), req.focus()) }, label))),
    h('div.form', { style: 'margin-top:10px' }, req, h('div.row', h('button.primary', { onclick: run, disabled: d.jobs.claude ? true : null }, d.jobs.claude ? 'Claude is busy with this one…' : 'Ask Claude'), h('span.small.muted', '⌘↩'))),
    d.outputs.map((o) =>
      h(
        'div.card',
        h('div.row', h('div.small.muted.grow', `“${o.request.length > 120 ? `${o.request.slice(0, 120)}…` : o.request}” · ${dayTime(o.at)}`), h('button.quiet', { onclick: () => navigator.clipboard.writeText(o.text).then(() => toast('Copied')) }, 'Copy'), h('a.small', { href: `/api/recordings/${enc}/download/${o.id}` }, 'Download'), h('button.quiet.danger', { onclick: () => confirm('Delete this answer?') && act(() => api('DELETE', `recordings/${enc}/outputs/${o.id}`), 'Deleted') }, 'Delete')),
        h('div.md', { html: md(o.text) }),
      ),
    ),
  )
}

// ----- transcribe again -----

function transcribeTab(d) {
  const enc = encodeURIComponent(d.id)
  const st = S.status
  if (!st.transcribe.available) return h('div.card', h('strong', 'Transcription is not available on this Mac. '), st.transcribe.why)
  const def = st.settings?.transcribeModel ?? 'turbo'
  const radio = (v, label, hint) => h('label', { title: hint }, h('input', { type: 'radio', name: 'model', value: v, checked: v === def }), label)
  const seg = h('div.seg', radio('turbo', 'Whisper turbo', 'Fast. Good default.'), radio('large', 'Whisper large', 'Better with names and terms; about twice as slow.'), radio('parakeet', 'Parakeet', 'Often most accurate on meetings, fast, detects the language; takes no word list.'))
  const exact = h('input', { type: 'number', min: 1, max: 30, placeholder: 'Exactly', style: 'width:90px' })
  const lo = h('input', { type: 'number', min: 1, max: 30, placeholder: 'From', style: 'width:80px' })
  const hi = h('input', { type: 'number', min: 1, max: 30, placeholder: 'To', style: 'width:80px' })
  const lang = h('input', { type: 'text', placeholder: 'auto', value: st.settings?.language ?? '', style: 'width:80px' })
  const words = h('input', { type: 'text', placeholder: 'Names and terms for this recording, comma-separated', style: 'width:100%' })
  const then = h('input', { type: 'checkbox', checked: !d.private && st.claude.available && (st.settings?.autoNotes ?? true) })
  const go = () => {
    const n = (el) => (el.value ? Number(el.value) : null)
    act(() => api('POST', `recordings/${enc}/transcribe`, { model: seg.querySelector('input:checked').value, speakers: n(exact), minSpeakers: n(lo), maxSpeakers: n(hi), language: lang.value, prompt: words.value, thenNotes: then.checked }), 'Transcription queued')
  }
  return h(
    'div',
    h(
      'div.card.form',
      h('div.field', h('span', 'Model'), seg, h('small', 'Whisper turbo is fast. Whisper large gets names and terms right more often. Parakeet is often the most accurate on meetings and is fast, but cannot be told words to expect.')),
      h('div.field', h('span', 'Speakers'), h('div.row', exact, h('span.muted', 'or between'), lo, h('span.muted', 'and'), hi), h('small', 'Leave empty to detect. When unsure, a range does better than a guessed exact number.')),
      h('div.field', h('span', 'Language'), lang, h('small', '"en", "fr", "de"… skips detection (Whisper only). Empty detects it.')),
      h('div.field', h('span', 'Words to expect'), words, h('small', 'Added to your glossary (Settings) and the speakers\' names. Whisper only.')),
      d.private || !st.claude.available ? null : h('label.check', then, 'Then write the notes again from the new transcript'),
      h('div.row', h('button.primary', { onclick: go, disabled: d.jobs.transcribe ? true : null }, d.hasTranscript ? 'Transcribe again' : 'Transcribe'), h('span.small.muted', d.hasTranscript ? 'The current transcript is kept below, to go back to.' : '')),
    ),
    d.earlier.length
      ? [
          h('h3', 'Earlier transcripts'),
          h(
            'div.card',
            d.earlier.map((e) => h('div.row', { style: 'padding:4px 0' }, h('span.grow', `${e.made} · ${e.model ?? 'unknown model'}${e.speakers ? ` · ${e.speakers} speakers` : ''}${e.words ? ` · ${e.words} words` : ''}`), h('button', { onclick: () => act(() => api('POST', `recordings/${enc}/restore`, { name: e.name }), 'Earlier transcript back') }, 'Use this one'))),
          ),
        ]
      : null,
  )
}

// ---------- settings ----------

async function renderSettings() {
  setNav('settings')
  const st = await api('GET', 'status')
  const s = st.settings
  S.status = st
  const ok = (good, text) => h('span', { class: `badge ${good ? 'good' : 'warn'}` }, text)
  const field = (label, input, hint) => h('label.field', h('span', label), input, hint ? h('small', hint) : null)
  const myName = h('input', { type: 'text', value: s.myName, placeholder: 'e.g. Alex' })
  const about = h('textarea', { rows: 3, placeholder: 'e.g. I run a small design studio. Meetings are mostly with clients and two colleagues, Sam and Priya.' }, s.aboutMe)
  about.value = s.aboutMe
  const glossary = h('textarea', { rows: 4, placeholder: 'One per line, or comma-separated: names, companies, jargon, acronyms.' }, s.glossary)
  glossary.value = s.glossary
  const rules = h('textarea', { rows: 8 }, s.rules)
  rules.value = s.rules
  const autoT = h('input', { type: 'checkbox', checked: s.autoTranscribe })
  const autoN = h('input', { type: 'checkbox', checked: s.autoNotes })
  const model = h('select', ['turbo', 'large', 'parakeet'].map((m) => h('option', { value: m, selected: s.transcribeModel === m ? true : null }, MODEL_NAMES[m])))
  const lang = h('input', { type: 'text', value: s.language, placeholder: 'auto', style: 'width:90px' })
  const cmodel = h('input', { type: 'text', value: s.claudeModel, style: 'width:160px' })
  const sinceIn = h('input', { type: 'datetime-local', value: toLocalInput(s.autoSince) })
  const save = () =>
    act(async () => {
      await api('PUT', 'settings', { myName: myName.value, aboutMe: about.value, glossary: glossary.value, rules: rules.value, autoTranscribe: autoT.checked, autoNotes: autoN.checked, transcribeModel: model.value, language: lang.value, claudeModel: cmodel.value, autoSince: new Date(sinceIn.value).toISOString() })
      await renderSettings()
    }, 'Saved')
  const sync = st.sync
  const last = sync.lastRun
  $('#app').replaceChildren(
    h(
      'main.page',
      h('h1', 'Settings'),
      h('h2', 'How things stand'),
      h(
        'div.card.status-grid',
        h('div.row', h('span', 'Recordings folder'), h('span.mono', st.dir)),
        h('div.row', h('span', 'Plaud sync'), sync.installed ? ok(sync.loggedIn && (!last || last.ok), last ? (last.ok ? `Checked ${dayTime(last.at)}` : `Last check failed: ${last.error}`) : 'Installed, not run yet') : ok(false, 'Not installed (npm run setup)')),
        h('div.row', h('span', 'Transcription on this Mac'), ok(st.transcribe.available, st.transcribe.available ? 'Ready' : st.transcribe.why)),
        h('div.row', h('span', 'Claude for notes'), ok(st.claude.available, st.claude.available ? 'Ready' : st.claude.why)),
      ),
      h('p.small.muted', 'The folder and the port are set in the .env file in the project folder (npm run setup writes it). Everything below is saved in the recordings folder, in .processing/settings.json.'),
      h('h2', 'About you'),
      h('div.card.form', field('Your name', myName, 'So the notes can tell your tasks from everyone else\'s.'), field('About you and your work', about, 'A line or two of context that helps Claude know what matters.')),
      h('h2', 'Doing things on their own'),
      h(
        'div.card.form',
        h('label.check', autoT, 'Transcribe new recordings as they arrive'),
        h('label.check', autoN, 'Then have Claude write the notes (never for private recordings)'),
        field('Count as new from', sinceIn, 'Recordings from before this are left for you to start by hand, so a folder full of old audio does not queue days of work. Set it further back to have older ones done too.'),
      ),
      h('h2', 'Transcription'),
      h('div.card.form', field('Model for new recordings', model, 'Whisper turbo: fast. Whisper large: better with names, about twice as slow. Parakeet: often the most accurate on meetings, fast, no word list.'), field('Language', lang, 'Leave empty to detect it each time. "en", "fr", "de"… if you always record in one language (Whisper only).'), field('Glossary: words to expect', glossary, 'Whisper gets these as a hint, with the speakers\' names. Helps with names, companies and jargon.')),
      h('h2', 'Claude'),
      h(
        'div.card.form',
        field('Model', cmodel, '"sonnet" (a good default), "opus" (the most capable, slower and dearer) or "haiku" (fastest and cheapest), or a full model name.'),
        field('Your rules for every recording\'s notes', rules, 'In your own words: what to include, how to write, what to leave out.'),
        h('div.row', h('button.quiet', { onclick: () => (rules.value = DEFAULT_RULES_HINT) }, 'Put the default rules back')),
      ),
      h('div.row', { style: 'margin-top:20px' }, h('button.primary', { onclick: save }, 'Save settings')),
    ),
  )
}

const DEFAULT_RULES_HINT = `- Be precise and brief. Prefer concrete facts, names, numbers and dates over impressions.
- A task is something someone committed to doing, not every idea that came up.
- Resolve relative dates ("next Friday") against the recording date when you can.
- Write in the language of the recording.
- Plain sentences, no filler, no hype.`

function toLocalInput(iso) {
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

// ---------- start ----------

async function show() {
  const r = route()
  if (r.page === 'settings') {
    S.id = null
    return renderSettings().catch((e) => toast(e.message))
  }
  if (r.id !== S.id) {
    S.id = r.id
    S.tab = 'notes'
    S.find = ''
    lastNow = -1
  }
  S.status ??= await api('GET', 'status').catch(() => null)
  await Promise.all([loadList(), loadDetail()])
  S.version = S.status?.version ?? 0
  renderRecordings()
  if (S.status) renderBusy()
}

window.addEventListener('hashchange', show)
show()
setInterval(() => refresh(), 4000)
setInterval(() => {
  for (const el of document.querySelectorAll('[data-since]')) el.textContent = since(el.dataset.since)
}, 1000)
