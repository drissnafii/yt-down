import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import type Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Locate the same media in an existing player before handing it to the OS. */
export class MediaOpener {
  private cancellable = new Gio.Cancellable();
  private pending = false;
  private launches = new Map<string, { appId: string | null; before: Set<Meta.Window>; at: number }>();

  constructor(private launch: (uri: string) => Promise<void>) {}

  private call(name: string, path: string, iface: string, method: string, args: GLib.Variant | null = null): Promise<GLib.Variant> {
    return new Promise((resolve, reject) => {
      Gio.DBus.session.call(name, path, iface, method, args, null, Gio.DBusCallFlags.NONE, 1500,
        this.cancellable, (connection, result) => {
          try { resolve(connection!.call_finish(result)); }
          catch (error) { reject(error); }
        });
    });
  }

  private windows(): Meta.Window[] {
    return global.get_window_actors().map(actor => actor.get_meta_window()).filter((window): window is Meta.Window => window !== null);
  }

  private async raisePlayer(uri: string): Promise<boolean> {
    try {
      const names = (await this.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', 'ListNames')).deep_unpack() as [string[]];
      const matches = await Promise.all(names[0].filter(name => name.startsWith('org.mpris.MediaPlayer2.')).map(async name => {
        try {
          const result = await this.call(name, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Metadata']));
          const metadata = (result.deep_unpack() as [GLib.Variant])[0].deep_unpack() as Record<string, GLib.Variant>;
          const current = metadata['xesam:url']?.deep_unpack();
          return typeof current === 'string' && Gio.File.new_for_uri(current).equal(Gio.File.new_for_uri(uri)) ? name : null;
        } catch { return null; }
      }));
      for (const name of matches) {
        if (!name) continue;
        try {
          await this.call(name, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2', 'Raise');
          return true;
        } catch {
          // Some players omit Raise but expose a process that Shell can focus.
          try {
            const result = await this.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
              'GetConnectionUnixProcessID', new GLib.Variant('(s)', [name]));
            const pid = (result.deep_unpack() as [number])[0];
            const window = this.windows().find(window => window.get_pid() === pid);
            if (window) { Main.activateWindow(window); return true; }
          } catch { /* Fall back to matching the default player's windows. */ }
        }
      }
    } catch { /* MPRIS is optional. */ }
    return false;
  }

  async open(path: string): Promise<void> {
    if (this.pending || this.cancellable.is_cancelled()) return;
    this.pending = true;
    try {
      const file = Gio.File.new_for_path(path);
      const uri = file.get_uri();
      if (await this.raisePlayer(uri) || this.cancellable.is_cancelled()) return;
      const app = Gio.AppInfo.get_default_for_type(Gio.content_type_guess(path, null)[0], false);
      const tracker = Shell.WindowTracker.get_default();
      const appId = app?.get_id() ?? null;
      const windows = this.windows();
      const candidates = appId ? windows.filter(window => tracker.get_window_app(window)?.get_id() === appId) : [];
      const basename = file.get_basename() ?? '';
      const stem = basename.replace(/\.[^.]+$/, '').toLocaleLowerCase();
      const named = stem ? candidates.find(window => {
        const title = (window.get_title() ?? '').toLocaleLowerCase();
        return title === stem || title === basename.toLocaleLowerCase()
          || title.startsWith(`${stem} — `) || title.startsWith(`${stem} - `);
      }) : undefined;
      if (named) { Main.activateWindow(named); return; }
      const previous = this.launches.get(uri);
      if (previous) {
        const created = candidates.filter(window => {
          const title = window.get_title() ?? '';
          const genericTitle = !title || title === app?.get_name() || title === app?.get_display_name();
          return !previous.before.has(window) && genericTitle;
        });
        // Track our first launch even if the player uses a generic window title.
        if (created.length === 1) { Main.activateWindow(created[0]!); return; }
        if (GLib.get_monotonic_time() - previous.at < 8_000_000) return;
      }
      this.launches.set(uri, { appId, before: new Set(windows), at: GLib.get_monotonic_time() });
      try { await this.launch(uri); }
      catch (error) { this.launches.delete(uri); throw error; }
    } finally { this.pending = false; }
  }

  destroy(): void {
    this.cancellable.cancel();
    this.launches.clear();
  }
}
