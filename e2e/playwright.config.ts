import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: true,
  retries: 0,
  use: {
    headless: false,
  },
  // Paths are resolved relative to this config file's directory. This package is
  // `"type": "module"`, so Playwright loads these `.ts` files as ESM — `require` is not
  // defined in that scope (see the CI ReferenceError this replaced). Use plain relative
  // strings instead of `require.resolve`.
  globalSetup: './setup/global-setup.ts',
  globalTeardown: './setup/global-teardown.ts',
});
