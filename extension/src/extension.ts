import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Backend, findBun } from './client.js';
import { choiceKey, choiceLabel, qualityBadge, groupChoices, higherQualityHint } from './choices.js';
import { normalizeYouTubeUrl, formatDuration } from '../../src/utils.js';
import type { BackendEvent, DownloadChoice } from '../../src/protocol.js';

type Phase = 'idle' | 'searching' | 'ready' | 'downloading' | 'complete' | 'error';

export default class YtDownExtension extends Extension {
  private button?: PanelMenu.Button;
  private settings?: Gio.Settings;
  private backend?: Backend;
  private entry?: St.Entry;
  private searchButton?: St.Button;
  private cancelButton?: St.Button;
  private status?: St.Label;
  private statusIcon?: St.Icon;
  private activity?: Animation.Spinner;
  private panelActivity?: Animation.Spinner;
  private panelIcon?: St.Icon;
  private panelRing?: St.DrawingArea;
  private videoInfo?: St.BoxLayout;
  private clearButton?: St.Button;
  private urlField?: St.BoxLayout;
  private moreHint?: St.Label;
  private title?: St.Label;
  private skeleton?: St.BoxLayout;
  private formats?: PopupMenu.PopupMenuSection;
  private more?: PopupMenu.PopupSubMenuMenuItem;
  private progress?: St.Widget;
  private fill?: St.Widget;
  private progressLabel?: St.Label;
  private progressDetails?: St.Label;
  private progressBox?: St.BoxLayout;
  private completion?: St.BoxLayout;
  private openFile?: St.Button;
  private phase: Phase = 'idle';
  private percent: number | null = null;
  private loadedUrl = '';
  private lastClipboard = '';
  private selectedLabel = '';
  private filePath = '';
  private outputDirectory = '';
  private debounce = 0;
  private suppressEntry = false;
  private shellMajor = 0;

  private column(style = ''): St.BoxLayout {
    return new St.BoxLayout({ style_class: style,
      ...(this.shellMajor >= 48 ? { orientation: Clutter.Orientation.VERTICAL } : { vertical: true }),
    });
  }

  private icon(name: string, size = 16): St.Icon {
    return new St.Icon({ icon_name: name, icon_size: size, y_align: Clutter.ActorAlign.CENTER });
  }

  private label(text: string, style = '', wrap = false): St.Label {
    const label = new St.Label({ text, style_class: style, y_align: Clutter.ActorAlign.CENTER, x_expand: true });
    label.clutter_text.line_wrap = wrap;
    label.clutter_text.ellipsize = wrap ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END;
    return label;
  }

  private action(name: string, text: string, callback: () => void, primary = false): St.Button {
    const button = new St.Button({ can_focus: true, accessible_name: text,
      style_class: `yt-down-action${primary ? ' yt-down-primary' : ''}` });
    const content = new St.BoxLayout({ style_class: 'yt-down-action-content' });
    content.add_child(this.icon(name));
    content.add_child(this.label(text));
    button.set_child(content);
    button.connect('clicked', callback);
    return button;
  }

