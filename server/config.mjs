import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where things are. Only the few settings that must be known before the
 * server starts live in `.env` at the repository root (npm run setup writes
 * it); everything you change from the web page lives in the recordings
 * folder itself (settings.mjs), so it travels with the folder in Dropbox.
 */

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const HOME = os.homedir()

export function expandHome(p) {
  if (!p) return p
  if (p === '~') return HOME
  return p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p
}

/** KEY=value lines; # comments; optional quotes. No interpolation. */
export function parseDotEnv(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || line.trim().startsWith('#')) continue
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

export function readDotEnv(file = path.join(REPO, '.env')) {
  try {
    return parseDotEnv(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** The environment wins over .env, so a launchd agent or a one-off `PORT=9000 npm start` can override. */
export function loadConfig(env = process.env) {
  const file = readDotEnv()
  const get = (k, d = '') => (env[k] ?? file[k] ?? d).toString().trim()
  const dir = expandHome(get('RECORDINGS_DIR'))
  return {
    recordingsDir: dir ? path.resolve(dir) : '',
    port: Number(get('PORT', '8787')) || 8787,
    host: get('HOST', '127.0.0.1'),
    /** Extra host names the page may be opened under (comma-separated), beyond localhost and *.ts.net. */
    allowedHosts: get('ALLOWED_HOSTS')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    claudeBin: expandHome(get('CLAUDE_BIN')) || null,
    transcribePython: expandHome(get('TRANSCRIBE_PYTHON')) || null,
    logsDir: path.join(HOME, 'Library', 'Logs', 'plaud-processing'),
  }
}

/** Common install places for the tools we call, since launchd starts us with a bare PATH. */
export const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local', 'bin'), path.join(HOME, '.claude', 'local'), path.join(HOME, '.npm-global', 'bin')]

export function searchPath(env = process.env) {
  const seen = new Set()
  return [...(env.PATH ?? '').split(path.delimiter), ...EXTRA_PATH, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter((d) => d && !seen.has(d) && seen.add(d))
}

export function which(bin, env = process.env) {
  for (const dir of searchPath(env)) {
    const p = path.join(dir, bin)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {}
  }
  return null
}

/** The environment for the tools we spawn: our PATH, with the usual install places added. */
export function childEnv(extra = {}) {
  return { ...process.env, PATH: searchPath().join(path.delimiter), ...extra }
}
