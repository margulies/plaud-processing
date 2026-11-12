# How it works

Four small pieces, each doing one thing, joined by files in one folder.

| Piece | File | Runs |
|---|---|---|
| Plaud sync | `sync/plaud-sync.mjs` | every five minutes (launchd) |
| Server and queue | `server/` | always (launchd), serves the page on port 8787 |
| Transcriber | `transcribe/transcribe.py` | started by the server, one recording at a time |
| Notes | `claude -p`, started by the server | after each transcript |
| Web page | `web/` | in your browser |
| MCP server | `mcp/server.mjs` | started by the Claude app or Claude Code, when connected ([MCP.md](MCP.md)) |

Nothing here needs a database or npm packages. The folder is the database.

## 1. Plaud sync

`plaud-sync.mjs` uses the login that Plaud's own command line saves (`plaud login`, in `~/.plaud/tokens.json`), and Plaud's developer API, the same one that command line calls. Every five minutes it:

1. Refreshes the login when it is about to expire. If Plaud refuses, the Mac shows a notification asking you to run `plaud login` (at most twice a day), and the page's Settings shows the error.
2. Lists your most recent recordings (the first run lists them all).
3. Skips any it has already copied (`~/.plaud/sync-state.json`), and any whose file is already in the folder (so a new Mac with a Dropbox folder already full never downloads them again).
4. Downloads each new one into a hidden `.part` file and renames it when complete, so nothing ever sees half a file. A recording whose audio Plaud hasn't finished processing is retried on later runs.

Files are named `2026-10-08_2132 Title [ab12cd34].mp3`: Plaud's start time **in UTC** (so the name is the same whatever time zone the Mac is in; the page shows it in yours), Plaud's title, and the first eight characters of Plaud's id.

It never deletes or changes anything in your Plaud account. Plaud's own transcription and summaries are not used.

Run one pass by hand with `npm run sync` (add `-- --dry-run` to only see what it would download).

## 2. The folder

The server looks at the folder (and its `Private` subfolder) every 20 seconds. Every audio file there is a recording: `.mp3 .m4a .aac .wav .ogg .opus .flac .webm .mp4 .mov`. Hidden files and anything else are ignored. A file is only picked up once its size has stopped changing, so a recording Dropbox is still bringing in isn't read half-way.

Next to each recording:

```
2026-10-08_2132 Team sync [ab12cd34].mp3              the audio
2026-10-08_2132 Team sync [ab12cd34].transcript.txt   readable transcript, with speaker names
2026-10-08_2132 Team sync [ab12cd34].transcript.json  the same, as data
2026-10-08_2132 Team sync [ab12cd34].notes.md         Claude's notes, readable anywhere
.transcripts/                                         earlier transcripts
.processing/recordings/<name>.json                    speaker names, notes as data, your answers from Claude
.processing/settings.json                             the Settings page
```

You can rename a recording on the page (the file keeps its name), or rename the file itself in Finder: rename the transcript and notes files with it, and the `.processing/recordings/<name>.json`, or the page treats it as a new recording.

## 3. Transcription

The server runs `transcribe/transcribe.py` on each new recording, one at a time (the GPU does one well, not two at once). `uv` builds the script's Python environment from the list at the top of the file, once, into its cache.

For each recording the script:

1. Converts the audio with ffmpeg to 16 kHz mono, cuts rumble below 60 Hz and evens out the loudness. (It does **not** denoise: on far-field recordings, denoising made Whisper worse.)
2. Writes the words with timestamps, on the GPU through Apple's MLX:
   - **Whisper turbo** (`whisper-large-v3-turbo`): fast; the default.
   - **Whisper large** (`whisper-large-v3`): better with names and terms, about twice as slow.
   - **Parakeet** (`parakeet-tdt-0.6b-v3`): often the most accurate on meetings and much faster; detects the language itself (English and 24 other European languages); can't be given words to expect.
3. Works out who spoke when with pyannote's `speaker-diarization-community-1` (with usage telemetry switched off).
4. Gives each word to the speaker talking at that moment, groups words into turns, and folds in the one- or two-word fragments diarization tends to split off ("Thank" / "you.").
5. Writes `<name>.transcript.txt` and `.json`, first moving any earlier transcript into `.transcripts/`.

