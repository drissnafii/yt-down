import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { findTool } from './dependencies.js';

export const cancelled = new Gio.Cancellable();
export const emit = (event: unknown) => print(JSON.stringify(event));
export const checkCancelled = () => { if (cancelled.is_cancelled()) throw new Error('Cancelled'); };

export function readLine(stream: Gio.DataInputStream, cancellable: Gio.Cancellable | null = null): Promise<string | null> {
  return new Promise((resolve, reject) => stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (_stream, result) => {
    try { resolve(stream.read_line_finish_utf8(result)[0]); } catch (error) { reject(error); }
  }));
}

/** Runs outside Shell. Read both pipes and wait asynchronously; bound diagnostic memory. */
export async function runProcess(args: string[], line?: (text: string, source: 'stdout' | 'stderr') => void,
  metadata = false): Promise<{ code: number; stdout: string; stderr: string }> {
  checkCancelled();
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE });
  const home = GLib.get_home_dir();
  launcher.setenv('PATH', `${home}/.local/bin:${home}/.local/share/mise/shims:${GLib.getenv('PATH') ?? '/usr/bin:/bin'}`, true);
  const process = launcher.spawnv(args);
  const signal = cancelled.connect(() => { try { process.send_signal(2); } catch { /* Already exited. */ } });
  const read = async (pipe: Gio.InputStream, source: 'stdout' | 'stderr') => {
    const stream = new Gio.DataInputStream({ base_stream: pipe });
    let output = '';
    try {
      for (;;) {
        const value = await readLine(stream);
        if (value === null) break;
        line?.(value + '\n', source);
        output += value + '\n';
        if (metadata && source === 'stdout' && output.length > 32 * 1024 * 1024) {
          process.force_exit();
          throw new Error('Video metadata exceeds the 32 MiB limit.');
        }
        if (!metadata || source === 'stderr') output = output.slice(-32768);
      }
      return output;
    } finally { stream.close(null); }
  };
  const exited = new Promise<void>((resolve, reject) => process.wait_async(null, (_process, result) => {
    try { process.wait_finish(result); resolve(); } catch (error) { reject(error); }
  }));
  try {
    const results = await Promise.allSettled([read(process.get_stdout_pipe()!, 'stdout'),
      read(process.get_stderr_pipe()!, 'stderr'), exited]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    checkCancelled();
    return { code: process.get_if_exited() ? process.get_exit_status() : 130,
      stdout: (results[0] as PromiseFulfilledResult<string>).value,
      stderr: (results[1] as PromiseFulfilledResult<string>).value };
  } finally { cancelled.disconnect(signal); }
}

export function wait(ms: number): Promise<void> {
  checkCancelled();
  return new Promise((resolve, reject) => {
    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      cancelled.disconnect(signal); resolve(); return GLib.SOURCE_REMOVE;
    });
    const signal = cancelled.connect(() => { GLib.Source.remove(id); reject(new Error('Cancelled')); });
  });
}

function cookieArgs(): string[] {
  const browser = GLib.getenv('YT_DLP_COOKIES');
  if (!browser || browser === 'none') return [];
  if (!['auto', 'zen'].includes(browser)) return ['--cookies-from-browser', browser];
  const home = GLib.get_home_dir();
  const config = GLib.getenv('XDG_CONFIG_HOME') ?? `${home}/.config`;
  const zen = findCookieRoot([`${config}/zen`, `${home}/.zen`, `${home}/.var/app/app.zen_browser.zen/config/zen`,
    `${home}/.var/app/app.zen_browser.zen/.zen`]);
  if (zen) return ['--cookies-from-browser', `firefox:${zen}`];
  if (browser === 'auto') {
    const firefox = findCookieRoot([`${config}/mozilla/firefox`, `${home}/.mozilla/firefox`,
      `${home}/.var/app/org.mozilla.firefox/config/mozilla/firefox`, `${home}/.var/app/org.mozilla.firefox/.mozilla/firefox`,
      `${home}/snap/firefox/common/.mozilla/firefox`]);
    if (firefox) return ['--cookies-from-browser', `firefox:${firefox}`];
  }
  if (browser === 'zen') throw new Error('No Zen cookies database found. Open Zen first or set an explicit Firefox profile.');
  return [];
}

/** Inspect browser profile directories only after explicit cookie opt-in. */
function findCookieRoot(roots: string[]): string | undefined {
  let selected: string | undefined;
  let newest = -Infinity;
  const scan = (path: string, root: string, depth: number) => {
    checkCancelled();
    try {
      const file = Gio.File.new_for_path(`${path}/cookies.sqlite`);
      const info = file.query_info('time::modified,time::modified-usec', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancelled);
      const modified = info.get_attribute_uint64('time::modified') * 1000000 + info.get_attribute_uint32('time::modified-usec');
      if (modified > newest) { newest = modified; selected = root; }
    } catch { checkCancelled(); }
    if (depth >= 3) return;
    try {
      const entries = Gio.File.new_for_path(path).enumerate_children('standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancelled);
      try {
        for (let info = entries.next_file(cancelled); info; info = entries.next_file(cancelled))
          if (info.get_file_type() === Gio.FileType.DIRECTORY) scan(`${path}/${info.get_name()}`, root, depth + 1);
      } finally { entries.close(null); }
    } catch { checkCancelled(); }
  };
  for (const root of roots) scan(root, root, 0);
  return selected;
}

export function baseArgs(): string[] {
  const executable = findTool('yt-dlp', GLib.getenv('YT_DLP_BIN'));
  if (!executable) throw new Error('yt-dlp is missing. Open Settings for installation help.');
  const args = [executable, '--no-playlist', ...cookieArgs()];
  const explicit = GLib.getenv('YT_DLP_JS_RUNTIME');
  if (explicit) args.push('--js-runtimes', explicit);
  else {
    // Bun is intentionally absent: modern Bun is unsupported by yt-dlp's solver.
    for (const [tool, runtime] of [['deno', 'deno'], ['node', 'node'], ['qjs', 'quickjs']]) {
      const path = findTool(tool);
      if (path) args.push('--js-runtimes', `${runtime}:${path}`);
    }
  }
  return args;
}
