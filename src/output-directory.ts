import { homedir } from 'node:os';
import * as path from 'node:path';

/** One output-directory policy for the terminal CLI and downloader backend. */
export function getOutputDirectory({
  directory = Bun.env.YT_DOWN_OUTPUT_DIR,
  home = homedir(),
  paths = path,
}: { directory?: string; home?: string; paths?: Pick<typeof path, 'join' | 'resolve'> } = {}): string {
  return directory?.trim() ? paths.resolve(directory.trim()) : paths.join(home, 'Videos', 'yt-down');
}
