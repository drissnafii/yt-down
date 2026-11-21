import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadCancelledError, RECOVERY_ARGS, runDownload } from './download-recovery.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'yt-down-recovery-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function fixture(errors: string[], mode = '') {
  const script = join(dir, 'downloader.ts');
  writeFileSync(script, `
    import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
    const directory = ${JSON.stringify(dir)};
    const errors = ${JSON.stringify(errors)};
    const state = directory + '/attempts.json';
    const attempts = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : [];
    attempts.push(process.argv.slice(2));
    writeFileSync(state, JSON.stringify(attempts));
    const partial = directory + '/video.mp4.part';
    if (${JSON.stringify(mode)} === 'hang') {
      writeFileSync(partial, 'saved');
      process.on('SIGINT', () => process.exit(130));
      await Bun.sleep(60_000);
    }
    if (attempts.length <= errors.length) {
      if (!existsSync(partial)) writeFileSync(partial, 'saved');
      console.error(errors[attempts.length - 1]);
      process.exit(1);
    }
    if (existsSync(partial)) appendFileSync(partial, '-resumed');
  `);
  return [process.execPath, script, '-f', '137+140', '-o', join(dir, 'video.%(ext)s'), 'https://youtube.com/watch?v=test'];
}

function attempts(): string[][] {
  return JSON.parse(readFileSync(join(dir, 'attempts.json'), 'utf8'));
}

test('recovers from the reported DNS failure and preserves partial data and arguments', async () => {
  const messages: string[] = [];
  await runDownload(fixture([
    "ERROR: unable to download video data: HTTPSConnection: Failed to resolve 'cdn.googlevideo.com' ([Errno -3] Temporary failure in name resolution)",
    'ERROR: Unable to download API page: Network is unreachable',
  ]), { retryDelaysMs: [1], onRetry: message => messages.push(message) });
  expect(attempts()).toHaveLength(3);
  expect(attempts()[0]).toEqual(attempts()[2]);
  expect(readFileSync(join(dir, 'video.mp4.part'), 'utf8')).toBe('saved-resumed');
  expect(messages).toHaveLength(2);
  expect(messages[0]).toContain('waiting to reconnect');
  expect(attempts()[0]).toEqual(expect.arrayContaining(RECOVERY_ARGS));
});

test('retries incomplete transfers and temporary server failures', async () => {
  const messages: string[] = [];
  await runDownload(fixture([
    'ERROR: 4096 bytes read, 10000 more expected',
    'ERROR: HTTP Error 503: Service Unavailable',
    'ERROR: HTTP Error 429: Too Many Requests',
    'ERROR: Connection reset by peer',
  ]), { retryDelaysMs: [1, 2], onRetry: message => messages.push(message) });
  expect(attempts()).toHaveLength(5);
  expect(messages.map(message => message.match(/Retrying in (\S+)s/)?.[1])).toEqual(['0.001', '0.002', '0.002', '0.002']);
});

test('re-extracts after a rejected URL and resumes', async () => {
  await runDownload(fixture(['ERROR: unable to download video data: HTTP Error 403: Forbidden']), {
    retryDelaysMs: [1], onRetry: () => {},
  });
  expect(attempts()).toHaveLength(2);
});

test('resumes the truncated-transfer error reported by the pinned yt-dlp release', async () => {
  await runDownload(fixture(['ERROR: [download] Got error: Downloaded 32768 bytes, expected 262144 bytes']), {
    retryDelaysMs: [1], onRetry: () => {},
  });
  expect(attempts()).toHaveLength(2);
  expect(readFileSync(join(dir, 'video.mp4.part'), 'utf8')).toBe('saved-resumed');
});

