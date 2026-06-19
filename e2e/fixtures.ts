import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, test as base, chromium } from '@playwright/test';

// This package is `"type": "module"`; Playwright loads this file as ESM, where `__dirname`
// is not defined. Derive it from `import.meta.url`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright's fixture-deps signature.
  context: async ({}, use) => {
    const pathToExtension = path.resolve(__dirname, '../dist');
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: false,
      args: [
        `--disable-extensions-except=${pathToExtension}`,
        `--load-extension=${pathToExtension}`,
      ],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    // Wait for the service worker to be registered
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      sw = await context.waitForEvent('serviceworker');
    }
    const extensionId = sw.url().split('/')[2];
    await use(extensionId);
  },
});

export const expect = test.expect;
