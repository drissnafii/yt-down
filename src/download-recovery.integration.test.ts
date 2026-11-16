import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDownload } from './download-recovery.ts';
import { withMetadataFile } from './metadata-cache.ts';
import { getTransferArgs } from './transfer-options.ts';
import { createProgressParser } from './json-cli.ts';
import type { BackendEvent } from './protocol.ts';

// Use the real downloader when installed; all traffic stays on loopback.
const integration = test.skipIf(!Bun.which('yt-dlp'));
let dir: string;
let server: Server | undefined;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'yt-down-http-')); });
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function listen() {
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server!.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  return `http://127.0.0.1:${address.port}`;
}

integration('real yt-dlp resumes a dropped HTTP transfer using a byte range', async () => {
  const content = Buffer.alloc(256 * 1024, 42);
  const ranges: number[] = [];
  let requests = 0;
  server = createServer((req, res) => {
    const start = Number(req.headers.range?.match(/^bytes=(\d+)-/)?.[1] ?? 0);
    ranges.push(start);
    res.writeHead(req.headers.range ? 206 : 200, {
      'Content-Type': 'video/mp4',
      'Content-Length': content.length - start,
      'Accept-Ranges': 'bytes',
      ...(req.headers.range ? { 'Content-Range': `bytes ${start}-${content.length - 1}/${content.length}` } : {}),
    });
    // The first request probes metadata; interrupt the actual media transfer.
    if (++requests === 2) {
      res.write(content.subarray(start, start + 32 * 1024));
      setTimeout(() => res.destroy(), 20);
    } else {
      res.end(content.subarray(start));
    }
  });
  const base = await listen();
  const messages: string[] = [];
  await runDownload(['yt-dlp', '--ignore-config', '--no-playlist', '--proxy', '', '-o', join(dir, 'video.mp4'), `${base}/video.mp4`], {
    retryDelaysMs: [1], onRetry: message => messages.push(message), signal: AbortSignal.timeout(10_000),
  });
  expect(messages).toHaveLength(1);
  expect(ranges.some(start => start > 0)).toBe(true);
  expect(readFileSync(join(dir, 'video.mp4'))).toEqual(content);
}, 15_000);

integration('real yt-dlp preserves completed HLS fragments when a later one fails', async () => {
  // Sequential transfer makes the completed-before-failure ordering deterministic.
  // Parallel transfer behavior has its own test below.
  const fragments = [Buffer.alloc(1024, 1), Buffer.alloc(1024, 2), Buffer.alloc(1024, 3)];
  const requests = [0, 0, 0];
  server = createServer((req, res) => {
    if (req.url === '/video.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n' + fragments.map((_, i) => `#EXTINF:1,\n/segment${i}.ts\n`).join('') + '#EXT-X-ENDLIST\n');
      return;
    }
    const index = Number(req.url?.match(/segment(\d).ts/)?.[1]);
    if (!Number.isInteger(index) || !fragments[index]) { res.writeHead(404); res.end(); return; }
    requests[index]!++;
    if (index === 1 && requests[index] === 1) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    res.end(fragments[index]);
  });
  const base = await listen();
  await runDownload(['yt-dlp', '--ignore-config', '--no-playlist', '--proxy', '', ...getTransferArgs({ fragments: '1', downloader: 'native' }), '--fixup', 'never', '-o', join(dir, 'video.ts'), `${base}/video.m3u8`], {
    retryDelaysMs: [1], onRetry: () => {}, signal: AbortSignal.timeout(10_000),
  });
  expect(requests).toEqual([1, 2, 1]);
  expect(readFileSync(join(dir, 'video.ts'))).toEqual(Buffer.concat(fragments));
}, 15_000);

integration('cached metadata skips extraction; expired cached URLs fall back to the original', async () => {
  const content = Buffer.alloc(8192, 42);
  const paths: string[] = [];
  server = createServer((req, res) => {
    paths.push(req.url!);
    if (req.url === '/expired.mp4') { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': content.length });
    res.end(content);
  });
  const base = await listen();
  for (const expired of [false, true]) {
    paths.length = 0;
    const url = `${base}/${expired ? 'expired' : 'media'}.mp4`;
    const original = `${base}/original.mp4`;
    const info = {
      id: 'video', title: 'video', duration: 1, webpage_url: original,
      url, ext: 'mp4', extractor: 'generic', extractor_key: 'Generic',
      formats: [{ format_id: 'mp4', url, ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', filesize: content.length }],
    };
    const output = join(dir, `${expired}.mp4`);
    const args = ['yt-dlp', '--ignore-config', '--proxy', '', '-f', 'mp4', '-o', output];
    await withMetadataFile(info, async path => {
      await runDownload([...args, original], {
        initialArgs: [...args, '--load-info-json', path!],
        retryDelaysMs: [1], onRetry: () => {}, signal: AbortSignal.timeout(10_000),
      });
    });
    expect(readFileSync(output)).toEqual(content);
    if (expired) {
      expect(paths[0]).toBe('/expired.mp4');
      expect(paths).toContain('/original.mp4');
    } else {
      expect(paths).toEqual(['/media.mp4']);
    }
  }
}, 15_000);

integration('fragment concurrency is bounded and actually downloads in parallel', async () => {
  let active = 0;
  let peak = 0;
  server = createServer((req, res) => {
    if (req.url === '/video.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n' + Array.from({ length: 8 }, (_, i) => `#EXTINF:1,\n/${i}.ts\n`).join('') + '#EXT-X-ENDLIST\n');
      return;
    }
    active++;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active--;
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.end(Buffer.alloc(1024, Number(req.url?.match(/\d+/)?.[0])));
    }, 30);
  });
  const base = await listen();
  await runDownload(['yt-dlp', '--ignore-config', '--proxy', '', ...getTransferArgs({ fragments: '4', downloader: 'native' }), '--fixup', 'never', '-o', join(dir, 'video.ts'), `${base}/video.m3u8`], {
    signal: AbortSignal.timeout(10_000),
  });
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(4);
  expect(readFileSync(join(dir, 'video.ts'))).toEqual(Buffer.concat(Array.from({ length: 8 }, (_, i) => Buffer.alloc(1024, i))));
}, 15_000);

