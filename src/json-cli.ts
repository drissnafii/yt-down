import { getOutputDirectory } from './output-directory.ts';
import { DownloadCancelledError } from './download-recovery.ts';
import { getVideoInfo, parseVideoFormats, parseAudioFormats, downloadVideo, downloadAudio, downloadMp3 } from './yt-dlp.ts';
import { normalizeYouTubeUrl } from './utils.ts';
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
    const url = input ? normalizeYouTubeUrl(input) : null;
    if (!url) throw new Error('Enter a valid YouTube video URL.');
    if (command === 'formats' && args.length !== 2) throw new Error('Usage: --json formats URL');
    if (command === 'download' && (args.length < 4 || args.length > 5 || !['video', 'audio', 'mp3'].includes(mode!)
      || !formatId || !/^(?:best|\w[\w.-]*(?:\+\w[\w.-]*)*)$/.test(formatId))) {
      throw new Error('Usage: --json download URL video|audio|mp3 FORMAT_ID [OUTPUT_DIR]');
    }
    emit({ type: 'status', message: 'Fetching video details…' });
    const info = await getVideoInfo(url, controller.signal);
    if (controller.signal.aborted) throw new DownloadCancelledError();
    if (command === 'formats') {
      const videos = parseVideoFormats(info);
      const audio = parseAudioFormats(info);
      emit({ type: 'formats', title: info.title, channel: info.channel ?? '', duration: info.duration, thumbnail: info.thumbnail,
        choices: [
          ...(videos.length ? [{ id: 'best', mode: 'video' as const, label: 'Best quality', sizeLabel: 'Auto' }] : []),
          ...videos.map(f => ({ id: f.formatId, mode: 'video' as const, label: f.resolution, height: f.height, fps: f.fps,
            sizeLabel: f.filesizeLabel, variant: f.variant })),
          ...(audio.length ? [{ id: 'best', mode: 'mp3' as const, label: 'Audio only', sizeLabel: 'MP3' }] : []),
          ...audio.map(f => ({ id: f.formatId, mode: 'audio' as const, label: `Audio · ${f.codec}`, sizeLabel: f.filesizeLabel })),
        ] });
      return;
    }
    const directory = output ?? getOutputDirectory();
    const download = mode === 'mp3' ? downloadMp3 : mode === 'audio' ? downloadAudio : downloadVideo;
    const selected = formatId === 'best' ? (mode === 'video' ? 'bestvideo+bestaudio/best' : 'bestaudio/best') : formatId!;
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
