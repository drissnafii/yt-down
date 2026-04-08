/**
 * yt-dlp wrapper — all yt-dlp interactions go through this module.
 * Uses Bun.spawn() for async, non-blocking execution.
 */

import { formatBytes, getCodecLabel, getAudioCodecLabel } from './utils.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface YtDlpFormat {
  format_id: string;
  ext: string;
  resolution?: string;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  vcodec?: string;
  acodec?: string;
  filesize?: number | null;
  filesize_approx?: number | null;
  tbr?: number | null;   // total bitrate
  abr?: number | null;   // audio bitrate
  asr?: number | null;   // audio sample rate
  format_note?: string;
}

export interface VideoInfo {
  id: string;
  title: string;
  duration: number | null;
  thumbnail?: string;
  channel?: string;
  upload_date?: string;
  view_count?: number;
  description?: string;
  formats: YtDlpFormat[];
  webpage_url: string;
}

export interface FormattedFormat {
  formatId: string;
  resolution: string;
  height: number;
  ext: string;
  filesize: number | null;
  filesizeLabel: string;
  codec: string;
  displayLabel: string;
  isCombined: boolean;  // true for formats that have both video+audio
}

export interface FormattedAudioFormat {
  formatId: string;
  ext: string;
  filesize: number | null;
  filesizeLabel: string;
  codec: string;
  bitrate: number;
  bitrateLabel: string;
  displayLabel: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const YT_DLP_BIN = '/usr/bin/yt-dlp';
const OUTPUT_DIR = '/home/dendo/Videos/yt-down';

// ─── Video Info ──────────────────────────────────────────────────────────────

/**
 * Fetch video metadata JSON using yt-dlp -j
 */
export async function getVideoInfo(url: string): Promise<VideoInfo> {
  const proc = Bun.spawn([YT_DLP_BIN, '-j', '--no-playlist', url], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    // Extract meaningful error from stderr
    const errorLines = stderr.trim().split('\n');
    const errorMsg = errorLines
      .filter((line) => line.startsWith('ERROR:'))
      .map((line) => line.replace('ERROR: ', ''))
      .join('; ');

    throw new Error(errorMsg || `yt-dlp exited with code ${exitCode}`);
  }

  try {
    const info = JSON.parse(stdout) as VideoInfo;
    return info;
  } catch {
    throw new Error('Failed to parse yt-dlp JSON output');
  }
}

// ─── Format Parsing ─────────────────────────────────────────────────────────

/**
 * Parse video formats: filter video-only, group by resolution, pick best per group.
 * Also includes combined formats (like format 18 which has both video+audio).
 */
export function parseVideoFormats(info: VideoInfo): FormattedFormat[] {
  const formats = info.formats ?? [];

  // Separate video-only and combined (video+audio) formats
  const videoFormats = formats.filter(
    (f) =>
      f.vcodec !== 'none' &&
      f.vcodec !== undefined &&
      f.height !== null &&
      f.height !== undefined &&
      f.height > 0
  );

  // Group by height, keeping best per resolution
  const byHeight = new Map<number, YtDlpFormat>();

  for (const fmt of videoFormats) {
    const h = fmt.height!;
    const existing = byHeight.get(h);

    if (!existing) {
      byHeight.set(h, fmt);
      continue;
    }

    // Prefer larger filesize (better quality) when comparing same resolution
    const fmtSize = fmt.filesize ?? fmt.filesize_approx ?? 0;
    const existingSize = existing.filesize ?? existing.filesize_approx ?? 0;

    // Prefer combined formats for low resolutions, otherwise pick best quality
    const fmtIsCombined = fmt.acodec !== 'none' && fmt.acodec !== undefined;
    const existingIsCombined = existing.acodec !== 'none' && existing.acodec !== undefined;

    if (fmtIsCombined && !existingIsCombined && h <= 360) {
      byHeight.set(h, fmt);
    } else if (fmtSize > existingSize) {
      byHeight.set(h, fmt);
    }
  }

  // Sort descending by height
  const sorted = [...byHeight.entries()]
    .sort(([a], [b]) => b - a)
    .map(([height, fmt]) => {
      const isCombined = fmt.acodec !== 'none' && fmt.acodec !== undefined;
      const filesize = fmt.filesize ?? fmt.filesize_approx ?? null;
      const vcodecLabel = getCodecLabel(fmt.vcodec);
      const acodecLabel = isCombined ? getAudioCodecLabel(fmt.acodec) : '';
      const codecDisplay = isCombined && acodecLabel
        ? `${vcodecLabel}+${acodecLabel}`
        : vcodecLabel;

      const resolutionLabel = getResolutionLabel(height);

      return {
        formatId: isCombined ? fmt.format_id : `${fmt.format_id}+bestaudio`,
        resolution: resolutionLabel,
        height,
        ext: fmt.ext,
        filesize,
        filesizeLabel: formatBytes(filesize),
        codec: codecDisplay,
        displayLabel: `${resolutionLabel}  │  ${formatBytes(filesize)}  │  ${codecDisplay}`,
        isCombined,
      };
    });

  return sorted;
}

/**
 * Parse audio formats: filter audio-only, sort by bitrate descending.
 */
export function parseAudioFormats(info: VideoInfo): FormattedAudioFormat[] {
  const formats = info.formats ?? [];

  const audioFormats = formats.filter(
    (f) =>
      (f.vcodec === 'none' || f.vcodec === undefined) &&
      f.acodec !== 'none' &&
      f.acodec !== undefined
  );

  // Group by codec type, pick best bitrate per codec
  const byCodec = new Map<string, YtDlpFormat>();

  for (const fmt of audioFormats) {
    const codec = getAudioCodecLabel(fmt.acodec);
    const existing = byCodec.get(codec);

    if (!existing) {
      byCodec.set(codec, fmt);
      continue;
    }

    const fmtBitrate = fmt.abr ?? fmt.tbr ?? 0;
    const existingBitrate = existing.abr ?? existing.tbr ?? 0;

    if (fmtBitrate > existingBitrate) {
      byCodec.set(codec, fmt);
    }
  }

  return [...byCodec.entries()]
    .sort(([, a], [, b]) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))
    .map(([codec, fmt]) => {
      const filesize = fmt.filesize ?? fmt.filesize_approx ?? null;
      const bitrate = fmt.abr ?? fmt.tbr ?? 0;
      const bitrateLabel = `${Math.round(bitrate)}kbps`;

      return {
        formatId: fmt.format_id,
        ext: fmt.ext,
        filesize,
        filesizeLabel: formatBytes(filesize),
        codec,
        bitrate,
        bitrateLabel,
        displayLabel: `${bitrateLabel} ${codec} (.${fmt.ext})  │  ${formatBytes(filesize)}`,
      };
    });
}

