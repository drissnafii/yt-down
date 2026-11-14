import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getCookieArgs } from './cookies.ts';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'yt-down-cookies-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function args(browser?: string, configHome = join(home, '.config')) {
  return getCookieArgs({ home, configHome, browser: browser ?? '' });
}

function database(relative: string) {
  const path = join(home, relative, 'cookies.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'test fixture');
  return path;
}

test('uses Arch Zen profiles with spaces through the Firefox reader', () => {
  database('.config/zen/profile.Default (release)');
  expect(args()).toEqual(['--cookies-from-browser', `firefox:${home}/.config/zen`]);
});

test('honors XDG_CONFIG_HOME', () => {
  database('custom-config/zen/profile');
  expect(args('', join(home, 'custom-config'))).toEqual([
    '--cookies-from-browser', `firefox:${home}/custom-config/zen`,
  ]);
});

test('finds legacy and Flatpak Zen profiles', () => {
  for (const root of ['.zen', '.var/app/app.zen_browser.zen/.zen', '.var/app/app.zen_browser.zen/config/zen']) {
    database(`${root}/profile`);
    expect(args('zen')).toEqual(['--cookies-from-browser', `firefox:${home}/${root}`]);
    rmSync(join(home, root), { recursive: true });
  }
});

test('prefers Zen over Firefox, and the newest Zen installation', () => {
  const old = database('.zen/profile');
  utimesSync(old, 1, 1);
  database('.config/zen/profile');
  database('.mozilla/firefox/profile');
  expect(args()).toEqual(['--cookies-from-browser', `firefox:${home}/.config/zen`]);
});

test('falls back to Firefox when Zen has no cookie database', () => {
  mkdirSync(join(home, '.config/zen'), { recursive: true });
  database('.mozilla/firefox/profile');
  expect(args()).toEqual(['--cookies-from-browser', `firefox:${home}/.mozilla/firefox`]);
});

test('runs without cookies when no browser database exists', () => {
  expect(args()).toEqual([]);
});

test('preserves explicit browser, profile, container, and disable overrides', () => {
  database('.config/zen/profile');
  for (const browser of ['chrome', 'firefox', 'firefox:/custom/profile::Work']) {
    expect(args(browser)).toEqual(['--cookies-from-browser', browser]);
  }
  expect(args('none')).toEqual([]);
});

test('explicit Zen selection explains missing profiles', () => {
  expect(() => args('zen')).toThrow('No Zen cookies database found');
});
