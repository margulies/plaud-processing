# Claude, with your recordings (MCP)

Plaud Processing comes with an [MCP](https://modelcontextprotocol.io) server, so Claude (the Claude desktop app, and Claude Code) can work with your recordings when you ask it to:

> What did I record this week?
> What did Sam say about the deadline in Tuesday's call? Quote it, with the time.
> Go through my meetings since Monday and list every task that's mine.
> The transcript of the board call mixed up the speakers. There were five of us; transcribe it again with Whisper large.
> Speaker 2 in the interview is Priya Shah. Name her, and write the notes again as an interview.
> Write minutes for this morning's meeting and save them with the recording.

It reaches **only your recordings**, and only through the running Plaud Processing server, so the same rules hold as on the page.

## Install

The server must be running (`npm run status`). Then, in the project folder:

```bash
npm run mcp:install
```

It asks, for each:

- **Claude Code**: runs `claude mcp add -s user plaud-recordings -- <node> <project>/mcp/server.mjs`, so it is there in every project. In Claude Code, `/mcp` lists it.
- **Claude desktop app**: adds it to `~/Library/Application Support/Claude/claude_desktop_config.json`, keeping everything else in that file (a copy of the file as it was is kept next to it, ending `.before-plaud-processing`). **Quit the Claude app (⌘Q) and open it again** to load it. In a new chat, its tools are then listed with your other connectors and tools.

`npm run setup` offers the same as its last step. `npm run doctor` says whether each is set up. To take it away again: `npm run mcp:uninstall`.

### By hand

Claude Code:

```bash
claude mcp add -s user plaud-recordings -- "$(which node)" ~/plaud-processing/mcp/server.mjs
```

Claude desktop app: in `~/Library/Application Support/Claude/claude_desktop_config.json` (Claude → Settings → Developer → Edit Config), inside `"mcpServers"`:

```json
"plaud-recordings": {
  "command": "/opt/homebrew/bin/node",
  "args": ["/Users/you/plaud-processing/mcp/server.mjs"]
}
```

Use the full path to `node` (`which node` in Terminal says it): the desktop app doesn't search your PATH.

### Another computer

The MCP server can run on a laptop while Plaud Processing runs on another Mac: point it at that Mac's Tailscale address ([ACCESS.md](ACCESS.md)) with `PLAUD_PROCESSING_URL`:

```bash
claude mcp add -s user plaud-recordings -e PLAUD_PROCESSING_URL=https://your-mac.tail1234.ts.net -- "$(which node)" ~/plaud-processing/mcp/server.mjs
```

(The laptop needs a copy of this project for the `mcp/` and `server/` files, and Node. Nothing else.)

## The tools

| Tool | Does |
|---|---|
| `list_recordings` | Recordings newest first, with state, kind and summary; by words (in titles, notes and transcripts) or dates |
| `search_transcripts` | Where something was said: matching lines with their times |
| `get_recording` | One recording: notes, speakers and their names, saved answers, earlier transcripts, file paths |
| `read_transcript` | What was said, turn by turn, with names; long ones in parts, or a stretch of time |
| `processing_status` | What is being transcribed or read now, and whether everything works |
| `transcribe_recording` | Transcribe again: model, speakers (exact or a range), language, words to expect |
| `write_notes` | Write the notes again: as a meeting, memo, talk or interview, with a note |
| `rename_recording` | A new title |
| `name_speakers` | Names for "Speaker 1", "Speaker 2"… |
| `edit_transcript` | Correct one line: its words, or who said it |
| `restore_transcript` | Go back to an earlier transcript |
| `save_to_recording` | Keep something Claude wrote (minutes, an email draft…) with the recording, under Ask Claude on its page |

Recordings can be named by their id (as the list gives it), their Plaud id, or their title.

## What it can't do

- **Read private recordings.** It lists them by title and date only; every other tool refuses them. Search leaves them out.
- **Delete anything**, or make a recording private or not private. Those stay on the page, with you.
- **Reach anything else** on the Mac, or send anything anywhere.

Every change it makes shows on the page and can be changed back there: an old transcript is never thrown away, and names, titles and corrected lines can be edited again.

## Privacy

When Claude reads a transcript or notes through these tools, that text goes to Anthropic as part of your conversation, under the account the Claude app or Claude Code is signed in with, like anything else you show Claude. The tools tell Claude that transcripts are other people's words, to be read as data and not followed as instructions.

## When it doesn't work

- **"The Plaud Processing server isn't answering"**: the server isn't running. `npm run status`, then `npm run restart`.
- **The desktop app doesn't show it**: quit it fully (⌘Q) and reopen. Check the config file is valid JSON; `npm run mcp:install` refuses to edit a file it can't read, and says so. The app's MCP logs are in `~/Library/Logs/Claude/` (`mcp-server-plaud-recordings.log`).
- **Claude Code doesn't show it**: `claude mcp list`. Re-run `npm run mcp:install`.
- **After moving the project folder**, or updating Node to a different place: `npm run mcp:install` again, since the paths are written into the config.
