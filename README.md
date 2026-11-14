# yt-down

> ⬢ Interactive YouTube Downloader CLI — powered by yt-dlp

A premium interactive CLI tool wrapping **yt-dlp** with beautiful prompts, real-time progress, and smart format selection.

## Features

- 📹 **Video Download** — Choose quality from dynamically fetched formats (4K → 144p)
- 🎙 **Podcast Mode** — Auto-select best audio track for audio-only downloads
- ⬢ **Beautiful CLI** — Built with `@clack/prompts` + `chalk` for a premium feel
- ⚡ **Fast** — Powered by Bun runtime
- 📊 **Smart Formats** — Groups by resolution, shows codec + filesize, auto-merges with ffmpeg
- 🔄 **Interruption Recovery** — Waits through connection failures and resumes saved downloads

## Prerequisites

| Tool | Required |
|:---|:---|
| [Bun](https://bun.sh) | ≥ 1.3 |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Latest |
| [ffmpeg](https://ffmpeg.org) | For video+audio merging |

## Quick Start

```bash
# Install dependencies
make install

# Run the tool
make start

# Or with live-reload during development
make dev
```

## Usage

```bash
bun run bin/yt-down.ts
```

1. Select mode: **Video** or **Podcast (Audio Only)**
2. Paste a YouTube URL
3. Pick your quality (video mode) or auto-select best audio (podcast mode)
4. Confirm and watch the download with live progress

Downloads are saved to `~/Videos/yt-down/`.

### Interrupted downloads

During video and audio downloads, connection failures automatically trigger a
retry after 2, 4, 8, 16, then 30 seconds between attempts. Retries continue while
the connection is unavailable. Each attempt refreshes the download URLs from
the original YouTube URL and resumes existing `.part` files and fragment state.
The downloader uses a 15-second socket timeout so stalled connections can recover.

Press **Ctrl+C** to cancel either an active download or a retry countdown.
Partial files stay in the output folder. To resume after cancelling or closing
the app, run it again with the same URL, quality, and output folder; keep the
`.part` and `.ytdl` files. Resume requires server support and matching filenames;
the server may require a restart if it cannot serve the saved position.

Failed fragments are never silently skipped. Temporary server errors are retried,
while persistent access rejection stops after three URL refreshes. Permanent
errors, such as a full disk, missing permissions, unavailable formats, or required
sign-in, stop and show the underlying error. Initial metadata fetching still
requires a working connection.

### Browser cookies

yt-down automatically uses an existing Zen cookie database (including Arch's
`~/.config/zen`, legacy `~/.zen`, and Flatpak profiles), then falls back to
Firefox. If neither is available, it runs without browser cookies. Zen profiles
are read using yt-dlp's Firefox cookie reader; the most recently used cookie
database is selected. Open Zen and visit YouTube first if you need to sign in.

Override cookie selection when needed:

```bash
YT_DLP_COOKIES=zen yt-down
YT_DLP_COOKIES=chrome yt-down
YT_DLP_COOKIES="firefox:/path/to/zen/profile" yt-down
YT_DLP_COOKIES=none yt-down
```

## Global Install

```bash
make link
# Then run from anywhere:
yt-down
```

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Prompts**: [@clack/prompts](https://github.com/natemoo-re/clack)
- **Colors**: [chalk](https://github.com/chalk/chalk)
- **Backend**: [yt-dlp](https://github.com/yt-dlp/yt-dlp)

## Development checks

```bash
bun test
bun run typecheck
make build
```

When yt-dlp is installed, tests also exercise real HTTP byte-range resume and
fragment recovery against temporary local servers. These tests do not change
your Wi-Fi or contact YouTube.

## License

MIT
