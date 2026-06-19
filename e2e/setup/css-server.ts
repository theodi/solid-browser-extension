import { type ChildProcess, spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This package is `"type": "module"`; Playwright loads this file as ESM, where `__dirname`
// is not defined. Derive it from `import.meta.url`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let serverProcess: ChildProcess | null = null;

const CSS_PORT = 3000;
const CSS_BASE_URL = `http://localhost:${CSS_PORT}`;

export async function startCSSServer(): Promise<void> {
  const seedConfig = path.resolve(__dirname, 'seed.json');
  const cssConfig = path.resolve(__dirname, 'css-config.json');

  serverProcess = spawn(
    'npx',
    [
      '@solid/community-server',
      '-p',
      String(CSS_PORT),
      '-c',
      cssConfig,
      '--seedConfig',
      seedConfig,
      '-l',
      'warn',
    ],
    {
      stdio: 'pipe',
      env: { ...process.env },
    },
  );

  serverProcess.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString();
    if (msg.includes('Error') || msg.includes('error')) {
      console.error('[CSS]', msg);
    }
  });

  // Wait for the server to be ready
  await waitForServer(CSS_BASE_URL, 30_000);
}

export async function stopCSSServer(): Promise<void> {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
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

export { CSS_BASE_URL, CSS_PORT };
