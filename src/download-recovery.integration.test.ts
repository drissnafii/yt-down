import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDownload } from './download-recovery.ts';

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
  await runDownload(['yt-dlp', '--ignore-config', '--no-playlist', '--proxy', '', '--fixup', 'never', '-o', join(dir, 'video.ts'), `${base}/video.m3u8`], {
    retryDelaysMs: [1], onRetry: () => {}, signal: AbortSignal.timeout(10_000),
  });
  expect(requests).toEqual([1, 2, 1]);
  expect(readFileSync(join(dir, 'video.ts'))).toEqual(Buffer.concat(fragments));
}, 15_000);
