// Loads the built Chrome extension in Playwright's Chromium and runs detection through the real
// offscreen document (WASM runtime, CSP, bundled model). Context-menu clicks can't be automated,
// so this drives the same message the background script sends.
//   npm run build && node tests/e2e-chromium.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const ext = fileURLToPath(new URL('../.output/chrome-mv3', import.meta.url));
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

const SAMPLES = [
  'The bridge was closed for three weeks in 1987 after a barge struck one of its piers during a storm.',
  'Certainly! Here is a concise overview of the key benefits of renewable energy: it reduces greenhouse gas ' +
    'emissions, enhances energy security, and creates sustainable economic opportunities.',
  // ~500 tokens: worst-case latency (inputs are truncated at 512).
  'We missed the 8:15 train so we walked to the next station, got rained on, and ended up eating cold pizza. '.repeat(20),
];

const results = await sw.evaluate(async (samples) => {
  const url = chrome.runtime.getURL('/offscreen.html');
  if (!(await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length) {
    await chrome.offscreen.createDocument({ url, reasons: ['WORKERS'], justification: 'e2e test' });
  }
  const out = [];
  for (const text of samples) {
    const t0 = performance.now();
    const res = await chrome.runtime.sendMessage({ target: 'host', type: 'detect', requestId: crypto.randomUUID(), text });
    out.push({ text: text.slice(0, 48), ms: Math.round(performance.now() - t0), ...res });
  }
  return out;
}, SAMPLES);

console.table(results);

// Extension pages share the manifest's COOP/COEP headers; isolation is what enables WASM threads.
const page = await context.newPage();
await page.goto(sw.url().replace(/[^/]*$/, 'offscreen.html'));
console.log('host page:', await page.evaluate(() => ({ crossOriginIsolated, cores: navigator.hardwareConcurrency })));
await context.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
