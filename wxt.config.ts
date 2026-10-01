import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: 'AI Text Detector',
    description: 'Right-click selected text to estimate whether it was AI-generated, using a local model.',
    permissions: [
      'contextMenus',
      'activeTab',
      'scripting',
      ...(browser === 'firefox' ? [] : ['offscreen']),
    ],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
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
