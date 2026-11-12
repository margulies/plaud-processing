#!/usr/bin/env node
// plaud-sync: copy new Plaud recordings (the audio) from your Plaud account into
// a folder on this Mac, usually a Dropbox folder, where the plaud-processing
// server transcribes them. It uses the login Plaud's official command line
// keeps (`plaud login`, in ~/.plaud/tokens.json) and the same developer API
// that command line calls. No dependencies; Node >= 20.
//
// `npm run setup` installs it as a launchd agent that runs every five minutes
// (scripts/agents.mjs).
//
// Usage:
//   node sync/plaud-sync.mjs                 # one sync pass (what launchd runs)
//   node sync/plaud-sync.mjs --mark-existing # record everything currently in Plaud as
//                                            # "already synced" without downloading
//   node sync/plaud-sync.mjs --dry-run       # show what would be downloaded
//
// Settings (environment variables):
//   PLAUD_SYNC_DEST     destination folder (RECORDINGS_DIR, from .env, is used when it is unset)
//   PLAUD_SYNC_SIDECAR  "1" to also write <recording>.json with Plaud's metadata next to the audio
//   PLAUD_SYNC_PAGES    how many pages of 100 recent recordings to scan (default 3;
//                       the first run scans everything)
//
// A recording whose file is already in the folder (this Mac is new, say, and
// Dropbox brought the folder over) is noted as synced and never downloaded
// again: the file names carry the first eight characters of Plaud's id.
//
// The time in a name is Plaud's start time in UTC, as Plaud keeps it, whatever
// clock this Mac is on: "2026-10-16_0922" is 10:22 in London that day. The
// server reads it so and the web page shows it in your browser's time zone.
//
// How each look went is kept in the state file (lastRun), which the server
// shows on its Settings page: on a Mac nobody sits at, the notification below
// is seen by no one.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";

const HOME = os.homedir();
const PLAUD_DIR = path.join(HOME, ".plaud");
const TOKEN_PATH = path.join(PLAUD_DIR, "tokens.json");
const STATE_PATH = path.join(PLAUD_DIR, "sync-state.json");
const API_BASE = process.env.PLAUD_API_BASE ?? "https://platform.plaud.ai/developer/api";
const REFRESH_URL =
  process.env.PLAUD_REFRESH_URL ??
  "https://platform.plaud.ai/developer/api/oauth/third-party/access-token/refresh";
const PAGE_SIZE = 100;
/** Private recordings live in this subfolder (never sent to Claude); a file there counts as synced too. */
const PRIVATE_DIR = "Private";
/** How much of Plaud's id goes into a file name: `… [of_177b5].mp3`. */
const ID_CHARS = 8;

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const MARK_EXISTING = args.has("--mark-existing");
const DEST = expandHome(process.env.PLAUD_SYNC_DEST || process.env.RECORDINGS_DIR || readDotEnv().RECORDINGS_DIR || "");
const SIDECAR = process.env.PLAUD_SYNC_SIDECAR === "1";
const SCAN_PAGES = Math.max(1, parseInt(process.env.PLAUD_SYNC_PAGES ?? "3", 10) || 3);

class AuthError extends Error {}

/** RECORDINGS_DIR and friends from the .env at the repository root, when run by hand. */
function readDotEnv() {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
    const out = {};
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
    return out;
  } catch {
    return {};
  }
}

function expandHome(p) {
  return p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p;
}

function log(...parts) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}]`, ...parts);
}

function notify(title, message) {
  if (process.platform !== "darwin") return;
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  execFile("osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`], () => {});
}

// ---------- state ----------
async function loadState() {
  try {
    return JSON.parse(await fsp.readFile(STATE_PATH, "utf8"));
  } catch {
    return { initialized: false, synced: {}, lastAuthNotice: 0 };
  }
}
async function saveState(state) {
  const tmp = STATE_PATH + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, STATE_PATH);
}

// ---------- auth (same token file + refresh flow as the official CLI) ----------
function jwtExpired(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return typeof payload.exp === "number" && payload.exp * 1000 <= Date.now();
  } catch {
    return false;
  }
}

