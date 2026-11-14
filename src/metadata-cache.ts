import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VideoInfo } from './yt-dlp.ts';

/** Cache only for the confirmed download; signed media URLs never enter the repo. */
export async function withMetadataFile<T>(info: VideoInfo | undefined, use: (path?: string) => Promise<T>): Promise<T> {
  if (!info) return use();
  const directory = await mkdtemp(join(tmpdir(), 'yt-down-info-'));
  const path = join(directory, 'video.info.json');
  try {
    // Our recovery loop owns URL refresh. Otherwise --load-info-json automatically
    // re-extracts even after permanent failures such as missing disk permissions.
    const { webpage_url, ...cached } = info;
    await writeFile(path, JSON.stringify(cached), { mode: 0o600 });
    return await use(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
