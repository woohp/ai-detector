import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifestVersion: 3,
  // Source zips are only for store review; we don't publish.
  zip: { zipSources: false },
  // Generates the 16–128 px PNG icons from one SVG (Chrome doesn't accept SVG manifest icons).
  modules: ['@wxt-dev/auto-icons'],
  autoIcons: { baseIconPath: 'assets/icon.svg', developmentIndicator: false },
  manifest: ({ browser }) => ({
    name: 'AI Text Detector',
    description: 'Right-click selected text to estimate whether it was AI-generated, using a local model.',
    permissions: [
      'contextMenus',
      'activeTab',
      'scripting',
      ...(browser === 'firefox' ? [] : ['offscreen']),
    ],
    // No popup: clicking the toolbar button opens check.html (see background.ts).
    action: { default_title: 'Check text for AI writing' },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    // Cross-origin isolation enables SharedArrayBuffer, which ORT needs for multithreaded WASM.
    // Firefox doesn't support these keys, so its WASM fallback runs single-threaded.
    ...(browser !== 'firefox' && {
      cross_origin_embedder_policy: { value: 'require-corp' },
      cross_origin_opener_policy: { value: 'same-origin' },
    }),
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: {
          id: 'ai-detector@local',
          data_collection_permissions: { required: ['none'] },
        },
      },
    }),
  }),
});
