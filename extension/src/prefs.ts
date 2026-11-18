import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class YtDownPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    const settings = this.getSettings();
    const page = new Adw.PreferencesPage({ title: 'yt-down', icon_name: 'folder-download-symbolic' });
    const group = new Adw.PreferencesGroup({ title: 'Downloads',
      description: 'The bundled yt-down backend requires Bun, yt-dlp and ffmpeg. Existing YT_DLP_* and YT_DOWN_* session environment settings apply.' });
    const runtime = new Adw.EntryRow({ title: 'Bun executable (empty = automatic)' });
    const directory = new Adw.EntryRow({ title: 'Download folder (empty = Videos/yt-down)' });
    settings.bind('bun-path', runtime, 'text', Gio.SettingsBindFlags.DEFAULT);
    settings.bind('output-directory', directory, 'text', Gio.SettingsBindFlags.DEFAULT);
    const clipboard = new Adw.SwitchRow({ title: 'Use YouTube links from clipboard',
      subtitle: 'Check when opening the panel. Downloads always require a click.' });
    settings.bind('clipboard-autofetch', clipboard, 'active', Gio.SettingsBindFlags.DEFAULT);
    const parallel = new Adw.SpinRow({ title: 'Simultaneous downloads', subtitle: '1–3 active downloads; extra videos wait in the queue.',
      adjustment: new Gtk.Adjustment({ lower: 1, upper: 3, step_increment: 1, page_increment: 1 }) });
    settings.bind('parallel-downloads', parallel, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(parallel);
    group.add(clipboard);
    group.add(runtime);
    group.add(directory);
    page.add(group);
    window.add(page);
    return Promise.resolve();
  }
}
