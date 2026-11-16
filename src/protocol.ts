/** Public newline-delimited JSON protocol shared with the GNOME frontend. */
export interface DownloadChoice {
  id: string;
  label: string;
  mode: 'video' | 'audio';
}

export type BackendEvent =
  | { type: 'formats'; title: string; channel: string; duration: number | null; choices: DownloadChoice[] }
  | { type: 'progress'; percent: number | null; speed: number | null; eta: number | null }
  | { type: 'status'; message: string }
  | { type: 'file'; path: string }
  | { type: 'complete'; directory: string }
  | { type: 'cancelled'; message: string }
  | { type: 'error'; message: string };
