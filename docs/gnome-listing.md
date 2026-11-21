# GNOME Extensions listing kit

Version 0.1.0 has been submitted and is awaiting human review. This kit contains
listing assets and instructions for subsequent releases; approval is pending.

## Description

DownDev — Video & Audio Downloader for GNOME

Save videos and audio directly from your GNOME panel using yt-dlp.

- Choose video quality, including HD and 4K when available.
- Download original audio or convert it to MP3.
- Follow progress, speed and remaining time.
- Queue downloads, cancel individual tasks, and resume interrupted transfers.
- Open saved files or their folders.
- Customize the download folder and concurrent download limit.

Optional clipboard access is disabled by default. When enabled, opening the
popup only fills the link field locally. Press Enter or Find video before the
site is contacted. Directly pasting a link fetches metadata automatically.

Requires GNOME 51, yt-dlp, GJS and standard Linux process tools. Add ffmpeg for
MP3 conversion and merging; original single-stream downloads work without it. Deno
2.3.0+ and the matching yt-dlp EJS scripts are recommended for YouTube. Install
these prerequisites through your distribution's software manager. Bun is not
required. This extension does not automatically install external tools.
Use a recent yt-dlp with `--js-runtimes` support (tested: 2026.10.26). If your
distribution ships an older incompatible version, upgrade using yt-dlp's
official installation guide before using the extension.

Open source, MIT licensed.
Source and issues: https://github.com/drissnafii/yt-down
Support: https://drissnafii.gumroad.com/l/support

## Images

The PNG screenshots in `screenshots/` capture the actual extension running in
an isolated GNOME 51 session. Downloads use local demo fixtures, not real remote
media; do not describe the sample progress/speeds as a performance benchmark.
Screenshots are cropped to the extension or preferences, with no personal data.

- `screenshots/formats.png`: quality and audio choices.
- `screenshots/downloads.png`: parallel downloads and queue.
- `screenshots/preferences.png`: setup guidance and settings.
- `listing-icon.png`: original download-arrow icon; editable source is
  `listing-icon.svg`. This is for the listing; the panel uses a symbolic icon.

Regenerate screenshots with:

```sh
mise exec -- bun run extension:build
YT_DOWN_SCREENSHOT_DIR="$PWD/docs/screenshots" mise exec -- bun run extension:smoke
```

Review the screenshots and support page before uploading. Catalog clients
control how the donation link is displayed; it is not a payment flow in the popup.

## Package and submit

1. Merge the reviewed implementation into `main` after CI passes.
2. Run the validation and release steps in [maintaining.md](maintaining.md).
3. Build `dist/yt-down@drissnafii.shell-extension.zip` with
   `mise exec -- bun run extension:pack` and inspect its contents.
4. Sign in or register at https://extensions.gnome.org/ and upload the ZIP at
   https://extensions.gnome.org/upload/. The numeric version is assigned there.
   Check the [0.1.0 review](https://extensions.gnome.org/review/78814/) first;
   respond to human comments before uploading if review has started. Version
   0.1.1 keeps the same UUID and includes the [review notes](gnome-review.md).
5. Explain that the readable GJS worker isolates metadata and process handling
   from Shell and calls user-installed yt-dlp/ffmpeg. No external binaries are
   bundled. Address reviewer feedback before advertising catalog availability.
6. Add the icon and screenshots through the listing management interface when
   available. The donation URL and source URL already come from metadata.

Creating an account, accepting publication terms, and submitting to the catalog
remain manual maintainer actions. Do not promise a zero-setup installation or
compatibility with GNOME releases not declared in metadata.
