# yt-down

> ⬢ Interactive YouTube Downloader CLI — powered by yt-dlp

A premium interactive CLI tool wrapping **yt-dlp** with beautiful prompts, real-time progress, and smart format selection.

## Features

- 📹 **Video Download** — Choose quality from dynamically fetched formats (4K → 144p)
- 🎙 **Podcast Mode** — Auto-select best audio track for audio-only downloads
- ⬢ **Beautiful CLI** — Built with `@clack/prompts` + `chalk` for a premium feel
- ⚡ **Fast** — Powered by Bun runtime
- 📊 **Smart Formats** — Groups by resolution, shows codec + filesize, auto-merges with ffmpeg

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

## License

MIT