  enable(): void {
    this.shellMajor = Number.parseInt(Config.PACKAGE_VERSION, 10);
    this.phase = 'idle';
    this.settings = this.getSettings();
    this.button = new PanelMenu.Button(0.0, 'yt-down');
    const menu = this.button.menu as PopupMenu.PopupMenu;
    menu.actor.add_style_class_name('yt-down-popup');
    if (this.shellMajor < 47) menu.actor.add_style_class_name('yt-down-legacy');

    const panel = new St.Widget({ layout_manager: new Clutter.BinLayout(), width: 24, height: 24,
      y_align: Clutter.ActorAlign.CENTER });
    this.panelIcon = this.icon('folder-download-symbolic');
    this.panelActivity = new Animation.Spinner(18);
    this.panelActivity.visible = false;
    this.panelRing = new St.DrawingArea({ width: 24, height: 24, visible: false });
    this.panelRing.connect('repaint', () => this.drawRing());
    panel.add_child(this.panelIcon);
    panel.add_child(this.panelActivity);
    panel.add_child(this.panelRing);
    this.button.add_child(panel);

    // Add content directly: nonreactive PopupBaseMenuItems inherit a dimmed text style.
    const content = this.column('yt-down-content');
    menu.box.add_child(content);
    const header = new St.BoxLayout({ style_class: 'yt-down-header' });
    header.add_child(this.label('yt-down', 'yt-down-heading'));
    const settings = new St.Button({ can_focus: true, accessible_name: 'Settings', style_class: 'yt-down-icon-button' });
    settings.set_child(this.icon('emblem-system-symbolic'));
    settings.connect('clicked', () => { this.button?.menu.close(); void this.openPreferences(); });
    header.add_child(settings);
    content.add_child(header);

    const input = new St.BoxLayout({ style_class: 'yt-down-input' });
    this.urlField = new St.BoxLayout({ style_class: 'yt-down-url-field', x_expand: true,
      min_width: 0, natural_width: 0, clip_to_allocation: true });
    this.entry = new St.Entry({ min_width: 0, natural_width: 0, hint_text: 'Paste a YouTube link…', can_focus: true, x_expand: true,
      accessible_name: 'YouTube video URL', style_class: 'yt-down-entry' });
    this.entry.clutter_text.min_width = 0;
    this.entry.clutter_text.natural_width = 0;
    this.clearButton = new St.Button({ can_focus: true, accessible_name: 'Clear link',
      style_class: 'yt-down-clear', y_align: Clutter.ActorAlign.CENTER });
    this.clearButton.set_child(this.icon('edit-clear-symbolic', 14));
    this.clearButton.connect('clicked', () => this.clear());
    this.entry.clutter_text.connect('activate', () => this.fetchFormats());
    this.entry.clutter_text.connect('text-changed', () => this.onInput());
    this.urlField.add_child(this.entry);
    this.urlField.add_child(this.clearButton);
    input.add_child(this.urlField);
    this.searchButton = new St.Button({ can_focus: true, accessible_name: 'Find video',
      style_class: 'yt-down-icon-button yt-down-primary' });
    this.searchButton.set_child(this.icon('go-next-symbolic', 20));
    this.searchButton.connect('clicked', () => this.fetchFormats());
    input.add_child(this.searchButton);
    content.add_child(input);

    this.skeleton = this.column('yt-down-skeleton');
    this.skeleton.visible = false;
    for (const width of [300, 220, 260]) {
      this.skeleton.add_child(new St.Widget({ style_class: 'yt-down-skeleton-line', width,
        x_align: Clutter.ActorAlign.START }));
    }
    content.add_child(this.skeleton);

    this.videoInfo = this.column('yt-down-video-info');
    this.videoInfo.visible = false;
    this.title = this.label('', 'yt-down-title');
    this.videoInfo.add_child(this.title);
    content.add_child(this.videoInfo);

    this.formats = new PopupMenu.PopupMenuSection();
    (this.formats.actor as St.BoxLayout).add_style_class_name('yt-down-choices');
    menu.addMenuItem(this.formats);
    this.more = new PopupMenu.PopupSubMenuMenuItem('Show more', false);
    this.moreHint = this.label('', 'yt-down-quality-hint');
    this.moreHint.x_expand = false;
    this.more.insert_child_below(this.moreHint, this.more.get_last_child());
    this.more.add_style_class_name('yt-down-more');
    this.more.visible = false;
    menu.addMenuItem(this.more);

    const footer = this.column('yt-down-footer');
    menu.box.add_child(footer);
    this.progressBox = this.column('yt-down-download');
    this.progressBox.visible = false;
    const progressHeader = new St.BoxLayout();
    this.progressLabel = this.label('', 'yt-down-title');
    progressHeader.add_child(this.progressLabel);
    this.progressBox.add_child(progressHeader);
    this.progress = new St.Widget({ style_class: 'yt-down-progress', x_expand: true,
      accessible_name: 'Download progress' });
    this.fill = new St.Widget({ style_class: 'yt-down-progress-fill', width: 0 });
    this.progress.add_child(this.fill);
    this.progress.connect('notify::width', () => this.updateProgress(false));
    this.progressBox.add_child(this.progress);
    this.progressDetails = this.label('', 'yt-down-secondary');
    this.progressBox.add_child(this.progressDetails);
    footer.add_child(this.progressBox);

    const statusRow = new St.BoxLayout({ style_class: 'yt-down-status-row' });
    this.activity = new Animation.Spinner(18);
    this.activity.visible = false;
    this.statusIcon = this.icon('insert-link-symbolic');
    this.status = this.label('A link is all you need. Paste one to get started.', 'yt-down-status', true);
    this.cancelButton = new St.Button({ label: 'Cancel', can_focus: true, accessible_name: 'Cancel current task',
      style_class: 'yt-down-cancel', visible: false });
    this.cancelButton.connect('clicked', () => {
      this.backend?.cancel();
      this.setStatus('Cancelling…');
      if (this.cancelButton) this.cancelButton.reactive = false;
    });
    statusRow.add_child(this.activity);
    statusRow.add_child(this.statusIcon);
    statusRow.add_child(this.status);
    statusRow.add_child(this.cancelButton);
    footer.add_child(statusRow);
    this.completion = new St.BoxLayout({ style_class: 'yt-down-completion', visible: false });
    this.openFile = this.action('media-playback-start-symbolic', 'Open file', () => this.openPath(this.filePath), true);
    this.completion.add_child(this.openFile);
    this.completion.add_child(this.action('folder-open-symbolic', 'Open folder', () => this.openPath(this.outputDirectory)));
    footer.add_child(this.completion);

    menu.connect('open-state-changed', (_menu, open: boolean) => {
      this.syncMotion();
      if (open) this.checkClipboard();
    });
    Main.panel.addToStatusArea(this.uuid, this.button);
  }

