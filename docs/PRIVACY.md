# Privacy: what goes where

| | Where it goes |
|---|---|
| **Audio** | Plaud's cloud (the Plaud app uploads it, as always) → your Mac → your Dropbox, if the folder is in Dropbox. Nowhere else. |
| **Transcription** | Entirely on your Mac. The models are downloaded once from Hugging Face; no audio or text is sent anywhere to transcribe. The speaker model's usage telemetry is switched off. |
| **Transcript text** | Your Mac and your Dropbox. Sent to Anthropic (Claude) only to write notes or answer your requests, and never for private recordings. |
| **Notes and Claude's answers** | Your Mac and your Dropbox. |
| **Your settings** (name, rules, glossary) | The recordings folder (`.processing/settings.json`), so in your Dropbox. Your name, the line about you and your rules go to Claude with each transcript. |
| **Plaud login** | `~/.plaud/` on the Mac, readable only by you. Only sent to Plaud. |

## Claude

When Claude writes notes, Claude Code sends the transcript's text (never the audio) to Anthropic, under whichever account Claude Code is signed in with: a Claude subscription, or an API key. Anthropic's own terms and privacy settings for that account apply; see https://www.anthropic.com/legal.

Claude runs with no tools at all, so whatever someone says in a recording can't make it read your files, run commands or go online. It can only answer.

To keep a recording away from Claude, **make it private** (on its page: 🔒 Make private). It moves, with its transcript, into the `Private` folder; it is still transcribed on the Mac, and never sent to Claude. If it already had notes, they stay; delete them in the folder if you like.

To decide recording by recording instead, switch off **Then have Claude write the notes** in Settings. Nothing is sent until you press **Write notes with Claude** on a recording's page.

Without Claude Code installed, nothing is ever sent anywhere.

## The people you record

Recording laws differ between countries and states, and many people expect to be told. Tell people when you're recording, and handle the transcripts as you would any notes about them.

## The web page

It listens only on your Mac (`127.0.0.1`). To reach it from elsewhere, use Tailscale ([ACCESS.md](ACCESS.md)), which keeps it among your own devices. It has no password of its own, so don't open its port to a network you don't control.

## Removing a recording

Delete its files from the folder (the audio, `.transcript.*`, `.notes.md`, and if you like `.processing/recordings/<name>.json` and its files in `.transcripts/`). Deleting it in the folder doesn't delete it from Plaud's cloud; do that in the Plaud app. The sync won't download it again: it remembers what it has copied.
