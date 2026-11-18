import { homedir } from 'node:os';
import * as path from 'node:path';

/** One output-directory policy for the terminal CLI and downloader backend. */
export function getOutputDirectory({
  directory = Bun.env.YT_DOWN_OUTPUT_DIR,
  home = homedir(),
  paths = path,
  url,
}: { directory?: string; home?: string; paths?: Pick<typeof path, 'join' | 'resolve'>; url?: string } = {}): string {
  const root = directory?.trim() ? paths.resolve(directory.trim()) : paths.join(home, 'Videos', 'yt-down');
  if (!url) return root;
  const host = new URL(url).hostname.toLowerCase();
  const youtube = ['youtube.com', 'youtu.be', 'youtube-nocookie.com']
    .some(domain => host === domain || host.endsWith(`.${domain}`));
  return youtube ? root : paths.join(root, 'other_sites');
}