async function getAccessToken() {
  let tokens;
  try {
    tokens = JSON.parse(await fsp.readFile(TOKEN_PATH, "utf8"));
  } catch {
    throw new AuthError("No Plaud login found (~/.plaud/tokens.json). Run `plaud login`.");
  }
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60_000) {
    if (!tokens.refresh_token || jwtExpired(tokens.refresh_token)) {
      throw new AuthError("Plaud login expired. Run `plaud login`.");
    }
    const res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ refresh_token: tokens.refresh_token }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`Plaud refused the token refresh (${res.status}). Run \`plaud login\`.`);
    }
    if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? tokens.refresh_token,
      token_type: data.token_type ?? "Bearer",
      expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    };
    const tmp = TOKEN_PATH + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, TOKEN_PATH);
    log("Refreshed Plaud access token.");
  }
  return tokens.access_token;
}

async function api(token, p) {
  const res = await fetch(API_BASE + p, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) throw new AuthError("Plaud rejected the access token. Run `plaud login`.");
  if (!res.ok) throw new Error(`API ${p} -> ${res.status} ${res.statusText}`);
  return res.json();
}

// ---------- helpers ----------
/**
 * Plaud's API gives its times in UTC and often without saying so
 * ("2026-10-16T09:22:31"), which JavaScript would read on this Mac's clock:
 * a time with no offset is UTC, as Plaud's own CLI reads it.
 */
export function toDate(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const n = Number(v);
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  const s = String(v).trim();
  const d = new Date(/\d{2}:\d{2}/.test(s) && !/(?:[Zz]|[+-]\d{2}(?::?\d{2})?)$/.test(s) ? `${s}Z` : s);
  return isNaN(d) ? null : d;
}

/** "2026-10-16_0922": the start time in UTC, so a name says the same on any Mac. */
export function stamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

export function safeName(s) {
  return (
    String(s ?? "")
      .normalize("NFC")
      .replace(/[\/\\:*?"<>|\x00-\x1f]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "recording"
  );
}

const EXT_BY_TYPE = {
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/webm": ".webm",
};
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|wav|webm|flac)$/i;

function pickExt(url, contentType) {
  const fromUrl = path.extname(new URL(url).pathname).toLowerCase();
  if (AUDIO_EXT.test(fromUrl)) return fromUrl;
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return EXT_BY_TYPE[ct] ?? ".mp3";
}

/**
 * The recordings already in the folder (and its Private subfolder), by the
 * id token in their names: `[of_177b5]` → the audio file's name when one is
 * there, else the name of whatever carries the token (a transcript, say).
 * Hidden files are left out, as the server leaves them out.
 */
export async function idsInFolder(dest) {
  const found = new Map();
  for (const dir of [dest, path.join(dest, PRIVATE_DIR)]) {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const m = /\[([^\[\]\s]{1,16})\]\./.exec(name);
      if (!m) continue;
      const id = m[1];
      const have = found.get(id);
      if (!have || (!AUDIO_EXT.test(have) && AUDIO_EXT.test(name))) found.set(id, name);
    }
  }
  return found;
}

