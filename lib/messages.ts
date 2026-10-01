/** Messages between background, the inference host (offscreen doc), and the content script. */

export interface DetectRequest {
  target: 'host';
  type: 'detect';
  requestId: string;
  text: string;
}

export type DetectResponse = { ok: true; score: number } | { ok: false; error: string };

/** Host → background, forwarded to the tab that asked. */
export interface ProgressMessage {
  target: 'background';
  type: 'progress';
  requestId: string;
  /** 0–100, model files loaded so far. */
  percent: number;
}

/** Background → content script. */
export type UiMessage =
  | { target: 'content'; type: 'analyzing' }
  | { target: 'content'; type: 'loading'; percent: number }
  | { target: 'content'; type: 'result'; score: number }
  | { target: 'content'; type: 'error'; error: string };
