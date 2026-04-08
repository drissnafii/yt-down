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
export function isValidYouTubeUrl(url: string): boolean {
  const patterns = [
    /^(https?:\/\/)?(www\.)?youtube\.com\/watch\?v=[\w-]+/,
    /^(https?:\/\/)?(www\.)?youtu\.be\/[\w-]+/,
    /^(https?:\/\/)?(www\.)?youtube\.com\/shorts\/[\w-]+/,
  ];

  return patterns.some((pattern) => pattern.test(url.trim()));
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