  private onInput(): void {
    if (this.suppressEntry || this.busy()) return;
    this.clearDebounce();
    this.formats?.removeAll();
    this.more?.menu.removeAll();
    if (this.more) this.more.visible = false;
    if (this.videoInfo) this.videoInfo.visible = false;
    this.setPhase('idle');
    this.setStatus('Paste a link, or press Enter to find a video.');
    const url = normalizeYouTubeUrl(this.entry?.get_text() ?? '');
    if (url) {
      this.debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
        this.debounce = 0;
        this.fetchFormats();
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  private checkClipboard(): void {
    if (this.busy() || !this.settings?.get_boolean('clipboard-autofetch')) return;
    const entry = this.entry!;
    const current = entry.get_text();
    // Never overwrite a link the user is editing.
    if (current && normalizeYouTubeUrl(current) !== this.loadedUrl) return;
    St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
      if (!this.isOpen() || this.busy() || this.entry !== entry || this.entry.get_text() !== current) return;
      const url = normalizeYouTubeUrl(text ?? '');
      if (!url || url === this.lastClipboard || (url === this.loadedUrl && this.phase !== 'idle')) return;
      this.lastClipboard = url;
      this.setEntry(url);
      this.fetchFormats();
    });
  }

  private setEntry(value: string): void {
    this.suppressEntry = true;
    this.entry?.set_text(value);
    this.suppressEntry = false;
  }

  private clear(): void {
    if (this.busy()) return;
    this.clearDebounce();
    this.loadedUrl = '';
    this.filePath = '';
    this.setEntry('');
    this.onInput();
    this.entry?.grab_key_focus();
  }

  private fetchFormats(): void {
    if (this.busy() || !this.entry) return;
    this.clearDebounce();
    const url = normalizeYouTubeUrl(this.entry.get_text());
    if (!url) { this.setPhase('error'); this.setStatus('Use a YouTube video, Shorts, or share link.', true); return; }
    this.loadedUrl = url;
    this.setEntry(url);
    this.filePath = '';
    this.formats?.removeAll();
    this.more?.menu.removeAll();
    if (this.more) this.more.visible = false;
    if (this.videoInfo) this.videoInfo.visible = false;
    this.setPhase('searching');
    this.setStatus('Finding your video…');
    this.run(['formats', url]);
  }

