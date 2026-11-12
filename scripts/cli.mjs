#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { loadConfig, readDotEnv, REPO, which } from '../server/config.mjs'

/**
 * npm run setup       a guided setup, start to finish (safe to run again)
 * npm run doctor      what is installed and signed in, and the fix for each gap
 * npm run status      are the background jobs running; the last lines of their logs
 * npm run restart     restart the server (after an update, say)
 * npm run uninstall   stop and remove the background jobs (your recordings stay)
 * npm run sync        one Plaud sync now, in this window
 */

const HOME = os.homedir()
const AGENTS = path.join(HOME, 'Library', 'LaunchAgents')
const LOGS = path.join(HOME, 'Library', 'Logs', 'plaud-processing')
const SERVER = 'local.plaud-processing.server'
const SYNC = 'local.plaud-processing.sync'
const PLAUD_DIR = path.join(HOME, '.plaud')
const SYNC_SCRIPT = path.join(REPO, 'sync', 'plaud-sync.mjs')
const HF_URL = 'https://huggingface.co/pyannote/speaker-diarization-community-1'
const domain = () => `gui/${os.userInfo().uid}`
const plistPath = (label) => path.join(AGENTS, `${label}.plist`)

const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`

// ---------- launchd ----------

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A launchd agent: either kept running (the server) or run every `interval` seconds (the sync). Exported for the tests. */
export function plist({ label, args, env, log, interval = null, keepAlive = false, cwd = REPO }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
${interval ? `  <key>StartInterval</key><integer>${interval}</integer>\n` : ''}${keepAlive ? '  <key>KeepAlive</key><true/>\n' : ''}  <key>ProcessType</key><string>${keepAlive ? 'Interactive' : 'Background'}</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`
}

function launchctl(args, quiet = true) {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' })
  if (r.status !== 0 && !quiet) throw new Error(`launchctl ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`)
  return r.stdout ?? ''
}

function load(label, content) {
  fs.mkdirSync(AGENTS, { recursive: true })
  fs.mkdirSync(LOGS, { recursive: true })
  launchctl(['bootout', `${domain()}/${label}`])
  fs.writeFileSync(plistPath(label), content)
  // bootout is asynchronous: try a few times while the old one goes away.
  for (let i = 0; i < 10; i++) {
    const r = spawnSync('launchctl', ['bootstrap', domain(), plistPath(label)], { encoding: 'utf8' })
    if (r.status === 0) return
    spawnSync('sleep', ['0.5'])
  }
  launchctl(['bootstrap', domain(), plistPath(label)], false)
}

function agentState(label) {
  if (!fs.existsSync(plistPath(label))) return null
  return /state = (\w+)/.exec(launchctl(['print', `${domain()}/${label}`]))?.[1] ?? 'not loaded'
}

