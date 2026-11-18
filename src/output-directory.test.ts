import { expect, test } from 'bun:test';
import { posix, win32 } from 'node:path';
import { getOutputDirectory } from './output-directory.ts';

test('Windows defaults use the current user instead of a hardcoded Linux home', () => {
  expect(getOutputDirectory({ directory: '', home: 'C:\\Users\\Alice', paths: win32 }))
    .toBe('C:\\Users\\Alice\\Videos\\yt-down');
});

test('Windows custom output directories preserve drives and spaces', () => {
  expect(getOutputDirectory({ directory: 'D:\\My Downloads\\YouTube', paths: win32 }))
    .toBe('D:\\My Downloads\\YouTube');
});

test('Linux defaults remain in the current user Videos folder', () => {
  expect(getOutputDirectory({ directory: '', home: '/home/alice', paths: posix }))
    .toBe('/home/alice/Videos/yt-down');
});

test('blank overrides fall back, and custom paths are normalized', () => {
  expect(getOutputDirectory({ directory: '  ', home: 'C:\\Users\\Alice', paths: win32 }))
    .toBe('C:\\Users\\Alice\\Videos\\yt-down');
  expect(getOutputDirectory({ directory: ' D:\\Downloads\\temp\\..\\YouTube ', paths: win32 }))
    .toBe('D:\\Downloads\\YouTube');
});

test('YouTube links stay in the main folder, including mobile and short links', () => {
  for (const url of ['https://www.youtube.com/watch?v=test', 'https://m.youtube.com/shorts/test',
    'https://youtu.be/test', 'https://www.youtube-nocookie.com/embed/test']) {
    expect(getOutputDirectory({ directory: '', home: '/home/alice', paths: posix, url }))
      .toBe('/home/alice/Videos/yt-down');
  }
});

test('other sites use other_sites under the default or custom folder on both platforms', () => {
  for (const url of ['https://de.pornhub.com/view_video.php?viewkey=test', 'https://vimeo.com/123',
    'https://cdn.example.com/video.mp4', 'https://youtube.com.example.com/watch?v=test']) {
    expect(getOutputDirectory({ directory: '', home: '/home/alice', paths: posix, url }))
      .toBe('/home/alice/Videos/yt-down/other_sites');
    expect(getOutputDirectory({ directory: '/tmp/custom', paths: posix, url }))
      .toBe('/tmp/custom/other_sites');
    expect(getOutputDirectory({ directory: 'D:\\My Downloads', paths: win32, url }))
      .toBe('D:\\My Downloads\\other_sites');
  }
});
