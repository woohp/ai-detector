import type { DetectRequest, DetectResponse, ProgressMessage, UiMessage } from '@/lib/messages';

const MENU_ID = 'detect-ai';

type RunDetect = (text: string, onProgress: (percent: number) => void) => Promise<DetectResponse>;

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({ id: MENU_ID, title: 'Check if AI-written', contexts: ['selection'] });
  });

  const runDetect = hostRunDetect();

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== MENU_ID || tab?.id == null || !info.selectionText) return;
    const target = { tabId: tab.id, frameId: info.frameId ?? 0 };

    const ui = await injectUi(target);
    ui({ target: 'content', type: 'analyzing' });

    const res = await runDetect(info.selectionText, (percent) =>
      ui({ target: 'content', type: 'loading', percent }),
    );
    ui(res.ok ? { target: 'content', type: 'result', score: res.score } : { target: 'content', type: 'error', error: res.error });
  });
});

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
  const progressHandlers = new Map<string, (percent: number) => void>();

  browser.runtime.onMessage.addListener((msg: ProgressMessage) => {
    if (msg?.target === 'background' && msg.type === 'progress') {
      progressHandlers.get(msg.requestId)?.(msg.percent);
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

  return async (text, onProgress) => {
    await ensureHost();
    const requestId = crypto.randomUUID();
    progressHandlers.set(requestId, onProgress);
    try {
      const req: DetectRequest = { target: 'host', type: 'detect', requestId, text };
      return await browser.runtime.sendMessage(req);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      progressHandlers.delete(requestId);
    }
  };
}
