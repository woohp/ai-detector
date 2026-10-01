import type { UiMessage } from '@/lib/messages';

declare global {
  interface Window {
    __aiDetectorInjected?: boolean;
  }
}

const STYLE = `
  :host { all: initial; }
  .box {
    position: fixed; z-index: 2147483647; max-width: 260px;
    padding: 8px 12px; border-radius: 8px;
    font: 13px/1.4 system-ui, sans-serif;
    background: #1f2328; color: #f0f3f6; box-shadow: 0 4px 16px rgb(0 0 0 / .3);
  }
  .score { font-weight: 600; font-variant-numeric: tabular-nums; }
  .bar { height: 4px; margin-top: 6px; border-radius: 2px; background: #444c56; overflow: hidden; }
  .fill { height: 100%; background: #4493f8; transition: width .2s; }
`;

// Injected on demand by the background script (activeTab + scripting), not on every page.
export default defineContentScript({
  registration: 'runtime',
  main() {
    if (window.__aiDetectorInjected) return;
    window.__aiDetectorInjected = true;

    let host: HTMLElement | null = null;
    let box: HTMLDivElement | null = null;

    function close() {
      host?.remove();
      host = box = null;
    }

    function open() {
      close();
      host = document.createElement('ai-detector-tooltip');
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = STYLE;
      box = document.createElement('div');
      box.className = 'box';
      root.append(style, box);

      const rect = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0).getBoundingClientRect() : null;
      const top = rect && rect.height ? rect.bottom + 8 : 16;
      const left = rect && rect.width ? rect.left : 16;
      box.style.top = `${Math.min(top, window.innerHeight - 60)}px`;
      box.style.left = `${Math.max(8, Math.min(left, window.innerWidth - 270))}px`;

      document.documentElement.append(host);
    }

    function el(tag: string, className: string, text = '') {
      const node = document.createElement(tag);
      node.className = className;
      node.textContent = text;
      return node;
    }

    /** Replaces the tooltip content with text and an optional 0–1 progress bar. */
    function render(parts: (string | Node)[], bar?: number) {
      if (!box) open();
      box!.replaceChildren(...parts);
      if (bar != null) {
        const fill = el('div', 'fill');
        fill.style.width = `${Math.round(bar * 100)}%`;
        const track = el('div', 'bar');
        track.append(fill);
        box!.append(track);
      }
    }

    document.addEventListener('mousedown', (e) => host && !e.composedPath().includes(host) && close(), true);
    document.addEventListener('keydown', (e) => e.key === 'Escape' && close(), true);

    browser.runtime.onMessage.addListener((msg: UiMessage) => {
      if (msg?.target !== 'content') return;
      switch (msg.type) {
        case 'analyzing':
          open();
          render(['Analyzing…']);
          break;
        case 'progress': {
          const p = msg.progress;
          // Files read fast; most of the wait after 100% is building the session and warming up.
          if (p.kind === 'loading') {
            if (p.percent >= 100) render(['Initializing model…']);
            else render([`Loading model… ${Math.round(p.percent)}%`], p.percent / 100);
          } else if (p.total > 1) {
            render([`Analyzing section ${p.done + 1} of ${p.total}…`], p.done / p.total);
          } else {
            render(['Analyzing…']);
          }
          break;
        }
        case 'result': {
          const label = msg.score >= 0.5 ? 'Likely AI' : 'Likely human';
          const sections = msg.chunks > 1 ? ` (${msg.chunks} sections)` : '';
          render([el('span', 'score', `AI score: ${msg.score.toFixed(2)}`), ` · ${label}${sections}`], msg.score);
          break;
        }
        case 'error':
          render([`Error: ${msg.error}`]);
          break;
      }
    });
  },
});
