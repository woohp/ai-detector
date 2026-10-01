import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type ProgressInfo,
} from '@huggingface/transformers';
/// <reference types="vite/client" />
import type { PublicPath } from 'wxt/browser';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import type { Chunk, DetectResult, Progress } from './messages';
import { DEFAULT_MODEL, MODELS, type ModelSpec } from './models';

// Everything is loaded from inside the extension package; nothing is fetched remotely.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = browser.runtime.getURL('/models/' as PublicPath); // populated by model/export.py
// Files are already local, so caching them would only duplicate hundreds of MB.
env.useBrowserCache = false;
// Load the ORT factory straight from the package instead of via a blob: URL (blocked by our CSP).
env.useWasmCache = false;
// Bundle ORT's runtime (asyncify build: WebGPU + WASM CPU) instead of loading it from jsDelivr.
env.backends.onnx.wasm!.wasmPaths = { mjs: ortMjsUrl, wasm: ortWasmUrl };

// Extension URLs come back without Content-Length, so Transformers.js grows its buffer and recopies
// it on every chunk (quadratic; small chunks made a 400 MB load take ~1 min in Firefox). Read the
// body natively and hand it over with a length so it allocates once.
const extensionOrigin = new URL(browser.runtime.getURL('/' as PublicPath)).origin;
env.fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (new URL(String(input), location.href).origin !== extensionOrigin || res.headers.has('Content-Length')) return res;
  const body = await res.arrayBuffer();
  return new Response(body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') ?? '', 'Content-Length': String(body.byteLength) },
  });
};

export type Device = 'webgpu' | 'wasm';

export interface Loaded {
  spec: ModelSpec;
  device: Device;
  tokenizer: PreTrainedTokenizer;
  model: PreTrainedModel;
}

/** WebGPU must load and finish a warm-up run within this, or we fall back to WASM. */
const GPU_BUDGET_MS = 10_000;
/** Set when WebGPU failed or was too slow in this browser, so later loads skip straight to WASM. */
export const DEVICE_KEY = 'ai-detector:device';

/** Loads the model on one device and runs a warm-up inference (WebGPU compiles shaders on first run). */
export async function loadModel(
  device: Device,
  onProgress?: (percent: number) => void,
  dtype: ModelSpec['dtype'] = MODELS[DEFAULT_MODEL].dtype,
): Promise<Loaded> {
  const spec = MODELS[DEFAULT_MODEL];
  const t0 = performance.now();
  let filesMs = 0;
  const progress_callback = (p: ProgressInfo) => {
    if (p.status !== 'progress_total') return;
    onProgress?.(p.progress);
    if (p.progress >= 100 && !filesMs) filesMs = performance.now() - t0;
  };
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(spec.dir, { progress_callback }),
    AutoModelForSequenceClassification.from_pretrained(spec.dir, { dtype, device, progress_callback }),
  ]);
  const sessionMs = performance.now() - t0 - filesMs;
  const loaded = { spec, device, tokenizer, model };
  const t1 = performance.now();
  await score(loaded, 'Warm-up.');
  console.info(
    `[ai-detector] ${device}/${dtype} ready in ${Math.round(performance.now() - t0)} ms ` +
      `(files ${Math.round(filesMs)}, session ${Math.round(sessionMs)}, warm-up ${Math.round(performance.now() - t1)}; ` +
      `crossOriginIsolated ${self.crossOriginIsolated})`,
  );
  return loaded;
}

async function hasGpu(): Promise<boolean> {
  try {
    return 'gpu' in navigator && !!(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function chooseAndLoad(onProgress?: (percent: number) => void): Promise<Loaded> {
  if (localStorage.getItem(DEVICE_KEY) === 'wasm' || !(await hasGpu())) return loadModel('wasm', onProgress);

  const gpu = loadModel('webgpu', onProgress);
  try {
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), GPU_BUDGET_MS));
    const loaded = await Promise.race([gpu, timeout]);
    if (loaded) return loaded;
    console.warn(`[ai-detector] WebGPU not ready within ${GPU_BUDGET_MS} ms; using WASM`);
    gpu.then((l) => l.model.dispose()).catch(() => {});
  } catch (err) {
    console.warn('[ai-detector] WebGPU failed; using WASM', err);
  }
  localStorage.setItem(DEVICE_KEY, 'wasm');
  return loadModel('wasm', onProgress);
}