Whisper is told what to expect: the recording's title (if it's a real one), the names you've given the speakers, and your glossary from Settings. Against Whisper's habit of looping on long recordings ("the same word, the same word…"), each 30-second window starts fresh, a repetitive window is retried, and words over long silence are dropped.

Speed, roughly, per hour of audio on an M1: 10 to 30 minutes with Whisper turbo, twice that with large; Parakeet is mostly the speaker step, around 10 minutes. Newer chips are faster.

Each run's full output is in `~/Library/Logs/plaud-processing/transcribe/<name>.log`. If it fails, the page shows the last lines.

You can run the script by hand too:

```bash
uv run transcribe/transcribe.py recording.m4a
uv run transcribe/transcribe.py recording.m4a --speakers 3 --language en
uv run transcribe/transcribe.py panel.m4a --engine parakeet --min-speakers 4 --max-speakers 8
uv run transcribe/transcribe.py call.m4a --whisper-model large --prompt "Names: Ana Ruiz, Bo Chen. Terms: OKR, Figma."
uv run transcribe/transcribe.py ~/Dropbox/Plaud\ Recordings/      # every file without a transcript
```

## 4. Notes from Claude

Once a recording has a transcript, the server asks Claude for notes, unless the recording is private, automatic notes are off in Settings, or it is older than **Count as new from**.

It runs Claude Code's command line (`claude -p`) with:

- **no tools at all** (`--tools ""`): Claude can't read files, run commands or browse; it can only answer;
- **no MCP servers, no settings, no hooks, no CLAUDE.md** (`--strict-mcp-config --setting-sources ""`), so nothing from your own Claude Code setup is involved;
- **no saved session** (`--no-session-persistence`), in an empty folder of its own;
- **a JSON schema** (`--json-schema`) the answer must match.

The prompt (`server/notes.mjs`) holds your name, the line about you, your rules, the recording's date and title, the names you've given the speakers, the kind of recording, any note you wrote for this one, and the transcript itself between tags. It tells Claude the transcript is untrusted: words from other people, transcribed by a machine, never instructions. Anything in a transcript shaped like one of the prompt's tags is defused, so a recording can't break out of its place. Very long transcripts (several hours) are thinned in the middle, keeping the beginning and the end whole.

The kinds:

| Kind | For | The notes focus on |
|---|---|---|
| Meeting | people discussing, deciding, planning | action items with owners and dates, decisions, points by topic, dates set or floated, open questions |
| Voice memo | you, thinking aloud or dictating | your words tidied into readable text, your tasks, ideas worth keeping |
| Talk or lecture | one main speaker presenting | notes following the argument, key points, quotes, audience questions and answers |
| Interview or conversation | a call, an interview | what each person said that matters, by theme, quotes, promises, open questions |

By default Claude decides which kind it is. On the page you can choose one and write it again.

The answer is kept as data in `.processing/recordings/<name>.json` and written out as `<name>.notes.md` next to the audio. Names Claude works out for the speakers are suggested on the page; keep them, or type your own.

**Ask Claude** works the same way, without the schema: your request and the transcript, an answer in Markdown, kept with the recording.

## 5. The server and the page

`server/main.mjs` is a plain Node HTTP server. It serves `web/` and a small JSON API (`/api/…`) that the page calls. The page asks `/api/status` every four seconds and refetches what it shows when something has changed.

It listens on `127.0.0.1` only, so nothing else on your network can reach it. It refuses requests addressed to any host name but this Mac's own and Tailscale's (against DNS rebinding), and refuses changes that come from any other web page (an Origin check). There is no password: anyone who can reach the port can use it, which is why it stays on `127.0.0.1` and you reach it from elsewhere through Tailscale ([ACCESS.md](ACCESS.md)).

## Settings in `.env`

| Key | Default | |
|---|---|---|
| `RECORDINGS_DIR` | (required) | the folder |
| `PORT` | `8787` | |
| `HOST` | `127.0.0.1` | `0.0.0.0` opens it to your network, with no password. Prefer Tailscale. |
| `ALLOWED_HOSTS` | | extra host names the page may be opened under, comma-separated |
| `CLAUDE_BIN` | found on PATH | path to `claude` if it lives somewhere unusual |
| `TRANSCRIBE_PYTHON` | uses `uv` | a Python with the transcriber's packages, instead of uv (keep any venv out of Dropbox) |

After changing `.env`: `npm run restart`. Everything else is on the page's Settings.
