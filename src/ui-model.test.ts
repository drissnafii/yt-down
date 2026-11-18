import { expect, test } from 'bun:test';
import { normalizeYouTubeUrl, normalizeVideoUrl } from './utils.ts';
import { automaticChoice, groupChoices, choiceKey, choiceLabel, higherQualityHint, qualityBadge } from '../extension/src/choices.ts';
import type { DownloadChoice } from './protocol.ts';

for (const url of [
  ' https://youtu.be/abc_DEF-12?si=tracking ',
  'youtube.com/watch?list=PLAYLIST&v=abc_DEF-12&t=12',
  'https://m.youtube.com/shorts/abc_DEF-12?si=tracking',
  'https://music.youtube.com/watch?v=abc_DEF-12',
  'https://www.youtube.com/live/abc_DEF-12?feature=share',
  'https://youtube.com/embed/abc_DEF-12',
  '<https://youtu.be/abc_DEF-12>',
  'https:// youtu.be/abc_DEF-12',
]) {
  test(`normalizes shared YouTube link: ${url}`, () => {
    expect(normalizeYouTubeUrl(url)).toBe('https://www.youtube.com/watch?v=abc_DEF-12');
  });
}
for (const url of ['https://youtube.com.evil.test/watch?v=abc', 'https://youtube.com@evil.test/watch?v=abc',
  'https://notyoutube.com/watch?v=abc', 'file:///tmp/video', 'javascript:alert(1)', 'https://youtube.com/playlist?list=abc']) {
  test(`rejects unsupported link: ${url}`, () => expect(normalizeYouTubeUrl(url)).toBeNull());
}

const choices: DownloadChoice[] = [
  { id: 'best', label: 'Best quality', mode: 'video' },
  ...[2160, 1080, 720, 480, 360].map(height => ({ id: String(height), label: `${height}p`, mode: 'video' as const, height, variant: 'quality' as const })),
  { id: 'small', label: '1080p', mode: 'video', height: 1080, variant: 'smaller' },
  { id: 'best', label: 'Audio only', mode: 'mp3' },
  { id: '140', label: 'AAC', mode: 'audio' },
];

test('presets reduce choices without hiding the rest or duplicating variants', () => {
  const { primary, more } = groupChoices(choices);
  expect(primary.map(choiceKey)).toEqual(['video:1080:quality', 'video:720:quality', 'mp3:best']);
  expect(new Set([...primary, ...more]).size).toBe(choices.length);
  expect(primary).toHaveLength(3);
});

test('other qualities remain behind Show more; missing presets are not invented', () => {
  const { primary, more } = groupChoices(choices);
  expect(primary.some(choice => choice.height === 480)).toBe(false);
  expect(more[0]?.height).toBe(2160);
  expect(more.some(choice => choice.height === 480)).toBe(true);
  const available = groupChoices(choices.filter(c => c.height !== 1080 && c.height !== 720));
  expect(available.primary.map(choiceKey)).toEqual(['video:2160:quality', 'mp3:best']);
});

test('simple resolution labels and high-quality availability remain accurate', () => {
  expect(choiceLabel({ id: '137', mode: 'video', label: 'verbose', height: 1080, fps: 60 })).toBe('1080p');
  expect(higherQualityHint(choices)).toBe('4K available');
  expect(higherQualityHint([{ id: 'x', mode: 'video', label: '', height: 1440 }])).toBe('1440p available');
  expect(higherQualityHint([{ id: 'x', mode: 'video', label: '', height: 4320 }])).toBe('8K available');
  expect(higherQualityHint(choices.filter(c => (c.height ?? 0) <= 1080))).toBe('');
  expect(qualityBadge({ id: 'x', mode: 'video', label: '', height: 2160 })).toBe('4K');
});


test('nonstandard resolutions show the highest video and audio on the first view', () => {
  const available: DownloadChoice[] = [
    { id: 'best', mode: 'video', label: 'Best available' },
    ...[818, 1634, 1090, 544, 364, 272, 182, 128].map(height => ({
      id: String(height), label: `${height}p`, mode: 'video' as const, height, variant: 'quality' as const,
    })),
    { id: 'small', mode: 'video', label: '1634p', height: 1634, variant: 'smaller' },
    { id: 'best', mode: 'mp3', label: 'Audio' },
  ];
  const { primary, more } = groupChoices(available);
  expect(primary.map(choiceKey)).toEqual(['video:1634:quality', 'mp3:best']);
  expect(more.some(choice => choice.id === '1634')).toBe(false);
  expect(more.some(choice => choice.id === '1090')).toBe(true);
  expect(new Set([...primary, ...more]).size).toBe(available.length);
  expect(higherQualityHint(more, 1634)).toBe('');
});

test('audio-only sources stay audio-only; automatic video is a fallback without heights', () => {
  const audio: DownloadChoice = { id: 'best', mode: 'mp3', label: 'Audio' };
  expect(groupChoices([audio]).primary).toEqual([audio]);
  const video: DownloadChoice = { id: 'best', mode: 'video', label: 'Best available' };
  expect(groupChoices([video, audio]).primary).toEqual([video, audio]);
});

for (const url of [
  'https://de.pornhub.com/view_video.php?viewkey=6af5118b07e59',
  'https://vimeo.com/123456',
  'https://cdn.example.com/video.mp4?token=ABC%2F123&expires=123#video',
]) {
  test(`accepts other video sources without changing query parameters: ${url}`, () => {
    expect(normalizeVideoUrl(url)).toBe(url);
  });
}
test('general video validation preserves YouTube normalization and accepts bare domains', () => {
  expect(normalizeVideoUrl(' https://youtu.be/abc_DEF-12?si=tracking ')).toBe('https://www.youtube.com/watch?v=abc_DEF-12');
  expect(normalizeVideoUrl('<vimeo.com/123>')).toBe('https://vimeo.com/123');
});
for (const url of ['file:///etc/passwd', 'javascript:alert(1)', '--exec', 'https://user:pass@example.com/video',
  'https://example.com:99999/video', 'https://example.com/has space', 'ftp://example.com/video', 'https://example.com\\evil']) {
  test(`rejects invalid or non-HTTP video input: ${url}`, () => expect(normalizeVideoUrl(url)).toBeNull());
}
test('automatic download uses a compatible preset and falls back to best video', () => {
  expect(automaticChoice(choices, 'video:720:quality')?.height).toBe(720);
  expect(automaticChoice(choices, 'video:1080:smaller')?.id).toBe('small');
  expect(automaticChoice(choices, 'video:1440:quality')?.id).toBe('best');
  expect(automaticChoice(choices, '')?.mode).toBe('video');
  expect(automaticChoice(choices, 'mp3:best')?.mode).toBe('mp3');
  expect(automaticChoice(choices, 'audio:140')?.mode).toBe('video');
  expect(automaticChoice([], '')).toBeUndefined();
});
