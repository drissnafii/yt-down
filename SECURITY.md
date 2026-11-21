# Security policy

Security fixes target the current `main` branch and latest release. Older
releases may require an upgrade. There is no guaranteed response time.

## Report privately

Use GitHub's [Report a vulnerability](https://github.com/drissnafii/yt-down/security/advisories/new)
to disclose suspected vulnerabilities privately. Include affected versions,
reproduction steps, impact, and a minimal example with fake credentials.
Do not publish exploits, real cookies, tokens, or private URLs in public issues.

## Trust and privacy

This is a downloader, not a sandbox. The extension runs in GNOME Shell and
launches an isolated GJS worker, yt-dlp, and ffmpeg as your user. The standalone
CLI uses Bun. Install trusted
versions of these programs and only run code you trust.

Browser cookies are off by default. Setting `YT_DLP_COOKIES` explicitly opts in;
`auto` discovers Zen or Firefox, and `none` disables cookie use. Cookies can
authenticate requests to remote sites; never send cookie exports in reports.
User-supplied yt-dlp configuration can independently affect its behavior.

Clipboard detection is off by default. If enabled, opening the popup reads a
supported URL into the field locally. Press Enter or Find video to contact the
site. Directly typing or pasting a valid URL fetches metadata automatically.
The URL and normal request information are sent to the requested site and its
media providers. There is no project-operated download server or telemetry.
Downloads and temporary partial files are stored locally.

See [docs/maintaining.md](docs/maintaining.md) for CI and release safeguards.

The GJS worker retains discovered metadata in memory until the session is used
or discarded. A download snapshot is written to a private temporary directory
with mode 0600 and removed on completion/cancellation. The parent also cleans it
after a forced worker stop. A sudden power loss can leave private temporary data;
no metadata is added to the extension package or Git repository.

User cancellation has a three-second forced-stop fallback. Disabling/unloading
clears that timer, drops event/UI callbacks and immediately kills the process
group and its root process. Asynchronous completion only reaps children and
removes private snapshots. Views cancel size queries and animations; the manager
disconnects stage/settings signals, and the application removes input debounce.
