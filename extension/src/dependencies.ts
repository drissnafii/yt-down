import GLib from 'gi://GLib';
import type { DownloadChoice } from '../../src/protocol.js';

export function findTool(name: string, override?: string | null): string | null {
  if (override) {
    const path = GLib.path_is_absolute(override) ? override : GLib.find_program_in_path(override);
    return path && GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE) ? path : null;
  }
  for (const path of [GLib.build_filenamev([GLib.get_home_dir(), '.local/bin', name]),
    GLib.build_filenamev([GLib.get_home_dir(), '.local/share/mise/shims', name]),
    GLib.find_program_in_path(name)]) {
    if (path && GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) return path;
  }
  return null;
}

export function missingDependencies(find = findTool): string[] {
  return ['gjs', 'yt-dlp', 'setsid', 'kill']
    .filter(name => !find(name, name === 'yt-dlp' ? GLib.getenv('YT_DLP_BIN') : null));
}

export function setupMessage(): string {
  const missing = missingDependencies();
  return missing.length ? `Setup needed: ${missing.join(', ')}. Open Settings for installation help.` : '';
}

export function workerCommand(path: string, ...args: string[]): string[] {
  const message = setupMessage();
  if (message) throw new Error(message);
  // A separate session lets cancellation reach yt-dlp, ffmpeg, and aria2 children.
  return [findTool('setsid')!, findTool('gjs')!, '-m', `${path}/worker.js`, ...args];
}

/** ffmpeg is needed for conversion and separately selected audio/video streams. */
export function downloadRequirement(choice: DownloadChoice, find = findTool): string {
  if (!find('ffmpeg') && (choice.mode === 'mp3' || choice.id.includes('+')))
    return 'This format needs ffmpeg for conversion or merging. Install it, or choose an original single-stream format.';
  return '';
}
