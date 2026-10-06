import {
  CHECK_PORT,
  type CheckReply,
  type CheckRequest,
  type DetectRequest,
  type DetectResponse,
  type Progress,
  type ProgressMessage,
  type Segment,
  type TranscriptResponse,
  type UiMessage,
} from '@/lib/messages';
import { grabTranscript } from '@/lib/youtube';

const MENU_ID = 'detect-ai';
const TRANSCRIPT_MENU_ID = 'detect-ai-transcript';
/**
 * Fails a check after this long with no progress from the host. Covers the worst wait between
 * updates: WebGPU hits its 10 s budget, then the WASM fallback loads. Long text keeps reporting
 * progress per section, so it can take longer overall.
 */
const IDLE_TIMEOUT_MS = 60_000;

type RunDetect = (
  text: string,
  onProgress: (progress: Progress) => void,
  segments?: Segment[],
) => Promise<DetectResponse>;

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({ id: MENU_ID, title: 'Check if AI-written', contexts: ['selection'] });
    browser.contextMenus.create({
      id: TRANSCRIPT_MENU_ID,
      title: "Check this video's transcript",
      contexts: ['page', 'link', 'video', 'image'],
      documentUrlPatterns: ['*://www.youtube.com/watch*', '*://m.youtube.com/watch*'],
    });
  });

  /** Transcripts being fetched, keyed by the id in the check.html?transcript=<id> that shows them. */
  const transcripts = new Map<string, Promise<TranscriptResponse>>();

  const runDetect = withIdleTimeout(hostRunDetect());

  // Open the results page right away; it shows progress while the transcript loads.
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== TRANSCRIPT_MENU_ID || tab?.id == null) return;
    const id = crypto.randomUUID();
    transcripts.set(id, fetchTranscript(tab.id));
    setTimeout(() => transcripts.delete(id), 10 * 60_000);
    browser.tabs.create({ url: browser.runtime.getURL(`/check.html?transcript=${id}`), index: tab.index + 1, openerTabId: tab.id });
  });

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== MENU_ID || tab?.id == null || !info.selectionText) return;
    const target = { tabId: tab.id, frameId: info.frameId ?? 0 };

    const ui = await injectUi(target);
    ui({ target: 'content', type: 'analyzing' });
    const res = await runDetect(info.selectionText, (progress) => ui({ target: 'content', type: 'progress', progress }));
    ui(
      res.ok
        ? { target: 'content', type: 'result', score: res.score, chunks: res.chunks.length }
        : { target: 'content', type: 'error', error: res.error },
    );
  });

  // Toolbar button opens the paste-and-check page.
  browser.action.onClicked.addListener(() => {
    browser.tabs.create({ url: browser.runtime.getURL('/check.html') });
  });

  // check.html asks over a port, which streams progress and keeps Firefox's event page alive.
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== CHECK_PORT) return;
    let open = true;
    port.onDisconnect.addListener(() => (open = false));
    const reply = (msg: CheckReply) => open && port.postMessage(msg);
    port.onMessage.addListener(async (req: CheckRequest) => {
      if (req.type === 'transcript') {
        const res = (await transcripts.get(req.id)) ?? {
          ok: false,
          error: "This transcript is no longer available; check the video again from its page",
        };
        reply({ type: 'transcript', res });
        return;
      }
      const res = await runDetect(req.text, (progress) => reply({ type: 'progress', progress }), req.segments);
      reply({ type: 'done', res });
    });
  });
});

/** Gives up when the host goes quiet for IDLE_TIMEOUT_MS; each progress update restarts the clock. */
function withIdleTimeout(run: RunDetect): RunDetect {
  return (text, onProgress, segments) =>
    new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => resolve({ ok: false, error: `No progress for ${IDLE_TIMEOUT_MS / 1000} s` }), IDLE_TIMEOUT_MS);
      };
      arm();
      run(
        text,
        (progress) => {
          arm();
          onProgress(progress);
        },
        segments,
      ).then((res) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
}

/** Runs grabTranscript in the YouTube page (allowed by activeTab, granted by the menu click). */
async function fetchTranscript(tabId: number): Promise<TranscriptResponse> {
  try {
    const [first] = await browser.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: grabTranscript });
    return (first?.result as TranscriptResponse | undefined) ?? { ok: false, error: 'Could not read this page' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Injects the tooltip content script into the frame and returns a sender for it. */
async function injectUi({ tabId, frameId }: { tabId: number; frameId: number }) {
  try {
    await browser.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ['/content-scripts/content.js'],
    });
  } catch (err) {
    // Restricted pages (browser UI, extension stores, PDF viewer) can't be scripted.
    console.warn('Cannot show result in this page:', err);
  }
  return (msg: UiMessage) => {
    browser.tabs.sendMessage(tabId, msg, { frameId }).catch(() => {});
  };
}

/**
 * The model runs in offscreen.html. Chrome hosts it as an offscreen document (service workers
 * can't host ORT reliably); Firefox's MV3 background is an event page with a DOM, so it hosts the
 * same page in a hidden iframe. Either way we talk to it via runtime messages.
 */
function hostRunDetect(): RunDetect {
  const progressHandlers = new Map<string, (progress: Progress) => void>();

  browser.runtime.onMessage.addListener((msg: ProgressMessage) => {
    if (msg?.target === 'background' && msg.type === 'progress') {
      progressHandlers.get(msg.requestId)?.(msg.progress);
    }
  });

  const url = browser.runtime.getURL('/offscreen.html');
  let creating: Promise<void> | null = null;

  async function ensureHost() {
    if (import.meta.env.FIREFOX) {
      creating ??= new Promise((resolve) => {
        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.onload = () => resolve();
        document.body.append(iframe);
      });
      return creating;
    }
    const existing = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    if (existing.length) return;
    creating ??= browser.offscreen
      .createDocument({ url, reasons: ['WORKERS'], justification: 'Run the local AI-text detection model' })
      .finally(() => (creating = null));
    await creating;
  }

  return async (text, onProgress, segments) => {
    await ensureHost();
    const requestId = crypto.randomUUID();
    progressHandlers.set(requestId, onProgress);
    try {
      const req: DetectRequest = { target: 'host', type: 'detect', requestId, text, segments };
      return await browser.runtime.sendMessage(req);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      progressHandlers.delete(requestId);
    }
  };
}