test('uses cached metadata only once and refreshes from the original URL after failure', async () => {
  const original = fixture(['ERROR: unable to download video data: HTTP Error 403: Forbidden']);
  const initial = [...original.slice(0, -1), '--load-info-json', '/private/video.info.json'];
  await runDownload(original, { initialArgs: initial, retryDelaysMs: [1], onRetry: () => {} });
  expect(attempts()[0]).toContain('--load-info-json');
  expect(attempts()[0]).not.toContain(original.at(-1)!);
  expect(attempts()[1]).not.toContain('--load-info-json');
  expect(attempts()[1]).toContain(original.at(-1)!);
});

test('recovers from aria2 network and HTTP status errors', async () => {
  await runDownload(fixture([
    'ERROR: aria2c exited with code 19',
    'errorCode=22 The response status is not successful. status=403\nERROR: aria2c exited with code 22',
  ]), { retryDelaysMs: [1], onRetry: () => {} });
  expect(attempts()).toHaveLength(3);
});

test('limits URL refreshes when access remains forbidden', async () => {
  await expect(runDownload(fixture(Array(5).fill('ERROR: HTTP Error 403: Forbidden')), {
    retryDelaysMs: [1], onRetry: () => {},
  })).rejects.toThrow('403');
  expect(attempts()).toHaveLength(4);
});

test('permanent failures stop immediately, even after an unrelated network warning', async () => {
  await expect(runDownload(fixture([
    'WARNING: API request timed out\nERROR: unable to open for writing: Permission denied',
  ]), { retryDelaysMs: [1], onRetry: () => { throw new Error('must not retry'); } })).rejects.toThrow('Permission denied');
  expect(attempts()).toHaveLength(1);
});

test('cancels immediately while waiting and removes signal listeners', async () => {
  const controller = new AbortController();
  const before = process.listenerCount('SIGINT');
  await expect(runDownload(fixture(['ERROR: Connection timed out']), {
    signal: controller.signal,
    retryDelaysMs: [60_000],
    onRetry: () => controller.abort(),
  })).rejects.toBeInstanceOf(DownloadCancelledError);
  expect(attempts()).toHaveLength(1);
  expect(process.listenerCount('SIGINT')).toBe(before);
});

test('cancels an active child and keeps its partial file', async () => {
  const controller = new AbortController();
  const run = runDownload(fixture([], 'hang'), { signal: controller.signal });
  const timer = setInterval(() => {
    if (existsSync(join(dir, 'video.mp4.part'))) controller.abort();
  }, 5);
  try {
    await expect(run).rejects.toBeInstanceOf(DownloadCancelledError);
  } finally {
    clearInterval(timer);
    controller.abort();
  }
  expect(readFileSync(join(dir, 'video.mp4.part'), 'utf8')).toBe('saved');
});

test('an already cancelled download starts no subprocess', async () => {
  await expect(runDownload(fixture([]), { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(DownloadCancelledError);
  expect(await Bun.file(join(dir, 'attempts.json')).exists()).toBe(false);
});

test('a child interrupted independently is not restarted', async () => {
  const script = join(dir, 'signal.ts');
  writeFileSync(script, 'process.kill(process.pid, "SIGTERM"); await Bun.sleep(1000);');
  await expect(runDownload([process.execPath, script])).rejects.toBeInstanceOf(DownloadCancelledError);
});

test('Ctrl+C signal handling cancels a retry countdown', async () => {
  await expect(runDownload(fixture(['ERROR: Connection timed out']), {
    retryDelaysMs: [60_000],
    onRetry: () => process.emit('SIGINT'),
  })).rejects.toBeInstanceOf(DownloadCancelledError);
  expect(attempts()).toHaveLength(1);
});

test.each([
  'ERROR: No space left on device',
  'ERROR: Postprocessing: ffmpeg failed',
  'ERROR: Sign in to confirm your age',
  'ERROR: Requested format is not available',
  'ERROR: Video unavailable',
])('does not retry permanent failure: %s', async error => {
  await expect(runDownload(fixture([error]), {
    retryDelaysMs: [1], onRetry: () => { throw new Error('must not retry'); },
  })).rejects.toThrow(error);
  expect(attempts()).toHaveLength(1);
});
