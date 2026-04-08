/**
 * yt-down — Main interactive flow
 * Follows the same pattern as fun-cli/src/lib/navigator.ts
 */

import * as p from '@clack/prompts';
import chalk from 'chalk';
import {
  getVideoInfo,
  parseVideoFormats,
  parseAudioFormats,
  downloadVideo,
  downloadAudio,
  type VideoInfo,
} from './yt-dlp.ts';
import { isValidYouTubeUrl, formatDuration } from './utils.ts';

// ─── Constants ───────────────────────────────────────────────────────────────

const OUTPUT_DIR = '/home/dendo/Videos/yt-down';

type Mode = 'video' | 'podcast';

// ─── Logo ────────────────────────────────────────────────────────────────────

function showLogo(): void {
  const red = chalk.red.bold;
  const white = chalk.white;
  const dim = chalk.dim;

  console.log('');
  console.log(white('  ⬡ ⬢ ⬡') + '     ' + red('██╗   ██╗ ████████╗') + '        ' + red('██████╗   ██████╗  ██╗    ██╗ ███╗   ██╗'));
  console.log(white(' ⬢ ⬡ ⬢ ⬡') + '    ' + red('╚██╗ ██╔╝ ╚══██╔══╝') + '        ' + red('██╔══██╗ ██╔═══██╗ ██║    ██║ ████╗  ██║'));
  console.log(white('⬡ ⬢ ⬡ ⬢ ⬡') + '   ' + red(' ╚████╔╝     ██║   ') + red('█████╗') + ' ' + red('██║  ██║ ██║   ██║ ██║ █╗ ██║ ██╔██╗ ██║'));
  console.log(white(' ⬢ ⬡ ⬢ ⬡') + '    ' + red('  ╚██╔╝      ██║   ') + red('╚════╝') + ' ' + red('██║  ██║ ██║   ██║ ██║███╗██║ ██║╚██╗██║'));
  console.log(white('  ⬡ ⬢ ⬡') + '     ' + red('   ██║       ██║   ') + '        ' + red('██████╔╝ ╚██████╔╝ ╚███╔███╔╝ ██║ ╚████║'));
  console.log(white('   ⬢ ⬡') + '      ' + red('   ╚═╝       ╚═╝   ') + '        ' + red('╚═════╝   ╚═════╝   ╚══╝╚══╝  ╚═╝  ╚═══╝'));
  console.log('');
  console.log(dim('        Interactive YouTube Downloader  v1.0'));
  console.log('');
}

// ─── Main Flow ───────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  showLogo();

  // Step 1 — Intro
  p.intro(chalk.bgRed.white.bold(' ⬢  yt-down  ⬢ ') + chalk.dim('  Interactive YouTube Downloader'));

  // Step 2 — Select mode
  const mode = await p.select({
    message: 'What would you like to download?',
    options: [
      { value: 'video', label: `${chalk.red('⬢')} Video Download`, hint: '📹  Video + Audio merged' },
      { value: 'podcast', label: `${chalk.red('⬢')} Podcast (Audio Only)`, hint: '🎙  Best audio track' },
      { value: 'exit', label: `${chalk.dim('⬡')} Exit` },
    ],
  });

  if (p.isCancel(mode) || mode === 'exit') {
    p.outro(chalk.dim('Goodbye! 👋'));
    return;
  }

  // Step 3 — Paste URL
  const url = await p.text({
    message: 'Paste YouTube URL:',
    placeholder: 'https://youtube.com/watch?v=...',
    validate(value) {
      if (!value || value.trim().length === 0) {
        return 'URL is required';
      }
      if (!isValidYouTubeUrl(value)) {
        return 'Invalid YouTube URL. Supported: youtube.com/watch, youtu.be/, youtube.com/shorts/';
      }
    },
  });

  if (p.isCancel(url)) {
    p.outro(chalk.dim('Cancelled.'));
    return;
  }

  // Step 4 — Fetch video info
  const s = p.spinner();
  s.start('Fetching video info...');

  let info: VideoInfo;
  try {
    info = await getVideoInfo(url as string);
    s.stop(chalk.green('✓') + ' Video info fetched!');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    s.stop(chalk.red('✗') + ' Failed to fetch video info');
    p.log.error(chalk.red(`❌ ${msg}`));
    p.outro(chalk.dim('Please check the URL and try again.'));
    return;
  }

  // Step 5 — Show video details
  const duration = formatDuration(info.duration);
  const channel = info.channel ?? 'Unknown';

  p.note(
    [
      `${chalk.white.bold(info.title)}`,
      `${chalk.dim('Channel:')}  ${chalk.cyan(channel)}`,
      `${chalk.dim('Duration:')} ${chalk.yellow(duration)}`,
    ].join('\n'),
    chalk.red('⬢') + ' Video Info'
  );

  // Branch based on mode
  if (mode === 'video') {
    await handleVideoDownload(url as string, info);
  } else {
    await handlePodcastDownload(url as string, info);
  }
}

