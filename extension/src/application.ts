import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { Backend } from './client.js';
import { workerCommand, setupMessage } from './dependencies.js';
import { PopupView } from './popup-view.js';
import { DownloadManager } from './download-manager.js';
import { MediaOpener } from './media.js';
import { automaticChoice } from './choices.js';
import { normalizeVideoUrl } from '../../src/utils.js';
import type { BackendEvent, DownloadChoice } from '../../src/protocol.js';

/** Coordinates input/discovery, the popup and the download manager. */
export class Application {
  readonly view: PopupView;
  readonly downloads: DownloadManager;
  readonly mediaOpener: MediaOpener;
  backend?: Backend;
  private loadedUrl = '';
  private lastClipboard = '';
  private debounce = 0;
  private suppressEntry = false;
  private pendingAutoDownload = false;
  private disposed = false;

  constructor(readonly settings: Gio.Settings, private path: string, readonly openPreferences: () => void) {
    this.view = new PopupView({ search: () => this.fetchFormats(), input: () => this.onInput(),
      cancel: () => { this.backend?.cancel(); this.view.setStatus('Cancelling…'); this.view.cancelButton.reactive = false; },
      choose: choice => this.download(choice), preferences: openPreferences, opened: () => this.onOpen() });
    this.mediaOpener = new MediaOpener(uri => this.launchUri(uri));
    this.downloads = new DownloadManager(settings, this.view.jobsBox, {
      changed: () => this.syncDownloads(), isOpen: () => this.view.isOpen(),
      file: path => { void this.openMedia(path); }, folder: path => this.openPath(path),
    });
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true; this.clearDebounce();
    this.backend?.destroy(); this.backend = undefined;
    this.downloads.destroy(); this.mediaOpener.destroy(); this.view.destroy();
  }
  private onOpen(): void {
    if (this.disposed) return;
    this.downloads?.updateActions();
    if (!this.view.isOpen()) return;
    const setup = setupMessage();
    if (setup) this.view.setStatus(setup, true); else this.checkClipboard();
  }
  private resetDiscovery(): void {
    this.clearDebounce(); this.backend?.destroy(); this.backend = undefined;
    this.loadedUrl = ''; this.pendingAutoDownload = false;
    this.view.clearFormats(); this.view.setPhase('idle'); this.view.setStatus('');
  }
  private onInput(): void {
    if (this.suppressEntry || this.view.busy()) return;
    this.resetDiscovery();
    if (normalizeVideoUrl(this.view.entry.get_text())) this.debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
      this.debounce = 0; this.fetchFormats(this.settings.get_boolean('download-on-paste')); return GLib.SOURCE_REMOVE;
    });
  }
  private checkClipboard(): void {
    if (this.view.busy() || !this.settings.get_boolean('clipboard-autofetch')) return;
    const entry = this.view.entry;
    const current = entry.get_text();
    if (current && normalizeVideoUrl(current) !== this.loadedUrl) return;
    St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
      if (this.disposed || !this.view.isOpen() || this.view.busy() || entry.get_text() !== current) return;
      const url = normalizeVideoUrl(text ?? '');
      if (!url || url === this.lastClipboard || (url === this.loadedUrl && this.view.phase !== 'idle')) return;
      this.lastClipboard = url; this.setEntry(url); this.resetDiscovery();
    });
  }
  private setEntry(value: string): void {
    this.suppressEntry = true; this.view.entry.set_text(value); this.suppressEntry = false;
  }
  private clear(): void {
    if (this.view.busy()) return;
    this.setEntry(''); this.resetDiscovery(); this.view.entry.grab_key_focus();
  }
  private fetchFormats(autoDownload = false): void {
    if (this.disposed || this.view.busy()) return;
    this.clearDebounce();
    const url = normalizeVideoUrl(this.view.entry.get_text());
    const error = !url ? 'Enter a valid HTTP or HTTPS video link.' : setupMessage();
    if (error) { this.view.setPhase('error'); this.view.setStatus(error, true); return; }
    this.resetDiscovery(); this.pendingAutoDownload = autoDownload; this.loadedUrl = url!; this.setEntry(url!);
    this.view.setPhase('searching'); this.view.setStatus('Finding your video…');
    try {
      const backend = new Backend(); this.backend = backend;
      backend.start(workerCommand(this.path, 'formats', url!), event => {
        if (!this.disposed && this.backend === backend) this.onEvent(event);
      }, () => { if (this.backend === backend) this.backend = undefined; });
    } catch (error) {
      this.backend?.destroy(); this.backend = undefined; this.view.setPhase('error'); this.view.setStatus(String(error), true);
    }
  }
  private onEvent(event: BackendEvent): void {
    if (event.type === 'formats') {
      const previous = this.settings.get_string('last-choice'); this.view.renderFormats(event, previous);
      const automatic = this.pendingAutoDownload; this.pendingAutoDownload = false;
      if (automatic && this.settings.get_boolean('download-on-paste')) {
        const choice = automaticChoice(event.choices, previous); if (choice) this.download(choice);
      }
    } else if (event.type === 'status') this.view.setStatus(event.message);
    else if (event.type === 'cancelled') { this.view.setPhase('idle'); this.view.setStatus(''); }
    else if (event.type === 'error') { this.view.setPhase('error'); this.view.setStatus(event.message, true); }
  }
  private download(choice: DownloadChoice): void {
    if (this.view.busy() || !this.loadedUrl || !this.backend) return;
    try {
      this.downloads.add(this.loadedUrl, this.view.title.text, choice, this.backend);
      this.backend = undefined; // Prepared metadata session now belongs to the job.
      this.view.releaseInput(); this.loadedUrl = ''; this.setEntry(''); this.view.setPhase('idle'); this.view.setStatus('');
      this.view.entry.grab_key_focus();
    } catch (error) { this.view.setStatus(String(error), true); }
  }
  private syncDownloads(): void {
    if (this.disposed) return;
    const active = this.downloads.jobs.filter(job => ['active', 'cancelling'].includes(job.state));
    const percent = active.some(job => job.percent !== null) ? active.reduce((sum, job) => sum + (job.percent ?? 0), 0) / active.length : null;
    this.view.updateDownloads(active.length, this.downloads.queue.queued, this.downloads.jobs.length, percent);
  }
  private async openMedia(path: string): Promise<void> {
    if (!path) return;
    try { await this.mediaOpener.open(path); }
    catch (error) { if (!this.disposed) this.view.setStatus(`Could not open download: ${String(error)}`, true); }
  }
  private openPath(path: string): void {
    if (path) void this.launchUri(Gio.File.new_for_path(path).get_uri()).catch(error => {
      if (!this.disposed) this.view.setStatus(`Could not open download: ${String(error)}`, true);
    });
  }
  private launchUri(uri: string): Promise<void> {
    return new Promise((resolve, reject) => {
      Gio.AppInfo.launch_default_for_uri_async(uri, global.create_app_launch_context(0, -1), null, (_source, result) => {
        try { Gio.AppInfo.launch_default_for_uri_finish(result); resolve(); } catch (error) { reject(error); }
      });
    });
  }
  private clearDebounce(): void { if (this.debounce) { GLib.Source.remove(this.debounce); this.debounce = 0; } }
}
