# AI Text Detector

Browser extension (Chrome + Firefox, MV3): select text → right-click → **Check if AI-written** → a tooltip shows P(AI), 0 = human, 1 = AI. The model runs locally via Transformers.js / ONNX Runtime Web and ships inside the extension: nothing is fetched at runtime.

Clicking the toolbar button opens **check.html**: paste any amount of text, press Check (⌘/Ctrl+Enter).

Text longer than the model's 512-token window is split into sections of about equal length,
cut at word boundaries. Each section is scored, and the overall score is their mean, weighted by token count.
The page lists the score for each section. The tooltip shows the overall score and how many sections there were.

## Layout

```
entrypoints/background.ts   context menu, toolbar button, relays the tooltip and check.html to the inference host
entrypoints/check/          paste-and-check page (talks to the background over a runtime port)
entrypoints/offscreen/      inference host page (Chrome: offscreen document, Firefox: iframe in background page)
entrypoints/content.ts      tooltip UI, injected on demand (activeTab, no host permissions)
lib/detector.ts             Transformers.js setup, chunking, tokenize → logits → score
lib/models.ts               model registry (dir, head type, dtype)
model/export.py             HF → ONNX fp32 → fp16, writes public/models/<name>/ (gitignored)
model/smoke.mjs             loads the shipped model via Transformers.js in Node
entrypoints/bench/          dev page timing WebGPU vs WASM load and inference
tests/e2e-chromium.mjs      loads the built extension in Playwright Chromium, runs detection and check.html
tests/bench-chromium.mjs    runs bench.html in Playwright Chromium
```

## Model (Vanguard)

ModernBERT-large, exported with `torch.onnx.export(dynamo=True)` and converted to fp16 (794 MB).
Max score error vs PyTorch on the sample set: 0.0035 on WebGPU, 0.0006 on WASM. 8-bit weight-only
was half the size but made WebGPU no faster than the CPU; that version is commit `34a3e60`.

Device: WebGPU if it loads and warms up within 10 s, else WASM (multithreaded via cross-origin
isolation); a fallback is remembered in the host page's localStorage. Chromium on Apple Silicon:

| | load + warm-up | short text | 512 tokens |
|---|---|---|---|
| WebGPU | 2.4 s | 0.02 s | 0.10 s |
| WASM | 2.1 s | 0.10 s | 2.0 s |

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
