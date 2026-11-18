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
