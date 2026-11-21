import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { column, icon, label, motionAllowed } from './widgets.js';
import { choiceLabel } from './choices.js';
import { formatBytes, formatDuration } from '../../src/utils.js';
import type { DownloadChoice } from '../../src/protocol.js';

/** Owns one job card, its file-size query, hover actions and transitions. */
export class DownloadView {
  readonly card = column('yt-down-download');
  readonly summary = new St.BoxLayout({ style_class: 'yt-down-job-summary' });
  readonly header = new St.BoxLayout({ style_class: 'yt-down-job-header' });
  readonly size = label('—', 'yt-down-job-size');
  readonly label = label('Queued', 'yt-down-secondary');
  readonly detail = label('Waiting for a download slot…', 'yt-down-secondary', true);
  readonly progress = new St.Widget({ style_class: 'yt-down-progress', x_expand: true });
  readonly fill = new St.Widget({ style_class: 'yt-down-progress-fill', width: 0 });
  readonly cancel = new St.Button({ can_focus: true, style_class: 'yt-down-clear' });
  readonly actions = new St.BoxLayout({ style_class: 'yt-down-completion', visible: false });
  readonly openFile: St.Button;
  private sizeQuery?: Gio.Cancellable;
  private disposed = false;
  private complete = false;
  private percent: number | null = null;

  constructor(private title: string, private choice: DownloadChoice, private isOpen: () => boolean,
    callbacks: { cancel(): void; file(): void; folder(): void }) {
    this.card.reactive = true; this.card.track_hover = true;
    const name = label(title, 'yt-down-job-title'); name.min_width = 0; name.natural_width = 0;
    this.size.x_expand = false; this.size.visible = false;
    this.summary.add_child(name); this.summary.add_child(this.size); this.card.add_child(this.summary);
    this.cancel.accessible_name = `Cancel ${title}`; this.cancel.set_child(icon('process-stop-symbolic', 14));
    this.header.add_child(this.label); this.header.add_child(this.cancel); this.card.add_child(this.header);
    this.progress.add_child(this.fill); this.card.add_child(this.progress); this.card.add_child(this.detail);
    this.openFile = this.action('media-playback-start-symbolic', 'Open file', callbacks.file);
    this.actions.add_child(this.openFile); this.actions.add_child(this.action('folder-open-symbolic', 'Open folder', callbacks.folder));
    this.summary.add_child(this.actions);
    this.card.connect('notify::hover', () => this.updateActions());
    this.cancel.connect('clicked', callbacks.cancel);
    this.progress.connect('notify::width', () => this.updateProgress());
  }

  destroy(): void {
    this.disposed = true; this.sizeQuery?.cancel(); this.fill.remove_all_transitions(); this.card.destroy();
  }
  connecting(): void { this.label.text = `${choiceLabel(this.choice)} · Connecting…`; this.detail.text = 'Starting download…'; }
  status(text: string): void { this.detail.text = text; }
  cancelling(): void { this.detail.text = 'Cancelling…'; this.cancel.reactive = false; }
  failed(message: string): void { this.label.text = 'Download failed'; this.detail.text = message; this.cancel.reactive = false; }
  cancelled(): void { this.label.text = 'Cancelled'; this.detail.text = 'Partial files kept for resuming.'; this.cancel.reactive = false; }
  progressEvent(percent: number | null, speed: number | null, eta: number | null): void {
    this.percent = percent;
    this.label.text = `${choiceLabel(this.choice)} · ${percent === null ? 'Downloading' : `${Math.floor(percent)}%`}`;
    this.detail.text = [speed === null ? '' : `${(speed / 1024 / 1024).toFixed(1)} MiB/s`,
      eta === null ? '' : `${formatDuration(Math.ceil(eta))} left`].filter(Boolean).join(' · ') || 'Downloading…';
    this.updateProgress();
  }
  saved(path: string): void {
    this.complete = true;
    this.header.visible = this.progress.visible = this.detail.visible = false;
    this.card.add_style_class_name('yt-down-finished'); this.card.can_focus = true;
    this.openFile.visible = Boolean(path); this.cancel.reactive = false;
    this.header.remove_child(this.cancel); this.actions.add_child(this.cancel); this.updateActions();
    if (!path) return;
    this.sizeQuery = new Gio.Cancellable();
    Gio.File.new_for_path(path).query_info_async('standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT,
      this.sizeQuery, (file, result) => {
        try {
          const info = (file as Gio.File).query_info_finish(result);
          if (this.disposed) return;
          this.size.text = formatBytes(info.get_size());
          this.card.accessible_name = `${this.title}, saved, ${this.size.text}. Focus to show file actions.`;
        } catch { /* Keep unknown size when a file is moved or the view is destroyed. */ }
      });
  }
  finished(): void {
    this.cancel.set_child(icon('window-close-symbolic', 14)); this.cancel.accessible_name = `Dismiss ${this.title}`;
    this.cancel.reactive = true;
    if (this.complete) this.cancel.add_style_class_name('yt-down-row-action');
  }
  updateActions(): void {
    if (!this.complete || this.disposed) return;
    const focus = global.stage.get_key_focus();
    const reveal = this.isOpen() && (this.card.hover || Boolean(focus && this.card.contains(focus)));
    this.actions.visible = reveal; this.size.visible = !reveal;
  }
  private updateProgress(): void {
    if (this.disposed) return;
    this.fill.remove_all_transitions();
    const width = this.progress.width * (this.percent ?? 0) / 100;
    if (this.isOpen() && motionAllowed()) this.fill.ease({ width, duration: 180 }); else this.fill.width = width;
    this.progress.accessible_name = this.percent === null ? 'Download size unknown' : `${Math.floor(this.percent)} percent downloaded`;
  }
  private action(name: string, title: string, activate: () => void): St.Button {
    const button = new St.Button({ can_focus: true, accessible_name: title, style_class: 'yt-down-row-action' });
    button.set_child(icon(name, 16)); button.connect('clicked', activate); return button;
  }
}
