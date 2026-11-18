import { expect, test } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ffmpeg = Bun.which('ffmpeg');
const ffprobe = Bun.which('ffprobe');
const ytdlp = Bun.which('yt-dlp');

test.skipIf(!ffmpeg || !ffprobe || !ytdlp)('MP3 download converts real audio and reports its final MP3 path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yt-down-mp3-'));
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const wav = join(dir, 'source.wav');
    const makeAudio = Bun.spawn([ffmpeg!, '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', wav], { stderr: 'pipe' });
    const synthesisError = await new Response(makeAudio.stderr).text();
    expect(synthesisError).toBe('');
    expect(await makeAudio.exited).toBe(0);
    const bytes = await readFile(wav);
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } }) });
    const url = `http://127.0.0.1:${server.port}/source.wav`;
    const modulePath = new URL('./yt-dlp.ts', import.meta.url).href;
    const info = { id: 'source', title: 'Conversion test', duration: 0.5, webpage_url: url,
      url, ext: 'wav', extractor: 'generic', extractor_key: 'Generic',
      formats: [{ format_id: 'wav', url, ext: 'wav', acodec: 'pcm_s16le', vcodec: 'none' }] };
    const proc = Bun.spawn([process.execPath, '-e', `
      import { downloadMp3 } from ${JSON.stringify(modulePath)};
      import { createProgressParser } from ${JSON.stringify(new URL('./json-cli.ts', import.meta.url).href)};
      const parse = createProgressParser(e => console.log(JSON.stringify(e)));
      await downloadMp3(${JSON.stringify(url)}, 'wav', ${JSON.stringify(dir)}, ${JSON.stringify(info)}, { onOutput: parse });
    `], { env: { ...process.env, YT_DLP_BIN: ytdlp!, YT_DLP_COOKIES: 'none', YT_DOWN_DOWNLOADER: 'native' },
      stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const output = join(dir, 'Conversion test [source].mp3');
    expect(stdout).toContain(JSON.stringify({ type: 'file', path: output }));
    const probe = Bun.spawn([ffprobe!, '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', output], { stdout: 'pipe' });
    expect((await new Response(probe.stdout).text()).trim()).toBe('mp3');
    expect(await probe.exited).toBe(0);
  } finally {
    server?.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
