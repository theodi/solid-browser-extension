import { stopCSSServer } from './css-server';
import type { ChildProcess } from 'child_process';

async function globalTeardown() {
  // Stop CSS server
  await stopCSSServer();

  // Stop test site server
  const testSiteProcess = (globalThis as Record<string, unknown>).__TEST_SITE_PROCESS__ as ChildProcess | undefined;
  if (testSiteProcess) {
    testSiteProcess.kill('SIGTERM');
  }
}

export default globalTeardown;
