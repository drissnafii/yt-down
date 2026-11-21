import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import { missingDependencies } from './dependencies.js';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class YtDownPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    window.set_default_size(640, 760);
    const settings = this.getSettings();
    const page = new Adw.PreferencesPage({ title: 'yt-down', icon_name: 'folder-download-symbolic' });
    const group = new Adw.PreferencesGroup({ title: 'Downloads',
      description: 'Uses yt-dlp and ffmpeg to save videos and audio. Install Deno for YouTube support.' });
    const directory = new Adw.EntryRow({ title: 'Download folder (empty = Videos/yt-down)' });
    settings.bind('output-directory', directory, 'text', Gio.SettingsBindFlags.DEFAULT);
    const clipboard = new Adw.SwitchRow({ title: 'Use video links from clipboard',
      subtitle: 'Fill the link field when opening the panel. Press Enter or Find video to contact the site.' });
    settings.bind('clipboard-autofetch', clipboard, 'active', Gio.SettingsBindFlags.DEFAULT);
    const direct = new Adw.SwitchRow({ title: 'Download automatically after pasting',
      subtitle: 'Start without Enter or a quality click. Use your last quality when available, otherwise best video quality.' });
    settings.bind('download-on-paste', direct, 'active', Gio.SettingsBindFlags.DEFAULT);
    const parallel = new Adw.SpinRow({ title: 'Simultaneous downloads', subtitle: '1–3 active downloads; extra videos wait in the queue.',
      adjustment: new Gtk.Adjustment({ lower: 1, upper: 3, step_increment: 1, page_increment: 1 }) });
    settings.bind('parallel-downloads', parallel, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(parallel);
    group.add(clipboard);
    group.add(direct);

    group.add(directory);
    const missing = missingDependencies();
    const setup = new Adw.PreferencesGroup({ title: 'Setup',
      description: missing.length ? `Missing: ${missing.join(', ')}. Install the tools below, then reopen the popup.` : 'Downloader tools are ready.' });
    setup.add(new Adw.ActionRow({ title: 'Install downloader tools',
      subtitle: 'Use your distribution’s software manager for yt-dlp and ffmpeg. Install Deno for YouTube support.' }));
    const help = new Adw.ActionRow({ title: 'Installation guide', subtitle: 'Dependencies and setup instructions', activatable: true });
    help.add_suffix(new Gtk.Image({ icon_name: 'external-link-symbolic' }));
    help.connect('activated', () => { Gio.AppInfo.launch_default_for_uri_async('https://github.com/drissnafii/yt-down#gnome-shell-extension-typescript', null, null, (_app, result) => {
      try { Gio.AppInfo.launch_default_for_uri_finish(result); } catch (error) { logError(error instanceof Error ? error : new Error(String(error))); }
    }); });
    setup.add(help);
    page.add(setup);
    page.add(group);
    window.add(page);
    return Promise.resolve();
  }
}
