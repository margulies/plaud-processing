import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { childEnv, which } from './config.mjs'

/**
 * Claude, through the Claude Code command line (`claude -p`) and whatever
 * login it has on this Mac: a Claude subscription or an API key. This is the
 * only step that sends anything off the Mac, and it sends text only (the
 * transcript), never audio. Recordings in the Private folder never get here.
 *
 * Each call is locked down: no tools at all (so nothing in a transcript can
 * make it read files, run commands or browse), no MCP servers, none of your
 * Claude Code settings, hooks or CLAUDE.md files, no saved session, and an
 * empty working folder of its own.
 */

const TIMEOUT_MS = 15 * 60_000

export function claudeStatus(cfg) {
  const bin = cfg.claudeBin || which('claude')
  if (!bin) return { available: false, bin: null, why: 'Claude Code is not installed (https://claude.com/claude-code), so notes are off. Transcripts still work.' }
  return { available: true, bin, why: null }
}

/** The arguments for one locked-down call. Exported for the tests. */
export function claudeArgs({ model, schema }) {
  const args = ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence']
  if (model) args.push('--model', model)
  if (schema) args.push('--json-schema', JSON.stringify(schema))
  return args
}

/** What the result line says, as text or the structured answer. Exported for the tests. */
export function parseResult(stdout) {
  let r
  try {
    r = JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1) ?? '')
  } catch {
    throw new Error(`Claude's answer couldn't be read: ${stdout.trim().slice(0, 300) || 'it said nothing'}`)
  }
  if (r.is_error || r.subtype !== 'success') throw new Error(`Claude stopped: ${String(r.result || r.subtype || 'unknown error').slice(0, 300)}`)
  return { text: typeof r.result === 'string' ? r.result : '', structured: r.structured_output ?? null, cost: r.total_cost_usd ?? null, model: Object.keys(r.modelUsage ?? {})[0] ?? null }
}

/**
 * One call. Resolves to { text, structured, cost, model }. `signal` stops it.
 */
export function runClaude(cfg, { prompt, model, schema, signal }) {
  const { bin, available, why } = claudeStatus(cfg)
  if (!available) return Promise.reject(new Error(why))
  const cwd = path.join(os.tmpdir(), 'plaud-processing-claude')
  fs.mkdirSync(cwd, { recursive: true })
  return new Promise((resolve, reject) => {
    const child = spawn(bin, claudeArgs({ model, schema }), { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS)
    const stop = () => child.kill('SIGTERM')
    signal?.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (signal?.aborted) return reject(new Error('Stopped.'))
      try {
        resolve(parseResult(out))
      } catch (e) {
        if (/not logged in|login|authenticate|\/login/i.test(out + err)) return reject(new Error('Claude Code is not signed in on this Mac. Open Terminal, run `claude`, and sign in.'))
        reject(code ? new Error(`${e.message}${err.trim() ? ` (${err.trim().split('\n').at(-1).slice(0, 200)})` : ''}`) : e)
      }
    })
    child.stdin.end(prompt)
  })
}
