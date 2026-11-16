/**
 * yt-dlp wrapper — all yt-dlp interactions go through this module.
 * Uses Bun.spawn() for async, non-blocking execution.
 */

import { formatBytes, getCodecLabel, getAudioCodecLabel } from './utils.ts';
import { getCookieArgs } from './cookies.ts';
import { runDownload, type RecoveryOptions } from './download-recovery.ts';
import { mkdir } from 'node:fs/promises';
import { withMetadataFile } from './metadata-cache.ts';
import { getTransferArgs } from './transfer-options.ts';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

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
  variant: 'quality' | 'smaller';
  fps: number | null;
  sizeEstimated: boolean;
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

// Prefer ~/.local/bin/yt-dlp (installed via pipx, kept up-to-date) over
// the system package (typically outdated). Falls back to env override or PATH.
const LOCAL_YT_DLP = join(homedir(), '.local/bin/yt-dlp');
const YT_DLP_BIN = Bun.env.YT_DLP_BIN ?? (Bun.file(LOCAL_YT_DLP).size > 0 ? LOCAL_YT_DLP : 'yt-dlp');
const OUTPUT_DIR = join(homedir(), 'Videos/yt-down');

function getJsRuntimeArgs(): string[] {
  if (Bun.env.YT_DLP_JS_RUNTIME) {
    // User explicitly set a single runtime — honour it with the correct flag format
    return ['--js-runtimes', Bun.env.YT_DLP_JS_RUNTIME];
  }

  // Build a list of available runtimes in priority order (highest first).
  // yt-dlp requires one --js-runtimes flag *per runtime* (not comma-separated).
  const candidates: Array<string | null> = [
    getSupportedRuntime('deno'),
    getSupportedRuntime('node'),   // Node.js (nvm / system)
    getSupportedBunRuntime(),      // Bun 1.2+
    getSupportedRuntime('qjs', 'quickjs'),
  ];

  const args: string[] = [];
  for (const runtime of candidates) {
    if (runtime !== null) {
      args.push('--js-runtimes', runtime);
    }
  }
  return args;
}

function getBaseArgs(): string[] {
  return [YT_DLP_BIN, ...getJsRuntimeArgs(), ...getCookieArgs(), '--no-playlist'];
}

function getSupportedRuntime(command: string, runtime = command): string | null {
  const proc = Bun.spawnSync(['which', command], {
    stdout: 'ignore',
    stderr: 'ignore',
  });

  return proc.exitCode === 0 ? runtime : null;
}

function getSupportedBunRuntime(): string | null {
  // This backend is already running in Bun. An absolute path also works when
  // launched by GNOME without an interactive shell's runtime PATH.
  return isSupportedBunVersion(Bun.version) ? `bun:${process.execPath}` : null;
}

function isSupportedBunVersion(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return false;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);

  // Bun >= 1.2 is supported as a yt-dlp JS runtime (no upper cap).
  return major > 1 || (major === 1 && minor >= 2);
}

// ─── Video Info ──────────────────────────────────────────────────────────────

/**
 * Fetch video metadata JSON using yt-dlp -j
 */
