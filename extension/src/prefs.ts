import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
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
    group.add(runtime);
    group.add(directory);
    page.add(group);
    window.add(page);
    return Promise.resolve();
  }
}
