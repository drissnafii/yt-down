import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Backend, findBun } from './client.js';
import type { BackendEvent, DownloadChoice } from '../../src/protocol.js';

export default class YtDownExtension extends Extension {
  private button?: PanelMenu.Button;
  private settings?: Gio.Settings;
  private backend?: Backend;
  private entry?: St.Entry;
  private next?: St.Button;
  private cancel?: St.Button;
  private status?: St.Label;
  private title?: St.Label;
  private formats?: PopupMenu.PopupMenuSection;
  private progress?: St.Widget;
  private fill?: St.Widget;
  private loadedUrl = '';
  private busy = false;
  private percent = 0;

  enable(): void {
    this.settings = this.getSettings();
    this.button = new PanelMenu.Button(0.0, 'yt-down');
    this.button.add_child(new St.Icon({ icon_name: 'folder-download-symbolic', style_class: 'system-status-icon' }));
    const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
    const shellMajor = Number.parseInt(Config.PACKAGE_VERSION, 10);
    if (shellMajor < 47) (this.button.menu as PopupMenu.PopupMenu).actor.add_style_class_name('yt-down-legacy');
    // orientation replaced vertical in GNOME 48; vertical was removed in 51.
    const box = new St.BoxLayout({ style_class: 'yt-down-content',
      ...(shellMajor >= 48 ? { orientation: Clutter.Orientation.VERTICAL } : { vertical: true }),
    });
    item.add_child(box);
    (this.button.menu as PopupMenu.PopupMenu).addMenuItem(item);
    box.add_child(new St.Label({ text: 'yt-down', style_class: 'yt-down-heading' }));
    box.add_child(new St.Label({ text: 'YouTube videos & audio', style_class: 'yt-down-subtitle' }));
    this.entry = new St.Entry({ hint_text: 'Paste a YouTube link…', can_focus: true, x_expand: true,
      accessible_name: 'YouTube URL' });
    box.add_child(this.entry);
    this.entry.clutter_text.connect('activate', () => this.fetchFormats());
    const actions = new St.BoxLayout({ style_class: 'yt-down-actions' });
    this.next = new St.Button({ label: 'Next', can_focus: true, style_class: 'yt-down-action yt-down-primary' });
    this.next.connect('clicked', () => this.fetchFormats());
    actions.add_child(this.next);
    this.cancel = new St.Button({ label: 'Cancel', can_focus: true, style_class: 'yt-down-action', visible: false });
    this.cancel.connect('clicked', () => {
      this.backend?.cancel();
      this.setStatus('Cancelling…');
      if (this.cancel) this.cancel.reactive = false;
    });
    actions.add_child(this.cancel);
    const preferences = new St.Button({ label: 'Settings', can_focus: true, style_class: 'yt-down-action' });
    preferences.connect('clicked', () => { this.button?.menu.close(); void this.openPreferences(); });
    actions.add_child(preferences);
    box.add_child(actions);
    this.title = new St.Label({ text: '', style_class: 'yt-down-title', visible: false });
    this.title.clutter_text.line_wrap = true;
    this.title.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    box.add_child(this.title);
    this.progress = new St.Widget({ style_class: 'yt-down-progress', x_expand: true, visible: false,
      accessible_name: 'Download progress' });
    this.fill = new St.Widget({ style_class: 'yt-down-progress-fill', width: 0 });
    this.progress.add_child(this.fill);
    this.progress.connect('notify::width', () => this.updateProgress());
    box.add_child(this.progress);
    this.status = new St.Label({ text: 'Paste a link to choose video quality or audio only.', style_class: 'yt-down-status' });
    this.status.clutter_text.line_wrap = true;
    this.status.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    box.add_child(this.status);
    this.formats = new PopupMenu.PopupMenuSection();
    const scroll = new St.ScrollView({ style_class: 'yt-down-formats', overlay_scrollbars: true,
      hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC });
    if (shellMajor < 46) {
      // GNOME 45 registers the scrollable via the Clutter.Container API.
      (scroll as unknown as { add_actor(child: Clutter.Actor): void }).add_actor(this.formats.actor);
    } else {
      scroll.set_child(this.formats.actor as St.BoxLayout);
    }
    const formatsItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
    formatsItem.add_child(scroll);
    scroll.x_expand = true;
    (this.button.menu as PopupMenu.PopupMenu).addMenuItem(formatsItem);
    this.entry.clutter_text.connect('text-changed', () => {
      if (!this.busy) {
        this.formats?.removeAll();
        if (this.title) this.title.visible = false;
      }
    });
    Main.panel.addToStatusArea(this.uuid, this.button);
  }

