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
   The hosted CI does not run the GNOME smoke test. Integration tests skip if
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

The extension has not been submitted. Review the current
[GNOME guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
before every submission. In particular:

- **Architecture:** the ZIP now includes a standalone GJS worker that directly
  invokes separately installed yt-dlp and ffmpeg. There is no Bun backend or
  executable binary in the ZIP. Heavy parsing and retry work stay outside Shell.
  Explain the external tools to reviewers; this architecture does not guarantee
  approval. No automatic dependency installation is implemented.
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
and local media integration tests. The GNOME Shell UI smoke test runs locally.
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
