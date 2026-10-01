// Inference host. Chrome loads it as an offscreen document, Firefox as an iframe in the
// background page (see background.ts). It keeps the model in memory between requests.
import { detect } from '@/lib/detector';
import type { DetectRequest, DetectResponse, ProgressMessage } from '@/lib/messages';

async function handleDetect(req: DetectRequest): Promise<DetectResponse> {
  try {
    const score = await detect(req.text, (percent) => {
      const msg: ProgressMessage = { target: 'background', type: 'progress', requestId: req.requestId, percent };
      browser.runtime.sendMessage(msg).catch(() => {});
    });
    return { ok: true, score };
  } catch (err) {
    console.error(err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

browser.runtime.onMessage.addListener((msg: DetectRequest, _sender, sendResponse) => {
  if (msg?.target !== 'host' || msg.type !== 'detect') return;
  handleDetect(msg).then(sendResponse);
  return true;
});
