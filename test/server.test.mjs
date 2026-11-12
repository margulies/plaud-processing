import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The whole server on a temporary folder, with a stand-in for `claude`
 * (test/fixtures/fake-claude.mjs): a recording with a transcript gets its
 * notes on its own, and the page's API does what it says.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STEM = '2026-03-01_0900 Budget review [aa11bb22]'

async function until(fn, ms = 10_000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 150))
  }
}

test('the server: list, notes on their own, names, private, audio ranges, guards', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-server-'))
  fs.writeFileSync(path.join(dir, `${STEM}.mp3`), Buffer.alloc(1000, 1))
  fs.writeFileSync(path.join(dir, `${STEM}.transcript.json`), JSON.stringify({ file: `${STEM}.mp3`, model: 'test', speakers: 1, utterances: [{ speaker: 'Speaker 1', start: 5, end: 9, text: 'We agree on the budget.' }] }))
  fs.mkdirSync(path.join(dir, '.processing'))
  fs.writeFileSync(path.join(dir, '.processing', 'settings.json'), JSON.stringify({ autoSince: '2000-01-01T00:00:00Z', autoTranscribe: false, autoNotes: true }))
  const port = 20000 + Math.floor(Math.random() * 20000)
  const server = spawn(process.execPath, [path.join(REPO, 'server', 'main.mjs')], {
    env: { ...process.env, RECORDINGS_DIR: dir, PORT: String(port), HOST: '127.0.0.1', CLAUDE_BIN: path.join(REPO, 'test', 'fixtures', 'fake-claude.mjs') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  server.stdout.on('data', (d) => (out += d))
  server.stderr.on('data', (d) => (out += d))
  t.after(() => server.kill())
  const base = `http://127.0.0.1:${port}`
  const get = (p, init) => fetch(base + p, init)
  const json = async (p, init) => {
    const r = await get(p, init)
    return { status: r.status, body: await r.json() }
  }
  const send = (method, p, body) => json(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const id = encodeURIComponent(STEM)

  await until(() => get('/api/status').then((r) => r.ok), 8000).catch(() => assert.fail(`server did not start:\n${out}`))

  // The page itself
  const page = await get('/')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Plaud Processing/)
  assert.equal((await get('/../package.json')).status, 404)

  // Notes arrive on their own (autoNotes, a new recording, Claude present)
  const d = await until(async () => {
    const r = await json(`/api/recordings/${id}`)
    return r.body.notes ? r.body : null
  })
  assert.equal(d.title, 'Budget review')
  assert.equal(d.notes.summary, 'The team agreed the budget.')
  assert.equal(d.suggested['Speaker 1'], 'Ana')
  const md = fs.readFileSync(path.join(dir, `${STEM}.notes.md`), 'utf8')
  assert.match(md, /^# Budget review/)
  assert.match(md, /\*\*Ana:\*\* Send the sheet, due 2026-01-09/)
  // the suggested name reaches the readable transcript
  assert.match(fs.readFileSync(path.join(dir, `${STEM}.transcript.txt`), 'utf8'), /Ana: We agree/)

  // Search, list
  assert.equal((await json('/api/recordings?q=budget%20agree')).body.recordings.length, 1)
  assert.equal((await json('/api/recordings?q=zebra')).body.recordings.length, 0)

  // Your own request
  assert.equal((await send('POST', `/api/recordings/${id}/process`, { request: 'Summarise it' })).status, 200)
  const withOut = await until(async () => ((await json(`/api/recordings/${id}`)).body.outputs[0] ?? null))
  assert.equal(withOut.text, 'Answer (saw transcript: true)')
  const dl = await get(`/api/recordings/${id}/download/${withOut.id}`)
  assert.match(dl.headers.get('content-disposition'), /attachment/)

  // Speaker names and line edits
  await send('PUT', `/api/recordings/${id}/speakers`, { speakers: { 'Speaker 1': 'Ana María' } })
  await send('PUT', `/api/recordings/${id}/utterance`, { index: 0, text: 'We agree on the whole budget.' })
  assert.match(fs.readFileSync(path.join(dir, `${STEM}.transcript.txt`), 'utf8'), /Ana María: We agree on the whole budget\./)

  // Audio with ranges
  const part = await get(`/api/recordings/${id}/audio`, { headers: { Range: 'bytes=10-19' } })
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000')
  assert.equal((await part.arrayBuffer()).byteLength, 10)

  // Private: moved, and Claude refuses it
  assert.equal((await send('POST', `/api/recordings/${id}/private`, { private: true })).status, 200)
  assert.ok(fs.existsSync(path.join(dir, 'Private', `${STEM}.mp3`)))
  const refused = await send('POST', `/api/recordings/${id}/notes`, {})
  assert.equal(refused.status, 400)
  assert.match(refused.body.error, /Private/)

  // Guards: a foreign Host, a foreign Origin
  const rebind = await new Promise((resolve) => {
    import('node:http').then(({ request }) => {
      const r = request({ host: '127.0.0.1', port, path: '/api/status', headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode))
      r.end()
    })
  })
  assert.equal(rebind, 403)
  const csrf = await get('/api/scan', { method: 'POST', headers: { Origin: 'https://evil.example' } })
  assert.equal(csrf.status, 403)

  // Settings
  const s = await send('PUT', '/api/settings', { myName: 'Alex', transcribeModel: 'nope' })
  assert.equal(s.body.myName, 'Alex')
  assert.equal(s.body.transcribeModel, 'turbo')
})
