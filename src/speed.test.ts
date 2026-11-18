import { expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { getTransferArgs } from './transfer-options.ts';
import { withMetadataFile } from './metadata-cache.ts';
import { parseVideoFormats, type VideoInfo } from './yt-dlp.ts';

const info: VideoInfo = {
  id: 'test', title: 'Example', webpage_url: 'https://youtu.be/test', duration: 10,
  formats: [
    { format_id: 'small', ext: 'mp4', height: 1080, fps: 30, vcodec: 'av01', acodec: 'none', filesize: 1000 },
    { format_id: 'quality', ext: 'mp4', height: 1080, fps: 60, vcodec: 'avc1', acodec: 'none', filesize: 3000 },
    { format_id: 'audio', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', filesize: 500 },
  ],
};

test('defaults to four native fragments and accepts a lower concurrency', () => {
  expect(getTransferArgs({ fragments: '4', downloader: 'native' })).toEqual(['--concurrent-fragments', '4', '--downloader', 'native']);
  expect(getTransferArgs({ fragments: '1', downloader: 'native' })).toContain('1');
});

test('optional aria2 uses four connections for HTTP and keeps DASH/HLS native', () => {
  const args = getTransferArgs({ fragments: '4', downloader: 'aria2c', findExecutable: () => '/test/aria2c' });
  expect(args).toContain('http:aria2c');
  expect(args).toContain('dash,m3u8:native');
  expect(args.join(' ')).toContain('-x4 -s4 -j1');
});

test('missing aria2 falls back before starting the transfer', () => {
  const messages: string[] = [];
  const args = getTransferArgs({ fragments: '4', downloader: 'aria2c', findExecutable: () => null, warn: message => messages.push(message) });
  expect(args).toContain('native');
  expect(args).not.toContain('http:aria2c');
  expect(messages).toHaveLength(1);
});

test.each(['0', '-1', '1.5', '17', 'NaN', ''])('rejects invalid fragment count %s', fragments => {
  expect(() => getTransferArgs({ fragments })).toThrow('YT_DOWN_FRAGMENTS');
});

test('rejects an unknown downloader', () => {
  expect(() => getTransferArgs({ fragments: '4', downloader: 'unknown' })).toThrow('YT_DOWN_DOWNLOADER');
});

test('picker shows a smaller choice, frame rate, and the full audio+video size', () => {
  const [quality, smaller] = parseVideoFormats(info);
  expect(quality?.formatId).toBe('quality+audio');
  expect(quality?.filesize).toBe(3500);
  expect(quality?.fps).toBe(60);
  expect(smaller?.formatId).toBe('small+audio');
  expect(smaller?.filesize).toBe(1500);
  expect(smaller?.variant).toBe('smaller');
});

test('combined formats include audio already and do not add it again', () => {
  const [combined] = parseVideoFormats({ ...info, formats: [{ format_id: 'combined', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'mp4a', filesize: 1000 }] });
  expect(combined?.filesize).toBe(1000);
  expect(combined?.formatId).toBe('combined');
});

test('marks approximate totals and does not advertise a partial known size as total', () => {
  const approximate = structuredClone(info);
  approximate.formats[2]!.filesize = undefined;
  approximate.formats[2]!.filesize_approx = 500;
  expect(parseVideoFormats(approximate)[0]?.sizeEstimated).toBe(true);
  approximate.formats[2]!.filesize_approx = undefined;
  expect(parseVideoFormats(approximate)[0]?.filesize).toBeNull();
});

test('does not offer duplicate smaller options when savings are insignificant', () => {
  const close = structuredClone(info);
  close.formats[0]!.filesize = 2999;
  expect(parseVideoFormats(close)).toHaveLength(1);
});

test('cached metadata is private, preserves formats, and is deleted after use', async () => {
  let path: string | undefined;
  await withMetadataFile(info, async value => {
    path = value;
    expect(statSync(path!).mode & 0o777).toBe(0o600);
    const cached = await Bun.file(path!).json();
    expect(cached.formats).toEqual(info.formats);
    expect(cached.webpage_url).toBeUndefined();
  });
  expect(existsSync(path!)).toBe(false);
});

test('cache is cleaned after failures and no file is needed without metadata', async () => {
  let path: string | undefined;
  await expect(withMetadataFile(info, async value => { path = value; throw new Error('cancelled'); })).rejects.toThrow('cancelled');
  expect(existsSync(path!)).toBe(false);
  await withMetadataFile(undefined, async value => { expect(value).toBeUndefined(); });
});

test('a video with no separate audio track does not request nonexistent bestaudio', () => {
  const [video] = parseVideoFormats({ ...info, formats: [{ format_id: 'http', ext: 'mp4', height: 720, filesize: 1024 }] });
  expect(video?.formatId).toBe('http');
  expect(video?.filesize).toBe(1024);
});
