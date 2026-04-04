import { startCSSServer } from './css-server';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import http from 'http';

let testSiteProcess: ChildProcess | null = null;
const TEST_SITE_PORT = 8080;

async function globalSetup() {
  // Start Community Solid Server
  console.log('Starting Community Solid Server...');
  await startCSSServer();
  console.log('CSS server ready on http://localhost:3000');

  // Start test site server
  const testSitePath = path.resolve(__dirname, '../../test-site');
  testSiteProcess = spawn('npx', [
    'http-server', testSitePath,
    '-p', String(TEST_SITE_PORT),
    '-s', // Silent
  ], {
    stdio: 'pipe',
    env: { ...process.env },
  });

  // Wait for test site to be ready
  await waitForServer(`http://localhost:${TEST_SITE_PORT}`, 10_000);
  console.log(`Test site ready on http://localhost:${TEST_SITE_PORT}`);

  // Store the process for teardown
  (globalThis as Record<string, unknown>).__TEST_SITE_PROCESS__ = testSiteProcess;
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(url, (res) => {
          res.resume();
          resolve();
        });
        req.on('error', reject);
        req.setTimeout(1000, () => {
          req.destroy();
          reject(new Error('timeout'));
        });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

export default globalSetup;
