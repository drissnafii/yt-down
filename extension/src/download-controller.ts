import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { RECOVERY_ARGS, classifyFailure, errorLines } from '../../src/recovery-policy.js';
import { getTransferArgs } from '../../src/transfer-options.js';
import { createProgressParser } from '../../src/progress.js';
import type { VideoInfo } from '../../src/format-model.js';
import { normalizeVideoUrl, normalizeYouTubeUrl } from '../../src/utils.js';
import { findTool } from './dependencies.js';
import { baseArgs, runProcess, wait, emit, checkCancelled } from './ytdlp-adapter.js';

export interface DownloadRequest { url: string; mode: string; id: string; directory: string; cacheDirectory?: string }

export async function getVideoInfo(url: string): Promise<VideoInfo> {
  const result = await runProcess([...baseArgs(), '-j', '--', url], undefined, true);
  if (result.code) throw new Error(errorLines(result.stderr).at(-1) ?? `yt-dlp failed (${result.code}).`);
  const info = JSON.parse(result.stdout) as VideoInfo;
  if (!info || typeof info.title !== 'string' || !Array.isArray(info.formats)) throw new Error('Invalid video metadata.');
  return info;
}

export async function download(request: DownloadRequest, info?: VideoInfo): Promise<void> {
  const url = normalizeVideoUrl(request.url);
  if (!url || !['video', 'audio', 'mp3'].includes(request.mode)
    || !/^(?:best|\w[\w.-]*(?:\+\w[\w.-]*)*)$/.test(request.id)
    || !GLib.path_is_absolute(request.directory)) throw new Error('Invalid download request.');
  const ffmpeg = findTool('ffmpeg');
  if (!ffmpeg && (request.mode === 'mp3' || request.id.includes('+')))
    throw new Error('This format needs ffmpeg for conversion or merging. Choose an original single-stream format or install ffmpeg.');
  const directory = normalizeYouTubeUrl(url) ? request.directory : GLib.build_filenamev([request.directory, 'other_sites']);
  try { Gio.File.new_for_path(directory).make_directory_with_parents(null); }
  catch (error) { if (!(error instanceof GLib.Error) || !error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.EXISTS)) throw error; }
  const transfer = getTransferArgs({ fragments: GLib.getenv('YT_DOWN_FRAGMENTS') ?? '4',
    downloader: GLib.getenv('YT_DOWN_DOWNLOADER') ?? 'native', findExecutable: findTool,
    warn: message => emit({ type: 'status', message }) });
  if (transfer.includes('http:aria2c')) transfer.push('--paths', `temp:${directory}/.aria2`);
  const selected = request.id === 'best' ? (request.mode === 'video' ? (ffmpeg ? 'bestvideo+bestaudio/best' : 'best') : 'bestaudio/best') : request.id;
  const args = [...baseArgs(), ...transfer, ...RECOVERY_ARGS, '-f', selected, '--paths', directory,
    '-o', '%(title)s [%(id)s].%(ext)s', '--newline', '--progress', '--progress-delta', '0.3',
    '--progress-template', 'download:yt-down-progress:%(progress)j', '--print', 'after_move:yt-down-file:%(filepath)j',
    ...(request.mode === 'mp3' ? ['--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0']
      : request.mode === 'video' ? ['--merge-output-format', 'mp4'] : [])];
  let temporary = request.cacheDirectory;
  if (temporary && (GLib.path_get_dirname(temporary) !== GLib.get_tmp_dir()
    || !/^yt-down-info-[\w-]+$/.test(GLib.path_get_basename(temporary)))) throw new Error('Invalid metadata directory.');
  try {
    let cached: string | undefined;
    if (info) {
      temporary ??= GLib.dir_make_tmp('yt-down-info-XXXXXX');
      cached = `${temporary}/video.info.json`;
      const { webpage_url, ...snapshot } = info;
      // Private file, inside a private directory; no metadata reaches the Shell UI.
      GLib.file_set_contents(cached, JSON.stringify(snapshot));
      GLib.chmod(cached, 0o600);
    }
    const parsers = { stdout: createProgressParser(emit), stderr: createProgressParser(emit) };
    let failures = 0;
    let refreshes = 0;
    for (;;) {
      checkCancelled();
      const input = cached ? ['--load-info-json', cached] : ['--', url];
      const result = await runProcess([...args, ...input], (text, source) => parsers[source](text));
      cached = undefined;
      if (!result.code) { emit({ type: 'complete', directory }); return; }
      const errors = result.stderr + '\n' + result.stdout;
      const failure = classifyFailure(errors);
      if (failure === 'permanent' || (failure === 'refresh' && refreshes++ >= 3))
        throw new Error(`${errorLines(errors).at(-1) ?? `Download failed (${result.code}).`} Partial files kept; choose the same quality to resume.`);
      const delay = [2000, 4000, 8000, 16000, 30000][Math.min(failures++, 4)];
      emit({ type: 'status', message: `Connection or media URL interrupted. Retrying in ${delay / 1000}s with saved progress…` });
      await wait(delay);
    }
  } finally {
    if (temporary) {
      try { GLib.unlink(`${temporary}/video.info.json`); GLib.rmdir(temporary); } catch { /* Already removed. */ }
    }
  }
}
