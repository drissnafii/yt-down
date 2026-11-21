type Failure = 'connection' | 'server' | 'refresh' | 'permanent';

// Let the outer loop re-extract fresh URLs instead of repeatedly using stale ones.
export const RECOVERY_ARGS = [
  '--continue', '--part', '--no-force-overwrites',
  '--abort-on-unavailable-fragments',
  '--retries', '0', '--fragment-retries', '0', '--extractor-retries', '0',
  '--socket-timeout', '15',
];

export function classifyFailure(stderr: string): Failure {
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

export function errorLines(stderr: string): string[] {
  // yt-dlp may emit "ERROR: \r[download] Got error: ..." on one line.
  return stderr.replace(/\r/g, '').split('\n').filter(line => line.startsWith('ERROR:'));
}
