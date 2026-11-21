import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeVideoUrl } from '../src/utils.ts';

const available = Boolean(Bun.which('gjs') && Bun.which('setsid') && Bun.which('python3'));
let build: string;
beforeAll(async () => {
  if (!available) return;
  build = await mkdtemp(join(tmpdir(), 'yt-down-gjs-build-'));
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, '../extension/src/worker.ts')],
    outdir: build, target: 'browser', external: ['gi://*', 'resource://*'] });
  if (!result.success) throw new AggregateError(result.logs);
});
afterAll(async () => { if (build) await rm(build, { recursive: true, force: true }); });

async function session(extra: Record<string, string> = {}, url = 'https://youtu.be/fixture') {
  const dir = await mkdtemp(join(tmpdir(), 'yt-down-gjs-'));
  const fixture = join(import.meta.dir, 'fixtures/fake-ytdlp.py');
  const proc = Bun.spawn(['setsid', 'gjs', '-m', join(build, 'worker.js'), 'formats', url], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, YT_DLP_BIN: fixture,
      YT_DLP_COOKIES: 'none', YT_DOWN_DOWNLOADER: 'native', YT_DOWN_TEST_DIR: dir, ...extra },
  });
  const errors = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  let pending = '';
  const events: any[] = [];
  const next = async (): Promise<any> => {
    for (;;) {
      const index = pending.indexOf('\n');
      if (index >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        const event = JSON.parse(line); events.push(event); return event;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Worker exited before event: ${await errors}`);
      pending += new TextDecoder().decode(chunk.value);
    }
  };
  const until = async (type: string) => { for (;;) { const event = await next(); if (event.type === type) return event; } };
  const download = (mode = 'video', id = 'video') => { proc.stdin.write(JSON.stringify({ url: normalizeVideoUrl(url),
    mode, id, directory: join(dir, 'output') }) + '\n'); proc.stdin.end(); };
  const cleanup = async () => {
    if (proc.exitCode === null) { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} await proc.exited; }
    reader.releaseLock(); await rm(dir, { recursive: true, force: true });
  };
  return { dir, proc, next, until, download, cleanup, errors, events };
}

test.skipIf(!available)('GJS reuses discovery metadata, uses a private snapshot and removes it after download', async () => {
  const s = await session();
  try {
    const formats = await s.until('formats');
    expect(formats.choices.some((c: any) => c.height === 720)).toBe(true);
    s.download();
    await s.until('complete'); await s.proc.exited;
    expect(await s.errors).toBe('');
    const calls = (await Bun.file(join(s.dir, 'calls.jsonl')).text()).trim().split('\n').map(v => JSON.parse(v));
    expect(calls.filter(args => args.includes('-j'))).toHaveLength(1);
    expect(calls[1]).toContain('--load-info-json');
    expect(calls[1]).toContain('--continue');
    const snapshot = await Bun.file(join(s.dir, 'snapshot.json')).json();
    expect(snapshot.mode).toBe(0o600);
    expect(snapshot.info.webpage_url).toBeUndefined();
    expect(existsSync(snapshot.path)).toBe(false);
    expect(existsSync(join(s.dir, 'output/fixture.mp4'))).toBe(true);
  } finally { await s.cleanup(); }
}, 10000);

test.skipIf(!available)('GJS refreshes a rejected cached URL and preserves resume arguments', async () => {
  const s = await session({ YT_DOWN_TEST_FAILURES: '1' });
  try {
    await s.until('formats'); s.download(); await s.until('complete'); await s.proc.exited;
    const calls = (await Bun.file(join(s.dir, 'calls.jsonl')).text()).trim().split('\n').map(v => JSON.parse(v));
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain('--load-info-json');
    expect(calls[2]).not.toContain('--load-info-json');
    expect(calls[2]).toContain('https://www.youtube.com/watch?v=fixture');
    expect(calls[2]).toContain('--continue');
    expect(s.events.some(e => e.type === 'status' && e.message.includes('Retrying'))).toBe(true);
    expect(await s.errors).toBe('');
  } finally { await s.cleanup(); }
}, 10000);

test.skipIf(!available)('GJS stops on permanent errors without retrying', async () => {
  const s = await session({ YT_DOWN_TEST_FAILURES: '10', YT_DOWN_TEST_ERROR: 'No space left on device' });
  try {
    await s.until('formats'); s.download();
    expect((await s.until('error')).message).toContain('No space left'); await s.proc.exited;
    expect(await Bun.file(join(s.dir, 'attempts')).text()).toBe('1');
    const snapshot = await Bun.file(join(s.dir, 'snapshot.json')).json();
    expect(existsSync(snapshot.path)).toBe(false);
  } finally { await s.cleanup(); }
}, 10000);

test.skipIf(!available)('GJS cancellation stops media descendants and deletes private metadata', async () => {
  const s = await session({ YT_DOWN_TEST_HANG: '1' });
  try {
    await s.until('formats'); s.download(); await s.until('progress');
    const child = Number(await Bun.file(join(s.dir, 'child.pid')).text());
    process.kill(-s.proc.pid, 'SIGINT');
    await s.until('cancelled'); await s.proc.exited;
    expect(existsSync(`/proc/${child}`)).toBe(false);
    const snapshot = await Bun.file(join(s.dir, 'snapshot.json')).json();
    expect(existsSync(snapshot.path)).toBe(false);
  } finally { await s.cleanup(); }
}, 10000);

test.skipIf(!available || !Bun.which('yt-dlp') || !Bun.which('ffmpeg') || !Bun.which('ffprobe'))('GJS downloads local media with real yt-dlp and converts MP3 with ffmpeg', async () => {
  const audio = Bun.spawn(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', '-f', 'wav', 'pipe:1'],
    { stdout: 'pipe', stderr: 'pipe' });
  const bytes = await new Response(audio.stdout).arrayBuffer();
  expect(await audio.exited).toBe(0);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: () => new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } }) });
  const s = await session({ YT_DLP_BIN: Bun.which('yt-dlp')! }, `http://127.0.0.1:${server.port}/source.wav`);
  try {
    await s.until('formats'); s.download('mp3', 'best'); await s.until('complete'); await s.proc.exited;
    const path = s.events.find(e => e.type === 'file')?.path;
    expect(path).toEndWith('.mp3');
    expect(path).toContain('/other_sites/');
    const probe = Bun.spawn(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path], { stdout: 'pipe' });
    expect((await new Response(probe.stdout).text()).trim()).toBe('mp3');
    expect(await probe.exited).toBe(0);
  } finally { server.stop(true); await s.cleanup(); }
}, 15000);

