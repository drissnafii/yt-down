import GLib from 'gi://GLib';

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

export function missingDependencies(): string[] {
  return ['gjs', 'yt-dlp', 'ffmpeg', 'setsid', 'kill']
    .filter(name => !findTool(name, name === 'yt-dlp' ? GLib.getenv('YT_DLP_BIN') : null));
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
