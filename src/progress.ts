import type { BackendEvent } from './protocol.js';

/** Each stream gets its own parser so interleaved stdout/stderr cannot corrupt lines. */
export function createProgressParser(report: (event: BackendEvent) => void) {
  let pending = '';
  function line(value: string) {
    if (value.startsWith('yt-down-progress:')) {
      try {
        const progress = JSON.parse(value.slice('yt-down-progress:'.length));
        const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
        const downloaded = number(progress.downloaded_bytes);
        const total = number(progress.total_bytes) ?? number(progress.total_bytes_estimate);
        report({ type: 'progress',
          percent: downloaded !== null && total && total > 0 ? Math.min(100, Math.max(0, downloaded / total * 100)) : null,
          speed: number(progress.speed), eta: number(progress.eta) });
      } catch { /* Ignore incomplete or unsupported progress records. */ }
    } else if (value.startsWith('yt-down-file:')) {
      try {
        const path: unknown = JSON.parse(value.slice('yt-down-file:'.length));
        if (typeof path === 'string') report({ type: 'file', path });
      } catch { /* Not a valid output path. */ }
    } else if (/^\[(Merger|ExtractAudio|Fixup\w*)\]/.test(value)) {
      report({ type: 'status', message: 'Finishing media…' });
    }
  }
  return (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/[\r\n]/);
    pending = lines.pop()!.slice(-65_536);
    for (const value of lines) line(value);
  };
}
