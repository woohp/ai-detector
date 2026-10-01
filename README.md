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
entrypoints/bench/          dev page timing WebGPU vs WASM load and inference
tests/e2e-chromium.mjs      loads the built extension in Playwright Chromium, runs detection
tests/bench-chromium.mjs    runs bench.html in Playwright Chromium
```

## Model (Vanguard)

ModernBERT-large, exported with `torch.onnx.export(dynamo=True)`, quantized weight-only
(8-bit MatMul, int8 embeddings via plain Gather/Cast/Mul so every ORT build and EP can run it):
~445 MB, max score error vs PyTorch 0.0050 on the sample set. Plain dynamic int8
(`quantize_dynamic`) was rejected: up to 0.15 error under WASM.

Device: WebGPU if it loads and warms up within 10 s, else WASM (multithreaded via cross-origin
isolation); a fallback is remembered in the host page's localStorage. Chromium on Apple Silicon:

| | load + warm-up | short text | 512 tokens |
|---|---|---|---|
| WebGPU | 1.4 s | 0.13 s | 1.7 s |
| WASM | 0.8 s | 0.23 s | 2.0 s |

Compare devices on any browser by opening `<extension origin>/bench.html`
(`node tests/bench-chromium.mjs` runs it in Playwright).

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