let loading: Promise<Loaded> | null = null;
/** Everyone waiting on the current load gets its progress, not just the first caller. */
const loadListeners = new Set<(percent: number) => void>();

async function load(onProgress?: (percent: number) => void): Promise<Loaded> {
  if (onProgress) loadListeners.add(onProgress);
  try {
    loading ??= chooseAndLoad((percent) => loadListeners.forEach((l) => l(percent))).catch((err) => {
      loading = null; // allow retry
      throw err;
    });
    return await loading;
  } finally {
    if (onProgress) loadListeners.delete(onProgress);
  }
}

const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF\u00AD]/g;

/** NFKC + strip zero-width chars + collapse whitespace (recommended by the tabularis model card). */
export function normalize(text: string): string {
  return text.normalize('NFKC').replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim();
}

/** Returns P(AI) in [0, 1]. */
export async function score({ spec, tokenizer, model }: Loaded, text: string): Promise<number> {
  const inputs = tokenizer(normalize(text), { truncation: true, max_length: spec.maxTokens });
  const { logits } = await model(inputs);
  const values = Array.from(logits.data as Float32Array);

  if (spec.head.kind === 'sigmoid') return 1 / (1 + Math.exp(-values[0]!));

  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - max));
  return exps[spec.head.aiIndex]! / exps.reduce((a, b) => a + b, 0);
}

/**
 * Splits text into model-sized sections of about equal length, cutting at word starts. Returns
 * token ids per section; the model only sees maxTokens at once, so long text is scored in parts.
 */
function chunk(tokenizer: PreTrainedTokenizer, text: string, maxTokens: number): number[][] {
  const ids = tokenizer.encode(text, { add_special_tokens: false });
  const budget = maxTokens - tokenizer.encode('').length; // room left after [CLS] and [SEP]
  const count = Math.ceil(ids.length / budget);
  const size = Math.ceil(ids.length / count);
  const startsWord = (i: number) => /^\s/.test(tokenizer.decode([ids[i]!]));

  const chunks: number[][] = [];
  let start = 0;
  for (let n = 1; n < count; n++) {
    let end = n * size;
    // Back up a few tokens to a word start so no word is split across sections.
    for (let back = 0; back < 16 && end - back > start + 1; back++) {
      if (startsWord(end - back)) {
        end -= back;
        break;
      }
    }
    chunks.push(ids.slice(start, end));
    start = end;
  }
  chunks.push(ids.slice(start));
  return chunks;
}

/** Scores text of any length: each section separately, overall as the token-weighted mean. */
export async function detect(text: string, onProgress?: (progress: Progress) => void): Promise<DetectResult> {
  const loaded = await load((percent) => onProgress?.({ kind: 'loading', percent }));
  const clean = normalize(text);
  if (!clean) throw new Error('No text to analyze');

  const t0 = performance.now();
  const parts = chunk(loaded.tokenizer, clean, loaded.spec.maxTokens);
  const chunks: Chunk[] = [];
  for (const ids of parts) {
    onProgress?.({ kind: 'analyzing', done: chunks.length, total: parts.length });
    const part = parts.length === 1 ? clean : loaded.tokenizer.decode(ids).trim();
    chunks.push({ text: part, tokens: ids.length, score: await score(loaded, part) });
  }
  const tokens = chunks.reduce((sum, c) => sum + c.tokens, 0);
  const overall = chunks.reduce((sum, c) => sum + c.score * c.tokens, 0) / tokens;
  console.info(
    `[ai-detector] ${tokens} tokens in ${chunks.length} section(s): ${Math.round(performance.now() - t0)} ms on ${loaded.device}`,
  );
  return { score: overall, chunks, device: loaded.device };
}
