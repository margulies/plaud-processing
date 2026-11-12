# Your recordings on your phone and other computers

There are two ways, and you can use both.

## 1. The files, through Dropbox (nothing to set up)

Every recording's transcript and notes are written next to its audio, in the folder you chose, as plain files:

- `<name>.notes.md`: the notes (Markdown, readable as plain text)
- `<name>.transcript.txt`: the transcript, with speaker names and times

Open the folder in the Dropbox app on your phone, or in Finder or Explorer on another computer, and read them there. They update whenever you rename speakers or Claude writes the notes again.

The `Private` subfolder holds the private recordings and their transcripts. Hidden folders (`.processing`, `.transcripts`) hold the page's own data; you can ignore them.

## 2. The web page, through Tailscale

The page runs on your Mac at `http://localhost:8787`, which only works on that Mac. To use it from your phone or laptop, anywhere, use [Tailscale](https://tailscale.com): a free private network between your own devices. Nothing is opened to the internet; only devices signed in to your Tailscale account can reach it.

1. Install Tailscale on the Mac (the Mac App Store or tailscale.com) and on your phone, and sign in to the same account on both.
2. On the Mac, in Terminal:

   ```bash
   tailscale serve --bg 8787
   ```

   (If `tailscale` isn't found: `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 8787`.) The first time, it may ask you to enable HTTPS for your tailnet; follow the link it prints.

3. It prints an address like `https://your-mac.tail1234.ts.net`. Open that on your phone (with Tailscale switched on) and add it to your home screen.

To stop: `tailscale serve reset`.

The server accepts any `*.ts.net` name, so this works without changing anything. For other ways in (another host name, a reverse proxy), add the name to `ALLOWED_HOSTS` in `.env` and `npm run restart`.

### Why not just open the port?

You can set `HOST=0.0.0.0` in `.env` to reach the page from other machines on your home network at `http://your-mac.local:8787` (add that name to `ALLOWED_HOSTS` if it isn't accepted). But the page has **no password**: anyone on the same network (a café, an office) could read your recordings. Tailscale is the safer way.
