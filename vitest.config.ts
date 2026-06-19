import { defineConfig } from 'vitest/config';

// The security-critical, browser-shaped core modules (DPoP proof generation, the
// per-origin token boundary, the silent-restore decision wiring) are testable WITHOUT
// a packed extension or a real Solid server. Default to `node` so jose signs with
// Node's spec-complete webcrypto CryptoKey (jsdom's crypto.subtle is incomplete); a
// DOM-needing test opts into jsdom with a `// @vitest-environment jsdom` docblock. The
// chrome.* extension APIs are stubbed per-test; the e2e Playwright suite (against a
// LOCAL CSS) covers the integrated extension. See e2e/playwright.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'e2e/**'],
    globals: false,
  },
});
