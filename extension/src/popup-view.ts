import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { column, icon, label, motionAllowed } from './widgets.js';
import { choiceKey, choiceLabel, qualityBadge, groupChoices, higherQualityHint } from './choices.js';
import type { BackendEvent, DownloadChoice } from '../../src/protocol.js';

export type Phase = 'idle' | 'searching' | 'ready' | 'error';
interface Callbacks { search(): void; input(): void; cancel(): void; choose(choice: DownloadChoice): void; preferences(): void; opened(): void }

/** Owns the popup/panel actors, presentation state, and their animations. */
export class PopupView {
  readonly button: PanelMenu.Button;
  entry!: St.Entry;
  searchButton!: St.Button;
  cancelButton!: St.Button;
  status!: St.Label;
  statusRow!: St.BoxLayout;
  inputError!: St.Label;
  activity!: Animation.Spinner;
  panelActivity!: Animation.Spinner;
  panelIcon!: St.Icon;
  panelRing!: St.DrawingArea;
  videoInfo!: St.BoxLayout;
  urlField!: St.Widget;
  moreHint!: St.Label;
  title!: St.Label;
  skeleton!: St.BoxLayout;
  formats!: PopupMenu.PopupMenuSection;
  more!: PopupMenu.PopupSubMenuMenuItem;
  jobsBox!: St.BoxLayout;
  jobsScroll!: St.ScrollView;
  jobsHeading!: St.Label;
  phase: Phase = 'idle';
  percent: number | null = null;
  private active = 0;
  private queued = 0;
  private disposed = false;

  constructor(private callbacks: Callbacks) {
    this.button = new PanelMenu.Button(0.0, 'yt-down');
    const menu = this.button.menu as PopupMenu.PopupMenu;
    menu.actor.add_style_class_name('yt-down-popup');

    const panel = new St.Widget({ layout_manager: new Clutter.BinLayout(), width: 24, height: 24,
      y_align: Clutter.ActorAlign.CENTER });
    this.panelIcon = icon('folder-download-symbolic');
    this.panelActivity = new Animation.Spinner(18);
    this.panelActivity.visible = false;
    this.panelRing = new St.DrawingArea({ width: 24, height: 24, visible: false });
    this.panelRing.connect('repaint', () => this.drawRing());
    panel.add_child(this.panelIcon);
    panel.add_child(this.panelActivity);
    panel.add_child(this.panelRing);
    this.button.add_child(panel);

    // Add content directly: nonreactive PopupBaseMenuItems inherit a dimmed text style.
    const content = column('yt-down-content');
    menu.box.add_child(content);
    const header = new St.BoxLayout({ style_class: 'yt-down-header' });
    header.add_child(label('yt-down', 'yt-down-heading'));
    const settings = new St.Button({ can_focus: true, accessible_name: 'Settings', style_class: 'yt-down-icon-button' });
    settings.set_child(icon('emblem-system-symbolic'));
    settings.connect('clicked', () => { this.button?.menu.close(); this.callbacks.preferences(); });
    header.add_child(settings);
    content.add_child(header);

    const input = new St.BoxLayout({ style_class: 'yt-down-input' });
    this.urlField = new St.Widget({ layout_manager: new Clutter.BinLayout(), style_class: 'yt-down-url-field', x_expand: true,
      min_width: 0, natural_width: 0, clip_to_allocation: true });
    this.entry = new St.Entry({ min_width: 0, natural_width: 0, hint_text: 'Paste a video link…', can_focus: true, x_expand: true,
      accessible_name: 'Video URL', style_class: 'yt-down-entry' });
    this.entry.clutter_text.min_width = 0;
    this.entry.clutter_text.natural_width = 0;
    this.entry.clutter_text.connect('activate', () => this.callbacks.search());
    this.entry.clutter_text.connect('text-changed', () => this.callbacks.input());
    this.urlField.add_child(this.entry);
    this.inputError = label('', 'yt-down-input-error');
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
    this.searchButton.set_child(icon('go-next-symbolic', 20));
    this.searchButton.connect('clicked', () => this.callbacks.search());
    input.add_child(this.searchButton);
    content.add_child(input);

    this.skeleton = column('yt-down-skeleton');
    this.skeleton.visible = false;
    for (const width of [300, 220, 260]) {
      this.skeleton.add_child(new St.Widget({ style_class: 'yt-down-skeleton-line', width,
        x_align: Clutter.ActorAlign.START }));
    }
    content.add_child(this.skeleton);

    this.videoInfo = column('yt-down-video-info');
    this.videoInfo.visible = false;
    this.title = label('', 'yt-down-title');
    this.videoInfo.add_child(this.title);
    content.add_child(this.videoInfo);

    this.formats = new PopupMenu.PopupMenuSection();
    (this.formats.actor as St.BoxLayout).add_style_class_name('yt-down-choices');
    menu.addMenuItem(this.formats);
    this.more = new PopupMenu.PopupSubMenuMenuItem('Show more', false);
    this.moreHint = label('', 'yt-down-quality-hint');
    this.moreHint.x_expand = false;
    this.more.insert_child_below(this.moreHint, this.more.get_last_child());
    this.more.add_style_class_name('yt-down-more');
    this.more.visible = false;
    menu.addMenuItem(this.more);

    const footer = column('yt-down-footer');
    menu.box.add_child(footer);
    this.statusRow = new St.BoxLayout({ style_class: 'yt-down-status-row', visible: false });
    this.activity = new Animation.Spinner(18);
    this.activity.visible = false;
    this.status = label('', 'yt-down-status', true);
    this.cancelButton = new St.Button({ label: 'Cancel', can_focus: true, accessible_name: 'Cancel current task',
      style_class: 'yt-down-cancel', visible: false });
    this.cancelButton.connect('clicked', () => {
      this.callbacks.cancel();
      this.setStatus('Cancelling…');
      if (this.cancelButton) this.cancelButton.reactive = false;
    });
    this.statusRow.add_child(this.activity);
    this.statusRow.add_child(this.status);
    this.statusRow.add_child(this.cancelButton);
    footer.add_child(this.statusRow);
    this.jobsHeading = label('', 'yt-down-secondary');
    this.jobsHeading.visible = false;
    footer.add_child(this.jobsHeading);
    this.jobsBox = column('yt-down-jobs');
    this.jobsScroll = new St.ScrollView({ style_class: 'yt-down-jobs-scroll', overlay_scrollbars: true,
      hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC, visible: false });
    this.jobsScroll.set_child(this.jobsBox);
    footer.add_child(this.jobsScroll);

    menu.connect('open-state-changed', (_menu, open: boolean) => {
      this.syncMotion();
      this.callbacks.opened();
    });
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.skeleton.remove_all_transitions();
    this.videoInfo.remove_all_transitions();
    this.formats.actor.remove_all_transitions();
    this.activity.stop();
    this.panelActivity.stop();
    this.button.destroy();
  }

