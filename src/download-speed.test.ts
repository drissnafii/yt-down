import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'yt-down-wrapper-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

test.each(['downloadVideo', 'downloadAudio'])('%s passes cached metadata and shared transfer settings, then cleans the snapshot', async method => {
  const fake = join(directory, 'yt-dlp');
  const log = join(directory, 'args.json');
  writeFileSync(fake, `#!/usr/bin/env bun
    const args = process.argv.slice(2);
    const path = args[args.indexOf('--load-info-json') + 1];
    await Bun.write(${JSON.stringify(log)}, JSON.stringify({ args, path, info: await Bun.file(path).json() }));
  `, { mode: 0o755 });
  const module = new URL('./yt-dlp.ts', import.meta.url).href;
  const proc = Bun.spawn([process.execPath, '-e', `
    import { ${method} } from ${JSON.stringify(module)};
    await ${method}('https://youtu.be/test', 'exact-format', ${JSON.stringify(directory)}, {
      id: 'test', title: 'Test', duration: 1, webpage_url: 'https://youtu.be/test', formats: []
    });
  `], {
    env: { ...process.env, YT_DLP_BIN: fake, YT_DLP_COOKIES: 'none', YT_DLP_JS_RUNTIME: 'bun', YT_DOWN_FRAGMENTS: '4', YT_DOWN_DOWNLOADER: 'native' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const errors = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0);
  expect(errors).toBe('');
  const { args, path, info } = JSON.parse(readFileSync(log, 'utf8'));
  expect(args).toContain('--load-info-json');
  expect(args).not.toContain('https://youtu.be/test');
  expect(args[args.indexOf('-f') + 1]).toBe('exact-format');
  expect(args[args.indexOf('--concurrent-fragments') + 1]).toBe('4');
  expect(args[args.indexOf('-o') + 1]).toBe('%(title)s.%(ext)s');
  expect(info.title).toBe('Test');
  expect(existsSync(path)).toBe(false);
});
