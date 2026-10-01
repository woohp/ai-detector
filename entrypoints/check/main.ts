// Paste-and-check page, opened from the toolbar button. The model runs in the shared inference
// host; this page talks to it through the background over a port (see background.ts).
import { CHECK_PORT, type CheckReply, type DetectResponse, type DetectResult, type Progress } from '@/lib/messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('form');
const input = $<HTMLTextAreaElement>('text');
const submit = $<HTMLButtonElement>('submit');
const count = $('count');
const status = $('status');
const statusText = $('status-text');
const statusBar = $('status-bar');
const result = $('result');

$('shortcut').textContent = /Mac/.test(navigator.platform) ? '⌘↵' : 'Ctrl+↵';

let busy = false;

function words(text: string) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function updateCount() {
  const n = words(input.value);
  count.textContent = `${n.toLocaleString()} word${n === 1 ? '' : 's'}`;
  submit.disabled = busy || n === 0;
}

input.addEventListener('input', updateCount);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value;
  if (busy || !words(text)) return;
  busy = true;
  updateCount();
  result.hidden = true;
  showProgress({ kind: 'analyzing', done: 0, total: 1 });

  const t0 = performance.now();
  const res = await check(text, showProgress);
  const seconds = (performance.now() - t0) / 1000;

  status.hidden = true;
  busy = false;
  updateCount();
  if (res.ok) showResult(res, seconds);
  else showError(res.error);
});

function check(text: string, onProgress: (p: Progress) => void): Promise<DetectResponse> {
  return new Promise((resolve) => {
    const port = browser.runtime.connect({ name: CHECK_PORT });
    port.onMessage.addListener((msg: CheckReply) => {
      if (msg.type === 'progress') return onProgress(msg.progress);
      port.disconnect();
      resolve(msg.res);
    });
    port.onDisconnect.addListener(() => resolve({ ok: false, error: 'The extension stopped responding; try again' }));
    port.postMessage({ text });
  });
}

function showProgress(p: Progress) {
  status.hidden = false;
  if (p.kind === 'loading') {
    // Files read fast; most of the wait after 100% is building the session and warming up.
    statusText.textContent = p.percent >= 100 ? 'Initializing model…' : `Loading model… ${Math.round(p.percent)}%`;
    statusBar.style.width = `${Math.min(p.percent, 100)}%`;
  } else {
    statusText.textContent = p.total > 1 ? `Analyzing section ${p.done + 1} of ${p.total}…` : 'Analyzing…';
    statusBar.style.width = `${(p.done / p.total) * 100}%`;
  }
}

function showError(error: string) {
  status.hidden = false;
  statusText.textContent = `Error: ${error}`;
  statusBar.style.width = '0';
}

const label = (score: number) => (score >= 0.5 ? 'Likely AI' : 'Likely human');
/** Green (human) through amber to red (AI). */
const color = (score: number) => `hsl(${Math.round(130 * (1 - score))} 65% 45%)`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function showResult({ score, chunks, device }: DetectResult, seconds: number) {
  $('score').textContent = score.toFixed(2);
  $('score').style.color = color(score);
  $('label').textContent = label(score);
  const tokens = chunks.reduce((sum, c) => sum + c.tokens, 0);
  $('meta').textContent = [
    `${tokens.toLocaleString()} tokens`,
    chunks.length > 1 ? `${chunks.length} sections, weighted by length` : null,
    `${device === 'webgpu' ? 'WebGPU' : 'CPU (WASM)'}, ${seconds.toFixed(1)} s`,
  ]
    .filter(Boolean)
    .join(' · ');
  $('marker').style.left = `${score * 100}%`;

  const items = chunks.length > 1
    ? chunks.map((c, i) => {
        const details = document.createElement('details');
        details.style.setProperty('--c', color(c.score));
        const summary = document.createElement('summary');
        summary.append(
          el('span', 's-score', `${i + 1}. ${c.score.toFixed(2)} ${label(c.score)}`),
          el('span', 's-excerpt', c.text),
        );
        details.append(summary, el('p', 's-text', c.text));
        const li = document.createElement('li');
        li.append(details);
        return li;
      })
    : [];
  $('sections').replaceChildren(...items);
  result.hidden = false;
}

updateCount();
