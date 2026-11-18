import type { DownloadChoice } from '../../src/protocol.js';

/** Keep the main decision small; preserve every other format under disclosure. */
export function groupChoices(choices: DownloadChoice[]) {
  const primary: DownloadChoice[] = [];
  for (const height of [1080, 720]) {
    const choice = choices.find(c => c.mode === 'video' && c.height === height && c.variant !== 'smaller');
    if (choice) primary.push(choice);
  }
  // Nonstandard aspect ratios may have no exact 1080p or 720p option.
  if (primary.length === 0) {
    const highest = choices.filter(c => c.mode === 'video' && (c.height ?? 0) > 0)
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0)
        || Number(a.variant === 'smaller') - Number(b.variant === 'smaller'))[0]
      ?? choices.find(c => c.mode === 'video' && c.id === 'best');
    if (highest) primary.push(highest);
  }
  const audio = choices.find(c => c.mode === 'mp3') ?? choices.find(c => c.mode === 'audio');
  if (audio) primary.push(audio);
  const more = choices.filter(c => !primary.includes(c));
  // Lead the expanded list with actual resolutions, keeping automatic selection last.
  more.sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  return { primary, more };
}

export function higherQualityHint(choices: DownloadChoice[], visibleHeight = 1080): string {
  const height = Math.max(0, ...choices.filter(c => c.mode === 'video').map(c => c.height ?? 0));
  if (height <= visibleHeight) return '';
  if (height >= 4320) return '8K available';
  if (height >= 2160) return '4K available';
  if (height > 1080) return `${height}p available`;
  return '';
}

export function choiceKey(choice: DownloadChoice): string {
  return choice.mode === 'video' && choice.height
    ? `video:${choice.height}:${choice.variant ?? 'quality'}` : `${choice.mode}:${choice.id}`;
}

export function choiceLabel(choice: DownloadChoice): string {
  if (choice.id === 'best' && choice.mode === 'video') return 'Best available';
  if (choice.mode === 'mp3') return 'Audio · MP3';
  if (choice.height) return `${choice.height}p${choice.variant === 'smaller' ? ' · smaller' : ''}`;
  return choice.label;
}

export function qualityBadge(choice: DownloadChoice): string {
  if (!choice.height) return '';
  if (choice.height >= 4320) return '8K';
  if (choice.height >= 2160) return '4K';
  if (choice.height >= 1440) return 'QHD';
  if (choice.height >= 1080) return 'HD';
  return '';
}
