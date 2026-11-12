# Setting it up, step by step

This takes about half an hour, most of it downloads. You'll type a few commands in Terminal (Applications → Utilities → Terminal); copy them exactly. `npm run setup` does most of it for you and asks before each step, so in practice you run that and answer its questions. This page explains what it does, so you know what you're agreeing to, and how to do any step by hand.

## 0. Before you start

- A Mac with Apple Silicon: Apple menu → About This Mac should say **Chip: Apple M1** (or M2, M3, M4…).
- **Dropbox** installed and signed in, if you want your recordings on your other devices (recommended).
- Your **Plaud** recorder working with the Plaud app as usual, uploading to Plaud's cloud.

## 1. Homebrew, Node and Git

[Homebrew](https://brew.sh) installs the other tools. If `brew --version` in Terminal says "command not found", install it with the one line on brew.sh, and follow what it prints at the end (it asks you to run two lines to add it to your PATH).

Then:

```bash
brew install node git
```

## 2. Get this project

```bash
git clone https://github.com/margulies/plaud-processing.git ~/plaud-processing
cd ~/plaud-processing
```

Keep the project folder **outside** Dropbox (your home folder is fine). Only the recordings folder belongs in Dropbox.

## 3. Run the setup

```bash
npm run setup
```

It goes through the following, in order.

### The recordings folder

Where the audio lands and where the transcripts and notes are written. It suggests `Plaud Recordings` inside your Dropbox. It writes your answer to `.env` in the project folder.

**In Dropbox, make this folder available offline** (right-click it in Finder → Make available offline). If Dropbox keeps files online-only, the Mac has to download each one before it can transcribe it, and may not.

### ffmpeg and uv

`ffmpeg` converts the audio; `uv` runs the Python transcriber in its own environment (it downloads Python and the libraries it needs the first time, into a cache, without touching any Python you have). Setup offers `brew install ffmpeg uv`.

### The speaker model (Hugging Face)

Telling speakers apart uses [pyannote's speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1), which is free but gated: you have to accept its conditions once.

1. Make a free account at https://huggingface.co.
2. Open https://huggingface.co/pyannote/speaker-diarization-community-1 and accept the conditions (it asks for a name and affiliation; "personal use" is fine).
3. Make a token at https://huggingface.co/settings/tokens: **Create new token** → type **Read** → copy it.
4. When setup asks to sign in (or later with `uvx hf auth login`), paste the token. You can answer "n" to the question about git credentials.

### Your Plaud account

Setup installs Plaud's own command line (`npm install -g @plaud-ai/cli`) and runs `plaud login`, which opens a browser for you to sign in to Plaud. The login is kept in `~/.plaud/`; the sync only reads it.

Then it asks whether to **download the recordings already in your Plaud account**. "No" (the default) means only recordings made from now on come down; the ones already there are noted as done. "Yes" downloads them all over the next few runs. Older recordings are not transcribed on their own either way (see "Count as new from" below); you can start them from the page.

### Claude Code (for notes)

Notes are written by Claude through [Claude Code](https://claude.com/claude-code), Anthropic's command-line tool. Install it from that page, then run `claude` once in Terminal and sign in, either with a Claude subscription (Pro or Max) or with an Anthropic API key. Notes then count against that subscription or are billed to that key; each recording's notes show what they cost.

Without Claude Code, everything else works: you get transcripts, but no notes and no "Ask Claude".

### The background jobs

Setup installs two launchd agents (macOS's way of running things in the background), so you never have to start anything:

- `local.plaud-processing.server`: the web server and the transcription queue. Starts at login, restarts if it stops.
- `local.plaud-processing.sync`: looks at your Plaud account every five minutes and downloads what is new.

Their definitions are in `~/Library/LaunchAgents/`, their logs in `~/Library/Logs/plaud-processing/`. `npm run uninstall` removes them.

At the end, setup prints a checklist (the same as `npm run doctor`) and the address of the page.

## 4. Open the page

Go to **http://localhost:8787**. Bookmark it.

Then open **Settings** on the page:

- **Your name**, so the notes can tell your tasks from other people's, and a line **about you** and your work.
- **Glossary**: names, companies and jargon you use, so Whisper spells them right.
- **Your rules** for the notes, in your own words.
- **Count as new from**: recordings older than this are left for you to start by hand, so a folder of old audio doesn't queue days of work. It is set to the moment the server first ran.

## 5. Try it

Make a short recording on the Plaud, let the Plaud app upload it, and wait. Within five minutes it appears on the page as "Waiting to transcribe", then "Transcribing", then the notes arrive.

The **first** transcription downloads the models (about 3 GB for Whisper and the speaker model, 2.5 GB more if you ever use Parakeet), so give it a while. After that it works offline.

To try without the Plaud: copy any audio file (`.m4a`, `.mp3`, `.wav`…) into the recordings folder.

## 6. Keep the Mac working

The server only works while the Mac is awake. On a desktop Mac, System Settings → Energy (or Battery → Options) → **Prevent automatic sleeping when the display is off**. On a laptop, recordings simply wait and are processed next time it's awake.

## Updating

```bash
cd ~/plaud-processing
git pull
npm run restart
```

## Removing it

```bash
cd ~/plaud-processing
npm run uninstall          # stops and removes the background jobs
```

Your recordings, transcripts and notes stay in the folder. To remove the rest: delete the project folder, `~/.plaud` (the Plaud login), `~/Library/Logs/plaud-processing`, and the models in `~/.cache/huggingface` (they may be shared with other tools).
