/**
 * Utility functions for yt-down
 */

/**
 * Format bytes into human-readable string
 * @example formatBytes(1536) → "1.5 KB"
 * @example formatBytes(null) → "~ unknown"
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes === 0) {
    return '~ unknown';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let size = bytes;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Validate YouTube URL (youtube.com/watch, youtu.be/, youtube.com/shorts/)
 */
/** Accept common share/mobile/player URLs, discard tracking and playlist arguments. */
export function normalizeYouTubeUrl(input: string): string | null {
  const value = input.trim().replace(/^[<"']|[>"']$/g, '').replace(/\s+/g, '');
  const match = value.match(/^(?:https?:\/\/)?(?:(?:www|m|music)\.)?(youtube\.com|youtu\.be)\/([^#]*)/i);
  if (!match) return null;
  const path = match[2]!;
  const id = match[1]!.toLowerCase() === 'youtu.be'
    ? path.match(/^([\w-]+)(?:[?&#/]|$)/)?.[1]
    : path.match(/^(?:shorts|live|embed|v)\/([\w-]+)(?:[?&#/]|$)/)?.[1]
      ?? (/^watch\?/.test(path) ? path.match(/[?&]v=([\w-]+)(?:[&#]|$)/)?.[1] : undefined);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

/** Accept public HTTP(S) video links; yt-dlp determines site support.
 * Keep non-YouTube paths and query parameters intact (including signed URLs).
 * This helper also runs in GJS, which has no browser URL global.
 */
export function normalizeVideoUrl(input: string): string | null {
  const value = input.trim().replace(/^[<"']|[>"']$/g, '');
  const youtube = normalizeYouTubeUrl(value);
  if (youtube) return youtube;
  if (/\s|[\\\x00-\x1f\x7f]/.test(value)) return null;
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const match = candidate.match(/^(https?):\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])(?::([0-9]{1,5}))?([/?#].*)?$/i);
  if (!match) return null;
  const host = match[2]!;
  if (!host.includes('.') && !host.startsWith('[') && host !== 'localhost') return null;
  if (host.includes('..') || (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535))) return null;
  return `${match[1]!.toLowerCase()}://${host.toLowerCase()}${match[3] ? `:${match[3]}` : ''}${match[4] ?? '/'}`;
}

export function isValidYouTubeUrl(url: string): boolean {
  return normalizeYouTubeUrl(url) !== null;
}

/**
 * Get human-readable codec label from yt-dlp codec string
 */
export function getCodecLabel(codec: string | null | undefined): string {
  if (!codec || codec === 'none') return '';

  if (/^av01/.test(codec)) return 'AV1';
  if (/^vp0?9/.test(codec)) return 'VP9';
  if (/^avc1/.test(codec)) return 'H.264';
  if (/^hev1|^hvc1/.test(codec)) return 'HEVC';

  // Audio codecs
  if (/^opus/.test(codec)) return 'Opus';
  if (/^mp4a/.test(codec)) return 'AAC';
  if (/^vorbis/.test(codec)) return 'Vorbis';

  return codec.split('.')[0]?.toUpperCase() ?? codec;
}

/**
 * Get audio codec label
 */
export function getAudioCodecLabel(codec: string | null | undefined): string {
  if (!codec || codec === 'none') return '';
  if (/^mp4a/.test(codec)) return 'AAC';
  if (/^opus/.test(codec)) return 'Opus';
  if (/^vorbis/.test(codec)) return 'Vorbis';
  return codec.split('.')[0]?.toUpperCase() ?? codec;
}

/**
 * Right-pad a string to a given width
 */
export function padColumn(str: string, width: number): string {
  if (str.length >= width) return str;
  return str + ' '.repeat(width - str.length);
}

/**
 * Format duration in seconds to human-readable string
 * @example formatDuration(213) → "3:33"
 * @example formatDuration(3723) → "1:02:03"
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '0:00';

  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
