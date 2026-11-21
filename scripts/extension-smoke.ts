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
    if (process.argv.includes('--package')) {
      await mkdir(join(extensions, uuid), { recursive: true });
      await command(['unzip', '-q', join(repo, 'dist', uuid + '.shell-extension.zip'), '-d', join(extensions, uuid)]);
    } else await cp(join(repo, 'dist', uuid), join(extensions, uuid), { recursive: true });
    const shellVersion = (await command(['gnome-shell', '--version'])).match(/\d+/)![0]!;
    if (shellVersion !== '51') throw new Error(`This UI test requires GNOME 51; found ${shellVersion}.`);
    await mkdir(join(extensions, helperUuid));
    await writeFile(join(extensions, helperUuid, 'metadata.json'), JSON.stringify({
      uuid: helperUuid, name: 'Isolated yt-down UI test', description: 'Test harness', 'shell-version': [shellVersion],
    }));
    await writeFile(join(extensions, helperUuid, 'extension.js'), `
      import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
      import * as Main from 'resource:///org/gnome/shell/ui/main.js';
      import * as Config from 'resource:///org/gnome/shell/misc/config.js';
      import Gio from 'gi://Gio';
      import GLib from 'gi://GLib';
      export default class Test extends Extension {
        enable() {
          global.settings.set_string('welcome-dialog-last-shown-version', Config.PACKAGE_VERSION);
          global.context.unsafe_mode = true;
          globalThis.__hideOverview = () => Main.overview.hide();
          globalThis.__clearNotifications = () => Main.messageTray.getSources().forEach(source => source.destroy());
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
          globalThis.__getYtDown = () => Main.extensionManager.lookup('${uuid}').stateObj.app;
          globalThis.__shellReady = () => !Main.layoutManager._startingUp;
        }
        disable() { this.root.unexport(); this.player.unexport(); Gio.bus_unown_name(this.name); delete globalThis.__getYtDown; global.context.unsafe_mode = false; }
      }
    `);
    // Exercise the real GJS worker and controller using a fake yt-dlp executable.
    const fakeDownloader = join(dir, 'yt-dlp');
    await writeFile(fakeDownloader, `#!/usr/bin/python3
import sys, json, time, os, signal
args = sys.argv[1:]
if '-j' in args:
    if 'disable-metadata' in args[-1]:
        open(${JSON.stringify(join(dir, 'metadata-started'))}, 'w').write(str(os.getpid()))
        time.sleep(60)
    time.sleep(0.7)
    print(json.dumps({'id':'test','title':'A walk through the mountains','duration':761,
      'webpage_url':args[-1], 'original_url':args[-1], 'formats':[
        *[{'format_id':str(h),'ext':'mp4','height':h,'vcodec':'h264','acodec':'aac','filesize':35000000} for h in [360,480,720,1080,2160]],
        {'format_id':'audio','ext':'m4a','vcodec':'none','acodec':'aac','abr':128,'filesize':1000000}]}), flush=True)
else:
    cached = args[args.index('--load-info-json')+1] if '--load-info-json' in args else None
    info = json.load(open(cached)) if cached else {}
    url = args[-1] if not cached else info.get('original_url','')
    if 'disable-retry' in url:
        print('ERROR: HTTP Error 503: Service Unavailable', file=sys.stderr)
        sys.exit(1)
    if 'disable-stubborn' in url:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    print('yt-down-progress:'+json.dumps({'downloaded_bytes':50,'total_bytes':100,'speed':1048576,'eta':10}),flush=True)
    time.sleep(60 if 'disable-stubborn' in url else 5 if 'batch' in url else 0.7)
    output = ${JSON.stringify(join(dir, 'example.mp4'))}
    with open(output,'wb') as f: f.write(bytes(1572864))
    print('yt-down-file:'+json.dumps(output),flush=True)
`, { mode: 0o755 });
    const env = { ...process.env, GSETTINGS_BACKEND: 'memory',
      XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'), XDG_CACHE_HOME: join(dir, 'cache'),
      LIBGL_ALWAYS_SOFTWARE: '1', YT_DOWN_SMOKE_DIR: dir, YT_DLP_BIN: fakeDownloader, YT_DLP_COOKIES: 'none' };
    await command(['dbus-run-session', '--', process.execPath, import.meta.path, '--session'], env);
    console.log('GNOME UI: multi-site paste, opt-in automatic downloads, clipboard safeguards, search, presets, progress ring, compact completion, hover/focus actions, actual file sizes, player reuse, parallel downloads, queue cancellation, reduced motion and disable/re-enable cleanup across metadata, active, retry and unresponsive workers passed.');
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
    for (let i = 0; i < 200; i++) {
      try { last = await operation(); if (predicate(last)) return last; }
      catch (error) { last = String(error); }
      if (shell.exitCode !== null) break;
      await delay(100);
    }
    throw new Error(`Timed out: ${description}: ${last}`);
  };
  const check = async (expression: string, label: string) => {
    const result = await evaluate(`(() => { const e = globalThis.__getYtDown(); return (${expression}) ? 'PASS' : 'FAIL'; })()`);
    if (!result.includes('"PASS"')) throw new Error(`${label}: ${result}; ` + await evaluate("JSON.stringify({phase:globalThis.__getYtDown().view.phase,open:globalThis.__getYtDown().view.button.menu.isOpen,ring:globalThis.__getYtDown().view.panelRing.visible,jobs:globalThis.__getYtDown().downloads.jobs.length})"));
  };
  const capture = async (name: string) => {
    if (!process.env.YT_DOWN_SCREENSHOT_DIR) return;
    await mkdir(process.env.YT_DOWN_SCREENSHOT_DIR, { recursive: true });
    await evaluate("globalThis.__clearNotifications(); 'OK'");
    await delay(300);
    const bounds = await evaluate("(() => { const a=globalThis.__getYtDown().view.button.menu.actor; const [x,y]=a.get_transformed_position(); const left=Math.max(0,Math.floor(x)-8); return [left,0,Math.min(1280-left,Math.ceil(a.width)+16),Math.min(900,Math.ceil(y+a.height)+8)].join(','); })()");
    const area = bounds.match(/\d+,\d+,\d+,\d+/)![0].split(',');
    await command(['gdbus', 'call', '--session', '--dest', 'org.gnome.Shell.Screenshot',
      '--object-path', '/org/gnome/Shell/Screenshot', '--method', 'org.gnome.Shell.Screenshot.ScreenshotArea',
      ...area, 'false', join(process.env.YT_DOWN_SCREENSHOT_DIR, name + '.png')]);
  };
  try {
    await waitFor(() => call('org.gnome.Shell.Extensions.EnableExtension', helperUuid), value => value.includes('true'), 'test helper');
    await waitFor(() => evaluate('Boolean(globalThis.__getYtDown)'), value => value.includes("'true'"), 'helper initialized');
    await waitFor(() => evaluate('globalThis.__shellReady()'), value => value.includes("'true'"), 'shell startup complete');
    await evaluate("globalThis.__hideOverview(); 'OK'");
    await call('org.gnome.Shell.Extensions.EnableExtension', uuid);
    await waitFor(() => evaluate('Boolean(globalThis.__getYtDown()?.view.entry)'), value => value.includes("'true'"), 'extension initialized');
    await check("!e.settings.get_boolean('clipboard-autofetch')", 'clipboard access is opt-in');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.view.button.menu.open(); e.setEntry('invalid'); e.fetchFormats(); return 'OK'; })()");
    await check("e.view.inputError.visible && e.view.inputError.get_parent() === e.view.urlField && !e.view.statusRow.visible && e.view.entry.get_text() === 'invalid'", 'validation stays inside input and preserves text');
    await evaluate("globalThis.__getYtDown().view.entry.set_text('correction'); 'OK'");
    await check("!e.view.inputError.visible && e.view.entry.opacity === 255 && !e.view.statusRow.visible", 'editing dismisses inline error without an idle helper row');
    await evaluate("globalThis.__downloader=imports.gi.GLib.getenv('YT_DLP_BIN'); imports.gi.GLib.setenv('YT_DLP_BIN','/missing/yt-dlp',true); globalThis.__getYtDown().setEntry('https://youtu.be/test'); globalThis.__getYtDown().fetchFormats(); 'OK'");
    await check("e.view.phase === 'error' && e.view.inputError.text.includes('Setup needed') && !e.backend", 'missing dependency uses the input with setup guidance');
    await evaluate("imports.gi.GLib.setenv('YT_DLP_BIN',globalThis.__downloader,true); 'OK'");
    await evaluate(`(() => { const e = globalThis.__getYtDown(); e.settings.set_boolean('clipboard-autofetch',false);
      e.settings.set_string('output-directory',${JSON.stringify(join(process.env.YT_DOWN_SMOKE_DIR!, 'downloads'))});
      e.view.button.menu.open(); e.setEntry('https://youtu.be/test'); e.fetchFormats(); return 'OK'; })()`);
    await check("e.view.phase === 'searching' && e.view.skeleton.visible", 'immediate loading feedback');
    await waitFor(() => evaluate('globalThis.__getYtDown().view.phase'), value => value.includes('"ready"'), 'format result');
    await capture('formats');
    await check("e.view.formats._getMenuItems().length === 3 && e.view.more.visible && e.view.videoInfo.visible && e.view.moreHint.text === '4K available'", 'simple presets and 4K availability');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.setEntry('https://www.youtube.com/watch?v=test&tracking='+'x'.repeat(500)); return 'OK'; })()");
    await delay(150);
    await check("(() => { const [fx] = e.view.urlField.get_transformed_position(); const [ix] = e.view.urlField.get_parent().get_transformed_position(); return e.view.urlField.get_n_children() === 2 && fx+e.view.urlField.width <= ix+e.view.urlField.get_parent().width+1; })()", 'long URL stays within field without a clear button');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.view.formats._getMenuItems()[0].emit('activate',null); return 'OK'; })()");
    await waitFor(() => evaluate('globalThis.__getYtDown().downloads.jobs[0]?.percent'), value => value.includes("'50'"), 'download progress');
    await check("!e.view.statusRow.visible && e.view.button.menu.isOpen && e.view.panelRing.visible && e.view.jobsScroll.visible && e.view.entry.clutter_text.editable", 'progress stays visible after activation');
    await waitFor(() => evaluate('globalThis.__getYtDown().downloads.jobs[0]?.state'), value => value.includes('"complete"'), 'saved state');
    await waitFor(() => evaluate('globalThis.__getYtDown().downloads.jobs[0]?.view.size.text'), value => value.includes('1.5 MB'), 'actual completed file size');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.view.entry.grab_key_focus(); e.downloads.jobs[0].view.card.set_hover(false); return 'OK'; })()");
    await check("!e.downloads.jobs[0].view.actions.visible && e.downloads.jobs[0].view.size.visible && !e.downloads.jobs[0].view.header.visible && !e.downloads.jobs[0].view.progress.visible && !e.downloads.jobs[0].view.detail.visible", 'saved row is compact by default');
    await evaluate("globalThis.__savedRowHeight=globalThis.__getYtDown().downloads.jobs[0].view.card.height; globalThis.__getYtDown().downloads.jobs[0].view.card.set_hover(true); 'OK'");
    await delay(100);
    await check("e.downloads.jobs[0].view.actions.visible && !e.downloads.jobs[0].view.size.visible && e.downloads.jobs[0].view.card.height === globalThis.__savedRowHeight", 'hover actions preserve one-line height');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.downloads.jobs[0].view.card.set_hover(false); e.downloads.jobs[0].view.card.grab_key_focus(); return 'OK'; })()");
    await check("e.downloads.jobs[0].view.actions.visible", 'keyboard focus reveals actions');
    await evaluate("globalThis.__getYtDown().downloads.jobs[0].view.openFile.grab_key_focus(); 'OK'");
    await check("e.downloads.jobs[0].view.actions.visible", 'actions remain available while a child has focus');
    await evaluate("globalThis.__getYtDown().view.entry.grab_key_focus(); 'OK'");
    await check("!e.downloads.jobs[0].view.actions.visible && e.downloads.jobs[0].view.size.visible && !e.view.panelRing.visible", 'actions hide when focus leaves');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.mediaOpener.launch=async()=>{globalThis.__mediaLaunches++;}; e.openMedia(e.downloads.jobs[0].filePath); return 'OK'; })()");
    await waitFor(() => evaluate('globalThis.__mediaRaises'), value => value.includes("'1'"), 'focus currently playing file');
    await evaluate("globalThis.__getYtDown().openMedia(globalThis.__getYtDown().downloads.jobs[0].filePath); 'OK'");
    await waitFor(() => evaluate('globalThis.__mediaRaises'), value => value.includes("'2'"), 'second click raises the same player');
    await check("globalThis.__mediaLaunches === 0", 'no duplicate player launch');
    await evaluate("globalThis.__mediaUrl='file:///tmp/another-video.mp4'; globalThis.__getYtDown().openMedia(globalThis.__getYtDown().downloads.jobs[0].filePath); 'OK'");
    await waitFor(() => evaluate('globalThis.__mediaLaunches'), value => value.includes("'1'"), 'launch file when it is not playing');
    await evaluate("globalThis.__getYtDown().openMedia(globalThis.__getYtDown().downloads.jobs[0].filePath); 'OK'");
    await delay(200);
    await check("globalThis.__mediaLaunches === 1", 'repeated clicks during player startup do not launch twice');
    for (const number of [1, 2, 3]) {
      await evaluate(`(() => { const e=globalThis.__getYtDown(); e.setEntry('https://youtu.be/batch${number}'); e.fetchFormats(); return 'OK'; })()`);
      await waitFor(() => evaluate('globalThis.__getYtDown().view.phase'), value => value.includes('"ready"'), 'next video formats while downloading');
      await evaluate("(() => { const e=globalThis.__getYtDown(); e.view.formats._getMenuItems()[0].emit('activate',null); return 'OK'; })()");
    }
    await capture('downloads');
    await check("e.downloads.queue.active === 2 && e.downloads.queue.queued === 1 && e.view.entry.clutter_text.editable", 'two simultaneous downloads and an editable input');
    await check("e.downloads.jobs.filter(j=>j.state==='active').length === 2 && e.downloads.jobs.filter(j=>j.state==='queued').length === 1", 'independent job state');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.downloads.cancel(e.downloads.jobs.find(j=>j.state==='active')); return 'OK'; })()");
    await waitFor(() => evaluate('globalThis.__getYtDown().downloads.queue.queued'), value => value.includes("'0'"), 'cancelled slot starts queued download');
    await check("e.downloads.queue.active === 2 && e.downloads.jobs.some(j=>j.state==='cancelled')", 'per-job cancellation leaves the other download running');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.view.motionAllowed=()=>false; e.view.setPhase('searching'); e.view.syncMotion(); return 'OK'; })()");
    await check("e.view.skeleton.opacity === 255 && e.view.skeleton.get_transition('opacity') === null", 'reduced motion');
    await call('org.gnome.Shell.Extensions.DisableExtension', uuid);
    await call('org.gnome.Shell.Extensions.EnableExtension', uuid);
    await waitFor(() => evaluate('Boolean(globalThis.__getYtDown()?.view.entry)'), value => value.includes("'true'"), 're-enable after cleanup');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.settings.set_string('output-directory', " + JSON.stringify(join(dir, 'downloads')) + "); e.settings.set_boolean('clipboard-autofetch', false); e.view.button.menu.open(); e.view.entry.set_text('https://vimeo.com/123'); return 'OK'; })()");
    await waitFor(() => evaluate('globalThis.__getYtDown().view.phase'), value => value.includes('"ready"'), 'pasted non-YouTube URL fetches without Enter');
    await check("e.downloads.jobs.length === 0", 'direct downloading is off by default');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.settings.set_boolean('download-on-paste', true); e.settings.set_string('last-choice', 'video:720:quality'); e.view.entry.set_text('https://de.pornhub.com/view_video.php?viewkey=6af5118b07e59'); return 'OK'; })()");
    await waitFor(() => evaluate('globalThis.__getYtDown().downloads.jobs.length'), value => value.includes("'1'"), 'paste automatically queues download without Enter or a quality click');
    await check("e.downloads.jobs[0].choice.height === 720 && e.view.entry.get_text() === ''", 'automatic download uses remembered quality and clears input');
    await waitFor(() => evaluate('globalThis.__getYtDown().downloads.jobs[0].state'), value => value.includes('"complete"'), 'automatic download completes');
    await evaluate("(() => { const e=globalThis.__getYtDown(); e.clear(); e.settings.set_boolean('clipboard-autofetch', true); imports.gi.St.Clipboard.get_default().set_text(imports.gi.St.ClipboardType.CLIPBOARD, 'https://vimeo.com/456'); e.checkClipboard(); return 'OK'; })()");
    await waitFor(() => evaluate('globalThis.__getYtDown().view.entry.get_text()'), value => value.includes('https://vimeo.com/456'), 'clipboard fills input locally');
    await delay(500);
    await check("e.view.phase === 'idle' && !e.backend && e.downloads.jobs.length === 1", 'clipboard does not contact the site even with automatic downloads enabled');
    await evaluate("globalThis.__getYtDown().fetchFormats(); 'OK'");
    await waitFor(() => evaluate('globalThis.__getYtDown().view.phase'), value => value.includes('"ready"'), 'confirmed clipboard URL fetches formats');
    await check("e.downloads.jobs.length === 1", 'clipboard detection does not automatically download');
    if (process.env.YT_DOWN_SCREENSHOT_DIR) {
      await command(['dbus-update-activation-environment', `WAYLAND_DISPLAY=yt-down-smoke-${process.pid}`]);
      await evaluate("(() => { const e=globalThis.__getYtDown(); e.settings.set_string('output-directory',''); e.view.button.menu.close(); e.openPreferences(); return 'OK'; })()");
      await waitFor(() => evaluate("global.get_window_actors().some(a=>a.meta_window.get_title()?.includes('yt-down'))"), value => value.includes("'true'"), 'preferences window');
      await evaluate("global.get_window_actors().find(a=>a.meta_window.get_title()?.includes('yt-down')).meta_window.activate(global.get_current_time()); 'OK'");
      await evaluate("globalThis.__clearNotifications(); 'OK'");
      await delay(800);
      const bounds = await evaluate("(() => { const w=global.get_window_actors().find(a=>a.meta_window.get_title()?.includes('yt-down')).meta_window; const r=w.get_frame_rect(); return [r.x,r.y,r.width,r.height].join(','); })()");
      await command(['gdbus','call','--session','--dest','org.gnome.Shell.Screenshot','--object-path','/org/gnome/Shell/Screenshot',
        '--method','org.gnome.Shell.Screenshot.ScreenshotArea',...bounds.match(/\d+,\d+,\d+,\d+/)![0].split(','),'false',join(process.env.YT_DOWN_SCREENSHOT_DIR,'preferences.png')]);
      await evaluate("global.get_window_actors().find(a=>a.meta_window.get_title()?.includes('yt-down')).meta_window.delete(global.get_current_time()); 'OK'");
    }
    for (const phase of ['metadata', 'active', 'retry', 'stubborn']) {
      await evaluate(`(() => { const e=globalThis.__getYtDown(); e.clear(); e.settings.set_boolean('download-on-paste',false); e.settings.set_boolean('clipboard-autofetch',false); e.settings.set_string('output-directory',${JSON.stringify(join(dir, 'downloads'))}); e.setEntry('https://youtu.be/disable-${phase}'); e.fetchFormats(); return 'OK'; })()`);
      if (phase === 'metadata') {
        await waitFor(async () => String(await Bun.file(join(dir, 'metadata-started')).exists()), value => value === 'true', 'metadata process started');
        await evaluate("globalThis.__oldApp=globalThis.__getYtDown(); globalThis.__oldBackend=globalThis.__oldApp.backend; 'OK'");
      } else {
        await waitFor(() => evaluate('globalThis.__getYtDown().view.phase'), value => value.includes('"ready"'), 'formats for unload test');
        await evaluate("(() => { const e=globalThis.__getYtDown(); e.view.formats._getMenuItems()[0].emit('activate',null); globalThis.__oldApp=e; globalThis.__oldBackend=e.downloads.jobs.at(-1).backend; return 'OK'; })()");
        if (phase === 'retry') await waitFor(() => evaluate("globalThis.__oldApp.downloads.jobs.at(-1).view.detail.text.includes('Retrying')"), value => value.includes("'true'"), 'retry delay started');
        else await waitFor(() => evaluate('globalThis.__oldApp.downloads.jobs.at(-1).percent'), value => value.includes("'50'"), 'active process started');
      }
      await call('org.gnome.Shell.Extensions.DisableExtension', uuid);
      await waitFor(() => evaluate('globalThis.__oldBackend.process === null'), value => value.includes("'true'"), 'disabled worker reaped');
      const result = await evaluate("globalThis.__oldBackend.killTimer === 0 && globalThis.__oldApp.debounce === 0 && globalThis.__oldApp.downloads.jobs.length === 0 && !imports.gi.GObject.signal_handler_is_connected(global.stage,globalThis.__oldApp.downloads.focusSignal) && !imports.gi.GObject.signal_handler_is_connected(globalThis.__oldApp.settings,globalThis.__oldApp.downloads.limitSignal)");
      if (!result.includes("'true'")) throw new Error(`Cleanup failed during ${phase}: ${result}`);
      await call('org.gnome.Shell.Extensions.EnableExtension', uuid);
      await waitFor(() => evaluate('Boolean(globalThis.__getYtDown()?.view.entry)'), value => value.includes("'true'"), 're-enabled after unload scenario');
      await check("e !== globalThis.__oldApp && e.downloads.jobs.length === 0", 're-enable has independent state');
    }
    await evaluate("delete globalThis.__oldApp; delete globalThis.__oldBackend; 'OK'");
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
