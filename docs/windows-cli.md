# Windows CLI setup

This guide sets up the **terminal downloader** on Windows 10 (version 1809 or
later) or Windows 11. Use **PowerShell** in Windows Terminal. The GNOME extension
runs on Linux; it is not part of this Windows setup. WSL is not required.

You need four things:

- **Bun** runs the TypeScript CLI; this guide manages it with **mise**.
- **yt-dlp** downloads media. The name is `yt-dlp`, not `ydl` or `youtube-dl`.
- **ffmpeg and ffprobe** merge video/audio and perform audio conversions.
- **Git** downloads and updates this repository.

Installing the repository's JavaScript packages with `bun install` does **not**
install yt-dlp or ffmpeg. Install those separately below.

## 1. Install the tools

In PowerShell, first check Windows Package Manager:

```powershell
winget --version
```

If `winget` is missing, install/update Microsoft's **App Installer** from the
[Microsoft Store](https://apps.microsoft.com/detail/9nblggh4nns1), then reopen
PowerShell.

Install these packages. Skip a command if that tool is already installed and
working:

```powershell
winget install --id jdx.mise --exact --source winget
winget install --id Git.Git --exact --source winget
winget install --id yt-dlp.yt-dlp --exact --source winget
winget install --id Gyan.FFmpeg --exact --source winget
```

Close **all** Windows Terminal/PowerShell windows and open PowerShell again so
the updated `PATH` is available. Then install Bun through mise:

```powershell
mise --version
mise use --global bun@1.4.4
mise exec -- bun --version
```

This guide uses `mise exec -- bun ...` so it works without editing your PowerShell
profile or relying on shell activation. If Bun is already installed another way,
you can use your existing `bun` command instead; do not install a second copy
just for this project. Bun 1.3 or later is required.

Verify the external tools before continuing:

```powershell
git --version
yt-dlp --version
ffmpeg -version
ffprobe -version
Get-Command mise, git, yt-dlp, ffmpeg, ffprobe
```

All commands must succeed. `Get-Command` shows which executable PowerShell found.
For ffmpeg you need the actual Windows executables, **not** a Python package
named `ffmpeg`. The standalone Windows yt-dlp executable does not require you to
install Python separately.

## 2. Get the repository and install its packages

Choose a writable folder. For example:

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\Projects" | Out-Null
Set-Location "$env:USERPROFILE\Projects"
git clone https://github.com/drissnafii/yt-down.git
Set-Location .\yt-down
```

Use a checkout containing the Windows fixes described in this guide. If those
changes are still on the `windows-cli` feature branch and it has been published:

```powershell
git fetch origin
git switch windows-cli
```

Install the repository's dependencies:

```powershell
mise exec -- bun install
```

For native Windows setup, use the commands in this guide. The repository's
`make setup` and related installer targets use Linux commands and paths.

## 3. Choose where downloads go

The default directory is your home folder plus `Videos\yt-down`, for example:

```text
C:\Users\Alice\Videos\yt-down
```

The CLI creates the directory when downloading. It no longer uses the original
developer's `/home/dendo/Videos/yt-down` path.

To choose another directory for the current PowerShell session:

```powershell
$env:YT_DOWN_OUTPUT_DIR = 'D:\Downloads\YouTube'
```

Use a drive that exists and a folder you can write to. Spaces in the folder name
are supported; keep the path quoted. If your Videos folder is redirected to
OneDrive or another drive, you can use its Windows-known location:

```powershell
$videosFolder = [Environment]::GetFolderPath('MyVideos')
if ($videosFolder) {
    $env:YT_DOWN_OUTPUT_DIR = Join-Path $videosFolder 'yt-down'
}
```

To keep your chosen output directory for future terminals:

```powershell
[Environment]::SetEnvironmentVariable('YT_DOWN_OUTPUT_DIR', $env:YT_DOWN_OUTPUT_DIR, 'User')
```

Only run that after setting the variable to the directory you want. Reopen the
terminal to pick up persistent changes. To return to the default:

```powershell
Remove-Item Env:YT_DOWN_OUTPUT_DIR -ErrorAction SilentlyContinue
[Environment]::SetEnvironmentVariable('YT_DOWN_OUTPUT_DIR', $null, 'User')
```

## 4. Run the CLI

From the repository directory:

```powershell
mise exec -- bun start
```

Choose **Video** or **Podcast**, paste a YouTube video URL, choose a quality, and
confirm the displayed output directory. High-resolution video usually needs
ffmpeg to combine separate video and audio streams.

You can also use the explicit entry point:

```powershell
mise exec -- bun run .\bin\yt-down.ts
```

You do not need a global `yt-down` command to run the CLI. To launch it from
another directory, pass the entry point's absolute path:

```powershell
mise exec -- bun run "$env:USERPROFILE\Projects\yt-down\bin\yt-down.ts"
```

## Troubleshooting

### `bun` is not recognized

Use `mise exec -- bun --version` rather than a bare `bun` command. Check the
selected installation with:

```powershell
mise ls bun
mise which bun
```

If mise is missing too, reopen Windows Terminal after installing it. See
[mise's Windows installation instructions](https://mise.jdx.dev/installing-mise.html#windows)
if your package manager did not expose the executable on `PATH`.

### `yt-dlp` is missing or the wrong executable is selected

```powershell
Get-Command yt-dlp -All
where.exe yt-dlp
```

Use `where.exe`, not PowerShell's `where` alias. Reopen the terminal after
installation. You can explicitly select an existing executable:

```powershell
$env:YT_DLP_BIN = 'C:\Tools\yt-dlp\yt-dlp.exe'
Test-Path $env:YT_DLP_BIN
& $env:YT_DLP_BIN --version
mise exec -- bun start
```

Replace that example with the executable's real path. `YT_DLP_BIN` must contain
only the executable path, without command-line arguments or extra quote marks
inside the value. Clear an outdated override with:

```powershell
Remove-Item Env:YT_DLP_BIN -ErrorAction SilentlyContinue
```

### ffmpeg/ffprobe not found, or merging fails

```powershell
Get-Command ffmpeg, ffprobe
```

Both executable directories must be on `PATH`. If you installed a ZIP manually,
add the directory containing `ffmpeg.exe` and `ffprobe.exe` for this session:

```powershell
$env:Path = 'C:\Tools\ffmpeg\bin;' + $env:Path
ffmpeg -version
ffprobe -version
mise exec -- bun start
```

Use your real extraction directory. For a permanent change, add that folder in
Windows **Environment Variables → User variables → Path**, then restart the
terminal. Installing only `ffmpeg.exe` without `ffprobe.exe` is insufficient.

### Permission denied, wrong folder, or disk full

```powershell
$env:YT_DOWN_OUTPUT_DIR
$env:YT_DOWN_OUTPUT_DIR = Join-Path $env:USERPROFILE 'Videos\yt-down'
mise exec -- bun start
```

Check the folder shown at confirmation. Choose a writable folder with enough
free space for video, audio, and the merged output. If Windows Controlled Folder
Access blocks the downloader, choose another permitted folder or allow the
specific executable through Windows Security.

### Browser-cookie errors or YouTube requests sign-in

Start without browser cookies to isolate the problem:

```powershell
$env:YT_DLP_COOKIES = 'none'
mise exec -- bun start
```

For a video requiring your signed-in browser session, explicitly select Firefox:

```powershell
$env:YT_DLP_COOKIES = 'firefox'
mise exec -- bun start
```

The CLI's automatic Zen/Firefox profile search currently checks Linux-style
locations. On Windows, use an explicit browser setting. To use a particular Zen
profile, read its directory from `about:profiles` in Zen and pass it through
yt-dlp's Firefox cookie reader:

```powershell
$env:YT_DLP_COOKIES = 'firefox:C:\Users\Alice\AppData\Roaming\zen\Profiles\YOUR_PROFILE'
mise exec -- bun start
```

Replace the entire example path with your real profile directory. Cookies from
Chrome/Edge may be inaccessible because of Windows browser encryption or locked
databases; selecting another browser is often necessary. Clear the override to return
to the CLI's default behavior:

```powershell
Remove-Item Env:YT_DLP_COOKIES -ErrorAction SilentlyContinue
```

### JavaScript challenge errors or formats are missing

Update yt-dlp and confirm the selected Bun version:

```powershell
winget upgrade --id yt-dlp.yt-dlp --exact --source winget
mise exec -- bun --version
```

The CLI supplies its Bun executable as a JavaScript runtime to yt-dlp. If an old
`YT_DLP_JS_RUNTIME` override is pointing to another machine's runtime, remove it:

```powershell
Remove-Item Env:YT_DLP_JS_RUNTIME -ErrorAction SilentlyContinue
```

Full YouTube support also needs yt-dlp's EJS components; official standalone
releases include them. See the [yt-dlp EJS guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS)
for current runtime requirements.

### A transfer is interrupted

Connection failures are retried automatically. Press **Ctrl+C** to cancel and
keep partial files. To resume, start again with the same URL, quality, and output
directory. Keep its `.part` and `.ytdl` files. Resume still depends on the server.
Native Windows cancellation and process handling have not been validated on a
Windows machine in this change.

## Update and optional executable build

Update your checkout from its current tracking branch, then refresh dependencies:

```powershell
git pull --ff-only
mise exec -- bun install
winget upgrade --id yt-dlp.yt-dlp --exact --source winget
winget upgrade --id Gyan.FFmpeg --exact --source winget
```

If you prefer an `.exe`, build it **on Windows**. Keep a separate Bun runtime
available for yt-dlp's YouTube JavaScript challenges:

```powershell
mise exec -- bun build .\bin\yt-down.ts --compile --outfile .\bin\yt-down.exe
$bunRuntimePath = (mise which bun).Trim()
$env:YT_DLP_JS_RUNTIME = "bun:$bunRuntimePath"
.\bin\yt-down.exe
```

That executable bundles the CLI's runtime but still needs **yt-dlp, ffmpeg,
and ffprobe**, plus an external JavaScript runtime for full YouTube support.
The explicit override above points yt-dlp at real Bun rather than the compiled
`yt-down.exe`. Keep it set whenever launching the compiled CLI, or persist it
with `[Environment]::SetEnvironmentVariable('YT_DLP_JS_RUNTIME', $env:YT_DLP_JS_RUNTIME, 'User')`.
If you later move or upgrade Bun to a different path, update that override too.

Do not commit the generated `.exe` to the repository.

## Validation and sources

The Windows path behavior is covered by tests, and the CLI changes were checked
on Linux. These PowerShell steps have **not** been executed on a Windows host in
this change; Windows-specific process/cancellation behavior still needs a real
Windows check.

- [mise installation on Windows](https://mise.jdx.dev/installing-mise.html#windows)
- [mise Bun management](https://mise.jdx.dev/lang/bun.html)
- [Bun Windows installation and requirements](https://bun.sh/docs/installation)
- [yt-dlp installation](https://github.com/yt-dlp/yt-dlp#installation)
- [yt-dlp dependencies](https://github.com/yt-dlp/yt-dlp#dependencies)
- [FFmpeg downloads](https://ffmpeg.org/download.html)
