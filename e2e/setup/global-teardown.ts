import { stopCSSServer } from './css-server';
import type http from 'http';

async function globalTeardown() {
  await stopCSSServer();

  const server = (globalThis as Record<string, unknown>).__TEST_SITE_SERVER__ as http.Server | undefined;
  if (server) {
    server.close();
  }
}

export default globalTeardown;
