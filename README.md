# AI Text Detector

Browser extension (Chrome + Firefox, MV3): select text → right-click → **Check if AI-written** → a tooltip shows P(AI), 0 = human, 1 = AI. The model runs locally via Transformers.js / ONNX Runtime Web and ships inside the extension: nothing is fetched at runtime.

## Layout

```
entrypoints/background.ts   context menu, injects the tooltip, relays to the inference host
entrypoints/offscreen/      inference host page (Chrome: offscreen document, Firefox: iframe in background page)
entrypoints/content.ts      tooltip UI, injected on demand (activeTab, no host permissions)
lib/detector.ts             Transformers.js setup, tokenize → logits → score
lib/models.ts               model registry (dir, head type, dtype)
model/export.py             HF → ONNX fp32 → 8-bit weight-only, writes public/models/<name>/ (gitignored)
model/smoke.mjs             loads the shipped model via Transformers.js in Node
tests/e2e-chromium.mjs      loads the built extension in Playwright Chromium, runs detection
```

## Model (Vanguard)

ModernBERT-large, exported with `torch.onnx.export(dynamo=True)`, quantized weight-only
(8-bit MatMul, 4-bit embeddings): 398 MB, max score error vs PyTorch 0.0055 on the sample set,
identical between ORT native and WASM. Plain dynamic int8 (`quantize_dynamic`) was rejected: up
to 0.15 error under WASM.

Chromium (single-threaded WASM): first check ~4 s (model load), then ~0.2 s short text,
~1.8 s at the 512-token cap.

## Setup

```sh
npm install
source ~/projects/pytorch_ext/.venv/bin/activate   # or any venv with model/requirements.txt
npm run export:vanguard                            # writes public/models/vanguard/
npm run dev            # Chrome
npm run dev:firefox    # Firefox
npm run zip && npm run zip:firefox

node model/smoke.mjs vanguard          # Node check of shipped files
npm run build && node tests/e2e-chromium.mjs
```