// ─── Download ────────────────────────────────────────────────────────────────

/**
 * Download video/audio with yt-dlp. Uses stdio:'inherit' for live progress.
 */
export async function downloadVideo(
  url: string,
  formatId: string,
  outputDir: string = OUTPUT_DIR
): Promise<string> {
  // Ensure output dir exists
  await Bun.spawn(['mkdir', '-p', outputDir], { stdout: 'ignore', stderr: 'ignore' }).exited;

  const outputTemplate = `${outputDir}/%(title)s.%(ext)s`;

  const args = [
    YT_DLP_BIN,
    '-f', formatId,
    '-o', outputTemplate,
    '--no-playlist',
    '--merge-output-format', 'mp4',
    '--progress',
    url,
  ];

  const proc = Bun.spawn(args, {
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`Download failed (yt-dlp exit code: ${exitCode})`);
  }

  return outputDir;
}

/**
 * Download audio only with yt-dlp.
 */
export async function downloadAudio(
  url: string,
  formatId: string,
  outputDir: string = OUTPUT_DIR
): Promise<string> {
  // Ensure output dir exists
  await Bun.spawn(['mkdir', '-p', outputDir], { stdout: 'ignore', stderr: 'ignore' }).exited;

  const outputTemplate = `${outputDir}/%(title)s.%(ext)s`;

  const args = [
    YT_DLP_BIN,
    '-f', formatId,
    '-o', outputTemplate,
    '--no-playlist',
    '--progress',
    url,
  ];

  const proc = Bun.spawn(args, {
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`Download failed (yt-dlp exit code: ${exitCode})`);
  }

  return outputDir;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getResolutionLabel(height: number): string {
  const labels: Record<number, string> = {
    2160: '2160p (4K)',
    1440: '1440p',
    1080: '1080p',
    720: '720p',
    480: '480p',
    360: '360p',
    240: '240p',
    144: '144p',
  };

  return labels[height] ?? `${height}p`;
}
