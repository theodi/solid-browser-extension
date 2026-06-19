import path from 'node:path';
import { type BrowserContext, test as base, chromium } from '@playwright/test';

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
