/** Run only inside an isolated D-Bus session, with GSettings memory-backed.
 * Never run a nested Shell against the user's persistent dconf database.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '..');
const uuid = 'yt-down@drissnafii';
const helperUuid = 'yt-down-smoke@local';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function command(argv: string[], env = process.env) {
  const proc = Bun.spawn(argv, { env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code) throw new Error(`${argv[0]} failed: ${stderr || stdout}`);
  return stdout.trim();
}

if (process.argv[2] !== '--session') {
  const before = await command(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions']);
  const dir = await mkdtemp(join(tmpdir(), 'yt-down-ui-smoke-'));
  try {
    const extensions = join(dir, 'data/gnome-shell/extensions');
    await mkdir(extensions, { recursive: true });
    await cp(join(repo, 'dist', uuid), join(extensions, uuid), { recursive: true });
    const shellVersion = (await command(['gnome-shell', '--version'])).match(/\d+/)![0]!;
    await mkdir(join(extensions, helperUuid));
    await writeFile(join(extensions, helperUuid, 'metadata.json'), JSON.stringify({
      uuid: helperUuid, name: 'Isolated yt-down UI test', description: 'Test harness', 'shell-version': [shellVersion],
    }));
    await writeFile(join(extensions, helperUuid, 'extension.js'), `
      import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
      import * as Main from 'resource:///org/gnome/shell/ui/main.js';
      import Gio from 'gi://Gio';
      import GLib from 'gi://GLib';
      export default class Test extends Extension {
        enable() {
          global.context.unsafe_mode = true;
          globalThis.__mediaRaises = 0;
          globalThis.__mediaLaunches = 0;
          globalThis.__mediaUrl = ${JSON.stringify('file://' + join(dir, 'example.mp4'))};
          this.root = Gio.DBusExportedObject.wrapJSObject('<node><interface name="org.mpris.MediaPlayer2"><method name="Raise"/></interface></node>', {
            Raise() { globalThis.__mediaRaises++; }
          });
          this.player = Gio.DBusExportedObject.wrapJSObject('<node><interface name="org.mpris.MediaPlayer2.Player"><property name="Metadata" type="a{sv}" access="read"/></interface></node>', {
            get Metadata() { return {'xesam:url':new GLib.Variant('s',globalThis.__mediaUrl)}; }
          });
          this.root.export(Gio.DBus.session,'/org/mpris/MediaPlayer2');
          this.player.export(Gio.DBus.session,'/org/mpris/MediaPlayer2');
          this.name = Gio.bus_own_name_on_connection(Gio.DBus.session,'org.mpris.MediaPlayer2.ytdown_smoke',Gio.BusNameOwnerFlags.NONE,null,null);
          globalThis.__getYtDown = () => Main.extensionManager.lookup('${uuid}').stateObj;
          globalThis.__shellReady = () => !Main.layoutManager._startingUp;
        }
        disable() { this.root.unexport(); this.player.unexport(); Gio.bus_unown_name(this.name); delete globalThis.__getYtDown; global.context.unsafe_mode = false; }
      }
    `);
    // Exercise the frontend without network traffic, browser cookies or real downloads.
    await writeFile(join(extensions, uuid, 'backend.js'), `
      const emit = event => console.log(JSON.stringify(event));
      const args = process.argv.slice(2);
      if (args.includes('formats')) {
        await Bun.sleep(700);
        emit({type:'formats',title:'A video title that wraps gracefully across lines',channel:'Test channel',duration:761,
          choices:[{id:'best',mode:'video',label:'Best quality',sizeLabel:'Auto'},
          ...[2160,1080,720,480,360].map(height=>({id:String(height),mode:'video',label:height+'p',height,variant:'quality',sizeLabel:'35.5 MB'})),
          {id:'best',mode:'mp3',label:'Audio only',sizeLabel:'MP3'}]});
      } else {
        emit({type:'progress',percent:50,speed:1048576,eta:10});
        await Bun.sleep(args.some(arg=>arg.includes('batch')) ? 5000 : 700);
        const output = ${JSON.stringify(join(dir, 'example.mp4'))};
        await Bun.write(output, new Uint8Array(1572864));
        emit({type:'file',path:output});
        emit({type:'complete',directory:'/tmp'});
      }
    `);
    const env = { ...process.env, GSETTINGS_BACKEND: 'memory',
      XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'), XDG_CACHE_HOME: join(dir, 'cache'),
      LIBGL_ALWAYS_SOFTWARE: '1', YT_DOWN_SMOKE_DIR: dir, YT_DOWN_SMOKE_BUN: process.execPath };
    await command(['dbus-run-session', '--', process.execPath, import.meta.path, '--session'], env);
    console.log('GNOME UI: multi-site paste, opt-in automatic downloads, clipboard safeguards, search, presets, progress ring, compact completion, hover/focus actions, actual file sizes, player reuse, parallel downloads, queue cancellation, reduced motion and cleanup passed.');
  } finally {
    await rm(dir, { recursive: true, force: true });
    const after = await command(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions']);
    if (after !== before) throw new Error('Desktop enabled-extension settings changed during isolated test!');
  }
} else {
  if (process.env.GSETTINGS_BACKEND !== 'memory') throw new Error('Refusing to test with persistent settings');
  const dir = process.env.YT_DOWN_SMOKE_DIR!;
  await mkdir(process.env.XDG_CONFIG_HOME!, { recursive: true });
  await mkdir(process.env.XDG_CACHE_HOME!, { recursive: true });
  const log = join(dir, 'shell.log');
  const shell = Bun.spawn(['gnome-shell', '--headless', '--virtual-monitor', '1280x900',
    '--wayland-display', `yt-down-smoke-${process.pid}`], { stdout: Bun.file(log), stderr: Bun.file(log + '.stderr') });
  const readLogs = async () => (await Bun.file(log).text()) + '\n' + (await Bun.file(log + '.stderr').text());
  const call = (method: string, ...args: string[]) => command(['gdbus', 'call', '--session', '--dest', 'org.gnome.Shell',
    '--object-path', '/org/gnome/Shell', '--method', method, ...args]);
  const evaluate = async (js: string) => {
    const value = await call('org.gnome.Shell.Eval', js);
    if (!value.startsWith('(true,')) throw new Error(`Shell evaluation failed: ${value}`);
    return value;
  };
  const waitFor = async (operation: () => Promise<string>, predicate: (result: string) => boolean, description: string) => {
    let last = '';
    for (let i = 0; i < 100; i++) {
      try { last = await operation(); if (predicate(last)) return last; }
      catch (error) { last = String(error); }
      if (shell.exitCode !== null) break;
      await delay(100);
    }
    throw new Error(`Timed out: ${description}: ${last}`);
  };
  const check = async (expression: string, label: string) => {
    const result = await evaluate(`(() => { const e = globalThis.__getYtDown(); return (${expression}) ? 'PASS' : 'FAIL'; })()`);
    if (!result.includes('"PASS"')) throw new Error(`${label}: ${result}; ` + await evaluate("JSON.stringify({phase:globalThis.__getYtDown().phase,open:globalThis.__getYtDown().button.menu.isOpen,ring:globalThis.__getYtDown().panelRing.visible,jobs:globalThis.__getYtDown().jobs.length})"));
  };
  try {
    await waitFor(() => call('org.gnome.Shell.Extensions.EnableExtension', helperUuid), value => value.includes('true'), 'test helper');
    await waitFor(() => evaluate('Boolean(globalThis.__getYtDown)'), value => value.includes("'true'"), 'helper initialized');
    await waitFor(() => evaluate('globalThis.__shellReady()'), value => value.includes("'true'"), 'shell startup complete');
    await call('org.gnome.Shell.Extensions.EnableExtension', uuid);
    await waitFor(() => evaluate('Boolean(globalThis.__getYtDown()?.entry)'), value => value.includes("'true'"), 'extension initialized');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.button.menu.open(); e.setEntry('invalid'); e.fetchFormats(); return 'OK'; })()");
    await check("e.inputError.visible && e.inputError.get_parent() === e.urlField && !e.statusRow.visible && e.entry.get_text() === 'invalid'", 'validation stays inside input and preserves text');
    await evaluate("globalThis.__getYtDown().entry.set_text('correction'); 'OK'");
    await check("!e.inputError.visible && e.entry.opacity === 255 && !e.statusRow.visible", 'editing dismisses inline error without an idle helper row');
    await evaluate(`(() => { const e = globalThis.__getYtDown(); e.settings.set_boolean('clipboard-autofetch',false);
      e.settings.set_string('bun-path',${JSON.stringify(process.env.YT_DOWN_SMOKE_BUN)});
      e.button.menu.open(); e.setEntry('https://youtu.be/test'); e.fetchFormats(); return 'OK'; })()`);
    await check("e.phase === 'searching' && e.skeleton.visible", 'immediate loading feedback');
    await waitFor(() => evaluate('globalThis.__getYtDown().phase'), value => value.includes('"ready"'), 'format result');
    await check("e.formats._getMenuItems().length === 3 && e.more.visible && e.videoInfo.visible && e.moreHint.text === '4K available'", 'simple presets and 4K availability');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.setEntry('https://www.youtube.com/watch?v=test&tracking='+'x'.repeat(500)); return 'OK'; })()");
    await delay(150);
    await check("(() => { const [fx] = e.urlField.get_transformed_position(); const [ix] = e.urlField.get_parent().get_transformed_position(); return e.urlField.get_n_children() === 2 && fx+e.urlField.width <= ix+e.urlField.get_parent().width+1; })()", 'long URL stays within field without a clear button');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.formats._getMenuItems()[0].emit('activate',null); return 'OK'; })()");
    await waitFor(() => evaluate('globalThis.__getYtDown().jobs[0]?.percent'), value => value.includes("'50'"), 'download progress');
    await check("!e.statusRow.visible && e.button.menu.isOpen && e.panelRing.visible && e.jobsScroll.visible && e.entry.clutter_text.editable", 'progress stays visible after activation');
    await waitFor(() => evaluate('globalThis.__getYtDown().jobs[0]?.state'), value => value.includes('"complete"'), 'saved state');
    await waitFor(() => evaluate('globalThis.__getYtDown().jobs[0]?.size.text'), value => value.includes('1.5 MB'), 'actual completed file size');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.entry.grab_key_focus(); e.jobs[0].card.set_hover(false); return 'OK'; })()");
    await check("!e.jobs[0].actions.visible && e.jobs[0].size.visible && !e.jobs[0].header.visible && !e.jobs[0].progress.visible && !e.jobs[0].detail.visible", 'saved row is compact by default');
    await evaluate("globalThis.__savedRowHeight=globalThis.__getYtDown().jobs[0].card.height; globalThis.__getYtDown().jobs[0].card.set_hover(true); 'OK'");
    await delay(100);
    await check("e.jobs[0].actions.visible && !e.jobs[0].size.visible && e.jobs[0].card.height === globalThis.__savedRowHeight", 'hover actions preserve one-line height');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.jobs[0].card.set_hover(false); e.jobs[0].card.grab_key_focus(); return 'OK'; })()");
    await check("e.jobs[0].actions.visible", 'keyboard focus reveals actions');
    await evaluate("globalThis.__getYtDown().jobs[0].openFile.grab_key_focus(); 'OK'");
    await check("e.jobs[0].actions.visible", 'actions remain available while a child has focus');
    await evaluate("globalThis.__getYtDown().entry.grab_key_focus(); 'OK'");
    await check("!e.jobs[0].actions.visible && e.jobs[0].size.visible && !e.panelRing.visible", 'actions hide when focus leaves');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.mediaOpener.launch=async()=>{globalThis.__mediaLaunches++;}; e.openMedia(e.jobs[0].filePath); return 'OK'; })()");
    await waitFor(() => evaluate('globalThis.__mediaRaises'), value => value.includes("'1'"), 'focus currently playing file');
    await evaluate("globalThis.__getYtDown().openMedia(globalThis.__getYtDown().jobs[0].filePath); 'OK'");
    await waitFor(() => evaluate('globalThis.__mediaRaises'), value => value.includes("'2'"), 'second click raises the same player');
    await check("globalThis.__mediaLaunches === 0", 'no duplicate player launch');
    await evaluate("globalThis.__mediaUrl='file:///tmp/another-video.mp4'; globalThis.__getYtDown().openMedia(globalThis.__getYtDown().jobs[0].filePath); 'OK'");
    await waitFor(() => evaluate('globalThis.__mediaLaunches'), value => value.includes("'1'"), 'launch file when it is not playing');
    await evaluate("globalThis.__getYtDown().openMedia(globalThis.__getYtDown().jobs[0].filePath); 'OK'");
    await delay(200);
    await check("globalThis.__mediaLaunches === 1", 'repeated clicks during player startup do not launch twice');
    for (const number of [1, 2, 3]) {
      await evaluate(`(() => { const e=globalThis.__getYtDown(); e.setEntry('https://youtu.be/batch${number}'); e.fetchFormats(); return 'OK'; })()`);
      await waitFor(() => evaluate('globalThis.__getYtDown().phase'), value => value.includes('"ready"'), 'next video formats while downloading');
      await evaluate("(() => { const e=globalThis.__getYtDown(); e.formats._getMenuItems()[0].emit('activate',null); return 'OK'; })()");
    }
    await check("e.queue.active === 2 && e.queue.queued === 1 && e.entry.clutter_text.editable", 'two simultaneous downloads and an editable input');
    await check("e.jobs.filter(j=>j.state==='active').length === 2 && e.jobs.filter(j=>j.state==='queued').length === 1", 'independent job state');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.cancelJob(e.jobs.find(j=>j.state==='active')); return 'OK'; })()");
    await waitFor(() => evaluate('globalThis.__getYtDown().queue.queued'), value => value.includes("'0'"), 'cancelled slot starts queued download');
    await check("e.queue.active === 2 && e.jobs.some(j=>j.state==='cancelled')", 'per-job cancellation leaves the other download running');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.motionAllowed=()=>false; e.setPhase('searching'); e.syncMotion(); return 'OK'; })()");
    await check("e.skeleton.opacity === 255 && e.skeleton.get_transition('opacity') === null", 'reduced motion');
    await call('org.gnome.Shell.Extensions.DisableExtension', uuid);
    await call('org.gnome.Shell.Extensions.EnableExtension', uuid);
    await waitFor(() => evaluate('Boolean(globalThis.__getYtDown()?.entry)'), value => value.includes("'true'"), 're-enable after cleanup');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.settings.set_string('bun-path', " + JSON.stringify(process.env.YT_DOWN_SMOKE_BUN) + "); e.settings.set_boolean('clipboard-autofetch', false); e.button.menu.open(); e.entry.set_text('https://vimeo.com/123'); return 'OK'; })()");
    await waitFor(() => evaluate('globalThis.__getYtDown().phase'), value => value.includes('"ready"'), 'pasted non-YouTube URL fetches without Enter');
    await check("e.jobs.length === 0", 'direct downloading is off by default');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.settings.set_boolean('download-on-paste', true); e.settings.set_string('last-choice', 'video:720:quality'); e.entry.set_text('https://de.pornhub.com/view_video.php?viewkey=6af5118b07e59'); return 'OK'; })()");
    await waitFor(() => evaluate('globalThis.__getYtDown().jobs.length'), value => value.includes("'1'"), 'paste automatically queues download without Enter or a quality click');
    await check("e.jobs[0].choice.height === 720 && e.entry.get_text() === ''", 'automatic download uses remembered quality and clears input');
    await waitFor(() => evaluate('globalThis.__getYtDown().jobs[0].state'), value => value.includes('"complete"'), 'automatic download completes');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.clear(); e.settings.set_boolean('clipboard-autofetch', true); imports.gi.St.Clipboard.get_default().set_text(imports.gi.St.ClipboardType.CLIPBOARD, 'https://vimeo.com/456'); e.checkClipboard(); return 'OK'; })()");
    await waitFor(() => evaluate('globalThis.__getYtDown().phase'), value => value.includes('"ready"'), 'clipboard detection fetches formats');
    await check("e.jobs.length === 1", 'clipboard detection does not automatically download');
    await call('org.gnome.Shell.Extensions.DisableExtension', uuid);
    const logs = await readLogs();
    if (/JS ERROR|Extension yt-down@drissnafii:|Theme parsing error/.test(logs)) throw new Error(`Shell reported errors:\n${logs}`);
  } catch (error) {
    console.error(await readLogs());
    throw error;
  } finally {
    shell.kill('SIGTERM');
    await shell.exited;
  }
}
