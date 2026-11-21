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
import { MediaOpener } from './media.js';
import { TaskQueue } from './queue.js';
import { choiceKey, choiceLabel, qualityBadge, groupChoices, higherQualityHint, automaticChoice } from './choices.js';
import { normalizeVideoUrl, formatDuration, formatBytes } from '../../src/utils.js';
import type { BackendEvent, DownloadChoice } from '../../src/protocol.js';

type Phase = 'idle' | 'searching' | 'ready' | 'error';
interface DownloadJob {
  url: string; title: string; choice: DownloadChoice; directory: string;
  state: 'queued' | 'active' | 'cancelling' | 'complete' | 'cancelled' | 'error';
  percent: number | null; filePath: string; backend?: Backend;
  card: St.BoxLayout; progress: St.Widget; fill: St.Widget; label: St.Label;
  summary: St.BoxLayout; header: St.BoxLayout; size: St.Label; sizeQuery?: Gio.Cancellable;
  detail: St.Label; cancel: St.Button; actions: St.BoxLayout; openFile: St.Button;
}

export default class YtDownExtension extends Extension {
  private button?: PanelMenu.Button;
  private settings?: Gio.Settings;
  private backend?: Backend;
  private entry?: St.Entry;
  private searchButton?: St.Button;
  private cancelButton?: St.Button;
  private status?: St.Label;
  private statusRow?: St.BoxLayout;
  private inputError?: St.Label;
  private activity?: Animation.Spinner;
  private panelActivity?: Animation.Spinner;
  private panelIcon?: St.Icon;
  private panelRing?: St.DrawingArea;
  private videoInfo?: St.BoxLayout;
  private urlField?: St.Widget;
  private moreHint?: St.Label;
  private title?: St.Label;
  private skeleton?: St.BoxLayout;
  private formats?: PopupMenu.PopupMenuSection;
  private more?: PopupMenu.PopupSubMenuMenuItem;
  private jobsBox?: St.BoxLayout;
  private jobsScroll?: St.ScrollView;
  private jobsHeading?: St.Label;
  private jobs: DownloadJob[] = [];
  private queue?: TaskQueue<DownloadJob>;
  private limitSignal = 0;
  private focusSignal = 0;
  private mediaOpener?: MediaOpener;
  private phase: Phase = 'idle';
  private percent: number | null = null;
  private loadedUrl = '';
  private lastClipboard = '';
  private debounce = 0;
  private suppressEntry = false;
  private pendingAutoDownload = false;
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

