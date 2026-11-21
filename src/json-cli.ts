import { getOutputDirectory } from './output-directory.ts';
import { DownloadCancelledError } from './download-recovery.ts';
import { getVideoInfo, downloadVideo, downloadAudio, downloadMp3 } from './yt-dlp.ts';
import { normalizeVideoUrl } from './utils.ts';
import type { BackendEvent } from './protocol.ts';

import { createProgressParser } from './progress.ts';
export { createProgressParser } from './progress.ts';
import { formatChoices } from './format-model.ts';

const emit = (event: BackendEvent) => console.log(JSON.stringify(event));

export async function runJsonCommand(args: string[]): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const [command, input, mode, formatId, output] = args;
    if (command !== 'formats' && command !== 'download') throw new Error('Expected formats or download.');
    const url = input ? normalizeVideoUrl(input) : null;
    if (!url) throw new Error('Enter a valid HTTP or HTTPS video URL.');
    if (command === 'formats' && args.length !== 2) throw new Error('Usage: --json formats URL');
    if (command === 'download' && (args.length < 4 || args.length > 5 || !['video', 'audio', 'mp3'].includes(mode!)
      || !formatId || !/^(?:best|\w[\w.-]*(?:\+\w[\w.-]*)*)$/.test(formatId))) {
      throw new Error('Usage: --json download URL video|audio|mp3 FORMAT_ID [OUTPUT_DIR]');
    }
    emit({ type: 'status', message: 'Fetching video details…' });
    const info = await getVideoInfo(url, controller.signal);
    if (controller.signal.aborted) throw new DownloadCancelledError();
    if (command === 'formats') {
      emit({ type: 'formats', title: info.title, channel: info.channel ?? '', duration: info.duration,
      thumbnail: info.thumbnail, choices: formatChoices(info) });
      return;
    }
    const directory = getOutputDirectory({ directory: output, url });
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
