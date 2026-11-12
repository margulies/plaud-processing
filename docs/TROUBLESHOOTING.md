# When something doesn't work

Start with:

```bash
cd ~/plaud-processing
npm run doctor     # what's missing, and the command for each
npm run status     # are the background jobs running, and their last log lines
```

The page's **Settings → How things stand** says the same for the sync, transcription and Claude. Logs are in `~/Library/Logs/plaud-processing/` (`server.log`, `sync.log`, and `transcribe/<recording>.log`).

## The page doesn't open

- `npm run status`: is the server `running`? If not, `npm run restart`, then look at the end of `~/Library/Logs/plaud-processing/server.log`.
- "RECORDINGS_DIR is not set" in the log: run `npm run setup`.
- Something else uses port 8787: set `PORT=8788` in `.env`, then `npm run restart`.
- "This host name is not allowed": you opened it under a name the server doesn't know. Use `localhost`, or add the name to `ALLOWED_HOSTS` in `.env`.

## New Plaud recordings don't arrive

- Did the Plaud app finish uploading? The recording must be in Plaud's cloud (visible in the Plaud app or web app).
- `npm run sync` runs one pass in the window and says what it finds.
- "Plaud login expired" / "No Plaud login found": run `plaud login` (install it with `npm install -g @plaud-ai/cli` if it's missing).
- "audio not ready yet": Plaud is still processing the upload; it's retried every five minutes.
- Check Dropbox has synced: the file should be in the folder on the Mac.

## A recording stays "Not transcribed"

- It's older than **Settings → Count as new from**, so it waits for you: open it and press **Transcribe**, or use **Transcribe N waiting** above the list.
- **Transcribe new recordings as they arrive** is off in Settings.
- Transcription isn't available: Settings says why (ffmpeg or uv missing, not Apple Silicon).
- Dropbox has the file online-only: make the folder available offline (right-click in Finder).

## Transcription fails

The recording's page shows the last lines of the log; the whole log is in `~/Library/Logs/plaud-processing/transcribe/`.

- **401 / 403 from Hugging Face, or "Could not load the diarization model"**: the speaker model's conditions weren't accepted, or there's no token. Accept them at https://huggingface.co/pyannote/speaker-diarization-community-1 with the same account, then `uvx hf auth login`.
- **The first run is slow or stops while downloading**: it fetches about 3 GB of models. Check the connection and disk space, and try again.
- **A crash right after "Detected language"**: a threading clash between libraries; the script sets `NUMBA_THREADING_LAYER=workqueue` against it. If it persists, try Parakeet.
- **"ffmpeg not found"**: `brew install ffmpeg`, then `npm run restart`.
- **Out of memory on a very long recording**: try Parakeet, or close other heavy apps.

## The transcript is wrong

- **Speakers merged or split wrongly**: Transcribe again with the exact number of speakers, or a range when unsure (a range does better than a guessed exact count).
- **Names and jargon misheard**: add them to Settings → Glossary, or type them in **Words to expect**, and transcribe again with **Whisper large**. Or try **Parakeet**.
- **Wrong language**: set the language (Whisper), or use Parakeet, which detects it.
- **The same words over and over** (a hallucination loop): try Parakeet, which doesn't loop.
- Small mistakes: correct the line on the page (✎ next to it).

Earlier transcripts are never lost: **Transcribe again → Earlier transcripts → Use this one**.

## Notes don't appear

- Settings says "Claude Code is not installed": install it from https://claude.com/claude-code.
- "Claude Code is not signed in": open Terminal, run `claude`, sign in, then press **Try again** on the recording.
- The recording is private (never sent to Claude), or older than **Count as new from** (press **Write notes with Claude**), or automatic notes are off.
- The server can't find `claude`: set `CLAUDE_BIN=/full/path/to/claude` in `.env` (`which claude` in Terminal tells you the path), then `npm run restart`.
- Usage limits: if your Claude plan's limit is reached, the error says so; try later.

## The Mac was asleep

Nothing is lost. The sync and the queue catch up when it wakes. For a Mac that should always process, see [SETUP.md](SETUP.md#6-keep-the-mac-working).

## Starting over

Your recordings are safe in the folder whatever you do. `npm run uninstall`, then `npm run setup`. To reprocess everything from scratch, delete the `.transcript.*` and `.notes.md` files and the `.processing` folder (it holds your speaker names and Claude's answers).
