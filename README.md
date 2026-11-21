# yt-down

> ⬢ Interactive Video Downloader CLI — powered by yt-dlp

A premium interactive CLI tool wrapping **yt-dlp** with beautiful prompts, real-time progress, and smart format selection.

## Features

- 📹 **Video Download** — Choose quality from dynamically fetched formats (4K → 144p)
- 🎙 **Podcast Mode** — Auto-select best audio track for audio-only downloads
- ⬢ **Beautiful CLI** — Built with `@clack/prompts` + `chalk` for a premium feel
- ⚡ **Transfers** — Parallel fragments and resumable downloads
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

Using Windows? See the [Windows CLI setup guide](docs/windows-cli.md).

```bash
# Install dependencies
make install

# Run the tool
make start

# Or with live-reload during development
make dev
```

## Supported websites

Links from any HTTP(S) website are passed to yt-dlp, including YouTube, Vimeo,
Pornhub (including regional domains), and direct video links. Actual support
is determined by [yt-dlp's extractors](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md).
Login requirements, regional restrictions, DRM, and site changes can prevent downloads.
Keep yt-dlp updated; no tool can guarantee downloading every video.

## Usage

```bash
bun run bin/yt-down.ts
```

1. Select mode: **Video** or **Podcast (Audio Only)**
2. Paste a video URL supported by yt-dlp
3. Pick your quality (video mode) or auto-select best audio (podcast mode)
4. Confirm and watch the download with live progress

Downloads are saved to `~/Videos/yt-down/`.
YouTube downloads stay in this folder; downloads from other websites go into
`~/Videos/yt-down/other_sites/`. With a custom download folder, `other_sites/`
is created inside that folder. This applies to the CLI and GNOME extension,
including automatic downloads and audio downloads.

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

Browser-cookie access is **off by default**. For sites that need your signed-in
session, explicitly select a browser or opt into discovery. Cookie-enabled
requests can act as your browser account on the requested site; never share
cookie exports in issues or pull requests.

```bash
YT_DLP_COOKIES=auto yt-down  # Discover Zen, then Firefox
YT_DLP_COOKIES=zen yt-down
YT_DLP_COOKIES=chrome yt-down
YT_DLP_COOKIES="firefox:/path/to/zen/profile" yt-down
YT_DLP_COOKIES=none yt-down
```

`auto` checks Zen's standard, Arch, and Flatpak locations before Firefox and
chooses the most recently used database within each browser. The extension
inherits explicit `YT_DLP_COOKIES` settings from the desktop session. User yt-dlp
configuration may independently enable cookies. See [SECURITY.md](SECURITY.md).

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

[MIT](LICENSE). The license and copyright notice are included in the extension
package. MIT permits redistribution under GPL-compatible terms required for
GNOME Shell extensions; third-party components retain their own notices.

## GNOME Shell extension (TypeScript)

The panel extension lives in `extension/` and supports **GNOME Shell 51**,
which is covered by the isolated UI smoke test. Earlier versions are not declared
until they are tested. The interface remains TypeScript compiled to GJS; **Bun
is not required to run the installed extension**. Paste
a video link to fetch formats automatically. Optional clipboard detection is
**off by default** and can be enabled in Settings. Opening the popup then reads
a supported link into the field locally; press Enter or Find video before the
site is contacted. Clipboard detection never starts downloads automatically.
By default, choose a format to start a download. Enable **Download automatically
after pasting** in Settings to start as soon as a valid link is pasted, without
Enter or a quality click. Automatic downloads use your last quality or MP3
preset when available, otherwise best available video quality.

The main list keeps **1080p**, **720p**, and **Audio · MP3** visible when available.
When neither 1080p nor 720p exists (for example, a video offers 1634p and 1090p),
the highest available video quality appears alongside audio on the main list.
Each row shows quality on the left and file size on the right. Video rows have no
icons; audio rows use a music icon. **Show more** contains other resolutions,
smaller-file variants, automatic best quality, and original audio. A badge such
as **4K available** or **1440p available** signals higher resolutions in that list.
Your last choice is remembered without adding extra rows to the main list.

The video title appears above the list without a thumbnail or preview card. Search shows
immediate loading placeholders and a spinner; results reveal with a brief
transition. Motion follows GNOME's animation and reduced-motion settings.
Downloads show progress, speed and remaining time, plus a panel progress ring.
The link field stays available while downloads run. Select a quality for each
new link to add it to the queue. **Two videos download simultaneously by default**;
Settings lets you choose **1–3 simultaneous downloads**. This is the application's
limit, not a hardware maximum. Additional videos wait until a slot is free.
Each job has its own progress and cancellation. Finished jobs collapse to a single
line with their title and actual saved-file size. Hover or keyboard focus reveals
Open file, Open folder, and Dismiss controls in that same line. Reducing the
limit lets already-running jobs finish; it does not interrupt them. Downloads of
the same video into the same folder run sequentially to protect partial files.
The queue and its recent history last for the current extension session;
disabling the extension or logging out cancels active jobs and clears the queue.
Partial files remain available to resume by adding the same video and quality.

Downloads continue when the popup closes; **Cancel** keeps partial files for
resuming. The saved state offers **Open file** and **Open folder**, along with a
desktop notification. Open file focuses a player already showing that same file
(using MPRIS media metadata, with a window-matching fallback) and suppresses
repeated launches while the player starts. Buttons use a neutral fill and modest
corner rounding. MP3 downloads are converted by ffmpeg; original audio
formats remain available under Show more.

The frontend starts an isolated, readable **GJS worker** through
`Gio.Subprocess`. The worker invokes the installed yt-dlp directly and keeps
metadata parsing, pipe processing and retries outside GNOME Shell. Its metadata
stays in memory after format discovery and is reused when you choose a quality.
The first download attempt uses a private temporary information file, deleted
after completion or cancellation. Snapshots older than five minutes are skipped;
rejected signed URLs trigger a fresh extraction with saved progress. Native
fragment concurrency, optional aria2, resume behavior, and bounded URL refreshes
are retained. Cancellation signals the process group, including ffmpeg/aria2,
with a forced stop after three seconds if needed. Disabling the extension
immediately stops workers and removes outstanding cancellation timers.

The extension entry point owns only enable/disable. `application.ts` coordinates
input and discovery, `popup-view.ts` owns popup/panel presentation,
`download-view.ts` owns job cards, and `download-manager.ts` owns the queue and
workers. Each module destroys its own actors, subscriptions, queries or workers.

Format selection, progress parsing, transfer options and failure classification
are shared with the Bun CLI as pure TypeScript modules. Removing Bun from the
extension reduces installation requirements; it is not a claim of faster media
transfers. Bun remains the CLI runtime and development/build tool.

### Install the extension

The extension has not yet been submitted to GNOME Extensions. Once approved,
users can install it from the GNOME catalog or Extension Manager and see its
panel icon. The extension ZIP cannot install system downloader tools for them.
This is **not a zero-setup downloader**.

Install **yt-dlp** and **GJS** from your distribution's software manager. Add
**ffmpeg** for MP3 conversion and audio/video merging. Original single-stream
formats remain available without ffmpeg; automatic best video then chooses a
combined stream. Standard Linux process tools `setsid` and `kill` must also be available
(normally supplied by util-linux/procps). The popup detects missing tools and
shows an error inside the input; Settings explains setup and links to this guide.
No tools are silently downloaded or installed.

For YouTube, install **Deno 2.3.0 or newer** and the matching yt-dlp EJS components
as described in [yt-dlp's EJS setup guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS).
Your distribution may package EJS separately; official yt-dlp executables bundle
it. Deno is recommended; modern Bun is not a supported yt-dlp challenge runtime.
With mise, `mise use --global deno@2` is an option. The extension detects desktop
PATH executables, `~/.local/bin`, and mise's standard shims directory. Other
supported challenge runtimes can be configured through yt-dlp.

Install a supplied ZIP with your extension manager or:

```bash
gnome-extensions install --force dist/yt-down@drissnafii.shell-extension.zip
```

Log out and back in if GNOME has not discovered the extension or needs to load
updated modules, then enable `yt-down@drissnafii`. On Wayland, locking the screen
or closing a terminal does not restart Shell. Use Settings to change the download
folder, parallel downloads, clipboard detection, or automatic downloads. The old
`bun-path` key is retained for migration compatibility but is ignored.

Session environment variables such as `YT_DLP_COOKIES`, `YT_DLP_BIN`,
`YT_DLP_JS_RUNTIME`, `YT_DOWN_DOWNLOADER` and `YT_DOWN_FRAGMENTS` still apply.
Variables exported only in a terminal are not automatically visible to GNOME.

### Build and install from source

Developers use Bun through mise; this is not an end-user runtime requirement:

```bash
mise install
mise exec -- bun install --frozen-lockfile --ignore-scripts
mise exec -- bun run extension:install
# Or create the distributable ZIP:
mise exec -- bun run extension:pack
```

The build also requires `glib-compile-schemas` (GLib); packing requires `zip`.
The ZIP contains readable `extension.js`, `prefs.js`, `worker.js`, metadata,
stylesheet, schemas and the MIT license. It contains no Bun backend, runtime
binaries, node_modules, or media tools. Installation copies it into
`$XDG_DATA_HOME/gnome-shell/extensions/yt-down@drissnafii` (normally under
`~/.local/share`).

Support development through [Gumroad](https://drissnafii.gumroad.com/l/support).
The donation URL is also declared in extension metadata for catalog clients.
See [the listing kit](docs/gnome-listing.md) for screenshots, icon, description,
and the remaining manual publication steps.

### Development

```bash
bun run typecheck
bun run extension:typecheck
bun test
bun run extension:build
bun run extension:smoke
```

The build is written to `dist/yt-down@drissnafii/`. After changing the extension,
rebuild and reinstall, then restart your GNOME session to load updated ES modules.
The automated `extension:smoke` check runs a separate headless GNOME Shell with
memory-backed settings, the real GJS worker, and a fake yt-dlp executable. It exercises loading, presets,
progress, completion, reduced motion, and cleanup, and verifies that your desktop's
enabled-extension list stayed unchanged. It requires a working local GNOME Shell
and a built extension. Pass `--package` to load the generated ZIP instead of
the build directory. It does not contact websites or use browser cookies. Worker integration tests also
cover metadata reuse, retries, permanent failures, process-tree cancellation, and
destruction during startup, metadata extraction, downloading and retry delay.
Hosted CI includes a separate Fedora 45 container job that verifies Shell 51 and
loads the actual ZIP in an isolated headless session.

For a graphical test on GNOME 51, use
`GSETTINGS_BACKEND=memory dbus-run-session -- gnome-shell --devkit`.
Keep settings memory-backed when testing a nested shell so it cannot overwrite
your desktop preferences.

Inspect shell errors with:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

GNOME references: [TypeScript extensions](https://gjs.guide/extensions/development/typescript.html),
[asynchronous subprocesses](https://gjs.guide/guides/gio/subprocesses.html),
and [GNOME 51 changes](https://gjs.guide/extensions/upgrading/gnome-shell-51.html).

### Compare the old runtime path with GJS

The worker integration test verifies that discovery runs once and the download
uses its metadata. For a real-media timing comparison on your own machine:

```bash
mise exec -- bun run extension:build
mise exec -- bun run benchmark:gnome 'https://example.com/video.mp4' best ./benchmark-gnome video
```

Replace the example with a URL you are authorized to download. This command
downloads the same selection through the standalone Bun CLI (fresh metadata on
selection) and the persistent GJS worker into separate directories. It records
discovery, selection-to-first-progress, and selection-to-completion timings.
Network and filesystem caching affect sequential samples; repeat with the paths
in reverse order with `--gjs-first` before drawing performance conclusions. No public-site speed
improvement has been measured or claimed for this migration.

### Standalone Bun CLI JSON interface

Other frontends can use the same newline-delimited JSON API:

```bash
bun run bin/yt-down.ts --json formats 'https://youtu.be/VIDEO_ID'
bun run bin/yt-down.ts --json download 'https://youtu.be/VIDEO_ID' video '137+140' "$HOME/Videos/yt-down"
bun run bin/yt-down.ts --json download 'https://youtu.be/VIDEO_ID' audio '140' "$HOME/Videos/yt-down"
```

Each stdout line is a JSON event: `status`, `formats`, `progress`, `file`,
`complete`, `cancelled`, or `error`. Format choices include their ID and mode.
Extension downloads include the video ID in their filename to distinguish videos
with identical titles. Progress percentages apply to the current stream, so the percentage can restart
when the audio stream begins. Unknown totals produce `percent: null`; completion
is reported only after postprocessing succeeds. SIGTERM or SIGINT cancels the
backend and its active downloader; errors exit with status 1 and cancellation
with status 130. Types are defined in `src/protocol.ts`. The `mp3` download mode converts audio
to MP3; `audio` preserves the selected original stream. Shared, mobile, Shorts,
live, and embedded video links are normalized and tracking/playlist arguments
are removed.

The popup design applies [Laws of UX](https://lawsofux.com/): progressive
disclosure limits the initial choices (Hick's Law), generous full-width targets
reduce pointing effort (Fitts's Law), immediate loading feedback acknowledges
input (Doherty Threshold), and completion actions make the saved result useful
(Peak-End Rule). These improve feedback without claiming faster network access.


## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and PR expectations,
[SECURITY.md](SECURITY.md) for private vulnerability reports, and
[docs/maintaining.md](docs/maintaining.md) for repository protections, release
procedures, and the remaining GNOME publication requirements.