export async function getVideoInfo(url: string, signal?: AbortSignal): Promise<VideoInfo> {
  const proc = Bun.spawn([...getBaseArgs(), '-j', url], {
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
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
  const available = info.formats ?? [];
  const audio = available.filter(isAudioOnly).at(-1);
  const groups = new Map<number, YtDlpFormat[]>();
  for (const format of available) {
    if (!format.vcodec || format.vcodec === 'none' || !format.height || format.height <= 0) continue;
    const group = groups.get(format.height) ?? [];
    group.push(format);
    groups.set(format.height, group);
  }

  function describe(fmt: YtDlpFormat, variant: 'quality' | 'smaller'): FormattedFormat {
    const combined = Boolean(fmt.acodec && fmt.acodec !== 'none');
    const videoSize = estimateSize(fmt, info.duration);
    const audioSize = audio ? estimateSize(audio, info.duration) : null;
    const size = combined ? videoSize : videoSize && audioSize
      ? { bytes: videoSize.bytes + audioSize.bytes, estimated: videoSize.estimated || audioSize.estimated }
      : null;
    const codec = [getCodecLabel(fmt.vcodec), getAudioCodecLabel(combined ? fmt.acodec : audio?.acodec)].filter(Boolean).join('+');
    const resolution = getResolutionLabel(fmt.height!);
    const sizeLabel = size ? `${size.estimated ? '~ ' : ''}${formatBytes(size.bytes)}` : '~ unknown';
    const fps = fmt.fps ?? null;
    return {
      formatId: combined ? fmt.format_id : `${fmt.format_id}+${audio?.format_id ?? 'bestaudio'}`,
      resolution,
      height: fmt.height!,
      ext: fmt.ext,
      filesize: size?.bytes ?? null,
      filesizeLabel: sizeLabel,
      sizeEstimated: size?.estimated ?? false,
      codec,
      displayLabel: `${resolution}${fps ? ` ${fps}fps` : ''} (${variant === 'smaller' ? 'smaller file' : 'quality'})  │  ${sizeLabel} total  │  ${codec}`,
      isCombined: combined,
      variant,
      fps,
    };
  }

  return [...groups.entries()].sort(([a], [b]) => b - a).flatMap(([, formats]) => {
    // yt-dlp lists formats from worst to best, accounting for codec and frame rate.
    const quality = describe(formats.at(-1)!, 'quality');
    const smaller = formats.map(fmt => describe(fmt, 'smaller'))
      .filter(fmt => fmt.filesize !== null)
      .sort((a, b) => a.filesize! - b.filesize!)[0];
    // Avoid duplicate choices when estimated savings are negligible or unknown.
    return smaller && quality.filesize !== null && smaller.formatId !== quality.formatId
      && smaller.filesize! < quality.filesize * 0.9 ? [quality, smaller] : [quality];
  });
}

function isAudioOnly(format: YtDlpFormat): boolean {
  return (!format.vcodec || format.vcodec === 'none') && Boolean(format.acodec && format.acodec !== 'none');
}

function estimateSize(format: YtDlpFormat, duration: number | null): { bytes: number; estimated: boolean } | null {
  if (format.filesize && format.filesize > 0) return { bytes: format.filesize, estimated: false };
  if (format.filesize_approx && format.filesize_approx > 0) return { bytes: format.filesize_approx, estimated: true };
  const bitrate = format.tbr ?? (isAudioOnly(format) ? format.abr : undefined);
  if (duration && duration > 0 && bitrate && bitrate > 0) {
    return { bytes: Math.round(bitrate * 1_000 * duration / 8), estimated: true };
  }
  return null;
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
 * Download video/audio with live progress and automatic interruption recovery.
 */
export async function downloadVideo(
  url: string,
  formatId: string,
  outputDir: string = OUTPUT_DIR,
  info?: VideoInfo,
  options?: RecoveryOptions,
): Promise<string> {
  return download(url, formatId, outputDir, info, ['--merge-output-format', 'mp4'], options);
}

/** Download audio using the same metadata reuse, transfer, and recovery settings. */
export async function downloadAudio(
  url: string,
  formatId: string,
  outputDir: string = OUTPUT_DIR,
  info?: VideoInfo,
  options?: RecoveryOptions,
): Promise<string> {
  return download(url, formatId, outputDir, info, [], options);
}

async function download(url: string, formatId: string, outputDir: string, info?: VideoInfo, extra: string[] = [], options: RecoveryOptions = {}): Promise<string> {
  const outputPath = resolve(outputDir);
  const transferArgs = getTransferArgs();
  // aria2 may create sparse partial files. Keep them apart from native partials,
  // which resume by byte length, so switching downloaders cannot corrupt a file.
  if (transferArgs.includes('http:aria2c')) transferArgs.push('--paths', `temp:${join(outputPath, '.aria2')}`);
  const args = [
    ...getBaseArgs(), ...transferArgs,
    '-f', formatId, '--paths', outputPath, '-o', '%(title)s.%(ext)s',
    ...extra, '--progress',
    ...(options.onOutput ? ['--newline', '--progress-delta', '0.3', '--progress-template',
      'download:yt-down-progress:%(progress)j', '--print', 'after_move:yt-down-file:%(filepath)j'] : []),
  ];
  await mkdir(outputDir, { recursive: true });
  await withMetadataFile(info, async path => {
    await runDownload([...args, url], {
      ...options,
      initialArgs: path ? [...args, '--load-info-json', path] : undefined,
    });
  });
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
