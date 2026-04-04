import { startCSSServer } from './css-server';
import { startTestSiteServer } from '../../test-site/server';
import type http from 'http';

const TEST_SITE_PORT = 8080;

async function globalSetup() {
  // Start Community Solid Server
  console.log('Starting Community Solid Server...');
  await startCSSServer();
  console.log('CSS server ready on http://localhost:3000');

  // Start test site server (with dynamic Client ID Document endpoint)
  const server = await startTestSiteServer({ port: TEST_SITE_PORT });
  console.log(`Test site ready on http://localhost:${TEST_SITE_PORT}`);

  (globalThis as Record<string, unknown>).__TEST_SITE_SERVER__ = server;
}

export default globalSetup;
