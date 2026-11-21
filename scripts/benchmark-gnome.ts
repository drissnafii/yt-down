/** Opt-in real-media comparison. Both paths use the same URL, format and machine. */
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { normalizeVideoUrl } from '../src/utils.ts';

const args = process.argv.slice(2);
const [input, format = 'best', output = 'benchmark-gnome', mode = 'video'] = args.filter(arg => arg !== '--gjs-first');
if (!input || !['video', 'audio', 'mp3'].includes(mode))
  throw new Error('Usage: bun run benchmark:gnome URL [FORMAT_ID] [OUTPUT_DIRECTORY] [video|audio|mp3]');
const url = normalizeVideoUrl(input);
if (!url) throw new Error('Expected a valid HTTP(S) video URL.');
const normalizedUrl: string = url;
await mkdir(resolve(output), { recursive: true });
const directory = await mkdtemp(join(resolve(output), 'run-'));
const cli = resolve(import.meta.dir, '../bin/yt-down.ts');
const worker = resolve(import.meta.dir, '../dist/yt-down@drissnafii/worker.js');
if (!await Bun.file(worker).exists()) throw new Error('Run bun run extension:build first.');

type Timing = { discoveryMs: number; selectionToProgressMs: number | null; selectionToCompleteMs: number };
const cancellation = new AbortController();
async function measure(kind: 'bun-cli' | 'gjs-worker'): Promise<Timing> {
  let discoveryMs = 0;
  let selectedAt = 0;
  let firstProgress: number | null = null;
  const started = performance.now();
  let completed = false;
  async function run(argv: string[], persistent: boolean) {
    cancellation.signal.throwIfAborted();
    const proc = Bun.spawn(argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, YT_DLP_COOKIES: process.env.YT_DLP_COOKIES ?? 'none' } });
    const errors = new Response(proc.stderr).text();
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (proc.exitCode !== null || force) return;
      try { if (persistent) process.kill(-proc.pid, 'SIGINT'); else proc.kill('SIGTERM'); }
      catch { /* setsid may still be starting; the forced stop covers it. */ }
      force = setTimeout(() => {
        try { if (persistent) process.kill(-proc.pid, 'SIGKILL'); } catch { /* Already exited. */ }
        try { proc.kill('SIGKILL'); } catch { /* Already exited. */ }
      }, 3000);
    };
    cancellation.signal.addEventListener('abort', stop, { once: true });
    try {
      let pending = '';
      for await (const chunk of proc.stdout) {
        pending += new TextDecoder().decode(chunk);
        const lines = pending.split('\n'); pending = lines.pop()!;
        for (const line of lines.filter(Boolean)) {
          const event = JSON.parse(line);
          if (event.type === 'error' || event.type === 'cancelled') throw new Error(event.message);
          if (event.type === 'formats') {
            discoveryMs = performance.now() - started;
            if (persistent) {
              selectedAt = performance.now();
              proc.stdin.write(JSON.stringify({ url: normalizedUrl, mode, id: format, directory: join(directory, kind) }) + '\n');
              proc.stdin.end();
            }
          }
          if (event.type === 'progress' && firstProgress === null) firstProgress = performance.now() - selectedAt;
          if (event.type === 'complete') completed = true;
        }
      }
      if (await proc.exited) throw new Error(await errors);
    } finally {
      if (proc.exitCode === null) { stop(); await proc.exited; }
      clearTimeout(force);
      cancellation.signal.removeEventListener('abort', stop);
    }
    cancellation.signal.throwIfAborted();
  }
  if (kind === 'bun-cli') {
    await run([process.execPath, cli, '--json', 'formats', normalizedUrl], false);
    selectedAt = performance.now();
    await run([process.execPath, cli, '--json', 'download', normalizedUrl, mode, format, join(directory, kind)], false);
  } else await run(['setsid', 'gjs', '-m', worker, 'formats', normalizedUrl], true);
  if (!completed) throw new Error(`${kind} did not complete the download.`);
  return { discoveryMs, selectionToProgressMs: firstProgress, selectionToCompleteMs: performance.now() - selectedAt };
}
const measurements: Partial<Record<'bun-cli' | 'gjs-worker', Timing>> = {};
const order = args.includes('--gjs-first') ? ['gjs-worker', 'bun-cli'] as const : ['bun-cli', 'gjs-worker'] as const;
const cancel = () => cancellation.abort();
process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
try {
  for (const kind of order) { cancellation.signal.throwIfAborted(); measurements[kind] = await measure(kind); }
  const results = {
    note: 'Sequential single samples; network/cache effects prevent attributing timing differences to runtime alone.',
    sourceHost: new URL(url).hostname, format, mode, bun: Bun.version,
    order, bunCli: measurements['bun-cli'], gjsWorker: measurements['gjs-worker'],
  };
  const report = join(directory, 'results.json');
  await Bun.write(report, JSON.stringify(results, null, 2) + '\n');
  console.log(`Saved ${report}. Reverse test order and repeat for a meaningful comparison; keep downloaded files out of Git.`);
} catch (error) {
  if (!cancellation.signal.aborted) throw error;
  process.exitCode = 130;
  console.error('Benchmark cancelled. No further measurements were started.');
} finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