test.skipIf(!available)('GJS client force-stops an unresponsive process group and cleans its snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yt-down-client-'));
  try {
    const driver = join(dir, 'driver.js');
    await Bun.write(driver, `
      import GLib from 'gi://GLib';
      import { Backend } from ${JSON.stringify(resolve(import.meta.dir, '../extension/src/client.ts'))};
      const loop = new GLib.MainLoop(null, false);
      const backend = new Backend();
      let snapshot = '';
      let stopping = false;
      const onEnd = () => {
        let attempts = 0;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
          if (!GLib.file_test(snapshot, GLib.FileTest.EXISTS)) {
            print('CLEAN'); loop.quit(); return GLib.SOURCE_REMOVE;
          }
          if (++attempts > 50) { print('LEAK'); loop.quit(); return GLib.SOURCE_REMOVE; }
          return GLib.SOURCE_CONTINUE;
        });
      };
      const onEvent = event => {
        if (event.type === 'formats') backend.download({url:'https://www.youtube.com/watch?v=fixture',mode:'video',id:'video',directory:${JSON.stringify(join(dir, 'output'))}},onEvent,onEnd);
        if (event.type === 'progress' && !stopping) {
          stopping=true; snapshot=backend.cacheDirectory; backend.cancel();
        }
        if (event.type === 'error') print('ERROR:'+event.message);
      };
      backend.start(['setsid','gjs','-m',${JSON.stringify(join(build, 'worker.js'))},'formats','https://youtu.be/fixture'],onEvent,onEnd);
      loop.run();
    `);
    const result = await Bun.build({ entrypoints: [driver], outdir: join(dir, 'compiled'), target: 'browser', external: ['gi://*'] });
    expect(result.success).toBe(true);
    const proc = Bun.spawn(['gjs', '-m', join(dir, 'compiled/driver.js')], { stdout: 'pipe', stderr: 'pipe', env: {
      ...process.env, YT_DLP_BIN: join(import.meta.dir, 'fixtures/fake-ytdlp.py'), YT_DLP_COOKIES: 'none',
      YT_DOWN_TEST_DIR: dir, YT_DOWN_TEST_HANG: '1', YT_DOWN_TEST_IGNORE_SIGNALS: '1', YT_DOWN_DOWNLOADER: 'native',
    } });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0); expect(stderr).toBe(''); expect(stdout.trim()).toBe('CLEAN');
    const snapshot = await Bun.file(join(dir, 'snapshot.json')).json();
    expect(existsSync(snapshot.path)).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 10000);

