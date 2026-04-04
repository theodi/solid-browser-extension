import { stopCSSServer } from './css-server';
import type http from 'http';

async function globalTeardown() {
  await stopCSSServer();

  const globals = globalThis as Record<string, unknown>;
  for (const key of ['__TEST_SITE_SERVER__', '__APP_SITE_SERVER__']) {
    const server = globals[key] as http.Server | undefined;
    if (server) server.close();
  }
}

export default globalTeardown;
