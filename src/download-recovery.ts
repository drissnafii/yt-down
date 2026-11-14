import { setTimeout as delay } from 'node:timers/promises';

export class DownloadCancelledError extends Error {
  constructor() {
    super('Download cancelled. Partial files kept; choose the same URL and quality to resume.');
    this.name = 'DownloadCancelledError';
  }
}

type Failure = 'connection' | 'server' | 'refresh' | 'permanent';

export interface RecoveryOptions {
  /** Use saved metadata once; subsequent attempts use the original URL args. */
  initialArgs?: string[];
  signal?: AbortSignal;
  onRetry?: (message: string) => void;
  /** Override the backoff schedule for embedders and tests. */
  retryDelaysMs?: readonly number[];
}

// Let the outer loop re-extract fresh URLs instead of repeatedly using stale ones.
export const RECOVERY_ARGS = [
  '--continue', '--part', '--no-force-overwrites',
  '--abort-on-unavailable-fragments',
  '--retries', '0', '--fragment-retries', '0', '--extractor-retries', '0',
  '--socket-timeout', '15',
];

function classifyFailure(stderr: string): Failure {
  // Classify the final error, not unrelated extractor warnings earlier in the run.
  const errors = errorLines(stderr);
  const message = errors.filter(line => !/fragment \d+ not found, unable to continue/i.test(line)).at(-1) ?? stderr;
  if (/aria2c exited with code (?:2|6|7|19)\b/i.test(message)) return 'connection';
  if (/aria2c exited with code 22\b/i.test(message)) {
    if (/status=(?:429|5\d\d)\b/i.test(stderr)) return 'server';
    if (/status=(?:403|404|410)\b/i.test(stderr)) return 'refresh';
  }
  if (/permission denied|no space left|disk quota|read-only file system|postprocessing|ffmpeg|private video|video unavailable|sign in|not available|unsupported url|requested format.*not available|certificate verify failed/i.test(message)) {
    return 'permanent';
  }
  if (/failed to resolve|name or service not known|temporary failure in name resolution|nodename nor servname|timed? out|timeout|connection (?:reset|refused|aborted)|network is (?:unreachable|down)|no route to host|remote (?:end closed|disconnected)|incomplete read|incompleteread|bytes read, .*more expected|did not get any data blocks/i.test(message)) {
    return 'connection';
  }
  if (/HTTP Error (?:429|5\d\d)\b/i.test(message)) return 'server';
  if (/HTTP Error (?:403|410)\b/i.test(message)
    || /(?:video data|fragment).*HTTP Error 404\b/i.test(message)) return 'refresh';
  return 'permanent';
}

function errorLines(stderr: string): string[] {
  // yt-dlp may emit "ERROR: \r[download] Got error: ..." on one line.
  return stderr.replace(/\r/g, '').split('\n').filter(line => line.startsWith('ERROR:'));
}

/** Keep yt-dlp's partial files and re-run the original URL after transient errors. */
export async function runDownload(args: string[], options: RecoveryOptions = {}): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const signal = controller.signal;
  const backoff = options.retryDelaysMs?.length ? options.retryDelaysMs : [2_000, 4_000, 8_000, 16_000, 30_000];
  const report = options.onRetry ?? ((message: string) => console.error(`\n${message}`));
  let failures = 0;
  let refreshes = 0;
  let nextArgs = options.initialArgs ?? args;
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();

  try {
    while (!signal.aborted) {
      const result = await attempt([...nextArgs, ...RECOVERY_ARGS], signal);
      nextArgs = args;
      if (signal.aborted || result.cancelled) throw new DownloadCancelledError();
      if (result.exitCode === 0) return;

      const failure = classifyFailure(result.stderr);
      if (failure === 'permanent' || (failure === 'refresh' && refreshes++ >= 3)) {
        const error = errorLines(result.stderr).at(-1);
        throw new Error(`${error ?? `Download failed (yt-dlp exit code: ${result.exitCode})`}\nPartial files kept. Retry the same URL and quality to resume.`);
      }

      const waitMs = backoff[Math.min(failures++, backoff.length - 1)]!;
      const reason = failure === 'connection'
        ? 'Connection interrupted—waiting to reconnect.'
        : failure === 'refresh'
          ? 'Download URL rejected—refreshing it.'
          : 'Download server temporarily unavailable.';
      report(`${reason} Retrying in ${waitMs / 1_000}s with saved progress. Press Ctrl+C to cancel.`);
      await delay(waitMs, undefined, { signal });
    }
    throw new DownloadCancelledError();
  } catch (error) {
    if (signal.aborted) throw new DownloadCancelledError();
    throw error;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    options.signal?.removeEventListener('abort', cancel);
  }
}

async function attempt(args: string[], signal: AbortSignal) {
  const grouped = process.platform !== 'win32';
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', detached: grouped });
  const kill = (signal: 'SIGINT' | 'SIGKILL') => {
    try {
      // Include external downloaders and ffmpeg in cancellation on Unix.
      if (grouped) process.kill(-proc.pid, signal);
      else proc.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    kill('SIGINT');
    // Allow yt-dlp to close its files, but don't leave an unresponsive child behind.
    killTimer = setTimeout(() => kill('SIGKILL'), 3_000);
    killTimer.unref();
  };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  try {
    const [stdout, errors] = await Promise.all([
      forward(proc.stdout, process.stdout),
      forward(proc.stderr, process.stderr),
    ]);
    const stderr = `${stdout}\n${errors}`;
    const exitCode = await proc.exited;
    return { exitCode, stderr, cancelled: proc.signalCode === 'SIGINT' || proc.signalCode === 'SIGTERM' };
  } finally {
    signal.removeEventListener('abort', stop);
    clearTimeout(killTimer);
  }
}

async function forward(stream: ReadableStream<Uint8Array>, destination: NodeJS.WriteStream): Promise<string> {
  const decoder = new TextDecoder();
  let tail = '';
  for await (const chunk of stream) {
    destination.write(chunk);
    tail = (tail + decoder.decode(chunk, { stream: true })).slice(-32_768);
  }
  return tail + decoder.decode();
}
