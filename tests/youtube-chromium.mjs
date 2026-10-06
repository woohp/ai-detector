// YouTube transcript checks against real videos, in a visible Chromium window (YouTube serves
// empty captions to headless browsers). Playwright can't click context-menu items, so this runs
// the same pieces the menu item does:
//   1. grabTranscript (lib/youtube.ts) injected into video pages, with captions off and on
//   2. the built extension scoring the transcript through check.html's port, sections with times
//   3. check.html?transcript=<unknown id> showing an error
//   npm run build:chrome && node tests/youtube-chromium.mjs [videoId ...]
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { grabTranscript } from '../lib/youtube.ts';

const VIDEOS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      '7E9a24Nw6Cg', // creator and auto captions; the player picks auto, so this tests switching tracks
      'NiKtZgImdlY', // creator captions
      '1sxl01xlOBY', // auto captions only
    ];

const ext = fileURLToPath(new URL('../.output/chrome-mv3', import.meta.url));
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: false,
  locale: 'en-US',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--disable-blink-features=AutomationControlled'],
});
const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extPage = (path) => sw.url().replace(/[^/]*$/, path);
const page = await context.newPage();
let failures = 0;
const fail = (msg) => (failures++, console.log('  FAIL', msg));

const transcripts = [];
for (const [i, id] of VIDEOS.entries()) {
  await page.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#movie_player')?.getPlayerResponse?.()?.videoDetails, null, { timeout: 30_000 });
  await page.evaluate(() => { const p = document.querySelector('#movie_player'); p.mute(); p.playVideo(); });
  await page.waitForTimeout(2000);
  const ccPressed = () => page.getAttribute('.ytp-subtitles-button', 'aria-pressed');
  // Alternate the starting caption state to check it is restored either way.
  const startOn = i % 2 === 1;
  if ((await ccPressed()) === 'true' !== startOn) await page.click('.ytp-subtitles-button');

  const ad = await page.evaluate(() => document.querySelector('#movie_player').classList.contains('ad-showing'));
  const t0 = Date.now();
  const res = await page.evaluate(`(${grabTranscript})()`);
  if (ad) console.log(id, 'ad was playing; waited for it');
  const ms = Date.now() - t0;
  const restored = ((await ccPressed()) === 'true') === startOn;
  console.log(id, res.ok
    ? `ok in ${ms} ms: ${res.segments.length} lines, ${res.autoCaptions ? 'auto' : 'creator'} captions, ${Math.round(res.durationMs / 60000)} min`
    : `error: ${res.error}`, `| captions started ${startOn ? 'on' : 'off'}, restored: ${restored}`);
  if (!res.ok) fail(`${id}: ${res.error}`);
  if (!restored) fail(`${id}: caption setting not restored`);
  if (res.ok) transcripts.push(res);
}
if (transcripts[0]?.videoId === '7E9a24Nw6Cg' && transcripts[0].autoCaptions) fail('did not switch to creator captions');

// Score through the extension, as check.html does for a transcript.
const check = await context.newPage();
await check.goto(extPage('check.html'));
for (const t of transcripts) {
  const res = await check.evaluate(
    (t) =>
      new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: 'check' });
        port.onMessage.addListener((msg) => msg.type === 'done' && resolve(msg.res));
        port.postMessage({ type: 'detect', text: t.segments.map((s) => s.text).join(' '), segments: t.segments });
      }),
    t,
  );
  if (!res.ok) { fail(`${t.videoId} scoring: ${res.error}`); continue; }
  const starts = res.chunks.map((c) => c.startMs);
  const ordered = starts.every((s, i) => typeof s === 'number' && (i === 0 || s > starts[i - 1]));
  console.log(t.videoId, `score ${res.score.toFixed(2)} on ${res.device}, ${res.chunks.length} sections starting at`,
    starts.map((s) => `${Math.floor(s / 60000)}:${String(Math.floor(s / 1000) % 60).padStart(2, '0')}`).join(' '));
  if (!ordered) fail(`${t.videoId}: section start times missing or out of order`);
  if (res.chunks.some((c) => c.tokens > 510)) fail(`${t.videoId}: a section is over the token budget`);
}

await check.goto(extPage('check.html?transcript=unknown'));
await check.waitForSelector('#status-text:has-text("no longer available")', { timeout: 10_000 }).catch(() => fail('unknown transcript id: no error shown'));

await context.close();
console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
