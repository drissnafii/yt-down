#!@GJS@ -m
// Standalone GJS worker: metadata, subprocess I/O and retries stay outside Shell.
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import { formatChoices } from '../../src/format-model.js';
import { normalizeVideoUrl } from '../../src/utils.js';
import { getVideoInfo, download, type DownloadRequest } from './download-controller.js';
import { cancelled, emit, readLine } from './ytdlp-adapter.js';

const loop = new GLib.MainLoop(null, false);
// The standalone worker also runs in CI with an older GJS/GLib than Shell 51.
type SignalAdd = (priority: number, signal: number, callback: () => boolean) => number;
let signalAdd: SignalAdd;
try {
  signalAdd = (imports.gi as unknown as { GLibUnix: { signal_add: SignalAdd } }).GLibUnix.signal_add;
  if (typeof signalAdd !== 'function') throw new Error('Legacy Unix signal API');
}
catch { signalAdd = (GLib as unknown as { unix_signal_add: SignalAdd }).unix_signal_add; }
const signals = [2, 15].map(signal => signalAdd(GLib.PRIORITY_DEFAULT, signal, () => {
  cancelled.cancel(); return GLib.SOURCE_CONTINUE;
}));

async function main(): Promise<void> {
  try {
    const [command, input, mode, id, directory] = ARGV;
    const url = normalizeVideoUrl(input ?? '');
    if (!url) throw new Error('Enter a valid HTTP or HTTPS video link.');
    if (command === 'download') {
      await download({ url, mode, id, directory });
      return;
    }
    if (command !== 'formats') throw new Error('Expected formats or download.');
    emit({ type: 'status', message: 'Fetching video details…' });
    const info = await getVideoInfo(url);
    const fetched = GLib.get_monotonic_time();
    emit(formatChoices(info));
    const stdin = new Gio.DataInputStream({ base_stream: new GioUnix.InputStream({ fd: 0, close_fd: false }) });
    try {
      const line = await readLine(stdin, cancelled);
      if (line === null) return;
      const request = JSON.parse(line) as DownloadRequest;
      if (request.url !== url) throw new Error('Download URL does not match the selected video.');
      // Expired snapshots are discarded; URL rejection also triggers fresh extraction.
      await download(request, GLib.get_monotonic_time() - fetched < 5 * 60 * 1000000 ? info : undefined);
    } finally { stdin.close(null); }
  } catch (error) {
    emit(cancelled.is_cancelled() ? { type: 'cancelled', message: 'Cancelled. Partial files kept.' }
      : { type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    for (const signal of signals) GLib.Source.remove(signal);
    loop.quit();
  }
}
GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { void main(); return GLib.SOURCE_REMOVE; });
loop.run();
