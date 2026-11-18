import { cp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const destination = join(root, 'dist/yt-down@drissnafii');
const command = process.argv[2] ?? 'build';
if (!['build', 'install', 'pack'].includes(command)) throw new Error('Expected build, install, or pack.');
async function run(argv: string[]) {
  const process = Bun.spawn(argv, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (await process.exited !== 0) throw new Error(`Command failed: ${argv[0]}`);
}
await run([process.execPath, 'run', 'extension:typecheck']);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
// Bundle only our frontend helpers; GJS resolves GNOME's native imports at runtime.
const frontend = await Bun.build({
  entrypoints: [join(root, 'extension/src/extension.ts'), join(root, 'extension/src/prefs.ts')],
  target: 'browser', outdir: destination, naming: '[name].js', minify: false,
  external: ['gi://*', 'resource://*'],
});
if (!frontend.success) throw new AggregateError(frontend.logs, 'Frontend build failed');
for (const file of ['metadata.json', 'stylesheet.css', 'schemas']) {
  await cp(join(root, 'extension', file), join(destination, file), { recursive: true });
}
await run(['glib-compile-schemas', '--strict', join(destination, 'schemas')]);
const backend = await Bun.build({ entrypoints: [join(root, 'bin/yt-down.ts')], target: 'bun',
  outdir: destination, naming: 'backend.js', minify: false });
if (!backend.success) throw new AggregateError(backend.logs, 'Backend build failed');
if (command === 'install') {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local/share');
  const installed = join(dataHome, 'gnome-shell/extensions/yt-down@drissnafii');
  await mkdir(installed, { recursive: true });
  await cp(destination, installed, { recursive: true });
  console.log(`Installed ${installed}\nLog out and back in, then run: gnome-extensions enable yt-down@drissnafii`);
} else if (command === 'pack') {
  const archive = join(root, 'dist/yt-down@drissnafii.shell-extension.zip');
  await rm(archive, { force: true });
  const zip = Bun.spawn(['zip', '-qr', archive, '.'], { cwd: destination, stdout: 'inherit', stderr: 'inherit' });
  if (await zip.exited !== 0) throw new Error('zip failed');
  console.log(archive);
} else {
  console.log(`Built ${destination}`);
}
