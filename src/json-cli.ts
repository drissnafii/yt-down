import { homedir } from 'node:os';
import { join } from 'node:path';
import { DownloadCancelledError } from './download-recovery.ts';
import { getVideoInfo, parseVideoFormats, parseAudioFormats, downloadVideo, downloadAudio } from './yt-dlp.ts';
import { isValidYouTubeUrl } from './utils.ts';
import type { BackendEvent } from './protocol.ts';

const emit = (event: BackendEvent) => console.log(JSON.stringify(event));

/** Each stream gets its own parser so interleaved stdout/stderr cannot corrupt lines. */
export function createProgressParser(report: (event: BackendEvent) => void) {
  let pending = '';
  function line(value: string) {
    if (value.startsWith('yt-down-progress:')) {
      try {
        const progress = JSON.parse(value.slice('yt-down-progress:'.length));
        const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
        const downloaded = number(progress.downloaded_bytes);
        const total = number(progress.total_bytes) ?? number(progress.total_bytes_estimate);
        report({ type: 'progress',
          percent: downloaded !== null && total && total > 0 ? Math.min(100, Math.max(0, downloaded / total * 100)) : null,
          speed: number(progress.speed), eta: number(progress.eta) });
      } catch { /* Ignore incomplete or unsupported progress records. */ }
    } else if (value.startsWith('yt-down-file:')) {
      try {
        const path: unknown = JSON.parse(value.slice('yt-down-file:'.length));
        if (typeof path === 'string') report({ type: 'file', path });
      } catch { /* Not a valid output path. */ }
    } else if (/^\[(Merger|ExtractAudio|Fixup\w*)\]/.test(value)) {
      report({ type: 'status', message: 'Finishing media…' });
    }
  }
  return (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/[\r\n]/);
    pending = lines.pop()!.slice(-65_536);
    for (const value of lines) line(value);
  };
}

export async function runJsonCommand(args: string[]): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const [command, input, mode, formatId, output] = args;
    if (command !== 'formats' && command !== 'download') throw new Error('Expected formats or download.');
    if (!input || !isValidYouTubeUrl(input)) throw new Error('Enter a valid YouTube video URL.');
    if (command === 'formats' && args.length !== 2) throw new Error('Usage: --json formats URL');
    if (command === 'download' && (args.length < 4 || args.length > 5 || !['video', 'audio'].includes(mode!)
      || !formatId || !/^(?:best|\w[\w.-]*(?:\+\w[\w.-]*)*)$/.test(formatId))) {
      throw new Error('Usage: --json download URL video|audio FORMAT_ID [OUTPUT_DIR]');
    }
    const url = /^https?:\/\//.test(input.trim()) ? input.trim() : `https://${input.trim()}`;
    emit({ type: 'status', message: 'Fetching video details…' });
    const info = await getVideoInfo(url, controller.signal);
    if (controller.signal.aborted) throw new DownloadCancelledError();
    if (command === 'formats') {
      const videos = parseVideoFormats(info);
      const audio = parseAudioFormats(info);
      emit({ type: 'formats', title: info.title, channel: info.channel ?? '', duration: info.duration,
        choices: [
          ...(videos.length ? [{ id: 'best', mode: 'video' as const, label: 'Best available video + audio' }] : []),
          ...videos.map(f => ({ id: f.formatId, mode: 'video' as const, label: f.displayLabel })),
          ...audio.map(f => ({ id: f.formatId, mode: 'audio' as const, label: `Audio only · ${f.displayLabel}` })),
        ] });
      return;
    }
    const directory = output ?? join(homedir(), 'Videos', 'yt-down');
    const download = mode === 'audio' ? downloadAudio : downloadVideo;
    const selected = formatId === 'best' ? 'bestvideo+bestaudio/best' : formatId!;
    emit({ type: 'status', message: 'Starting download…' });
    const parsers = { stdout: createProgressParser(emit), stderr: createProgressParser(emit) };
    await download(url, selected, directory, info, {
      signal: controller.signal,
      onOutput: (text, stream) => parsers[stream](text),
      onRetry: message => emit({ type: 'status', message: message.replace(' Press Ctrl+C to cancel.', '') }),
    });
    emit({ type: 'complete', directory });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (controller.signal.aborted || error instanceof DownloadCancelledError) {
      emit({ type: 'cancelled', message: 'Cancelled. Partial files kept; select the same quality to resume.' });
      process.exitCode = 130;
    } else {
      emit({ type: 'error', message });
      process.exitCode = 1;
    }
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
