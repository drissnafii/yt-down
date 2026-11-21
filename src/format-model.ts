import { formatBytes, getCodecLabel, getAudioCodecLabel } from './utils.js';
import type { BackendEvent } from './protocol.js';

export interface YtDlpFormat {
  format_id: string;
  ext: string;
  video_ext?: string;
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

/** Generic direct media often has an extension but no codecs or dimensions. */
export function hasVideoFormats(info: VideoInfo): boolean {
  return (info.formats ?? []).some(f => f.vcodec !== 'none' && Boolean(
    f.vcodec || f.height || (f.video_ext && f.video_ext !== 'none')
    || /^(mp4|webm|mkv|mov|flv|avi|m4v|ts|ogv)$/i.test(f.ext)));
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

/**
 * Parse video formats: filter video-only, group by resolution, pick best per group.
 * Also includes combined formats (like format 18 which has both video+audio).
 */
export function parseVideoFormats(info: VideoInfo): FormattedFormat[] {
  const available = info.formats ?? [];
  const audio = available.filter(isAudioOnly).at(-1);
  const groups = new Map<number, YtDlpFormat[]>();
  for (const format of available) {
    if (format.vcodec === 'none' || !format.height || format.height <= 0) continue;
    const group = groups.get(format.height) ?? [];
    group.push(format);
    groups.set(format.height, group);
  }

  function describe(fmt: YtDlpFormat, variant: 'quality' | 'smaller'): FormattedFormat {
    const combined = Boolean(fmt.acodec && fmt.acodec !== 'none');
    const videoSize = estimateSize(fmt, info.duration);
    const audioSize = audio ? estimateSize(audio, info.duration) : null;
    const size = combined || !audio ? videoSize : videoSize && audioSize
      ? { bytes: videoSize.bytes + audioSize.bytes, estimated: videoSize.estimated || audioSize.estimated }
      : null;
    const codec = [getCodecLabel(fmt.vcodec), getAudioCodecLabel(combined ? fmt.acodec : audio?.acodec)].filter(Boolean).join('+');
    const resolution = getResolutionLabel(fmt.height!);
    const sizeLabel = size ? `${size.estimated ? '~ ' : ''}${formatBytes(size.bytes)}` : '~ unknown';
    const fps = fmt.fps ?? null;
    return {
      formatId: combined || !audio ? fmt.format_id : `${fmt.format_id}+${audio.format_id}`,
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

export function formatChoices(info: VideoInfo): Extract<BackendEvent, { type: 'formats' }> {
  const videos = parseVideoFormats(info);
  const audio = parseAudioFormats(info);
  return { type: 'formats', title: info.title, channel: info.channel ?? '', duration: info.duration, thumbnail: info.thumbnail,
    choices: [
      ...(hasVideoFormats(info) ? [{ id: 'best', mode: 'video' as const, label: 'Best quality', sizeLabel: 'Auto' }] : []),
      ...videos.map(f => ({ id: f.formatId, mode: 'video' as const, label: f.resolution, height: f.height, fps: f.fps,
        sizeLabel: f.filesizeLabel, variant: f.variant })),
      ...((info.formats ?? []).some(f => f.acodec && f.acodec !== 'none') ? [{ id: 'best', mode: 'mp3' as const, label: 'Audio only', sizeLabel: 'MP3' }] : []),
      ...audio.map(f => ({ id: f.formatId, mode: 'audio' as const, label: `Audio · ${f.codec}`, sizeLabel: f.filesizeLabel })),
    ] };
}
