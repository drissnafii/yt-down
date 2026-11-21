import { homedir } from 'node:os';
import { join } from 'node:path';
import { statSync } from 'node:fs';

interface CookieOptions {
  browser?: string;
  home?: string;
  configHome?: string;
}

/** Zen uses Firefox's cookie format, but stores profiles in its own directory. */
export function getCookieArgs({
  browser = Bun.env.YT_DLP_COOKIES,
  home = homedir(),
  configHome = Bun.env.XDG_CONFIG_HOME ?? join(home, '.config'),
}: CookieOptions = {}): string[] {
  if (!browser || browser === 'none') return [];
  if (browser !== 'zen' && browser !== 'auto') return ['--cookies-from-browser', browser];

  const zenRoots = [
    join(configHome, 'zen'),
    join(home, '.zen'),
    join(home, '.var/app/app.zen_browser.zen/config/zen'),
    join(home, '.var/app/app.zen_browser.zen/.zen'),
  ];
  const zenRoot = findCookieRoot(zenRoots);
  if (zenRoot) return ['--cookies-from-browser', `firefox:${zenRoot}`];

  if (browser === 'zen') {
    throw new Error('No Zen cookies database found. Open Zen and visit YouTube first, or set YT_DLP_COOKIES="firefox:/path/to/zen/profile".');
  }

  const firefoxRoot = findCookieRoot([
    join(configHome, 'mozilla/firefox'),
    join(home, '.mozilla/firefox'),
    join(home, '.var/app/org.mozilla.firefox/config/mozilla/firefox'),
    join(home, '.var/app/org.mozilla.firefox/.mozilla/firefox'),
    join(home, 'snap/firefox/common/.mozilla/firefox'),
  ]);
  return firefoxRoot ? ['--cookies-from-browser', `firefox:${firefoxRoot}`] : [];
}

function findCookieRoot(roots: string[]): string | undefined {
  let newestRoot: string | undefined;
  let newestTime = -Infinity;
  for (const root of roots) {
    try {
      for (const database of new Bun.Glob('**/cookies.sqlite').scanSync({ cwd: root, absolute: true })) {
        const modified = statSync(database).mtimeMs;
        if (modified > newestTime) {
          newestRoot = root;
          newestTime = modified;
        }
      }
    } catch {
      // Missing or inaccessible browser directories are normal.
    }
  }
  return newestRoot;
}
