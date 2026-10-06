// Paste-and-check page, opened from the toolbar button. The model runs in the shared inference
// host; this page talks to it through the background over a port (see background.ts).
// Opened as check.html?transcript=<id> from a YouTube video's context menu, it loads and checks
// that video's transcript.
import {
  CHECK_PORT,
  type CheckReply,
  type CheckRequest,
  type DetectResponse,
  type DetectResult,
  type Progress,
  type Segment,
  type TranscriptResponse,
} from '@/lib/messages';

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
/** The transcript in the text box, until the user edits it. */
let transcript: Extract<TranscriptResponse, { ok: true }> | null = null;

function words(text: string) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function updateCount() {
  const n = words(input.value);
  count.textContent = `${n.toLocaleString()} word${n === 1 ? '' : 's'}`;
  submit.disabled = busy || n === 0;
}

input.addEventListener('input', () => {
  // Edited text is no longer the transcript: score it as plain text.
  if (transcript) {
    transcript = null;
    $('video-meta').textContent = 'Edited; checked as plain text.';
  }
  updateCount();
});
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
  const res = await check({ type: 'detect', text, segments: transcript?.segments });
  const seconds = (performance.now() - t0) / 1000;

  status.hidden = true;
  busy = false;
  updateCount();
  if (res.ok) showResult(res, seconds);
  else showError(res.error);
});

/** Sends one request to the background and waits for its final reply. */
function ask<R>(req: CheckRequest, pick: (msg: CheckReply) => R | undefined, onProgress?: (p: Progress) => void): Promise<R | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const port = browser.runtime.connect({ name: CHECK_PORT });
    port.onMessage.addListener((msg: CheckReply) => {
      if (msg.type === 'progress') return onProgress?.(msg.progress);
      const value = pick(msg);
      if (value === undefined) return;
      port.disconnect();
      resolve(value);
    });
    port.onDisconnect.addListener(() => resolve({ ok: false, error: 'The extension stopped responding; try again' }));
    port.postMessage(req);
  });
}

const check = (req: CheckRequest) =>
  ask<DetectResponse>(req, (msg) => (msg.type === 'done' ? msg.res : undefined), showProgress);

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

/**
 * Transcripts get wider bands: recent human videos scored up to 0.47 (YouTube's punctuated
 * auto-captions push spoken text up), and suspected AI narration 0.67 and above.
 */
function label(score: number, isTranscript: boolean) {
  if (!isTranscript) return score >= 0.5 ? 'Likely AI' : 'Likely human';
  return score < 0.4 ? 'Likely human' : score <= 0.6 ? 'Unclear' : 'Likely AI';
}
/** Green (human) through amber to red (AI). */
const color = (score: number) => `hsl(${Math.round(130 * (1 - score))} 65% 45%)`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  const [h, m] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60)];
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function showResult({ score, chunks, device }: DetectResult, seconds: number) {
  const video = transcript;
  $('score').textContent = score.toFixed(2);
  $('score').style.color = color(score);
  $('label').textContent = label(score, !!video);
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
        summary.append(el('span', 's-score', `${i + 1}. ${c.score.toFixed(2)} ${label(c.score, !!video)}`));
        if (video && c.startMs != null) {
          const end = chunks[i + 1]?.startMs ?? video.durationMs;
          const link = el('a', 's-time', `${clock(c.startMs)}–${clock(end)}`);
          link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}&t=${Math.floor(c.startMs / 1000)}s`;
          link.target = '_blank';
          link.rel = 'noopener';
          summary.append(link);
        }
        summary.append(el('span', 's-excerpt', c.text));
        details.append(summary, el('p', 's-text', c.text));
        const li = document.createElement('li');
        li.append(details);
        return li;
      })
    : [];
  $('sections').replaceChildren(...items);
  $('sections-note').hidden = !video || chunks.length < 2;
  result.hidden = false;
}

async function loadTranscript(id: string) {
  $('video').hidden = false;
  $('video-status').textContent = 'Getting the transcript… (waits for an ad to finish, if one is playing)';
  busy = true;
  updateCount();
  const res = await ask<TranscriptResponse>({ type: 'transcript', id }, (msg) => (msg.type === 'transcript' ? msg.res : undefined));
  busy = false;
  if (!res.ok) {
    $('video-status').textContent = '';
    updateCount();
    return showError(res.error);
  }
  transcript = res;
  document.title = `${res.title} · AI Text Detector`;
  $('video-status').textContent = 'YouTube transcript';
  const title = $<HTMLAnchorElement>('video-title');
  title.textContent = res.title;
  title.href = `https://www.youtube.com/watch?v=${encodeURIComponent(res.videoId)}`;
  $('video-meta').textContent = `${clock(res.durationMs)} · ${res.autoCaptions ? 'auto-generated captions' : 'captions by the creator'}`;
  input.value = res.segments.map((s: Segment) => s.text).join(' ');
  updateCount();
  form.requestSubmit();
}

updateCount();
const transcriptId = new URLSearchParams(location.search).get('transcript');
if (transcriptId) loadTranscript(transcriptId);