  private fetchFormats(): void {
    if (this.busy || !this.entry) return;
    const url = this.entry.get_text().trim();
    if (!url) { this.setStatus('Paste a YouTube URL first.', true); return; }
    this.loadedUrl = url;
    this.formats?.removeAll();
    if (this.title) this.title.visible = false;
    if (this.progress) this.progress.visible = false;
    this.run(['formats', url]);
  }

  private download(choice: DownloadChoice): void {
    if (this.busy) return;
    const configured = this.settings!.get_string('output-directory').trim();
    const directory = configured || GLib.build_filenamev([
      GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ?? GLib.build_filenamev([GLib.get_home_dir(), 'Videos']),
      'yt-down',
    ]);
    if (!GLib.path_is_absolute(directory)) { this.setStatus('Set an absolute download directory in Settings.', true); return; }
    this.formats?.removeAll();
    this.percent = 0;
    if (this.progress) this.progress.visible = true;
    this.updateProgress();
    this.run(['download', this.loadedUrl, choice.mode, choice.id, directory]);
  }

  private run(args: string[]): void {
    try {
      const argv = [findBun(this.settings!.get_string('bun-path')), `${this.path}/backend.js`, '--json', ...args];
      const backend = new Backend();
      this.backend = backend;
      this.setBusy(true);
      this.setStatus('Connecting…');
      backend.start(argv, event => this.onEvent(event), () => {
        if (this.backend !== backend) return;
        this.backend = undefined;
        this.setBusy(false);
      });
    } catch (error) {
      this.backend?.destroy();
      this.backend = undefined;
      this.setBusy(false);
      this.setStatus(String(error), true);
    }
  }

  private onEvent(event: BackendEvent): void {
    if (!this.button) return;
    switch (event.type) {
      case 'formats':
        this.title!.text = event.title;
        this.title!.visible = true;
        this.setStatus(event.choices.length ? 'Choose a format to start downloading.' : 'No downloadable formats found.', !event.choices.length);
        for (const choice of event.choices) {
          const item = new PopupMenu.PopupMenuItem(choice.label);
          item.label.clutter_text.line_wrap = true;
          item.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
          item.label.set_style('max-width: 380px;');
          item.connect('activate', () => this.download(choice));
          this.formats!.addMenuItem(item);
        }
        break;
      case 'progress': {
        this.percent = event.percent ?? 0;
        this.updateProgress();
        const speed = event.speed === null ? '' : ` · ${(event.speed / 1024 / 1024).toFixed(1)} MiB/s`;
        const eta = event.eta === null ? '' : ` · ${Math.ceil(event.eta)}s left`;
        this.setStatus(`${event.percent === null ? 'Downloading…' : `${event.percent.toFixed(0)}%`}${speed}${eta}`);
        break;
      }
      case 'status': this.setStatus(event.message); break;
      case 'complete':
        this.percent = 100;
        this.updateProgress();
        this.setStatus(`Saved to ${event.directory}`);
        Main.notify('yt-down', `Download complete. Saved to ${event.directory}`);
        break;
      case 'cancelled': this.setStatus(event.message); break;
      case 'error':
        this.setStatus(event.message, true);
        Main.notifyError('yt-down', event.message);
        break;
      case 'file': break;
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (this.next) { this.next.reactive = !busy; this.next.can_focus = !busy; }
    if (this.entry) this.entry.clutter_text.editable = !busy;
    if (this.cancel) { this.cancel.visible = busy; this.cancel.reactive = busy; }
  }

  private setStatus(text: string, error = false): void {
    if (!this.status) return;
    this.status.text = text;
    if (error) this.status.add_style_class_name('yt-down-error');
    else this.status.remove_style_class_name('yt-down-error');
  }

  private updateProgress(): void {
    if (this.fill && this.progress) this.fill.width = Math.max(0, this.progress.width * this.percent / 100);
  }

  disable(): void {
    this.backend?.destroy();
    this.backend = undefined;
    // Destroying the actor tree disconnects all actor-owned signal handlers.
    this.button?.destroy();
    this.button = undefined;
    this.settings = undefined;
    this.entry = undefined;
    this.next = undefined;
    this.cancel = undefined;
    this.status = undefined;
    this.title = undefined;
    this.formats = undefined;
    this.progress = undefined;
    this.fill = undefined;
    this.busy = false;
    this.loadedUrl = '';
  }
}
