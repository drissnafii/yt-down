#!/usr/bin/env bun

/**
 * yt-down — Interactive YouTube Downloader CLI
 * Entry point
 */

import { main } from '../src/index.ts';

try {
  await main();
} catch (error) {
  if (error instanceof Error && error.message.includes('cancel')) {
    // User cancelled — exit silently
    process.exit(0);
  }

  console.error('\n❌ Unexpected error:', error instanceof Error ? error.message : error);
  process.exit(1);
}