/** PATH for the agents: where node, uv, ffmpeg and claude live on this Mac, then the usual places. */
function agentPath() {
  const dirs = [path.dirname(process.execPath), ...['uv', 'ffmpeg', 'claude', 'plaud'].map((b) => which(b)).filter(Boolean).map((p) => path.dirname(p)), '/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  return [...new Set(dirs)].join(':')
}

function installAgents(cfg) {
  const env = { PATH: agentPath(), HOME }
  load(SERVER, plist({ label: SERVER, args: [process.execPath, path.join(REPO, 'server', 'main.mjs')], env, log: path.join(LOGS, 'server.log'), keepAlive: true }))
  load(SYNC, plist({ label: SYNC, args: [process.execPath, SYNC_SCRIPT], env: { ...env, PLAUD_SYNC_DEST: cfg.recordingsDir }, log: path.join(LOGS, 'sync.log'), interval: 300 }))
}

// ---------- checks ----------

function hfToken() {
  if (process.env.HF_TOKEN) return true
  return [path.join(HOME, '.cache', 'huggingface', 'token'), path.join(process.env.HF_HOME ?? '', 'token')].some((f) => f && fs.existsSync(f))
}

function checks(cfg) {
  const apple = process.platform === 'darwin' && os.arch() === 'arm64'
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 20
  return [
    { name: 'A Mac with Apple Silicon', ok: apple, fix: 'Transcription runs on the Apple GPU (MLX); Intel Macs and other systems are not supported.' },
    { name: `Node.js ${process.versions.node}`, ok: nodeOk, fix: 'brew install node   (version 20 or later)' },
    { name: 'Homebrew', ok: !!which('brew'), fix: 'Install from https://brew.sh', optional: true },
    { name: 'ffmpeg', ok: !!which('ffmpeg'), fix: 'brew install ffmpeg' },
    { name: 'uv (runs the Python transcriber)', ok: !!(which('uv') || cfg.transcribePython), fix: 'brew install uv' },
    { name: 'Hugging Face login (speaker model)', ok: hfToken(), fix: `Accept the conditions at ${HF_URL}, then: uvx hf auth login` },
    { name: 'Recordings folder', ok: !!cfg.recordingsDir && fs.existsSync(cfg.recordingsDir), fix: 'npm run setup' },
    { name: "Plaud's command line", ok: !!which('plaud'), fix: 'npm install -g @plaud-ai/cli', optional: true },
    { name: 'Plaud login', ok: fs.existsSync(path.join(PLAUD_DIR, 'tokens.json')), fix: 'plaud login', optional: true },
    { name: 'Claude Code (for notes)', ok: !!(cfg.claudeBin || which('claude')), fix: 'Install from https://claude.com/claude-code, then run `claude` once and sign in', optional: true },
    { name: 'Server running', ok: agentState(SERVER) === 'running', fix: 'npm run setup (or npm run restart)', optional: true },
    { name: 'Plaud sync scheduled', ok: !!agentState(SYNC), fix: 'npm run setup', optional: true },
  ]
}

function printChecks(list) {
  for (const c of list) console.log(`${c.ok ? green('✓') : c.optional ? yellow('○') : red('✗')} ${c.name}${c.ok ? '' : dim(`  →  ${c.fix}`)}`)
}

// ---------- setup ----------

function dropboxRoot() {
  const cloud = path.join(HOME, 'Library', 'CloudStorage')
  try {
    const d = fs.readdirSync(cloud).find((n) => n.startsWith('Dropbox'))
    if (d) return path.join(cloud, d)
  } catch {}
  return fs.existsSync(path.join(HOME, 'Dropbox')) ? path.join(HOME, 'Dropbox') : null
}

function writeEnv(values) {
  const file = path.join(REPO, '.env')
  const current = readDotEnv(file)
  const merged = { ...current, ...values }
  const lines = ['# plaud-processing settings (npm run setup writes this file; it is not committed).', '# Everything else is on the web page, under Settings.', '']
  for (const [k, v] of Object.entries(merged)) lines.push(`${k}=${/\s|#/.test(v) ? JSON.stringify(v) : v}`)
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
}

function run(cmd, args, opts = {}) {
  console.log(dim(`$ ${cmd} ${args.join(' ')}`))
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  return r.status === 0
}

async function setup() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = async (q, d = '') => (await rl.question(`${q}${d ? dim(` [${d}]`) : ''} `)).trim() || d
  const yes = async (q, d = true) => {
    const a = (await ask(`${q} ${dim(d ? '(Y/n)' : '(y/N)')}`)).toLowerCase()
    return a ? a.startsWith('y') : d
  }
  try {
    console.log(bold('\nplaud-processing setup\n'))
    if (process.platform !== 'darwin' || os.arch() !== 'arm64') {
      console.log(red('This needs a Mac with Apple Silicon (M1 or later): the transcription runs on its GPU.'))
      if (!(await yes('Carry on anyway?', false))) return
    }

    // 1. The folder
    console.log(bold('1. Where should recordings go?'))
    console.log('   A folder inside Dropbox is best: the audio, transcripts and notes then reach your other devices.')
    const cfg0 = loadConfig()
    const box = dropboxRoot()
    const suggested = cfg0.recordingsDir || (box ? path.join(box, 'Plaud Recordings') : path.join(HOME, 'Plaud Recordings'))
    if (!box) console.log(yellow('   No Dropbox folder found on this Mac. Install Dropbox first if you want syncing, or use any folder.'))
    let dir = await ask('   Folder:', suggested)
    dir = path.resolve(dir.replace(/^~(?=\/|$)/, HOME))
    fs.mkdirSync(dir, { recursive: true })
    writeEnv({ RECORDINGS_DIR: dir, PORT: String(cfg0.port), HOST: cfg0.host })
    console.log(green(`   ✓ ${dir}\n`))
    const cfg = loadConfig()

    // 2. Tools
    console.log(bold('2. Tools for transcribing on this Mac'))
    const missing = ['ffmpeg', 'uv'].filter((b) => !which(b))
    if (missing.length) {
      if (which('brew') && (await yes(`   Install ${missing.join(' and ')} with Homebrew now?`))) run('brew', ['install', ...missing])
      else console.log(yellow(`   Install them later: brew install ${missing.join(' ')}`))
    } else console.log(green('   ✓ ffmpeg and uv'))

    // 3. Hugging Face (the speaker model is gated)
    console.log(bold('\n3. The speaker model (who said what)'))
    if (hfToken()) console.log(green('   ✓ Hugging Face login found'))
    else {
      console.log('   It is free but gated. Two steps:')
      console.log(`   a) Make a free account at https://huggingface.co, open ${HF_URL} and accept the conditions.`)
      console.log('   b) Create a "Read" token at https://huggingface.co/settings/tokens and paste it when asked.')
      if (which('uv') && (await yes('   Sign in to Hugging Face now?'))) run(which('uvx') ?? 'uvx', ['hf', 'auth', 'login'])
      else console.log(yellow('   Later: uvx hf auth login'))
    }

    // 4. Plaud
    console.log(bold('\n4. Your Plaud account'))
    if (!which('plaud')) {
      if (await yes("   Install Plaud's command line (npm install -g @plaud-ai/cli) to sign in?")) run('npm', ['install', '-g', '@plaud-ai/cli'])
    }
    if (!fs.existsSync(path.join(PLAUD_DIR, 'tokens.json'))) {
      if (which('plaud') && (await yes('   Sign in to Plaud now? (a browser window opens)'))) run(which('plaud'), ['login'])
    }
    const plaudOk = fs.existsSync(path.join(PLAUD_DIR, 'tokens.json'))
    console.log(plaudOk ? green('   ✓ Signed in to Plaud') : yellow('   Not signed in: no automatic Plaud sync until you run `plaud login`. You can still drop audio into the folder.'))
    if (plaudOk && !fs.existsSync(path.join(PLAUD_DIR, 'sync-state.json'))) {
      const all = await yes('   Download the recordings already in your Plaud account too? (No: only new ones from now on)', false)
      if (!all) run(process.execPath, [SYNC_SCRIPT, '--mark-existing'], { env: { ...process.env, PLAUD_SYNC_DEST: dir } })
      else console.log('   They will download over the next few minutes; older ones wait for you to click Transcribe.')
    }

    // 5. Claude
    console.log(bold('\n5. Claude, for notes (optional)'))
    if (cfg.claudeBin || which('claude')) console.log(green('   ✓ Claude Code found. If you have never used it, run `claude` once in Terminal and sign in.'))
    else console.log(yellow('   Not installed. Transcripts work without it. For notes: https://claude.com/claude-code, then run `claude` once and sign in.'))

    // 6. Background jobs
    console.log(bold('\n6. Run it in the background'))
    if (await yes('   Start the server now, and at every login, and check Plaud every five minutes?')) {
      installAgents(cfg)
      console.log(green('   ✓ Installed'))
    } else console.log('   Later: npm run setup again, or run it in a window with `npm start`.')

    console.log(bold('\nWhere things stand:'))
    printChecks(checks(cfg))
    console.log(`\nOpen ${bold(`http://localhost:${cfg.port}`)} in your browser.`)
    console.log('The first transcription downloads the models (about 3 GB), so it takes longer than the rest.\n')
  } finally {
    rl.close()
  }
}

// ---------- the other commands ----------

function tail(file, n = 5) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n)
  } catch {
    return []
  }
}