  isOpen(): boolean { return (this.button.menu as PopupMenu.PopupMenu).isOpen; }
  busy(): boolean { return this.phase === 'searching'; }
  motionAllowed(): boolean { return motionAllowed(); }
  clearFormats(): void {
    this.formats.removeAll(); this.more.menu.removeAll(); this.more.visible = false; this.videoInfo.visible = false;
  }
  releaseInput(): void {
    this.formats.actor.visible = false; this.more.menu.close(); this.more.visible = false; this.videoInfo.visible = false;
  }

  renderFormats(event: Extract<BackendEvent, { type: 'formats' }>, previous: string): void {
    this.formats.removeAll(); this.formats.actor.visible = true;
    this.title.text = event.title; this.videoInfo.visible = true;
    const { primary, more } = groupChoices(event.choices);
    for (const choice of primary) this.addChoice(this.formats, choice, previous);
    for (const choice of more) this.addChoice(this.more.menu, choice, previous);
    this.more.visible = more.length > 0;
    this.moreHint.text = higherQualityHint(more, Math.max(1080, ...primary.map(choice => choice.height ?? 0)));
    this.moreHint.visible = Boolean(this.moreHint.text);
    this.setPhase('ready');
    this.setStatus(event.choices.length ? '' : 'No downloadable formats found.', !event.choices.length);
    this.reveal(this.videoInfo); this.reveal(this.formats.actor);
  }

  private addChoice(menu: PopupMenu.PopupMenuBase, choice: DownloadChoice, previous: string): void {
    const row = new PopupMenu.PopupBaseMenuItem({ style_class: 'yt-down-choice', can_focus: true });
    if (choice.mode !== 'video') row.add_child(icon('audio-x-generic-symbolic', 16));
    const name = label(choiceLabel(choice), 'yt-down-choice-label');
    name.x_expand = false;
    row.add_child(name);
    const badge = qualityBadge(choice);
    if (badge) {
      const tag = label(badge, 'yt-down-resolution-tag');
      tag.x_expand = false;
      row.add_child(tag);
    }
    const space = new St.Widget({ x_expand: true });
    row.add_child(space);
    const sizeText = choice.sizeLabel === '~ unknown' || choice.mode === 'mp3' ? '—' : choice.sizeLabel ?? '—';
    const size = label(sizeText, 'yt-down-choice-size');
    size.x_expand = false;
    row.add_child(size);
    const remembered = previous === choiceKey(choice);
    if (remembered) row.add_style_class_name('yt-down-last-used');
    row.accessible_name = `${choiceLabel(choice)}, ${badge}, ${sizeText}${remembered ? ', last used' : ''}`;
    // Avoid menu activation's default close: progress stays visible after choosing.
    row.connect('activate', () => {
      GObject.signal_stop_emission_by_name(row, 'activate');
      this.callbacks.choose(choice);
    });
    menu.addMenuItem(row);
  }

  setPhase(phase: Phase): void {
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

  setStatus(text: string, error = false): void {
    if (this.status) this.status.text = text;
    this.setInputError(error ? text : '');
  }

  setInputError(text: string): void {
    if (!this.entry || !this.inputError) return;
    this.inputError.text = text;
    this.inputError.visible = Boolean(text);
    // Keep the original URL editable beneath the error; typing or clicking reveals it.
    this.entry.opacity = text ? 0 : 255;
    this.entry.accessible_name = text ? `Video URL: ${text}` : 'Video URL';
  }

  syncMotion(): void {
    if (this.disposed) return;
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
        if (!this.disposed && this.skeleton && this.phase === 'searching' && this.isOpen() && this.motionAllowed()) this.pulse(!brighter);
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

  updateDownloads(active: number, queued: number, total: number, percent: number | null): void {
    this.active = active; this.queued = queued; this.percent = percent;
    this.jobsHeading.visible = this.jobsScroll.visible = total > 0;
    this.jobsHeading.text = `${active} downloading · ${queued} queued`;
    this.syncPanel();
  }
  private syncPanel(): void {
    const active = this.active > 0 || this.busy();
    const ring = active && this.percent !== null;
    this.panelIcon.visible = !active;
    this.panelRing.visible = ring; this.panelRing.queue_repaint();
    this.panelActivity.visible = active && !ring;
    if (active && !ring && motionAllowed()) this.panelActivity.play(); else this.panelActivity.stop();
    this.button.accessible_name = this.active ? `yt-down, ${this.active} downloads active, ${this.queued} queued`
      : this.busy() ? 'yt-down, finding video' : 'yt-down';
  }
}
