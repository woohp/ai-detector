/** Messages between background, the inference host (offscreen doc), the content script, and check.html. */

/** One caption line: start time and text. */
export interface Segment {
  ms: number;
  text: string;
}

export interface DetectRequest {
  target: 'host';
  type: 'detect';
  requestId: string;
  text: string;
  /** Transcript lines. When given, sections are cut between lines and carry time ranges. */
  segments?: Segment[];
}

export interface Chunk {
  /** Text the model saw for this section (normalized, so whitespace may differ from the input). */
  text: string;
  tokens: number;
  score: number;
  /** Start of the section's first caption line (transcripts only). */
  startMs?: number;
}

export interface DetectResult {
  /** Token-weighted mean of the chunk scores. */
  score: number;
  chunks: Chunk[];
  /** Where the model ran: webgpu or wasm. */
  device: string;
}

export type DetectResponse = ({ ok: true } & DetectResult) | { ok: false; error: string };

export type Progress =
  /** 0–100, model files loaded so far. */
  | { kind: 'loading'; percent: number }
  /** Chunk `done` of `total` scored. */
  | { kind: 'analyzing'; done: number; total: number };

/** Host → background, forwarded to whoever asked. */
export interface ProgressMessage {
  target: 'background';
  type: 'progress';
  requestId: string;
  progress: Progress;
}

/** Background → content script. */
export type UiMessage =
  | { target: 'content'; type: 'analyzing' }
  | { target: 'content'; type: 'progress'; progress: Progress }
  | { target: 'content'; type: 'result'; score: number; chunks: number }
  | { target: 'content'; type: 'error'; error: string };

export type TranscriptResponse =
  | {
      ok: true;
      videoId: string;
      title: string;
      durationMs: number;
      /** YouTube's speech recognition rather than captions uploaded by the creator. */
      autoCaptions: boolean;
      segments: Segment[];
    }
  | { ok: false; error: string };

/** check.html ↔ background, over a runtime port named CHECK_PORT. */
export const CHECK_PORT = 'check';
export type CheckRequest =
  | { type: 'detect'; text: string; segments?: Segment[] }
  /** Transcript the background is fetching for the check.html?transcript=<id> it opened. */
  | { type: 'transcript'; id: string };
export type CheckReply =
  | { type: 'progress'; progress: Progress }
  | { type: 'done'; res: DetectResponse }
  | { type: 'transcript'; res: TranscriptResponse };
