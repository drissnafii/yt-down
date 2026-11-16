import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type { BackendEvent } from '../../src/protocol.js';

/** One backend invocation. All pipe reads and process waits are asynchronous. */
export class Backend {
  private process: Gio.Subprocess | null = null;
  private cancellable = new Gio.Cancellable();
  private disposed = false;
  private cancelled = false;
  private terminal = false;
  private errorTail = '';

  start(argv: string[], onEvent: (event: BackendEvent) => void, onEnd: () => void): void {
    const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
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
              onEvent(event);
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
      this.process = null;
      stdout.close(null);
      stderr.close(null);
      if (this.disposed) return;
      if (!this.terminal) {
        onEvent(this.cancelled
          ? { type: 'cancelled', message: 'Cancelled. Partial downloads are kept.' }
          : { type: 'error', message: this.errorTail.trim() || 'Backend stopped before returning a result.' });
      }
      onEnd();
    }).catch(error => {
      if (!this.disposed) {
        onEvent({ type: 'error', message: String(error) });
        onEnd();
      }
    });
  }

  cancel(): void {
    this.cancelled = true;
    this.process?.send_signal(15);
  }

  destroy(): void {
    this.disposed = true;
    this.cancel();
    this.cancellable.cancel();
  }
}

export function findBun(configured: string): string {
  if (configured.trim()) return configured.trim();
  const home = GLib.get_home_dir();
  // GNOME sessions often lack the PATH additions from interactive shell startup.
  for (const candidate of [
    GLib.find_program_in_path('bun'),
    `${home}/.local/share/mise/shims/bun`,
    `${home}/.local/bin/bun`,
    `${home}/.bun/bin/bun`,
  ]) {
    if (candidate && GLib.file_test(candidate, GLib.FileTest.IS_EXECUTABLE)) return candidate;
  }
  throw new Error('Bun was not found. Set its absolute path in yt-down Settings.');
}
