import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { findTool } from './dependencies.js';
import type { DownloadRequest } from './download-controller.js';
import type { BackendEvent } from '../../src/protocol.js';

/** One backend invocation. All pipe reads and process waits are asynchronous. */
export class Backend {
  private process: Gio.Subprocess | null = null;
  private cancellable = new Gio.Cancellable();
  private disposed = false;
  private cancelled = false;
  private terminal = false;
  private errorTail = '';
  private killTimer = 0;
  private cacheDirectory = '';
  private onEvent: (event: BackendEvent) => void = () => {};
  private onEnd: () => void = () => {};

  start(argv: string[], onEvent: (event: BackendEvent) => void, onEnd: () => void): void {
    this.onEvent = onEvent; this.onEnd = onEnd;
    const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    this.process = proc;
    const stdout = new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe()! });
    const stderr = new Gio.DataInputStream({ base_stream: proc.get_stderr_pipe()! });
    const consume = (stream: Gio.DataInputStream, isError: boolean): Promise<void> => new Promise(resolve => {
      const read = () => {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, this.cancellable, (_source, result) => {
          try {
            const [line] = stream.read_line_finish_utf8(result);
            if (line === null || this.disposed) { resolve(); return; }
            if (isError) {
              this.errorTail = `${this.errorTail}\n${line}`.slice(-2048);
            } else {
              let event: BackendEvent;
              try { event = JSON.parse(line) as BackendEvent; }
              catch { read(); return; }
              if (['error', 'cancelled', 'complete', 'formats'].includes(event.type)) this.terminal = true;
              this.onEvent(event);
            }
            read();
          } catch (error) {
            if (!this.disposed) this.errorTail = String(error);
            resolve();
          }
        });
      };
      read();
    });
    const exited = new Promise<void>(resolve => proc.wait_async(null, (_source, result) => {
      try { proc.wait_finish(result); }
      catch (error) { this.errorTail = String(error); }
      resolve();
    }));
    void Promise.all([consume(stdout, false), consume(stderr, true), exited]).then(() => {
      if (this.killTimer) { GLib.Source.remove(this.killTimer); this.killTimer = 0; }
      this.process = null;
      this.cleanSnapshot();
      stdout.close(null);
      stderr.close(null);
      if (this.disposed) return;
      if (!this.terminal) {
        this.onEvent(this.cancelled
          ? { type: 'cancelled', message: 'Cancelled. Partial downloads are kept.' }
          : { type: 'error', message: this.errorTail.trim() || 'Backend stopped before returning a result.' });
      }
      this.onEnd();
    }).catch(error => {
      if (!this.disposed) {
        this.onEvent({ type: 'error', message: String(error) });
        this.onEnd();
      }
    });
  }

  download(request: DownloadRequest, onEvent: (event: BackendEvent) => void, onEnd: () => void): void {
    if (!this.process) throw new Error('The video session has ended. Paste the link again.');
    this.onEvent = onEvent; this.onEnd = onEnd; this.terminal = false;
    this.cacheDirectory = GLib.dir_make_tmp('yt-down-info-XXXXXX');
    request = { ...request, cacheDirectory: this.cacheDirectory };
    const stream = this.process.get_stdin_pipe()!;
    stream.write_all_async(new GLib.Bytes(JSON.stringify(request) + '\n').toArray()!, GLib.PRIORITY_DEFAULT,
      this.cancellable, (_stream, result) => {
        try { stream.write_all_finish(result); stream.close(null); }
        catch (error) { if (!this.disposed) this.onEvent({ type: 'error', message: String(error) }); this.cancel(); }
      });
  }

  private signalGroup(signal: 'INT' | 'KILL'): void {
    const pid = this.process?.get_identifier();
    if (!pid || !/^\d+$/.test(pid)) return;
    // No shell interpolation. The session contains the worker and every media child.
    // The group may not exist yet if unload races setsid startup. Direct force_exit
    // below covers that case; suppress only the kill helper's expected ESRCH text.
    const kill = Gio.Subprocess.new([findTool('kill')!, `-${signal}`, '--', `-${pid}`], Gio.SubprocessFlags.STDERR_SILENCE);
    kill.wait_async(null, (_process, result) => { try { kill.wait_finish(result); } catch { /* Already exited. */ } });
  }

  private cleanSnapshot(): void {
    const directory = this.cacheDirectory;
    this.cacheDirectory = '';
    if (!directory) return;
    const folder = Gio.File.new_for_path(directory);
    // Also remove metadata after a forced kill, where worker finally blocks cannot run.
    folder.get_child('video.info.json').delete_async(GLib.PRIORITY_DEFAULT, null, (file, result) => {
      try { (file as Gio.File).delete_finish(result); } catch { /* Worker normally removes it. */ }
      folder.delete_async(GLib.PRIORITY_DEFAULT, null, (_folder, result) => {
        try { folder.delete_finish(result); } catch { /* Already removed. */ }
      });
    });
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.signalGroup('INT');
    if (this.process) this.killTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
      this.killTimer = 0; this.signalGroup('KILL'); this.process?.force_exit(); return GLib.SOURCE_REMOVE;
    });
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onEvent = () => {};
    this.onEnd = () => {};
    if (this.killTimer) { GLib.Source.remove(this.killTimer); this.killTimer = 0; }
    // Unloading cannot leave a delayed timer retaining UI callbacks. User cancel
    // remains graceful; destruction immediately terminates the entire group.
    this.signalGroup('KILL');
    this.process?.force_exit();
    this.cancellable.cancel();
  }
}
