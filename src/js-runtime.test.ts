import { expect, test } from 'bun:test';
import { isSupportedBunVersion } from './js-runtime.ts';

test('only enables Bun versions supported by yt-dlp’s deprecated challenge solver', () => {
  for (const version of ['1.2.11', '1.2.99', '1.3.0', '1.3.14']) expect(isSupportedBunVersion(version)).toBe(true);
  for (const version of ['1.2.10', '1.3.15', '1.4.4', '2.0.0', '1.3.14-canary', 'bad']) expect(isSupportedBunVersion(version)).toBe(false);
});
