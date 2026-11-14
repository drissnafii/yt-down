import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getVideoInfo } from '../src/yt-dlp.ts';
import { getTransferArgs } from '../src/transfer-options.ts';
import { withMetadataFile } from '../src/metadata-cache.ts';
import { getCookieArgs } from '../src/cookies.ts';

const [url, formatId, destination = 'benchmark-results.json'] = Bun.argv.slice(2);
if (!url || !formatId) {
  console.error('Usage: bun run benchmark URL EXACT_FORMAT_IDS [report.json]\nEach setting downloads the full selected media three times into fresh temporary folders.');
  process.exit(1);
}

const executable = Bun.env.YT_DLP_BIN ?? Bun.which('yt-dlp');
if (!executable) throw new Error('yt-dlp is required.');
const info = await getVideoInfo(url);
const directory = await mkdtemp(join(tmpdir(), 'yt-down-benchmark-'));
const settings = [
  { name: 'original-native-1', cached: false, fragments: '1', downloader: 'native' },
  { name: 'cached-native-1', cached: true, fragments: '1', downloader: 'native' },
  { name: 'cached-native-4', cached: true, fragments: '4', downloader: 'native' },
  ...(Bun.which('aria2c') ? [{ name: 'cached-aria2c', cached: true, fragments: '4', downloader: 'aria2c' }] : []),
];
const results: Array<Record<string, string | number | null>> = [];
try {
  await withMetadataFile(info, async path => {
    // Alternate settings within each round to reduce timing-order bias.
    for (let round = 1; round <= 3; round++) {
      for (const setting of round % 2 ? settings : [...settings].reverse()) {
        console.error(`Round ${round}/3: ${setting.name}, fixed formats ${formatId}`);
        const output = join(directory, setting.name, String(round));
        await mkdir(output, { recursive: true });
        const args = [
          executable, '--ignore-config', '--no-playlist', '--continue', '--part',
          ...getCookieArgs(), '--js-runtimes', Bun.env.YT_DLP_JS_RUNTIME ?? 'bun',
          '--abort-on-unavailable-fragments', '--socket-timeout', '15', '--retries', '0', '--fragment-retries', '0',
          ...getTransferArgs(setting), '-f', formatId, '-o', join(output, '%(id)s.%(ext)s'),
          '--merge-output-format', 'mp4', '--newline', '--progress', '--progress-delta', '0',
          '--progress-template', 'download:YT_DOWN_BYTES:%(progress.downloaded_bytes)s|%(progress.status)s',
          '--progress-template', 'postprocess:YT_DOWN_PP:%(progress.postprocessor)s|%(progress.status)s',
          ...(setting.cached ? ['--load-info-json', path!] : [url]),
        ];
        const started = performance.now();
        let firstByte: number | undefined;
        let lastByte: number | undefined;
        let mergeStarted: number | undefined;
        let mergeMs = 0;
        const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
        const cancel = () => proc.kill('SIGINT');
        process.on('SIGINT', cancel);
        const inspect = async (stream: ReadableStream<Uint8Array>) => {
          const decoder = new TextDecoder();
          let pending = '';
          let tail = '';
          for await (const chunk of stream) {
            const text = decoder.decode(chunk, { stream: true });
            tail = (tail + text).slice(-8192);
            pending += text;
            const lines = pending.split(/[\r\n]+/);
            pending = lines.pop()!;
            for (const line of lines) {
              const bytes = line.match(/YT_DOWN_BYTES:(\d+)\|(\w+)/);
              if (bytes && Number(bytes[1]) > 0) {
                if (bytes[2] === 'downloading') firstByte ??= performance.now();
                if (bytes[2] === 'finished') lastByte = performance.now();
              }
              const merge = line.match(/YT_DOWN_PP:Merger\|(\w+)/);
              if (merge?.[1] === 'started') mergeStarted = performance.now();
              if (merge?.[1] === 'finished' && mergeStarted !== undefined) mergeMs += performance.now() - mergeStarted;
            }
          }
          return tail;
        };
        let logs: string[];
        try {
          logs = await Promise.all([inspect(proc.stdout), inspect(proc.stderr)]);
          const code = await proc.exited;
          if (code !== 0) throw new Error(`Benchmark failed (${code}): ${logs.join('\n').split('\n').filter(line => line.startsWith('ERROR:')).join('\n')}`);
        } finally {
          process.off('SIGINT', cancel);
        }
        results.push({
          setting: setting.name, round,
          confirmToFirstProgressMs: firstByte === undefined ? null : firstByte - started,
          transferMs: firstByte !== undefined && lastByte !== undefined ? lastByte - firstByte : null,
          mergeMs,
          totalMs: performance.now() - started,
        });
      }
    }
  });
} finally {
  await rm(directory, { recursive: true, force: true });
  const report = resolve(destination);
  await mkdir(dirname(report), { recursive: true });
  await writeFile(report, JSON.stringify({
    videoId: info.id, formatId, recordedAt: new Date().toISOString(),
    notes: 'First byte is approximated by the first downloading progress event with bytes. External downloaders exposing only a completion event have null startup/transfer timings. Transfer covers all selected streams; merge timing uses Merger hooks. Full media, three rounds, fresh output folders. Interrupted runs may have partial results. No automatic recovery during timed trials.',
    aria2Available: Boolean(Bun.which('aria2c')), results,
  }, null, 2));
  console.error(`Benchmark report: ${report}`);
}
