// Runs bench.html in Playwright's Chromium and prints its results.
//   npm run build && node tests/bench-chromium.mjs [query, e.g. 'webgpu=fp16,q8&wasm=fp16']
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const ext = fileURLToPath(new URL('../.output/chrome-mv3', import.meta.url));
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--enable-unsafe-webgpu'],
});
const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const page = await context.newPage();
page.on('console', (m) => console.log('[page]', m.text()));
await page.goto(sw.url().replace(/[^/]*$/, 'bench.html') + (process.argv[2] ? `?${process.argv[2]}` : ''));
await page.click('#run');
await page.waitForFunction(() => document.title === 'done', null, { timeout: 280_000 });
console.log(await page.textContent('#info'));
console.log(await page.$$eval('#results tr', (rows) => rows.map((r) => [...r.cells].map((c) => c.textContent).join(' | ')).join('\n')));
await context.close();