  enable(): void {
    this.shellMajor = Number.parseInt(Config.PACKAGE_VERSION, 10);
    this.phase = 'idle';
    this.settings = this.getSettings();
    this.jobs = [];
    this.focusSignal = global.stage.connect('notify::key-focus', () => {
      for (const job of this.jobs) this.updateCompletedActions(job);
    });
    this.queue = new TaskQueue(this.settings.get_int('parallel-downloads'), (job, done) => this.startDownload(job, done));
    this.limitSignal = this.settings.connect('changed::parallel-downloads', () => {
      this.queue?.setLimit(this.settings!.get_int('parallel-downloads'));
      this.syncJobs();
    });
    this.mediaOpener = new MediaOpener(uri => this.launchUri(uri));
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
    this.urlField = new St.Widget({ layout_manager: new Clutter.BinLayout(), style_class: 'yt-down-url-field', x_expand: true,
      min_width: 0, natural_width: 0, clip_to_allocation: true });
    this.entry = new St.Entry({ min_width: 0, natural_width: 0, hint_text: 'Paste a video link…', can_focus: true, x_expand: true,
      accessible_name: 'Video URL', style_class: 'yt-down-entry' });
    this.entry.clutter_text.min_width = 0;
    this.entry.clutter_text.natural_width = 0;
    this.entry.clutter_text.connect('activate', () => this.fetchFormats());
    this.entry.clutter_text.connect('text-changed', () => this.onInput());
    this.urlField.add_child(this.entry);
    this.inputError = this.label('', 'yt-down-input-error');
    this.inputError.visible = false;
    this.inputError.reactive = false;
    this.urlField.add_child(this.inputError);
    this.entry.clutter_text.connect('button-press-event', () => {
      this.setInputError('');
      return Clutter.EVENT_PROPAGATE;
    });
    this.entry.clutter_text.connect('key-focus-in', () => this.setInputError(''));
    input.add_child(this.urlField);
    this.searchButton = new St.Button({ can_focus: true, accessible_name: 'Find video',
      style_class: 'yt-down-icon-button' });
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
    this.statusRow = new St.BoxLayout({ style_class: 'yt-down-status-row', visible: false });
    this.activity = new Animation.Spinner(18);
    this.activity.visible = false;
    this.status = this.label('', 'yt-down-status', true);
    this.cancelButton = new St.Button({ label: 'Cancel', can_focus: true, accessible_name: 'Cancel current task',
      style_class: 'yt-down-cancel', visible: false });
    this.cancelButton.connect('clicked', () => {
      this.backend?.cancel();
      this.setStatus('Cancelling…');
      if (this.cancelButton) this.cancelButton.reactive = false;
    });
    this.statusRow.add_child(this.activity);
    this.statusRow.add_child(this.status);
    this.statusRow.add_child(this.cancelButton);
    footer.add_child(this.statusRow);
    this.jobsHeading = this.label('', 'yt-down-secondary');
    this.jobsHeading.visible = false;
    footer.add_child(this.jobsHeading);
    this.jobsBox = this.column('yt-down-jobs');
    this.jobsScroll = new St.ScrollView({ style_class: 'yt-down-jobs-scroll', overlay_scrollbars: true,
      hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC, visible: false });
    if (this.shellMajor < 46) {
      (this.jobsScroll as unknown as { add_actor(child: Clutter.Actor): void }).add_actor(this.jobsBox);
    } else this.jobsScroll.set_child(this.jobsBox);
    footer.add_child(this.jobsScroll);

    menu.connect('open-state-changed', (_menu, open: boolean) => {
      this.syncMotion();
      for (const job of this.jobs) this.updateCompletedActions(job);
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
    this.setStatus('');
    const url = normalizeVideoUrl(this.entry?.get_text() ?? '');
    if (url) {
      this.debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
        this.debounce = 0;
        this.fetchFormats(this.settings?.get_boolean('download-on-paste') ?? false);
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  private checkClipboard(): void {
    if (this.busy() || !this.settings?.get_boolean('clipboard-autofetch')) return;
    const entry = this.entry!;
    const current = entry.get_text();
    // Never overwrite a link the user is editing.
    if (current && normalizeVideoUrl(current) !== this.loadedUrl) return;
    St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
      if (!this.isOpen() || this.busy() || this.entry !== entry || this.entry.get_text() !== current) return;
      const url = normalizeVideoUrl(text ?? '');
      if (!url || url === this.lastClipboard || (url === this.loadedUrl && this.phase !== 'idle')) return;
      this.lastClipboard = url;
      this.setEntry(url);
      // Clipboard discovery is local: contacting the site needs confirmation.
      this.onClipboardInput();
    });
  }

  private onClipboardInput(): void {
    this.clearDebounce();
    this.loadedUrl = '';
    this.formats?.removeAll();
    this.more?.menu.removeAll();
    if (this.more) this.more.visible = false;
    if (this.videoInfo) this.videoInfo.visible = false;
    this.setPhase('idle');
    this.setStatus('');
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
    this.setEntry('');
    this.onInput();
    this.entry?.grab_key_focus();
  }

  private fetchFormats(autoDownload = false): void {
    if (this.busy() || !this.entry) return;
    this.clearDebounce();
    const url = normalizeVideoUrl(this.entry.get_text());
    if (!url) { this.setPhase('error'); this.setStatus('Enter a valid HTTP or HTTPS video link.', true); return; }
    this.pendingAutoDownload = autoDownload;
    this.loadedUrl = url;
    this.setEntry(url);
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
    this.moreHint!.text = higherQualityHint(more, Math.max(1080, ...primary.map(choice => choice.height ?? 0)));
    this.moreHint!.visible = Boolean(this.moreHint!.text);
    this.setPhase('ready');
    this.setStatus(event.choices.length ? 'Ready when you are.' : 'No downloadable formats found.', !event.choices.length);
    this.reveal(this.videoInfo!);
    this.reveal(this.formats!.actor);
    const autoDownload = this.pendingAutoDownload;
    this.pendingAutoDownload = false;
    if (autoDownload && this.settings?.get_boolean('download-on-paste')) {
      const choice = automaticChoice(event.choices, previous);
      if (choice) this.download(choice);
    }
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
    if (this.busy() || !this.loadedUrl) return;
    const requestedDirectory = this.settings!.get_string('output-directory').trim() || GLib.build_filenamev([
      GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ?? GLib.build_filenamev([GLib.get_home_dir(), 'Videos']), 'yt-down',
    ]);
    if (!GLib.path_is_absolute(requestedDirectory)) { this.setStatus('Set an absolute download folder in Settings.', true); return; }
    const directory = GLib.canonicalize_filename(requestedDirectory, null);
    if (this.jobs.some(job => job.url === this.loadedUrl && job.directory === directory && job.choice.mode === choice.mode
      && job.choice.id === choice.id && ['queued', 'active', 'cancelling'].includes(job.state))) {
      this.setStatus('That download is already running or queued.'); return;
    }
    this.settings!.set_string('last-choice', choiceKey(choice));
    const card = this.column('yt-down-download');
    card.reactive = true; card.track_hover = true;
    const summary = new St.BoxLayout({ style_class: 'yt-down-job-summary' });
    const title = this.label(this.title!.text, 'yt-down-job-title');
    title.min_width = 0; title.natural_width = 0;
    const size = this.label('—', 'yt-down-job-size');
    size.x_expand = false; size.visible = false;
    summary.add_child(title); summary.add_child(size); card.add_child(summary);
    const header = new St.BoxLayout({ style_class: 'yt-down-job-header' });
    const label = this.label('Queued', 'yt-down-secondary');
    const cancel = new St.Button({ can_focus: true, style_class: 'yt-down-clear', accessible_name: `Cancel ${this.title!.text}` });
    cancel.set_child(this.icon('process-stop-symbolic', 14));
    header.add_child(label); header.add_child(cancel); card.add_child(header);
    const progress = new St.Widget({ style_class: 'yt-down-progress', x_expand: true });
    const fill = new St.Widget({ style_class: 'yt-down-progress-fill', width: 0 });
    progress.add_child(fill); card.add_child(progress);
    const detail = this.label('Waiting for a download slot…', 'yt-down-secondary', true);
    card.add_child(detail);
    const actions = new St.BoxLayout({ style_class: 'yt-down-completion', visible: false });
    const job: DownloadJob = { url: this.loadedUrl, title: this.title!.text, choice, directory, state: 'queued', percent: null,
      filePath: '', card, summary, header, size, progress, fill, label, detail, cancel, actions,
      openFile: this.rowAction('media-playback-start-symbolic', 'Open file', () => { void this.openMedia(job.filePath); }) };
    actions.add_child(job.openFile);
    actions.add_child(this.rowAction('folder-open-symbolic', 'Open folder', () => this.openPath(job.directory)));
    summary.add_child(actions);
    card.connect('notify::hover', () => this.updateCompletedActions(job));
    cancel.connect('clicked', () => this.cancelJob(job));
    progress.connect('notify::width', () => this.updateJobProgress(job));
    this.jobs.push(job); this.jobsBox!.add_child(card);
    this.queue!.add(job, `${directory}\0${job.url}`);
    // Keep the activating row alive until its signal finishes, but release the input.
    this.formats!.actor.visible = false;
    this.more?.menu.close(); if (this.more) this.more.visible = false;
    this.videoInfo!.visible = false;
    this.loadedUrl = ''; this.setEntry(''); this.setPhase('idle');
    this.setStatus('');
    this.entry?.grab_key_focus();
    this.syncJobs();
  }

  private startDownload(job: DownloadJob, done: () => void): void {
    job.state = 'active'; job.label.text = `${choiceLabel(job.choice)} · Connecting…`;
    job.detail.text = 'Starting download…';
    try {
      const backend = new Backend(); job.backend = backend;
      backend.start([findBun(this.settings!.get_string('bun-path')), `${this.path}/backend.js`, '--json',
        'download', job.url, job.choice.mode, job.choice.id, job.directory], event => this.onJobEvent(job, event), () => {
        job.backend = undefined;
        job.cancel.reactive = true;
        if (['complete', 'error', 'cancelled'].includes(job.state)) this.finishJobControls(job);
        done(); this.syncJobs();
      });
    } catch (error) {
      job.backend?.destroy(); job.backend = undefined;
      this.onJobEvent(job, { type: 'error', message: String(error) });
      this.finishJobControls(job); done();
    }
    this.syncJobs();
  }

  private onJobEvent(job: DownloadJob, event: BackendEvent): void {
    if (!this.button || !['active', 'cancelling'].includes(job.state)) return;
    switch (event.type) {
      case 'progress':
        if (job.state === 'cancelling') break;
        job.percent = event.percent;
        job.label.text = `${choiceLabel(job.choice)} · ${event.percent === null ? 'Downloading' : `${Math.floor(event.percent)}%`}`;
        job.detail.text = [event.speed === null ? '' : `${(event.speed / 1024 / 1024).toFixed(1)} MiB/s`,
          event.eta === null ? '' : `${formatDuration(Math.ceil(event.eta))} left`].filter(Boolean).join(' · ') || 'Downloading…';
        this.updateJobProgress(job); break;
      case 'status': if (job.state !== 'cancelling') job.detail.text = event.message; break;
      case 'file': job.filePath = event.path; break;
      case 'complete':
        job.state = 'complete'; job.percent = 100; job.label.text = `${choiceLabel(job.choice)} · Saved`;
        job.detail.text = 'Download complete.'; job.directory = event.directory;
        job.header.visible = job.progress.visible = job.detail.visible = false;
        job.card.add_style_class_name('yt-down-finished');
        job.card.can_focus = true;
        job.openFile.visible = Boolean(job.filePath); job.cancel.reactive = false;
        job.header.remove_child(job.cancel); job.actions.add_child(job.cancel);
        this.updateCompletedActions(job);
        this.readCompletedSize(job);
        Main.notify('yt-down', `Saved: ${job.title}`); break;
      case 'cancelled':
        job.state = 'cancelled'; job.label.text = 'Cancelled'; job.detail.text = 'Partial files kept for resuming.';
        job.cancel.reactive = false; break;
      case 'error':
        job.state = 'error'; job.label.text = 'Download failed'; job.detail.text = event.message;
        job.cancel.reactive = false; Main.notifyError('yt-down', `${job.title}: ${event.message}`); break;
      case 'formats': break;
    }
    this.syncJobs();
  }

  private rowAction(icon: string, label: string, callback: () => void): St.Button {
    const button = new St.Button({ can_focus: true, accessible_name: label, style_class: 'yt-down-row-action' });
    button.set_child(this.icon(icon, 16));
    button.connect('clicked', callback);
    return button;
  }

  private updateCompletedActions(job: DownloadJob): void {
    if (job.state !== 'complete') return;
    const focus = global.stage.get_key_focus();
    const reveal = this.isOpen() && (job.card.hover || Boolean(focus && job.card.contains(focus)));
    job.actions.visible = reveal;
    job.size.visible = !reveal;
  }

  private readCompletedSize(job: DownloadJob): void {
    if (!job.filePath) return;
    job.sizeQuery = new Gio.Cancellable();
    Gio.File.new_for_path(job.filePath).query_info_async('standard::size', Gio.FileQueryInfoFlags.NONE,
      GLib.PRIORITY_DEFAULT, job.sizeQuery, (file, result) => {
        try {
          const info = (file as Gio.File).query_info_finish(result);
          if (!this.button || !this.jobs.includes(job)) return;
          job.size.text = formatBytes(info.get_size());
          job.card.accessible_name = `${job.title}, saved, ${job.size.text}. Focus to show file actions.`;
        } catch { /* Keep an unknown size if the file was moved or the row dismissed. */ }
      });
  }

  private finishJobControls(job: DownloadJob): void {
    job.cancel.set_child(this.icon('window-close-symbolic', 14));
    job.cancel.accessible_name = `Dismiss ${job.title}`;
    job.cancel.reactive = true;
    if (job.state === 'complete') job.cancel.add_style_class_name('yt-down-row-action');
    // Retain only a short session history so completed rows cannot grow forever.
    const history = this.jobs.filter(item => !item.backend && ['complete', 'error', 'cancelled'].includes(item.state));
    for (const older of history.slice(0, -5)) this.dismissJob(older);
  }

  private cancelJob(job: DownloadJob): void {
    if (job.state === 'queued') {
      this.queue!.remove(job); this.dismissJob(job);
    } else if (job.state === 'active') {
      job.state = 'cancelling'; job.detail.text = 'Cancelling…'; job.cancel.reactive = false; job.backend?.cancel();
    } else if (job.state !== 'cancelling' && !job.backend) this.dismissJob(job);
    this.syncJobs();
  }

  private dismissJob(job: DownloadJob): void {
    this.jobs = this.jobs.filter(item => item !== job);
    job.sizeQuery?.cancel();
    job.fill.remove_all_transitions(); job.card.destroy();
  }

  private updateJobProgress(job: DownloadJob): void {
    const width = job.progress.width * (job.percent ?? 0) / 100;
    job.fill.remove_all_transitions();
    if (this.isOpen() && this.motionAllowed()) job.fill.ease({ width, duration: 180 });
    else job.fill.width = width;
    job.progress.accessible_name = job.percent === null ? 'Download size unknown' : `${Math.floor(job.percent)} percent downloaded`;
  }

  private syncJobs(): void {
    if (!this.jobsHeading || !this.jobsScroll) return;
    this.jobsHeading.visible = this.jobsScroll.visible = this.jobs.length > 0;
    this.jobsHeading.text = `${this.queue?.active ?? 0} downloading · ${this.queue?.queued ?? 0} queued`;
    this.syncPanel();
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
    if (event.type === 'formats') this.renderFormats(event);
    else if (event.type === 'status') this.setStatus(event.message);
    else if (event.type === 'cancelled') { this.setPhase('idle'); this.setStatus('Search cancelled.'); }
    else if (event.type === 'error') { this.setPhase('error'); this.setStatus(event.message, true); }
  }

  private isOpen(): boolean { return Boolean(this.button && (this.button.menu as PopupMenu.PopupMenu).isOpen); }

  private busy(): boolean { return this.phase === 'searching'; }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    const busy = this.busy();
    if (this.entry) { this.entry.clutter_text.editable = !busy; this.entry.reactive = !busy; }
    if (this.searchButton) this.searchButton.visible = !busy && phase !== 'ready';
    if (this.cancelButton) { this.cancelButton.visible = busy; this.cancelButton.reactive = busy; }
    if (this.skeleton) this.skeleton.visible = phase === 'searching';
    if (this.statusRow) this.statusRow.visible = busy;
    this.setInputError('');
    this.syncMotion();
    this.syncPanel();
  }

  private setStatus(text: string, error = false): void {
    if (this.status) this.status.text = text;
    this.setInputError(error ? text : '');
  }

  private setInputError(text: string): void {
    if (!this.entry || !this.inputError) return;
    this.inputError.text = text;
    this.inputError.visible = Boolean(text);
    // Keep the original URL editable beneath the error; typing or clicking reveals it.
    this.entry.opacity = text ? 0 : 255;
    this.entry.accessible_name = text ? `Video URL: ${text}` : 'Video URL';
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

  private syncPanel(): void {
    const downloads = this.jobs.filter(job => ['active', 'cancelling'].includes(job.state));
    const active = downloads.length > 0 || this.busy();
    this.percent = downloads.some(job => job.percent !== null)
      ? downloads.reduce((sum, job) => sum + (job.percent ?? 0), 0) / downloads.length : null;
    const ring = active && this.percent !== null;
    if (this.panelIcon) this.panelIcon.visible = !active;
    if (this.panelRing) { this.panelRing.visible = ring; this.panelRing.queue_repaint(); }
    if (this.panelActivity) {
      this.panelActivity.visible = active && !ring;
      if (active && !ring && this.motionAllowed()) this.panelActivity.play(); else this.panelActivity.stop();
    }
    if (this.button) this.button.accessible_name = downloads.length
      ? `yt-down, ${downloads.length} downloads active, ${this.queue?.queued ?? 0} queued` : this.busy() ? 'yt-down, finding video' : 'yt-down';
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

  private async openMedia(path: string): Promise<void> {
    if (!path) return;
    try { await this.mediaOpener?.open(path); }
    catch (error) { if (this.button) this.setStatus(`Could not open download: ${String(error)}`, true); }
  }

  private openPath(path: string): void {
    if (!path) return;
    void this.launchUri(Gio.File.new_for_path(path).get_uri()).catch(error => {
      if (this.button) this.setStatus(`Could not open download: ${String(error)}`, true);
    });
  }

  private launchUri(uri: string): Promise<void> {
    return new Promise((resolve, reject) => {
      Gio.AppInfo.launch_default_for_uri_async(uri, global.create_app_launch_context(0, -1), null, (_source, result) => {
        try { Gio.AppInfo.launch_default_for_uri_finish(result); resolve(); }
        catch (error) { reject(error); }
      });
    });
  }

  private clearDebounce(): void {
    if (this.debounce) { GLib.Source.remove(this.debounce); this.debounce = 0; }
  }

  disable(): void {
    this.clearDebounce();
    if (this.focusSignal) { global.stage.disconnect(this.focusSignal); this.focusSignal = 0; }
    this.mediaOpener?.destroy();
    this.mediaOpener = undefined;
    this.backend?.destroy();
    this.backend = undefined;
    this.queue?.stop();
    for (const job of this.jobs) { job.sizeQuery?.cancel(); job.backend?.destroy(); job.fill.remove_all_transitions(); }
    this.jobs = []; this.queue = undefined;
    if (this.limitSignal) { this.settings?.disconnect(this.limitSignal); this.limitSignal = 0; }
    this.skeleton?.remove_all_transitions();
    this.videoInfo?.remove_all_transitions();
    this.formats?.actor.remove_all_transitions();
    this.activity?.stop();
    this.panelActivity?.stop();
    this.button?.destroy();
    this.button = undefined;
    this.settings = undefined;
    this.entry = undefined;
    this.searchButton = undefined;
    this.cancelButton = undefined;
    this.status = undefined;
    this.statusRow = undefined;
    this.inputError = undefined;
    this.activity = undefined;
    this.panelActivity = undefined;
    this.panelIcon = undefined;
    this.panelRing = undefined;
    this.videoInfo = undefined;
    this.urlField = undefined;
    this.moreHint = undefined;
    this.title = undefined;
    this.skeleton = undefined;
    this.formats = undefined;
    this.more = undefined;
    this.jobsBox = undefined;
    this.jobsScroll = undefined;
    this.jobsHeading = undefined;
    this.phase = 'idle';
    this.pendingAutoDownload = false;
    this.loadedUrl = '';
    this.lastClipboard = '';
  }
}
