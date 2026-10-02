# AI Text Detector

This is a browser extension that detects AI text:

Select text -> right-click -> **Check if AI-written** -> a tooltip shows P(AI), 0 = human, 1 = AI.

The model runs locally via Transformers.js / ONNX Runtime Web and ships inside the extension. Nothing is fetched at runtime, and your data stays fully local.

Clicking the toolbar button opens **check.html**: paste any amount of text and press Check.

Text longer than the model's 512-token window is split into sections of about equal length,
cut at word boundaries. Each section is scored, and the overall score is their mean, weighted by token count.
The page lists the score for each section. The tooltip shows the overall score and how many sections there were.

## Install

Requires Node.js and Python 3.10+. From a clone of this repo, run the line for your browser:

```sh
npm run bundle:chrome
npm run bundle:firefox
```

This installs dependencies, exports the model (first run only: downloads PyTorch and the model,
takes several minutes), and builds and zips the extension into `.output/`. Then load it:

- **Chrome:** `chrome://extensions` → enable Developer mode → **Load unpacked** → `.output/chrome-mv3/`
  (or unzip `ai-detector-*-chrome.zip` and pick that folder).
- **Firefox:** `about:debugging` → This Firefox → **Load Temporary Add-on** → `ai-detector-*-firefox.zip`
  or `.output/firefox-mv3/manifest.json`. Temporary add-ons are removed when Firefox restarts.

## Model

This extension uses the [Vanguard AI text detector model](https://huggingface.co/ShantanuT01/vanguard-ai-text-detector).
The weights are converted to fp16 and exported to ONNX format. The max score error vs the PyTorch
implementation is very small: 0.0035 on WebGPU and 0.0006 on WASM, measured on a sample set.
An 8-bit weight-only version was half the size but made WebGPU no faster than the CPU.

Device: WebGPU if it loads and warms up within 10 s, else WASM (multithreaded via cross-origin
isolation); a fallback is remembered in the host page's localStorage. Chromium on Apple Silicon:

| | load + warm-up | short text | 512 tokens |
| --- | --- | --- | --- |
| WebGPU | 2.4 s | 0.02 s | 0.10 s |
| WASM | 2.1 s | 0.10 s | 2.0 s |

Compare devices on any browser by opening `<extension origin>/bench.html`
(`node tests/bench-chromium.mjs` runs it in Playwright).

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

## Development

Requires Node.js and Python 3.10+.

```sh
npm install
```

Export the model once. Activate any Python environment (venv, conda, etc.) and install the
exporter's dependencies (PyTorch, Transformers, ONNX, ONNX Runtime, onnxscript):

```sh
pip install -r model/requirements.txt
npm run export:vanguard    # downloads from Hugging Face, writes public/models/vanguard/
```

Then build for both browsers:

```sh
npm run build          # or build:chrome / build:firefox; output in .output/
npm run zip            # or zip:chrome / zip:firefox; zipped builds in .output/
```

Load the build as described in [Install](#install).

For development, `npm run dev:chrome` or `npm run dev:firefox` launches the browser with the
extension installed and reloads it on changes.

Tests (Chromium via Playwright):

```sh
node model/smoke.mjs vanguard                           # Node check of shipped model files
npm run build:chrome && node tests/e2e-chromium.mjs     # end to end
```
