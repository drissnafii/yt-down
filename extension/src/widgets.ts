import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

export function column(style = ''): St.BoxLayout {
  return new St.BoxLayout({ style_class: style, orientation: Clutter.Orientation.VERTICAL });
}
export function icon(name: string, size = 16): St.Icon {
  return new St.Icon({ icon_name: name, icon_size: size, y_align: Clutter.ActorAlign.CENTER });
}
export function label(text: string, style = '', wrap = false): St.Label {
  const actor = new St.Label({ text, style_class: style, y_align: Clutter.ActorAlign.CENTER, x_expand: true });
  actor.clutter_text.line_wrap = wrap;
  actor.clutter_text.ellipsize = wrap ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END;
  return actor;
}
export function motionAllowed(): boolean {
  return St.Settings.get().enable_animations && St.Settings.get().reduced_motion !== 1;
}