test.skipIf(!available).each(['startup', 'metadata', 'active', 'retry', 'unresponsive'])('destroy during %s clears timers, suppresses callbacks and reaps the worker', async phase => {
  const dir = await mkdtemp(join(tmpdir(), 'yt-down-destroy-'));
  try {
    const driver = join(dir, 'driver.js');
    await Bun.write(driver, `
      import GLib from 'gi://GLib';
      import { Backend } from ${JSON.stringify(resolve(import.meta.dir, '../extension/src/client.ts'))};
      const loop = new GLib.MainLoop(null, false);
      const backend = new Backend();
      const phase = ${JSON.stringify(phase)};
      let stopping = false;
      let snapshot = '';
      const stop = () => {
        if (stopping) return;
        stopping=true; snapshot=backend.cacheDirectory;
        if (phase === 'unresponsive') backend.cancel();
        backend.destroy();
        if (backend.killTimer !== 0) print('TIMER');
        let attempts=0;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT,20,()=>{
          if (!backend.process && (!snapshot || !GLib.file_test(snapshot,GLib.FileTest.EXISTS))) {
            print('CLEAN'); loop.quit(); return GLib.SOURCE_REMOVE;
          }
          if (++attempts > 200) { print('LEAK'); loop.quit(); return GLib.SOURCE_REMOVE; }
          return GLib.SOURCE_CONTINUE;
        });
      };
      const onEnd = () => { print('UNEXPECTED END'); loop.quit(); };
      const onEvent = event => {
        if (stopping) { print('LATE CALLBACK'); return; }
        if (event.type === 'formats') backend.download({url:'https://www.youtube.com/watch?v=fixture',mode:'video',id:'video',directory:${JSON.stringify(join(dir, 'output'))}},onEvent,onEnd);
        if (phase === 'retry' && event.type === 'status' && event.message.includes('Retrying')) stop();
        if (['active','unresponsive'].includes(phase) && event.type === 'progress') stop();
        if (event.type === 'error') { print('ERROR:'+event.message); loop.quit(); }
      };
      backend.start(['setsid','gjs','-m',${JSON.stringify(join(build, 'worker.js'))},'formats','https://youtu.be/fixture'],onEvent,onEnd);
      if (phase === 'startup') stop();
      if (phase === 'metadata') GLib.timeout_add(GLib.PRIORITY_DEFAULT,20,()=>{
        if (GLib.file_test(${JSON.stringify(join(dir, 'metadata.pid'))},GLib.FileTest.EXISTS)) { stop(); return GLib.SOURCE_REMOVE; }
        return GLib.SOURCE_CONTINUE;
      });
      loop.run();
    `);
    const result = await Bun.build({ entrypoints: [driver], outdir: join(dir, 'compiled'), target: 'browser', external: ['gi://*'] });
    expect(result.success).toBe(true);
    const proc = Bun.spawn(['gjs', '-m', join(dir, 'compiled/driver.js')], { stdout: 'pipe', stderr: 'pipe', env: {
      ...process.env, YT_DLP_BIN: join(import.meta.dir, 'fixtures/fake-ytdlp.py'), YT_DLP_COOKIES: 'none',
      YT_DOWN_TEST_DIR: dir, YT_DOWN_TEST_HANG: '1', YT_DOWN_DOWNLOADER: 'native',
      ...(phase === 'metadata' ? { YT_DOWN_TEST_HANG_METADATA: '1' } : {}),
      ...(phase === 'retry' ? { YT_DOWN_TEST_FAILURES: '1' } : {}),
      ...(phase === 'unresponsive' ? { YT_DOWN_TEST_IGNORE_SIGNALS: '1' } : {}),
    } });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0); expect(stderr).toBe(''); expect(stdout.trim()).toBe('CLEAN');
    if (await Bun.file(join(dir, 'snapshot.json')).exists()) {
      const snapshot = await Bun.file(join(dir, 'snapshot.json')).json(); expect(existsSync(snapshot.path)).toBe(false);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 10000);

test.skipIf(!available)('missing ffmpeg leaves core tools and original single-stream downloads available', async () => {
  const source = join(build, 'requirements-source.js');
  await Bun.write(source, `
    import { missingDependencies, downloadRequirement } from ${JSON.stringify(resolve(import.meta.dir, '../extension/src/dependencies.ts'))};
    const find = name => name === 'ffmpeg' ? null : '/usr/bin/' + name;
    print(JSON.stringify({
      missing: missingDependencies(find),
      original: downloadRequirement({id:'audio',mode:'audio'},find),
      video: downloadRequirement({id:'combined',mode:'video'},find),
      mp3: downloadRequirement({id:'audio',mode:'mp3'},find),
      merged: downloadRequirement({id:'video+audio',mode:'video'},find),
      noTools: missingDependencies(() => null),
    }));
  `);
  const result = await Bun.build({ entrypoints: [source], outdir: build, naming: 'requirements.js', target: 'browser', external: ['gi://*'] });
  expect(result.success).toBe(true);
  const proc = Bun.spawn(['gjs', '-m', join(build, 'requirements.js')], { stdout: 'pipe', stderr: 'pipe' });
  const data = await new Response(proc.stdout).json() as {
    missing: string[]; original: string; video: string; mp3: string; merged: string; noTools: string[];
  };
  expect(await proc.exited).toBe(0);
  expect(data.missing).toEqual([]);
  expect(data.original).toBe(''); expect(data.video).toBe('');
  expect(data.mp3).toContain('ffmpeg'); expect(data.merged).toContain('ffmpeg');
  expect(data.noTools).toContain('yt-dlp'); expect(data.noTools).not.toContain('ffmpeg');
});
