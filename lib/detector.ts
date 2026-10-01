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
import { DEFAULT_MODEL, MODELS, type ModelSpec } from './models';

// Everything is loaded from inside the extension package; nothing is fetched remotely.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = browser.runtime.getURL('/models/' as PublicPath); // populated by model/export.py
// Files are already local, so caching them would only duplicate hundreds of MB.
env.useBrowserCache = false;
// Load the ORT factory straight from the package instead of via a blob: URL (blocked by our CSP).
env.useWasmCache = false;
// Bundle ORT's runtime with the extension; Transformers.js would otherwise load it from jsDelivr.
env.backends.onnx.wasm!.wasmPaths = { mjs: ortMjsUrl, wasm: ortWasmUrl };

interface Loaded {
  spec: ModelSpec;
  tokenizer: PreTrainedTokenizer;
  model: PreTrainedModel;
}

let loading: Promise<Loaded> | null = null;

async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  try {
    if ('gpu' in navigator && (await navigator.gpu.requestAdapter())) return 'webgpu';
  } catch {}
  return 'wasm';
}

function load(onProgress?: (percent: number) => void): Promise<Loaded> {
  loading ??= (async () => {
    const spec = MODELS[DEFAULT_MODEL];
    const progress_callback = (p: ProgressInfo) => {
      if (p.status === 'progress_total') onProgress?.(p.progress);
    };
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(spec.dir, { progress_callback }),
      AutoModelForSequenceClassification.from_pretrained(spec.dir, {
        dtype: spec.dtype,
        device: await pickDevice(),
        progress_callback,
      }),
    ]);
    return { spec, tokenizer, model };
  })().catch((err) => {
    loading = null; // allow retry
    throw err;
  });
  return loading;
}

const ZERO_WIDTH = /[​-‏⁠﻿­]/g;

/** NFKC + strip zero-width chars + collapse whitespace (recommended by the tabularis model card). */
export function normalize(text: string): string {
  return text.normalize('NFKC').replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim();
}

/** Returns P(AI) in [0, 1]. */
export async function detect(text: string, onProgress?: (percent: number) => void): Promise<number> {
  const { spec, tokenizer, model } = await load(onProgress);
  const inputs = tokenizer(normalize(text), { truncation: true, max_length: spec.maxTokens });
  const { logits } = await model(inputs);
  const values = Array.from(logits.data as Float32Array);

  if (spec.head.kind === 'sigmoid') return 1 / (1 + Math.exp(-values[0]!));

  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - max));
  return exps[spec.head.aiIndex]! / exps.reduce((a, b) => a + b, 0);
}
