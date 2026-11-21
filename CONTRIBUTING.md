# Contributing

Open an issue before substantial changes. Small fixes can go straight to a PR.
Fork the repository, create a feature branch, and target `main`. Explain the
problem, behavior changes, and how you checked the result. Contributions use
the project's MIT license; preserve third-party notices.

## Development

Install [mise](https://mise.jdx.dev/), then run:

```sh
mise install
mise exec -- bun install --frozen-lockfile --ignore-scripts
mise exec -- bun test
mise exec -- bun run typecheck
mise exec -- bun run extension:build
```

The extension build needs `glib-compile-schemas` from your distribution's GLib
tools. Tests using yt-dlp and ffmpeg skip when those tools are unavailable. GJS worker
integration tests require GJS, Python 3 and standard Linux process utilities;
CI installs these tools. The installed extension itself does not require Bun.
To run the GNOME UI checks on a compatible Linux desktop:

```sh
mise exec -- bun run extension:smoke
```

The smoke test creates an isolated D-Bus session and memory-backed settings.
Never test a nested Shell against your persistent desktop settings.

## Review expectations

Keep changes focused. Explain new dependencies, subprocesses, network access,
file access, clipboard access, cookie handling, and workflow permission changes.
Update `bun.lock` when changing dependencies. Do not commit credentials, browser
databases, cookie exports, private download URLs, or personal media.

Maintainers review contributions before merging; passing CI is not a security
approval. Test unfamiliar PRs in a disposable environment without credentials,
browser profiles, personal files, or access to your host's Docker socket.
See [SECURITY.md](SECURITY.md) for private vulnerability reporting and
[the maintainer guide](docs/maintaining.md) for repository and release practices.
