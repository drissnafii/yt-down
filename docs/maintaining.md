# Maintaining yt-down

## Repository settings

Protect `main` using an active branch ruleset: require PRs, resolved review
conversations, and the `checks` GitHub Actions check against the current base.
Block deletion and force pushes. No routine bypass list is needed. Required
approvals stay at zero while there is one maintainer: authors cannot approve
their own PRs. Review outside contributions yourself before merging. With a
second trusted maintainer, require one approval and dismiss stale approvals.

Protect `v*` release tags against updates and deletion. Creation stays available
to maintainers. Publish releases manually from reviewed commits on `main`;
do not reuse a version tag or publish artifacts supplied by an untrusted PR.

Keep Actions tokens read-only and disallow Actions from approving PRs. Require
approval for all outside contributors. Use GitHub-hosted runners without
personal credentials or browser profiles. Actions must be pinned to full SHAs.
The CI workflow uses `pull_request`, never privileged `pull_request_target`,
and does not publish releases or use secrets. Review workflow and mise config
changes before approving a run: the install and test steps execute PR code.

Keep Dependabot alerts, security updates, secret scanning, push protection, and
private vulnerability reporting enabled. Dependabot updates are reviewed PRs,
not automatic merges. The configuration tracks Bun and GitHub Actions weekly.
Account passkeys/2FA and recovery codes must be configured by the account owner.

## Release procedure

1. Review the full diff, dependency and lockfile updates, permission changes,
   cookie/clipboard access, and subprocess arguments. Test unfamiliar code in
   a disposable environment. A green build is not a security assessment.
2. Merge through a PR with passing `checks`. Review the actual final commit.
3. From a clean checkout of that commit, use `mise install` and
   `mise exec -- bun install --frozen-lockfile --ignore-scripts`.
4. Run tests, typecheck, extension build, and the isolated GNOME smoke test.
   The hosted GNOME 51 UI job runs the smoke test against the packed ZIP. Integration tests skip if
   yt-dlp or ffmpeg are absent; check the reported skips and run them locally.
5. Run `mise exec -- bun run extension:pack`. Inspect the ZIP for accidental
   credentials, browser data, executables, and unnecessary files. Confirm
   license notices and dependencies. Record the commit SHA and a SHA-256
   checksum of the ZIP in release notes.
6. Create a new `v*` tag on the reviewed `main` commit and a GitHub release.
   Upload only your freshly built artifacts. GNOME submission is a separate
   manual step after addressing the review requirements below.

If a secret is exposed, revoke it first, then investigate and remove it from
history as appropriate. Deleting the latest file does not remove history.

## GNOME publication status

Version 0.1.0 was [submitted](https://extensions.gnome.org/review/78814/)
and is awaiting human review. Before uploading 0.1.1, check that review for
human comments and address them first if review has started. Review the current
[GNOME guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
before every submission. In particular:

- **Architecture:** the ZIP now includes a standalone GJS worker that directly
  invokes separately installed yt-dlp and ffmpeg. There is no Bun backend or
  executable binary in the ZIP. Heavy parsing and retry work stay outside Shell.
  Explain the external tools to reviewers; this architecture does not guarantee
  approval. No automatic dependency installation is implemented.
- **Review warnings:** see [the warning analysis](gnome-review.md) for the
  schema packaging fix, worker entry point and lifecycle ownership. Release
  ZIPs must contain schema XML without `gschemas.compiled`; the package smoke
  test checks this before compiling schemas in its isolated installation.
- **Clipboard:** access is disclosed in metadata and off by default. When
  enabled, it only fills the field locally; Enter or Find video authorizes
  sending the URL. Verify this behavior in the smoke test.
- **Cookies:** browser discovery requires explicit `YT_DLP_COOKIES=auto` or a
  browser selection. Do not include cookies or private profiles in the ZIP.
- **Licensing:** the repository uses MIT, which permits GPL-compatible
  redistribution. Include the project license and any required dependency notices. GNOME
  distributes extensions under GPL-compatible terms.
- **Compatibility:** metadata declares only GNOME 51, which the isolated UI
  test covers. Add earlier versions only after verifying them.
- **Presentation:** supply accurate screenshots and a description explaining
  prerequisites and privacy behavior. Do not claim GNOME approval before it
  has been granted. Maintainers must understand and explain submitted code.

## CI maintenance

The workflow runs tests, CLI typecheck, and extension compilation (including
the GNOME typecheck). It installs Bun through the checked-in mise config and
uses the committed lockfile. Package lifecycle scripts and shared CI caches
are disabled. CI installs GJS, Python, yt-dlp and ffmpeg to exercise the worker
and local media integration tests. A separate Fedora 45 container job verifies GNOME 51 and runs the full UI smoke
test against the ZIP as a non-root user, with isolated D-Bus and memory-backed
settings. The official container index is pinned by digest; verify its source
and Shell version when updating it. The same smoke test runs locally.
The disposable container starts its own system bus. An empty, package-created
systemd seat directory is removed so GNOME uses its supported non-systemd login
manager; the container has no real logind session. The Shell/extension code and
UI assertions are not replaced or skipped.
The yt-dlp test executable is pinned to an official release and verified against
a checked-in SHA-256 digest; update the release and digest together after
checking the upstream release checksums. Older distro yt-dlp packages may lack
the JavaScript runtime flags used by the downloader.
Workflow changes must retain the `checks` job name or update the ruleset too.

Require the status check once it appears in GitHub. For an early CI
failure, fix the branch and push again; do not disable branch protection to
merge around it. Never automatically run untrusted code on a personal runner.


The [listing kit](gnome-listing.md) contains prepared screenshots, icon and copy.
The catalog controls the numeric `version`; metadata uses `version-name` for the
human-facing version and declares the Gumroad support URL through `donations`.


The extension entry point delegates to `Application`, `PopupView`,
`DownloadManager`, and `DownloadView`. Keep ownership explicit: the manager
owns focus/settings signals and worker sessions, each view owns its actors and
queries, and the application owns input debounce and discovery. User cancellation
allows a three-second grace period; module destruction clears that timer and
kills the worker group immediately, including the setsid startup race. Tests
verify destruction during startup, metadata, active transfer, retry delay and
unresponsive children, plus actual disable/re-enable behavior in Shell 51.

ffmpeg is a feature dependency, not a prerequisite for metadata discovery or
original single-stream downloads. Conversion and separately selected video/audio
require it. The shared format model returns choices; adapters construct protocol
events. Unknown download failures remain permanent, while both supported
truncated-transfer error formats are classified as interrupted connections.
