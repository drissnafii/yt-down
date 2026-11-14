interface TransferOptions {
  fragments?: string;
  downloader?: string;
  findExecutable?: (name: string) => string | null;
  warn?: (message: string) => void;
}

export function getTransferArgs({
  fragments = Bun.env.YT_DOWN_FRAGMENTS ?? '4',
  downloader = Bun.env.YT_DOWN_DOWNLOADER ?? 'native',
  findExecutable = Bun.which,
  warn = console.error,
}: TransferOptions = {}): string[] {
  if (!/^\d+$/.test(fragments) || Number(fragments) < 1 || Number(fragments) > 16) {
    throw new Error('YT_DOWN_FRAGMENTS must be an integer from 1 to 16.');
  }
  if (downloader !== 'native' && downloader !== 'aria2c') {
    throw new Error('YT_DOWN_DOWNLOADER must be native or aria2c.');
  }
  const args = ['--concurrent-fragments', String(Number(fragments))];
  if (downloader === 'aria2c' && findExecutable('aria2c')) {
    args.push(
      '--downloader', 'http:aria2c',
      '--downloader', 'dash,m3u8:native',
      '--downloader-args', 'aria2c:-x4 -s4 -j1 --max-tries=1 --connect-timeout=15 --timeout=15 --retry-wait=0',
    );
  } else {
    if (downloader === 'aria2c') warn('aria2c is unavailable; using the native downloader.');
    args.push('--downloader', 'native');
  }
  return args;
}
