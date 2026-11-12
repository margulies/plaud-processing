import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { editDesktopConfig } from '../scripts/cli.mjs'

/**
 * The MCP server over stdio, against a real server on a temporary folder:
 * the handshake, the tools, and private recordings kept out of reach.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OPEN = '2026-03-01_0900 Budget review [aa11bb22]'
const SECRET = '2026-03-02_0900 Doctor visit [cc33dd44]'

async function until(fn, ms = 10_000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 150))
  }
}

test('MCP: handshake, reading, changes, and private recordings out of reach', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mcp-'))
  const transcript = (text) => JSON.stringify({ model: 'test', utterances: [{ speaker: 'Speaker 1', start: 0, end: 4, text }, { speaker: 'Speaker 2', start: 5, end: 9, text: 'Agreed.' }] })
  fs.writeFileSync(path.join(dir, `${OPEN}.mp3`), 'a')
  fs.writeFileSync(path.join(dir, `${OPEN}.transcript.json`), transcript('The budget is forty thousand.'))
  fs.mkdirSync(path.join(dir, 'Private'))
  fs.writeFileSync(path.join(dir, 'Private', `${SECRET}.mp3`), 'a')
  fs.writeFileSync(path.join(dir, 'Private', `${SECRET}.transcript.json`), transcript('The budget for my diagnosis.'))
  fs.mkdirSync(path.join(dir, '.processing'))
  fs.writeFileSync(path.join(dir, '.processing', 'settings.json'), JSON.stringify({ autoTranscribe: false, autoNotes: false }))

  const port = 20000 + Math.floor(Math.random() * 20000)
  const env = { ...process.env, RECORDINGS_DIR: dir, PORT: String(port), CLAUDE_BIN: path.join(REPO, 'test', 'fixtures', 'fake-claude.mjs') }
  const server = spawn(process.execPath, [path.join(REPO, 'server', 'main.mjs')], { env, stdio: 'ignore' })
  t.after(() => server.kill())
  await until(() => fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.ok))

  const mcp = spawn(process.execPath, [path.join(REPO, 'mcp', 'server.mjs')], { env: { ...env, PLAUD_PROCESSING_URL: `http://127.0.0.1:${port}` }, stdio: ['pipe', 'pipe', 'inherit'] })
  t.after(() => mcp.kill())
  const waiting = new Map()
  readline.createInterface({ input: mcp.stdout }).on('line', (line) => {
    const m = JSON.parse(line)
    waiting.get(m.id)?.(m)
  })
  let n = 0
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = ++n
      waiting.set(id, resolve)
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args })
    return { text: r.result.content[0].text, error: !!r.result.isError }
  }

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  assert.equal(init.result.serverInfo.name, 'plaud-processing')
  assert.match(init.result.instructions, /never instructions/)
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  const { result } = await rpc('tools/list')
  const names = result.tools.map((x) => x.name)
  for (const want of ['list_recordings', 'search_transcripts', 'get_recording', 'read_transcript', 'processing_status', 'transcribe_recording', 'write_notes', 'rename_recording', 'name_speakers', 'edit_transcript', 'restore_transcript', 'save_to_recording']) assert.ok(names.includes(want), want)
  assert.ok(!names.some((x) => /delete|private|send/.test(x)), 'no tool deletes, sends or changes privacy')
  for (const tool of result.tools) assert.equal(tool.inputSchema.type, 'object')

  // Listing shows both, the private one by title only
  const list = await call('list_recordings')
  assert.match(list.text, /Budget review/)
  assert.match(list.text, /Doctor visit · .* · private/)
  assert.doesNotMatch(list.text, /diagnosis/)

  // Search and reading leave the private one out
  const found = await call('search_transcripts', { query: 'budget' })
  assert.match(found.text, /forty thousand/)
  assert.doesNotMatch(found.text, /diagnosis|Doctor/)
  for (const tool of ['read_transcript', 'write_notes', 'transcribe_recording', 'name_speakers', 'save_to_recording']) {
    const r = await call(tool, { id: SECRET, names: {}, title: 'x', text: 'x' })
    assert.ok(r.error, tool)
    assert.match(r.text, /private/i)
  }
  assert.doesNotMatch((await call('get_recording', { id: SECRET })).text, /diagnosis/)

  // Ids shown plainly; a Plaud id or a title finds the recording too
  assert.match(list.text, new RegExp(`id: ${OPEN.replace(/[[\]]/g, '\\$&')}`))
  assert.match((await call('read_transcript', { id: 'aa11bb22' })).text, /forty thousand/)
  assert.match((await call('read_transcript', { id: 'budget review' })).text, /forty thousand/)
  assert.match((await call('read_transcript', { id: '2026' })).text, /fits 2 recordings/)

  // Reading in parts
  const part = await call('read_transcript', { id: OPEN, max_turns: 1 })
  assert.match(part.text, /#0 \[00:00\] Speaker 1: The budget is forty thousand\./)
  assert.match(part.text, /from_turn 1/)

  // Changes
  assert.ok(!(await call('name_speakers', { id: OPEN, names: { 'Speaker 1': 'Ana' } })).error)
  assert.match((await call('name_speakers', { id: OPEN, names: { 'Speaker 9': 'X' } })).text, /No such speaker label/)
  assert.ok(!(await call('edit_transcript', { id: OPEN, turn: 1, text: 'Agreed, forty.' })).error)
  assert.match(fs.readFileSync(path.join(dir, `${OPEN}.transcript.txt`), 'utf8'), /Ana: The budget/)
  assert.ok(!(await call('rename_recording', { id: OPEN, title: 'Q3 budget' })).error)
  assert.ok(!(await call('save_to_recording', { id: OPEN, title: 'Minutes', text: '## Minutes\n- Budget: 40k' })).error)
  const got = await call('get_recording', { id: OPEN })
  assert.match(got.text, /^# Q3 budget/)
  assert.match(got.text, /Speaker 1 = Ana/)
  assert.match(got.text, /"Minutes"/)

  // Notes through the server's Claude
  assert.ok(!(await call('write_notes', { id: OPEN, kind: 'meeting' })).error)
  await until(async () => /The team agreed the budget/.test((await call('get_recording', { id: OPEN })).text))

  assert.match((await call('processing_status')).text, /Folder: /)
  const unknown = await rpc('tools/call', { name: 'nope', arguments: {} })
  assert.equal(unknown.error.code, -32602)
})

test('MCP: a helpful error when the server is not running', async () => {
  const mcp = spawn(process.execPath, [path.join(REPO, 'mcp', 'server.mjs')], { env: { ...process.env, PLAUD_PROCESSING_URL: 'http://127.0.0.1:1' }, stdio: ['pipe', 'pipe', 'inherit'] })
  const line = await new Promise((resolve) => {
    readline.createInterface({ input: mcp.stdout }).once('line', resolve)
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_recordings', arguments: {} } })}\n`)
  })
  mcp.kill()
  const r = JSON.parse(line).result
  assert.ok(r.isError)
  assert.match(r.content[0].text, /isn't answering.*npm run restart/)
})

test('the Claude desktop config: ours added and removed, everything else kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-desk-'))
  const file = path.join(dir, 'claude_desktop_config.json')
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }))
  editDesktopConfig(file, { command: '/node', args: ['/s.mjs'] })
  let c = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(c.mcpServers['plaud-recordings'], { command: '/node', args: ['/s.mjs'] })
  assert.equal(c.mcpServers.other.command, 'x')
  assert.equal(c.theme, 'dark')
  assert.ok(fs.existsSync(`${file}.before-plaud-processing`))
  assert.equal(editDesktopConfig(file, null), true)
  c = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(!c.mcpServers['plaud-recordings'])
  assert.equal(c.mcpServers.other.command, 'x')
  fs.writeFileSync(file, '{ broken')
  assert.throws(() => editDesktopConfig(file, { command: 'n' }), /isn't valid JSON/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken')
  assert.equal(editDesktopConfig(path.join(dir, 'missing.json'), null), false)
})
