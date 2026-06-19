import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startTestSiteServer } from '../../test-site/server';
import { startCSSServer } from './css-server';

// This package is `"type": "module"`; Playwright loads this file as ESM, where `__dirname`
// is not defined. Derive it from `import.meta.url`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_SITE_PORT = 8080;
const APP_SITE_PORT = 8081;

async function discoverExtensionId(): Promise<string> {
  const extPath = path.resolve(__dirname, '../../dist');
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];
  await ctx.close();
  return extensionId;
}

async function globalSetup() {
  console.log('Starting Community Solid Server...');
  await startCSSServer();
  console.log('CSS server ready on http://localhost:3000');

  console.log('Discovering extension ID...');
  const extensionId = await discoverExtensionId();
  const redirectUri = `https://${extensionId}.chromiumapp.org/callback`;
  console.log(`  Extension ID: ${extensionId}`);

  // Port 8080: basic test site + extension's Client ID Document
  const server = await startTestSiteServer({
    port: TEST_SITE_PORT,
    redirectUri,
    clientName: 'Solid Browser Extension',
  });
  console.log(`Test site ready on http://localhost:${TEST_SITE_PORT}`);

  // Port 8081: app site with its own Client ID Document
  const appClientIdUrl = `http://localhost:${APP_SITE_PORT}/client-id`;
  const appServer = await startTestSiteServer({
    port: APP_SITE_PORT,
    redirectUri,
    clientName: 'Test Application',
    clientIdUrl: appClientIdUrl,
  });
  console.log(`App site ready on http://localhost:${APP_SITE_PORT}`);

  const globals = globalThis as Record<string, unknown>;
  globals.__TEST_SITE_SERVER__ = server;
  globals.__APP_SITE_SERVER__ = appServer;
}

export default globalSetup;