function status() {
  const cfg = loadConfig()
  for (const [label, what] of [
    [SERVER, 'Server'],
    [SYNC, 'Plaud sync (every 5 minutes)'],
  ]) {
    const st = agentState(label)
    console.log(`${bold(what)}: ${st === null ? red('not installed (npm run setup)') : st === 'running' || (label === SYNC && st !== 'not loaded') ? green(st) : yellow(st)}`)
    const log = path.join(LOGS, label === SERVER ? 'server.log' : 'sync.log')
    for (const line of tail(log)) console.log(dim(`  ${line}`))
  }
  try {
    const s = JSON.parse(fs.readFileSync(path.join(PLAUD_DIR, 'sync-state.json'), 'utf8'))
    const copied = Object.values(s.synced ?? {}).filter((e) => e.file && !e.skipped && !e.found).length
    console.log(`${bold('Plaud')}: ${copied} recording(s) copied so far${s.lastRun ? `; last check ${s.lastRun.at.replace('T', ' ').slice(0, 16)} UTC, ${s.lastRun.ok ? 'fine' : `failed: ${s.lastRun.error}`}` : ''}`)
  } catch {}
  console.log(`${bold('Folder')}: ${cfg.recordingsDir || red('not set')}`)
  console.log(`${bold('Page')}: http://localhost:${cfg.port}`)
  console.log(dim(`Logs: ${LOGS}`))
}

function uninstall() {
  for (const label of [SERVER, SYNC]) {
    launchctl(['bootout', `${domain()}/${label}`])
    fs.rmSync(plistPath(label), { force: true })
  }
  console.log('Stopped and removed. Your recordings, transcripts and notes stay in the folder; the Plaud login stays in ~/.plaud.')
}

function restart() {
  if (!fs.existsSync(plistPath(SERVER))) return console.log('Not installed: npm run setup')
  launchctl(['kickstart', '-k', `${domain()}/${SERVER}`], false)
  console.log('Restarted.')
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.join(REPO, 'scripts', 'cli.mjs')
if (isMain) {
  const cmd = process.argv[2]
  try {
    if (cmd === 'setup') await setup()
    else if (cmd === 'doctor') printChecks(checks(loadConfig()))
    else if (cmd === 'status') status()
    else if (cmd === 'uninstall') uninstall()
    else if (cmd === 'restart') restart()
    else if (cmd === 'sync') execFileSync(process.execPath, [SYNC_SCRIPT, ...process.argv.slice(3)], { stdio: 'inherit', env: { ...process.env, PLAUD_SYNC_DEST: loadConfig().recordingsDir } })
    else console.log('Commands: setup, doctor, status, restart, uninstall, sync')
  } catch (e) {
    console.error(red(e.message))
    process.exit(1)
  }
}