  private renderFormats(event: Extract<BackendEvent, { type: 'formats' }>): void {
    this.formats!.removeAll();
    this.formats!.actor.visible = true;
    this.title!.text = event.title;
    this.videoInfo!.visible = true;
    const previous = this.settings!.get_string('last-choice');
    const { primary, more } = groupChoices(event.choices);
    for (const choice of primary) this.addChoice(this.formats!, choice, previous);
    for (const choice of more) this.addChoice(this.more!.menu, choice, previous);
    this.more!.visible = more.length > 0;
    this.moreHint!.text = higherQualityHint(more);
    this.moreHint!.visible = Boolean(this.moreHint!.text);
    this.setPhase('ready');
    this.setStatus(event.choices.length ? 'Ready when you are.' : 'No downloadable formats found.', !event.choices.length);
    this.reveal(this.videoInfo!);
    this.reveal(this.formats!.actor);
  }

  private addChoice(menu: PopupMenu.PopupMenuBase, choice: DownloadChoice, previous: string): void {
    const row = new PopupMenu.PopupBaseMenuItem({ style_class: 'yt-down-choice', can_focus: true });
    if (choice.mode !== 'video') row.add_child(this.icon('audio-x-generic-symbolic', 16));
    const name = this.label(choiceLabel(choice), 'yt-down-choice-label');
    name.x_expand = false;
    row.add_child(name);
    const badge = qualityBadge(choice);
    if (badge) {
      const tag = this.label(badge, 'yt-down-resolution-tag');
      tag.x_expand = false;
      row.add_child(tag);
    }
    const space = new St.Widget({ x_expand: true });
    row.add_child(space);
    const sizeText = choice.sizeLabel === '~ unknown' || choice.mode === 'mp3' ? '—' : choice.sizeLabel ?? '—';
    const size = this.label(sizeText, 'yt-down-choice-size');
    size.x_expand = false;
    row.add_child(size);
    const remembered = previous === choiceKey(choice);
    if (remembered) row.add_style_class_name('yt-down-last-used');
    row.accessible_name = `${choiceLabel(choice)}, ${badge}, ${sizeText}${remembered ? ', last used' : ''}`;
    // Avoid menu activation's default close: progress stays visible after choosing.
    row.connect('activate', () => {
      GObject.signal_stop_emission_by_name(row, 'activate');
      this.download(choice);
    });
    menu.addMenuItem(row);
  }

  private download(choice: DownloadChoice): void {
    if (this.busy()) return;
    const configured = this.settings!.get_string('output-directory').trim();
    const directory = configured || GLib.build_filenamev([
      GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ?? GLib.build_filenamev([GLib.get_home_dir(), 'Videos']), 'yt-down',
    ]);
    if (!GLib.path_is_absolute(directory)) { this.setStatus('Set an absolute download folder in Settings.', true); return; }
    this.settings!.set_string('last-choice', choiceKey(choice));
    this.selectedLabel = choiceLabel(choice);
    this.filePath = '';
    this.outputDirectory = directory;
    // Keep the activating row alive until its signal finishes; hide the group.
    // Destroying it mid-emission can let Shell's after-handler close the popup.
    if (this.formats) this.formats.actor.visible = false;
    this.more?.menu.close();
    if (this.more) this.more.visible = false;
    this.percent = null;
    this.progressLabel!.text = `Downloading ${this.selectedLabel}`;
    this.progressDetails!.text = 'Connecting…';
    this.setPhase('downloading');
    if (this.isOpen()) this.cancelButton?.grab_key_focus();
    this.setStatus('You can close this popup. We’ll keep downloading.');
    this.run(['download', this.loadedUrl, choice.mode, choice.id, directory]);
  }

  private run(args: string[]): void {
    try {
      const argv = [findBun(this.settings!.get_string('bun-path')), `${this.path}/backend.js`, '--json', ...args];
      const backend = new Backend();
      this.backend = backend;
      backend.start(argv, event => this.onEvent(event), () => {
        if (this.backend === backend) this.backend = undefined;
      });
    } catch (error) {
      this.backend?.destroy();
      this.backend = undefined;
      this.setPhase('error');
      this.setStatus(String(error), true);
    }
  }