test.skipIf(!Bun.which('yt-dlp') || !Bun.which('aria2c'))('real aria2 direct download supports range requests and byte-correct output', async () => {
  const content = Buffer.alloc(8 * 1024 * 1024, 42);
  const ranges: string[] = [];
  server = createServer((req, res) => {
    const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = Number(match?.[1] ?? 0);
    const end = match?.[2] ? Math.min(Number(match[2]), content.length - 1) : content.length - 1;
    if (req.headers.range) ranges.push(req.headers.range);
    res.writeHead(match ? 206 : 200, {
      'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
      ...(match ? { 'Content-Range': `bytes ${start}-${end}/${content.length}` } : {}),
    });
    res.end(content.subarray(start, end + 1));
  });
  const base = await listen();
  await runDownload(['yt-dlp', '--ignore-config', '--proxy', '', ...getTransferArgs({ fragments: '4', downloader: 'aria2c' }), '--paths', dir, '--paths', `temp:${join(dir, '.aria2')}`, '-o', 'video.mp4', `${base}/video.mp4`], {
    signal: AbortSignal.timeout(10_000),
  });
  expect(ranges.length).toBeGreaterThan(0);
  expect(readFileSync(join(dir, 'video.mp4'))).toEqual(content);
}, 15_000);

test.skipIf(!Bun.which('yt-dlp') || !Bun.which('aria2c'))('real aria2 HTTP rejection triggers URL refresh and succeeds', async () => {
  const content = Buffer.alloc(1024 * 1024, 42);
  let rejected = false;
  let refreshed = false;
  let requests = 0;
  server = createServer((req, res) => {
    if (++requests > 1 && !refreshed) {
      rejected = true;
      res.writeHead(403); res.end(); return;
    }
    const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = Number(match?.[1] ?? 0);
    const end = match?.[2] ? Math.min(Number(match[2]), content.length - 1) : content.length - 1;
    res.writeHead(match ? 206 : 200, {
      'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
      ...(match ? { 'Content-Range': `bytes ${start}-${end}/${content.length}` } : {}),
    });
    res.end(content.subarray(start, end + 1));
  });
  const base = await listen();
  await runDownload(['yt-dlp', '--ignore-config', '--proxy', '', ...getTransferArgs({ fragments: '4', downloader: 'aria2c' }), '--paths', dir, '--paths', `temp:${join(dir, '.aria2')}`, '-o', 'video.mp4', `${base}/video.mp4`], {
    retryDelaysMs: [1], onRetry: () => { refreshed = true; }, signal: AbortSignal.timeout(10_000),
  });
  expect(rejected).toBe(true);
  expect(refreshed).toBe(true);
  expect(readFileSync(join(dir, 'video.mp4'))).toEqual(content);
}, 15_000);

integration('real yt-dlp emits machine progress and final filenames without simulating the download', async () => {
  const content = Buffer.alloc(64 * 1024, 42);
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': content.length });
    res.end(content);
  });
  const base = await listen();
  const events: BackendEvent[] = [];
  const parsers = { stdout: createProgressParser(event => events.push(event)), stderr: createProgressParser(event => events.push(event)) };
  const output = join(dir, 'actual video.mp4');
  await runDownload(['yt-dlp', '--ignore-config', '--proxy', '', '--no-playlist', '--newline', '--progress',
    '--progress-template', 'download:yt-down-progress:%(progress)j',
    '--print', 'after_move:yt-down-file:%(filepath)j', '-o', output, `${base}/media.mp4`], {
    signal: AbortSignal.timeout(10_000), onOutput: (text, stream) => parsers[stream](text),
  });
  expect(readFileSync(output)).toEqual(content);
  expect(events.some(event => event.type === 'progress' && event.percent === 100)).toBe(true);
  expect(events).toContainEqual({ type: 'file', path: output });
}, 15_000);
