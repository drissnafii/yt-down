import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Backend } from './client.js';
import { TaskQueue } from './queue.js';
import { DownloadView } from './download-view.js';
import { choiceKey } from './choices.js';
import { downloadRequirement } from './dependencies.js';
import type { BackendEvent, DownloadChoice } from '../../src/protocol.js';

export interface DownloadJob {
  url: string; title: string; choice: DownloadChoice; directory: string;
  state: 'queued' | 'active' | 'cancelling' | 'complete' | 'cancelled' | 'error';
  percent: number | null; filePath: string; backend?: Backend; view: DownloadView;
}
interface Callbacks { changed(): void; isOpen(): boolean; file(path: string): void; folder(path: string): void }

/** Owns jobs, queue slots, prepared workers, and settings/focus subscriptions. */
export class DownloadManager {
  jobs: DownloadJob[] = [];
  readonly queue: TaskQueue<DownloadJob>;
  private limitSignal: number;
  private focusSignal: number;
  private disposed = false;

  constructor(private settings: Gio.Settings, private container: St.BoxLayout, private callbacks: Callbacks) {
    this.queue = new TaskQueue(settings.get_int('parallel-downloads'), (job, done) => this.start(job, done));
    this.limitSignal = settings.connect('changed::parallel-downloads', () => {
      this.queue.setLimit(settings.get_int('parallel-downloads')); callbacks.changed();
    });
    this.focusSignal = global.stage.connect('notify::key-focus', () => this.updateActions());
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.settings.disconnect(this.limitSignal); global.stage.disconnect(this.focusSignal);
    this.queue.stop();
    for (const job of this.jobs) { job.backend?.destroy(); job.backend = undefined; job.view.destroy(); }
    this.jobs = [];
  }
  add(url: string, title: string, choice: DownloadChoice, backend: Backend): void {
    const requirement = downloadRequirement(choice);
    if (requirement) throw new Error(requirement);
    const requested = this.settings.get_string('output-directory').trim() || GLib.build_filenamev([
      GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ?? `${GLib.get_home_dir()}/Videos`, 'yt-down']);
    if (!GLib.path_is_absolute(requested)) throw new Error('Set an absolute download folder in Settings.');
    const directory = GLib.canonicalize_filename(requested, null);
    if (this.jobs.some(job => job.url === url && job.directory === directory && job.choice.mode === choice.mode
      && job.choice.id === choice.id && ['queued', 'active', 'cancelling'].includes(job.state)))
      throw new Error('That download is already running or queued.');
    this.settings.set_string('last-choice', choiceKey(choice));
    let job: DownloadJob;
    const view = new DownloadView(title, choice, this.callbacks.isOpen, {
      cancel: () => this.cancel(job), file: () => this.callbacks.file(job.filePath), folder: () => this.callbacks.folder(job.directory),
    });
    job = { url, title, choice, directory, state: 'queued', percent: null, filePath: '', backend, view };
    this.jobs.push(job); this.container.add_child(view.card);
    this.queue.add(job, `${directory}\0${url}`); this.callbacks.changed();
  }
  updateActions(): void { for (const job of this.jobs) job.view.updateActions(); }
  cancel(job: DownloadJob): void {
    if (job.state === 'queued') { this.queue.remove(job); this.dismiss(job); }
    else if (job.state === 'active') { job.state = 'cancelling'; job.view.cancelling(); job.backend?.cancel(); }
    else if (job.state !== 'cancelling' && !job.backend) this.dismiss(job);
    this.callbacks.changed();
  }
  private dismiss(job: DownloadJob): void {
    this.jobs = this.jobs.filter(item => item !== job); job.backend?.destroy(); job.backend = undefined; job.view.destroy();
  }
  private start(job: DownloadJob, done: () => void): void {
    job.state = 'active'; job.view.connecting();
    try {
      if (!job.backend) throw new Error('The video session has ended. Paste the link again.');
      job.backend.download({ url: job.url, mode: job.choice.mode, id: job.choice.id, directory: job.directory },
        event => this.onEvent(job, event), () => {
          if (this.disposed) return;
          job.backend = undefined; job.view.finished();
          for (const older of this.jobs.filter(item => !item.backend && ['complete', 'error', 'cancelled'].includes(item.state)).slice(0, -5)) this.dismiss(older);
          done(); this.callbacks.changed();
        });
    } catch (error) {
      job.backend?.destroy(); job.backend = undefined;
      this.onEvent(job, { type: 'error', message: String(error) }); job.view.finished(); done();
    }
    this.callbacks.changed();
  }
  private onEvent(job: DownloadJob, event: BackendEvent): void {
    if (this.disposed || !['active', 'cancelling'].includes(job.state)) return;
    switch (event.type) {
      case 'progress':
        if (job.state !== 'cancelling') { job.percent = event.percent; job.view.progressEvent(event.percent, event.speed, event.eta); }
        break;
      case 'status': if (job.state !== 'cancelling') job.view.status(event.message); break;
      case 'file': job.filePath = event.path; break;
      case 'complete':
        job.state = 'complete'; job.percent = 100; job.directory = event.directory; job.view.saved(job.filePath);
        Main.notify('DownDev', `Saved: ${job.title}`); break;
      case 'cancelled': job.state = 'cancelled'; job.view.cancelled(); break;
      case 'error': job.state = 'error'; job.view.failed(event.message); Main.notifyError('DownDev', `${job.title}: ${event.message}`); break;
      case 'formats': break;
    }
    this.callbacks.changed();
  }
}