  private onEvent(event: BackendEvent): void {
    if (!this.button) return;
    switch (event.type) {
      case 'formats': this.renderFormats(event); break;
      case 'progress': {
        this.percent = event.percent;
        this.updateProgress();
        this.syncPanel();
        const percentage = event.percent === null ? 'Downloading' : `${Math.floor(event.percent)}%`;
        const speed = event.speed === null ? '' : `${(event.speed / 1024 / 1024).toFixed(1)} MiB/s`;
        const eta = event.eta === null ? '' : `${formatDuration(Math.ceil(event.eta))} left`;
        this.progressLabel!.text = `${this.selectedLabel} · ${percentage}`;
        this.progressDetails!.text = [speed, eta].filter(Boolean).join(' · ') || 'Downloading…';
        break;
      }
      case 'status':
        if (this.phase === 'downloading') this.progressDetails!.text = event.message;
        else this.setStatus(event.message);
        break;
      case 'file': this.filePath = event.path; break;
      case 'complete':
        this.outputDirectory = event.directory;
        this.percent = 100;
        this.updateProgress();
        this.setPhase('complete');
        this.openFile!.visible = Boolean(this.filePath);
        this.setStatus('Saved. Enjoy your download.');
        this.reveal(this.completion!);
        Main.notify('yt-down', 'Download saved. Open it from the panel.');
        break;
      case 'cancelled':
        this.setPhase('idle');
        this.setStatus('Cancelled. Partial files kept so you can resume.');
        break;
      case 'error':
        this.setPhase('error');
        this.setStatus(event.message, true);
        Main.notifyError('yt-down', event.message);
        break;
    }
  }

  private isOpen(): boolean { return Boolean(this.button && (this.button.menu as PopupMenu.PopupMenu).isOpen); }

