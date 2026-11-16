import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgressParser } from './json-cli.ts';
import type { BackendEvent } from './protocol.ts';

let dir: string;
let executable: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yt-down-json-'));
  executable = join(dir, 'fake-yt-dlp');
  await writeFile(executable, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('-j')) {
  if (process.env.HANG_METADATA) { await Bun.write(process.env.HANG_METADATA, 'ready'); await Bun.sleep(60000); }
  console.log(JSON.stringify({id:'test', title:'Test video', channel:'Test channel', duration:20, webpage_url:'https://youtu.be/test',
    formats:[{format_id:'18',height:360,vcodec:'avc1',acodec:'mp4a',ext:'mp4',filesize:1000},
      {format_id:'140',vcodec:'none',acodec:'mp4a',ext:'m4a',abr:128}]}));
} else {
  if (process.env.HANG_DOWNLOAD) { await Bun.write(process.env.HANG_DOWNLOAD, 'ready'); await Bun.sleep(60000); }
  if (!args.includes('--load-info-json')) throw new Error('Missing metadata snapshot');
  console.error('an extractor warning');
  console.log('yt-down-progress:' + JSON.stringify({downloaded_bytes:50,total_bytes:100,speed:1024,eta:2}));
  console.log('yt-down-file:' + JSON.stringify('/tmp/Test video.mp4'));
}
`, { mode: 0o755 });
});
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

function spawn(args: string[], env: Record<string, string> = {}) {
  return Bun.spawn([process.execPath, join(import.meta.dir, '../bin/yt-down.ts'), '--json', ...args], {
    env: { ...process.env, YT_DLP_BIN: executable, YT_DLP_COOKIES: 'none', ...env }, stdout: 'pipe', stderr: 'pipe',
  });
}
async function result(proc: ReturnType<typeof spawn>) {
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { events: stdout.trim().split('\n').map(line => JSON.parse(line) as BackendEvent), stderr, code };
}

test('formats protocol returns existing backend video and audio choices without terminal prompts', async () => {
  const { events, stderr, code } = await result(spawn(['formats', 'https://youtu.be/test']));
  expect(code).toBe(0);
  expect(stderr).toBe('');
  expect(events.at(-1)).toMatchObject({type:'formats', title:'Test video', choices: [
    {id:'best',mode:'video'}, {id:'18',mode:'video'}, {id:'140',mode:'audio'},
  ]});
});

test('download emits clean JSON progress and completion while using recovery and metadata', async () => {
  const { events, stderr, code } = await result(spawn(['download', 'https://youtu.be/test', 'video', '18', join(dir, 'output')]));
  expect(code).toBe(0);
  expect(stderr).toBe('');
  expect(events).toContainEqual({type:'progress',percent:50,speed:1024,eta:2});
  expect(events).toContainEqual({type:'file',path:'/tmp/Test video.mp4'});
  expect(events.at(-1)).toEqual({type:'complete',directory:join(dir, 'output')});
});

test('bad URLs and malformed download arguments produce JSON errors with failure exit codes', async () => {
  for (const args of [['formats','file:///etc/passwd'], ['download','https://youtu.be/test','audio','--exec']]) {
    const { events, code } = await result(spawn(args));
    expect(code).toBe(1);
    expect(events.at(-1)?.type).toBe('error');
  }
});

for (const phase of ['METADATA', 'DOWNLOAD']) {
  test(`SIGTERM cancels ${phase.toLowerCase()} and returns a cancelled event`, async () => {
    const ready = join(dir, 'ready');
    const proc = spawn(['download', 'https://youtu.be/test', 'video', '18', join(dir, 'output')], { [`HANG_${phase}`]: ready });
    try {
      for (let i = 0; i < 200 && !await Bun.file(ready).exists(); i++) await Bun.sleep(10);
      expect(await Bun.file(ready).exists()).toBe(true);
      proc.kill('SIGTERM');
      const { code, events } = await result(proc);
      expect(code).toBe(130);
      expect(events.at(-1)?.type).toBe('cancelled');
    } finally { if (proc.exitCode === null) proc.kill('SIGKILL'); }
  });
}

test('progress parser handles split records, unknown totals, escaped filenames and clamps percentages', () => {
  const events: BackendEvent[] = [];
  const parse = createProgressParser(event => events.push(event));
  parse('yt-down-prog');
  parse('ress:{"downloaded_bytes":150,"total_bytes":100,"speed":null}\n');
  parse('yt-down-progress:{"downloaded_bytes":5}\r\nyt-down-progress:invalid\n');
  parse(`yt-down-file:${JSON.stringify('/tmp/A "title".mp4')}\n`);
  expect(events).toEqual([
    {type:'progress',percent:100,speed:null,eta:null},
    {type:'progress',percent:null,speed:null,eta:null},
    {type:'file',path:'/tmp/A "title".mp4'},
  ]);
});
