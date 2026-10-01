export interface ModelSpec {
  /**
   * Directory under public/models/ (shipped inside the extension) in Transformers.js layout:
   * config.json, tokenizer.json, tokenizer_config.json, onnx/model_<dtype>.onnx.
   */
  dir: string;
  /** How logits map to P(AI). */
  head: { kind: 'sigmoid' } | { kind: 'softmax'; aiIndex: number };
  dtype: 'fp32' | 'fp16' | 'q8';
  maxTokens: number;
}

export const MODELS = {
  // ModernBERT-large, single logit. model_quantized.onnx is 8-bit weight-only (see model/export.py).
  vanguard: {
    dir: 'vanguard',
    head: { kind: 'sigmoid' },
    dtype: 'q8',
    maxTokens: 512,
  },
  // ModernBERT-base, two logits [human, AI].
  tabularis: {
    dir: 'tabularis',
    head: { kind: 'softmax', aiIndex: 1 },
    dtype: 'q8',
    maxTokens: 512,
  },
} satisfies Record<string, ModelSpec>;

export type ModelName = keyof typeof MODELS;

export const DEFAULT_MODEL: ModelName = 'vanguard';
