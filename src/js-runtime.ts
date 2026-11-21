/** yt-dlp's deprecated Bun challenge solver supports 1.2.11 through 1.3.14. */
export function isSupportedBunVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major === 1 && ((minor === 2 && patch! >= 11) || (minor === 3 && patch! <= 14));
}
