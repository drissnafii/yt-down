import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Application } from './application.js';

export default class YtDownExtension extends Extension {
  private app?: Application;

  enable(): void {
    this.app = new Application(this.getSettings(), this.path, () => { void this.openPreferences(); });
    Main.panel.addToStatusArea(this.uuid, this.app.view.button);
  }

  disable(): void {
    this.app?.destroy();
    this.app = undefined;
  }
}