// ─── Video Download Flow ────────────────────────────────────────────────────

async function handleVideoDownload(url: string, info: VideoInfo): Promise<void> {
  const formats = parseVideoFormats(info);

  if (formats.length === 0) {
    p.log.error(chalk.red('❌ No downloadable video formats found.'));
    p.outro(chalk.dim('This video may be restricted or unsupported.'));
    return;
  }

  // Step 6 — Quality picker
  const formatOptions = [
    {
      value: 'best',
      label: `${chalk.yellow('✨')} BEST (auto)`,
      hint: chalk.dim('yt-dlp picks optimal'),
    },
    ...formats.map((f) => ({
      value: f.formatId,
      label: `${chalk.red('⬢')} ${f.resolution}`,
      hint: chalk.dim(`${f.filesizeLabel}  │  ${f.codec}${f.isCombined ? '  (combined)' : ''}`),
    })),
    {
      value: '__cancel__',
      label: `${chalk.dim('⬡')} Cancel`,
      hint: '',
    },
  ];

  const selectedFormat = await p.select({
    message: 'Choose quality:',
    options: formatOptions,
  });

  if (p.isCancel(selectedFormat) || selectedFormat === '__cancel__') {
    p.outro(chalk.dim('Download cancelled.'));
    return;
  }

  // Step 7 — Confirm
  const formatLabel = selectedFormat === 'best'
    ? 'BEST (auto)'
    : formats.find((f) => f.formatId === selectedFormat)?.displayLabel ?? String(selectedFormat);

  const shouldDownload = await p.confirm({
    message: `Download ${chalk.cyan(formatLabel)} to ${chalk.dim(OUTPUT_DIR)}?`,
  });

  if (p.isCancel(shouldDownload) || !shouldDownload) {
    p.outro(chalk.dim('Download cancelled.'));
    return;
  }

  // Step 8 — Download
  console.log('');
  p.log.step(chalk.red('⬢') + chalk.white(' Starting download...'));
  console.log(chalk.dim('─'.repeat(60)));

  const formatId = selectedFormat === 'best' ? 'bestvideo+bestaudio' : String(selectedFormat);

  try {
    await downloadVideo(url, formatId, OUTPUT_DIR);
    console.log(chalk.dim('─'.repeat(60)));
    console.log('');

    // Step 9 — Done
    p.outro(
      chalk.green('✅ Download complete!') +
      chalk.dim(`  Saved to ${OUTPUT_DIR}/`)
    );
  } catch (error) {
    console.log('');
    const msg = error instanceof Error ? error.message : String(error);
    p.log.error(chalk.red(`❌ ${msg}`));
    p.outro(chalk.dim('Download failed. Please try again.'));
  }
}

// ─── Podcast / Audio Only Flow ──────────────────────────────────────────────

async function handlePodcastDownload(url: string, info: VideoInfo): Promise<void> {
  const audioFormats = parseAudioFormats(info);

  if (audioFormats.length === 0) {
    p.log.error(chalk.red('❌ No downloadable audio formats found.'));
    p.outro(chalk.dim('This video may be restricted or unsupported.'));
    return;
  }

  // Show best audio info
  const best = audioFormats[0]!;
  p.log.info(
    chalk.red('🎙 Podcast Mode\n') +
    chalk.dim('  → Auto-selecting best audio: ') +
    chalk.cyan(`${best.bitrateLabel} ${best.codec} (.${best.ext})`) +
    (best.filesizeLabel !== '~ unknown' ? chalk.dim(`  │  ${best.filesizeLabel}`) : '')
  );

  // Confirm download
  const shouldDownload = await p.confirm({
    message: `Download best audio to ${chalk.dim(OUTPUT_DIR)}?`,
  });

  if (p.isCancel(shouldDownload) || !shouldDownload) {
    p.outro(chalk.dim('Download cancelled.'));
    return;
  }

  // Download
  console.log('');
  p.log.step(chalk.red('⬢') + chalk.white(' Downloading audio...'));
  console.log(chalk.dim('─'.repeat(60)));

  try {
    // Use bestaudio with m4a preference for best compatibility
    await downloadAudio(url, `bestaudio[ext=m4a]/bestaudio`, OUTPUT_DIR);
    console.log(chalk.dim('─'.repeat(60)));
    console.log('');

    p.outro(
      chalk.green('✅ Audio download complete!') +
      chalk.dim(`  Saved to ${OUTPUT_DIR}/`)
    );
  } catch (error) {
    console.log('');
    const msg = error instanceof Error ? error.message : String(error);
    p.log.error(chalk.red(`❌ ${msg}`));
    p.outro(chalk.dim('Download failed. Please try again.'));
  }
}
