import { defineConfig } from 'vitest/config';

// Unit tests run in jsdom so the security-critical, browser-shaped core modules
// (DPoP proof generation, per-origin token boundary, the silent-restore decision
// wiring) are testable WITHOUT a packed extension or a real Solid server. The
// chrome.* extension APIs are stubbed per-test; the e2e Playwright suite (against a
// LOCAL CSS) covers the integrated extension. See e2e/playwright.config.ts.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'e2e/**'],
    globals: false,
  },
});
