# GNOME review notes for DownDev 0.1.1

The [0.1.0 submission](https://extensions.gnome.org/review/78814/) received
five automated warnings. These notes describe the fix and the ownership paths
for a human reviewer; they do not claim GNOME approval or prove garbage collection.

## EGO-P-006: compiled schema

`extension:pack` validates schema XML with `glib-compile-schemas --strict
--dry-run` and excludes generated `gschemas.compiled`, including any cache in
the source schema directory. Local `build` and `install` still compile schemas.
The package smoke test rejects an archive containing a compiled cache, then
compiles the extracted XML as an installer would before loading it in Shell.

## EGO-P-007: worker entry point

`worker.js` is required runtime source, deliberately executed rather than
imported into Shell. `extension/src/dependencies.ts` constructs
`setsid gjs -m <extension-path>/worker.js`; `application.ts` passes this command
to `Backend.start()` in `client.ts`, which launches it with `Gio.Subprocess`.
The worker communicates through JSON pipes and invokes user-installed yt-dlp
and media tools. Metadata parsing, pipe processing and retry work stay outside
the Shell process. Importing the worker into `extension.js` would execute its
process entry point in the wrong context.

## EGO-L-002 and EGO-L-005: objects and references

`extension.disable()` calls `Application.destroy()` and sets `app` to
`undefined`. The application stops discovery, the download manager and media
queries, then destroys `PopupView`. The view stops its spinners and transitions
and destroys its panel button. That button owns its popup menu; the menu owns
the `formats` section and `more` submenu added through `addMenuItem()`.
Job cards are separately destroyed by `DownloadManager.destroy()`, which also
empties its jobs array. The extension retains no application reference after
disable. The actor ownership chain is intentional; no extra member nulling or
duplicate actor destruction was added solely to satisfy static analysis.

## EGO-L-003: signal ownership

Entry, button, drawing-area and card handlers belong to actors destroyed by
their owning views. The popup owns its `open-state-changed` subscription and
is destroyed with the panel button. The two persistent external subscriptions
are explicitly disconnected by `DownloadManager.destroy()`:
`settings`' `changed::parallel-downloads` and `global.stage`'s
`notify::key-focus`. Application debounce and backend cancellation sources are
removed during destruction; outstanding queries are cancelled and worker
process groups terminated.

## Verification

Run `mise exec -- bun test`, `mise exec -- bun run typecheck`,
`mise exec -- bun run extension:pack` (includes extension typecheck), and
`mise exec -- bun run extension:smoke --package` on GNOME 51.
The existing smoke test verifies disable/re-enable during metadata extraction,
active downloads, retry delay and unresponsive workers, confirms workers are
reaped and timers removed, and checks that both persistent signal handlers
are disconnected. It also checks independent state after re-enabling and
leaves the desktop's enabled-extension settings unchanged.
