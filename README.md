# yt-down

> ⬢ Interactive YouTube Downloader CLI — powered by yt-dlp

A premium interactive CLI tool wrapping **yt-dlp** with beautiful prompts, real-time progress, and smart format selection.

## Features

- 📹 **Video Download** — Choose quality from dynamically fetched formats (4K → 144p)
- 🎙 **Podcast Mode** — Auto-select best audio track for audio-only downloads
- ⬢ **Beautiful CLI** — Built with `@clack/prompts` + `chalk` for a premium feel
- ⚡ **Fast** — Powered by Bun runtime
- 📊 **Smart Formats** — Quality and smaller-file choices, frame rates, estimated video + audio totals
- 🔄 **Interruption Recovery** — Waits through connection failures and resumes saved downloads
- 🚀 **Faster Startup** — Reuses the metadata fetched for the picker; four concurrent fragments by default

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

### Download speed

The confirmed download reuses the metadata already fetched for the picker, in
both video and podcast mode. A private temporary `.info.json` file is created
after confirmation and removed when the download finishes, fails, or is
cancelled. If the cached URL fails, recovery switches to the original URL to
fetch fresh metadata. Canceling at the quality picker creates no temporary file.

Native DASH/HLS downloads fetch up to **four fragments concurrently**. Direct
HTTP(S) files are unaffected by this setting. Adjust concurrency from 1 to 16:

```bash
YT_DOWN_FRAGMENTS=1 bun start
YT_DOWN_FRAGMENTS=4 bun start
```

For direct HTTP(S) files, optionally enable aria2c with four connections:

```bash
# Optional Arch dependency
sudo pacman -S --needed aria2
YT_DOWN_DOWNLOADER=aria2c bun start
```

DASH/HLS still use the native downloader. If aria2c is unavailable, the app
reports that it is using native mode before starting the transfer. Interrupted
aria2 downloads keep their `.aria2` control files and partial media under
`~/Videos/yt-down/.aria2/`; native partials stay separate. Resume using the same
downloader mode to reuse that mode's progress. Completed files still go to
`~/Videos/yt-down/`.

The picker offers a **Smaller file** alternative when its estimated total is at
least 10% below the resolution's Quality option. Frame rate and codec are shown
because smaller options may sacrifice quality or frame rate. Video-only choices
include the selected audio track in the displayed total, and pin its format ID.
Approximate sizes have a `~` prefix; totals stay unknown if either stream's size
cannot be estimated. Podcast mode downloads the exact format it displays.

Speed depends on the connection and server. More connections do not guarantee
higher throughput; reduce concurrency if the server throttles requests.

### Interrupted downloads

During video and audio downloads, connection failures automatically trigger a
retry after 2, 4, 8, 16, then 30 seconds between attempts. Retries continue while
the connection is unavailable. After the initial cached attempt, retries refresh
download URLs from the original YouTube URL and resume existing `.part` files
and fragment state.
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

### Repeatable speed measurements

Use fixed **video + audio format IDs**, for example `137+140`, or a fixed audio
ID. This downloads the full media three times per setting into fresh temporary
folders, alternating setting order between rounds:

```bash
bun run benchmark 'https://youtu.be/VIDEO_ID' '137+140' /tmp/yt-down-benchmark.json
```

The report compares original-URL extraction with metadata reuse, native fragment
concurrency 1 and 4, and optional aria2c when installed. Run it once with fragmented
formats and once with direct HTTP(S) formats. It records startup to first download
progress, transfer duration across selected streams, merger-hook time, and total
time separately. Startup uses the first progress event as an approximation of the
first byte; external downloaders that only report completion have `null` startup
and transfer durations. Temporary media and metadata are removed afterward.

Controlled local benchmarks exercise these paths, but their timings are not a
claim about YouTube throughput on your Wi-Fi. The app has also passed a small
live YouTube download using cached metadata.

## License

MIT