  private busy(): boolean { return this.phase === 'searching' || this.phase === 'downloading'; }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    const busy = this.busy();
    if (this.entry) { this.entry.clutter_text.editable = !busy; this.entry.reactive = !busy; }
    if (this.clearButton) { this.clearButton.reactive = !busy; this.clearButton.can_focus = !busy; }
    if (this.searchButton) this.searchButton.visible = !busy && phase !== 'ready' && phase !== 'complete';
    if (this.cancelButton) { this.cancelButton.visible = busy; this.cancelButton.reactive = busy; }
    if (this.skeleton) this.skeleton.visible = phase === 'searching';
    if (this.progressBox) this.progressBox.visible = phase === 'downloading';
    if (this.completion) this.completion.visible = phase === 'complete';
    if (this.statusIcon) {
      this.statusIcon.visible = !busy;
      this.statusIcon.icon_name = phase === 'complete' ? 'emblem-ok-symbolic'
        : phase === 'error' ? 'dialog-warning-symbolic' : phase === 'ready' ? 'object-select-symbolic' : 'insert-link-symbolic';
      if (phase === 'complete') this.statusIcon.add_style_class_name('yt-down-success');
      else this.statusIcon.remove_style_class_name('yt-down-success');
    }
    this.syncMotion();
    this.syncPanel();
  }

  private setStatus(text: string, error = false): void {
    if (!this.status) return;
    this.status.text = text;
    if (error) this.status.add_style_class_name('yt-down-error');
    else this.status.remove_style_class_name('yt-down-error');
  }

  private motionAllowed(): boolean {
    const settings = St.Settings.get();
    const reduced = settings as unknown as { reduced_motion?: number; reducedMotion?: number };
    // GNOME 51 adds ReducedMotion; earlier versions use enable-animations.
    return settings.enable_animations && (reduced.reduced_motion ?? reduced.reducedMotion ?? 0) !== 1;
  }

  private syncMotion(): void {
    if (!this.skeleton || !this.activity) return;
    this.skeleton.remove_all_transitions();
    this.skeleton.opacity = 255;
    const visibleBusy = Boolean(this.isOpen() && this.busy());
    this.activity.visible = visibleBusy;
    if (visibleBusy && this.motionAllowed()) this.activity.play();
    else this.activity.stop();
    if (this.phase === 'searching' && visibleBusy && this.motionAllowed()) this.pulse(false);
  }

  private pulse(brighter: boolean): void {
    this.skeleton?.ease({ opacity: brighter ? 255 : 115, duration: 650,
      mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
      onComplete: () => {
        if (this.skeleton && this.phase === 'searching' && this.isOpen() && this.motionAllowed()) this.pulse(!brighter);
      },
    });
  }

  private reveal(actor: Clutter.Actor): void {
    actor.remove_all_transitions();
    if (!this.motionAllowed() || !this.isOpen()) { actor.opacity = 255; actor.translation_y = 0; return; }
    actor.opacity = 0;
    actor.translation_y = 6;
    actor.ease({ opacity: 255, ...{ translation_y: 0 }, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
  }

  private updateProgress(animate = true): void {
    if (!this.fill || !this.progress) return;
    const width = this.progress.width * (this.percent ?? 0) / 100;
    if (animate && this.motionAllowed() && this.isOpen()) {
      this.fill.ease({ width, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    } else { this.fill.remove_all_transitions(); this.fill.width = width; }
    this.progress.accessible_name = this.percent === null ? 'Downloading, size unknown' : `${Math.floor(this.percent)} percent downloaded`;
  }

  private syncPanel(): void {
    const active = this.busy();
    const ring = this.phase === 'downloading' && this.percent !== null;
    if (this.panelIcon) this.panelIcon.visible = !active;
    if (this.panelRing) { this.panelRing.visible = ring; this.panelRing.queue_repaint(); }
    if (this.panelActivity) {
      this.panelActivity.visible = active && !ring;
      if (active && !ring && this.motionAllowed()) this.panelActivity.play();
      else this.panelActivity.stop();
    }
    if (this.button) this.button.accessible_name = ring ? `yt-down, ${Math.floor(this.percent!)} percent downloaded`
      : this.phase === 'searching' ? 'yt-down, finding video' : this.phase === 'complete' ? 'yt-down, download saved' : 'yt-down';
  }

  private drawRing(): void {
    if (!this.panelRing) return;
    const [width, height] = this.panelRing.get_surface_size();
    const cr = this.panelRing.get_context();
    const radius = Math.min(width, height) / 2 - 3;
    cr.setLineWidth(2.5);
    const color = this.panelRing.get_theme_node().get_foreground_color();
    cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, 0.22);
    cr.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
    cr.stroke();
    cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, 1);
    cr.arc(width / 2, height / 2, radius, -Math.PI / 2, -Math.PI / 2 + (this.percent ?? 0) / 100 * Math.PI * 2);
    cr.stroke();
    cr.$dispose();
  }

  private openPath(path: string): void {
    if (!path) return;
    Gio.AppInfo.launch_default_for_uri_async(Gio.File.new_for_path(path).get_uri(), null, null, (_source, result) => {
      try { Gio.AppInfo.launch_default_for_uri_finish(result); }
      catch (error) { if (this.button) this.setStatus(`Could not open download: ${String(error)}`, true); }
    });
  }

  private clearDebounce(): void {
    if (this.debounce) { GLib.Source.remove(this.debounce); this.debounce = 0; }
  }

  disable(): void {
    this.clearDebounce();
    this.backend?.destroy();
    this.backend = undefined;
    this.skeleton?.remove_all_transitions();
    this.videoInfo?.remove_all_transitions();
    this.formats?.actor.remove_all_transitions();
    this.completion?.remove_all_transitions();
    this.fill?.remove_all_transitions();
    this.activity?.stop();
    this.panelActivity?.stop();
    this.button?.destroy();
    this.button = undefined;
    this.settings = undefined;
    this.entry = undefined;
    this.searchButton = undefined;
    this.cancelButton = undefined;
    this.status = undefined;
    this.statusIcon = undefined;
    this.activity = undefined;
    this.panelActivity = undefined;
    this.panelIcon = undefined;
    this.panelRing = undefined;
    this.videoInfo = undefined;
    this.clearButton = undefined;
    this.urlField = undefined;
    this.moreHint = undefined;
    this.title = undefined;
    this.skeleton = undefined;
    this.formats = undefined;
    this.more = undefined;
    this.progress = undefined;
    this.fill = undefined;
    this.progressLabel = undefined;
    this.progressDetails = undefined;
    this.progressBox = undefined;
    this.completion = undefined;
    this.openFile = undefined;
    this.phase = 'idle';
    this.loadedUrl = '';
    this.lastClipboard = '';
  }
}