async function download(url, destDir, base) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Audio download failed: ${res.status}`);
  const ext = pickExt(url, res.headers.get("content-type"));
  const finalPath = path.join(destDir, base + ext);
  // Write to a hidden temp file in the same folder, then rename, so anything
  // watching the folder never sees a half-written file.
  const tmpPath = path.join(destDir, `.${base}${ext}.part`);
  const out = fs.createWriteStream(tmpPath);
  try {
    for await (const chunk of res.body) {
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    const expected = Number(res.headers.get("content-length"));
    const { size } = await fsp.stat(tmpPath);
    if (expected && size !== expected) throw new Error(`Incomplete download (${size}/${expected} bytes)`);
    await fsp.rename(tmpPath, finalPath);
  } catch (e) {
    out.destroy();
    await fsp.rm(tmpPath, { force: true });
    throw e;
  }
  return finalPath;
}

// ---------- main ----------
async function listRecent(token, maxPages) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await api(token, `/open/third-party/files/?page=${page}&page_size=${PAGE_SIZE}`);
    const items = res.data ?? [];
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  return all;
}

/** One look at Plaud. Resolves to how many recordings it copied; throws when the look itself failed (the login, the list). */
async function sync(state) {
  const token = await getAccessToken();
  const files = await listRecent(token, state.initialized ? SCAN_PAGES : 1000);

  if (MARK_EXISTING) {
    for (const f of files) state.synced[f.id] ??= { skipped: true, at: new Date().toISOString() };
    state.initialized = true;
    await saveState(state);
    log(`Marked ${files.length} existing recordings as already synced. Only new ones will be downloaded.`);
    return 0;
  }

  // What the folder already holds is synced, wherever it came from (Dropbox, an earlier Mac).
  const inFolder = await idsInFolder(DEST);
  let noted = 0;
  for (const f of files) {
    if (state.synced[f.id]) continue;
    const file = inFolder.get(f.id.slice(0, ID_CHARS));
    if (!file) continue;
    state.synced[f.id] = { file, at: new Date().toISOString(), found: true };
    noted++;
  }
  if (noted) {
    await saveState(state);
    log(`${noted} recording(s) already in the folder, noted.`);
  }

  // Oldest first, so files land in chronological order.
  const pending = files.filter((f) => !state.synced[f.id]).reverse();
  if (!pending.length) {
    state.initialized = true;
    return 0; // quiet when nothing is new
  }
  const fresh = pending.filter((f) => !state.retries?.[f.id]).length;
  if (fresh) log(`${fresh} new recording(s) in Plaud.`);

  let ok = 0;
  for (const f of pending) {
    try {
      const detail = await api(token, `/open/third-party/files/${encodeURIComponent(f.id)}`);
      if (!detail.presigned_url) {
        // Give up after ~a day of 5-minute retries (e.g. audio deleted in Plaud).
        state.retries ??= {};
        const n = (state.retries[f.id] = (state.retries[f.id] ?? 0) + 1);
        if (n >= 300) {
          state.synced[f.id] = { skipped: "no audio after 300 tries", at: new Date().toISOString() };
          delete state.retries[f.id];
          log(`  ${f.id} "${detail.name ?? f.name}": still no audio, giving up.`);
        } else if (n === 1) {
          log(`  ${f.id} "${detail.name ?? f.name}": audio not ready yet; will keep retrying.`);
        }
        await saveState(state);
        continue;
      }
      const when = toDate(detail.start_at) ?? toDate(detail.created_at) ?? toDate(f.created_at) ?? new Date();
      const base = `${stamp(when)} ${safeName(detail.name ?? f.name)} [${f.id.slice(0, ID_CHARS)}]`;
      if (DRY_RUN) {
        log(`  would download -> ${base}.*`);
        continue;
      }
      const saved = await download(detail.presigned_url, DEST, base);
      if (SIDECAR) {
        const meta = {
          id: detail.id ?? f.id,
          name: detail.name ?? f.name,
          start_at: detail.start_at ?? null,
          created_at: detail.created_at ?? f.created_at ?? null,
          duration: detail.duration ?? f.duration ?? null,
          serial_number: detail.serial_number ?? null,
          audio_file: path.basename(saved),
        };
        await fsp.writeFile(saved.replace(/\.[^.]+$/, ".json"), JSON.stringify(meta, null, 2));
      }
      state.synced[f.id] = { file: path.basename(saved), at: new Date().toISOString() };
      if (state.retries) delete state.retries[f.id];
      await saveState(state);
      ok++;
      log(`  saved ${path.basename(saved)}`);
    } catch (e) {
      if (e instanceof AuthError) throw e;
      log(`  ${f.id}: ${e.message}; will retry next run.`);
    }
  }
  if (!DRY_RUN) {
    state.initialized = true;
    if (ok) notify("Plaud sync", `${ok} new recording${ok > 1 ? "s" : ""} copied to ${path.basename(DEST)}`);
  }
  return ok;
}

async function main() {
  if (!DEST) {
    console.error("Set RECORDINGS_DIR in .env (npm run setup does it), or PLAUD_SYNC_DEST, to the destination folder.");
    process.exit(1);
  }
  await fsp.mkdir(DEST, { recursive: true });
  await fsp.mkdir(PLAUD_DIR, { recursive: true, mode: 0o700 });
  const state = await loadState();

  const run = { at: new Date().toISOString(), ok: true, error: null, copied: 0 };
  try {
    run.copied = await sync(state);
  } catch (e) {
    run.ok = false;
    run.error = e.message;
    if (e instanceof AuthError) {
      log(`AUTH: ${e.message}`);
      // Nag at most once every 12 hours.
      if (Date.now() - (state.lastAuthNotice ?? 0) > 12 * 3600_000) {
        notify("Plaud sync needs you", "Plaud login expired. Open Terminal and run: plaud login");
        state.lastAuthNotice = Date.now();
      }
      process.exitCode = 2;
    } else {
      log(`ERROR: ${e.message}`);
      process.exitCode = 1;
    }
  }
  // How this look went, for the server's Settings page: a laptop sees it where the notification above is not.
  state.lastRun = run;
  await saveState(state);
}

// Run when started as a program; a test imports the helpers above without syncing anything.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
