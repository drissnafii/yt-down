/**
 * yt-dlp wrapper — all yt-dlp interactions go through this module.
 * Uses Bun.spawn() for async, non-blocking execution.
 */

import type { VideoInfo } from './format-model.ts';
import { isSupportedBunVersion } from './js-runtime.ts';
export * from './format-model.ts';
import { getCookieArgs } from './cookies.ts';
import { runDownload, type RecoveryOptions } from './download-recovery.ts';
import { mkdir } from 'node:fs/promises';
import { withMetadataFile } from './metadata-cache.ts';
import { getTransferArgs } from './transfer-options.ts';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getOutputDirectory } from './output-directory.ts';

// ─── Constants ───────────────────────────────────────────────────────────────

// Prefer ~/.local/bin/yt-dlp (installed via pipx, kept up-to-date) over
// the system package (typically outdated). Falls back to env override or PATH.
const LOCAL_YT_DLP = join(homedir(), '.local/bin/yt-dlp');
const YT_DLP_BIN = Bun.env.YT_DLP_BIN ?? (Bun.file(LOCAL_YT_DLP).size > 0 ? LOCAL_YT_DLP : 'yt-dlp');
const OUTPUT_DIR = getOutputDirectory();

function getJsRuntimeArgs(): string[] {
  if (Bun.env.YT_DLP_JS_RUNTIME) {
    // User explicitly set a single runtime — honour it with the correct flag format
    return ['--js-runtimes', Bun.env.YT_DLP_JS_RUNTIME];
  }

  // Build a list of available runtimes in priority order (highest first).
  // yt-dlp requires one --js-runtimes flag *per runtime* (not comma-separated).
  const candidates: Array<string | null> = [
    getSupportedRuntime('deno'),
    getSupportedRuntime('node'),   // Node.js (nvm / system)
    getSupportedBunRuntime(),      // Supported Bun challenge-solver versions only
    getSupportedRuntime('qjs', 'quickjs'),
  ];

  const args: string[] = [];
  for (const runtime of candidates) {
    if (runtime !== null) {
      args.push('--js-runtimes', runtime);
    }
  }
  return args;
}

function getBaseArgs(): string[] {
  return [YT_DLP_BIN, ...getJsRuntimeArgs(), ...getCookieArgs(), '--no-playlist'];
}

function getSupportedRuntime(command: string, runtime = command): string | null {
  return Bun.which(command) ? runtime : null;
}

function getSupportedBunRuntime(): string | null {
  // This backend is already running in Bun. An absolute path also works when
  // launched by GNOME without an interactive shell's runtime PATH.
  return isSupportedBunVersion(Bun.version) ? `bun:${process.execPath}` : null;
}

// ─── Video Info ──────────────────────────────────────────────────────────────

/**
 * Fetch video metadata JSON using yt-dlp -j
 */
export async function getVideoInfo(url: string, signal?: AbortSignal): Promise<VideoInfo> {
  const proc = Bun.spawn([...getBaseArgs(), '-j', url], {
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    // Extract meaningful error from stderr
    const errorLines = stderr.trim().split('\n');
    const errorMsg = errorLines
      .filter((line) => line.startsWith('ERROR:'))
      .map((line) => line.replace('ERROR: ', ''))
      .join('; ');

    throw new Error(errorMsg || `yt-dlp exited with code ${exitCode}`);
  }

  try {
    const info = JSON.parse(stdout) as VideoInfo;
    return info;
  } catch {
    throw new Error('Failed to parse yt-dlp JSON output');
  }
}

// ─── Download ────────────────────────────────────────────────────────────────

/**
 * Download video/audio with live progress and automatic interruption recovery.
 */
export async function downloadVideo(
  url: string,
  formatId: string,
  outputDir: string = OUTPUT_DIR,
  info?: VideoInfo,
  options?: RecoveryOptions,
): Promise<string> {
  return download(url, formatId, outputDir, info, ['--merge-output-format', 'mp4'], options);
}

/** Download audio using the same metadata reuse, transfer, and recovery settings. */
export async function downloadAudio(
  url: string,
  formatId: string,
  outputDir: string = OUTPUT_DIR,
  info?: VideoInfo,
  options?: RecoveryOptions,
): Promise<string> {
  return download(url, formatId, outputDir, info, [], options);
}

/** Convert the selected audio stream to MP3 with ffmpeg. */
export async function downloadMp3(url: string, formatId: string, outputDir: string = OUTPUT_DIR,
  info?: VideoInfo, options?: RecoveryOptions): Promise<string> {
  return download(url, formatId, outputDir, info,
    ['--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0'], options);
}

async function download(url: string, formatId: string, outputDir: string, info?: VideoInfo, extra: string[] = [], options: RecoveryOptions = {}): Promise<string> {
  const outputPath = resolve(outputDir);
  const transferArgs = getTransferArgs({ fragments: Bun.env.YT_DOWN_FRAGMENTS, downloader: Bun.env.YT_DOWN_DOWNLOADER, findExecutable: Bun.which, warn: console.error });
  // aria2 may create sparse partial files. Keep them apart from native partials,
  // which resume by byte length, so switching downloaders cannot corrupt a file.
  if (transferArgs.includes('http:aria2c')) transferArgs.push('--paths', `temp:${join(outputPath, '.aria2')}`);
  const args = [
    ...getBaseArgs(), ...transferArgs,
    '-f', formatId, '--paths', outputPath, '-o', options.onOutput ? '%(title)s [%(id)s].%(ext)s' : '%(title)s.%(ext)s',
    ...extra, '--progress',
    ...(options.onOutput ? ['--newline', '--progress-delta', '0.3', '--progress-template',
      'download:yt-down-progress:%(progress)j', '--print', 'after_move:yt-down-file:%(filepath)j'] : []),
  ];
  await mkdir(outputDir, { recursive: true });
  await withMetadataFile(info, async path => {
    await runDownload([...args, url], {
      ...options,
      initialArgs: path ? [...args, '--load-info-json', path] : undefined,
    });
  });
  return outputDir;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
