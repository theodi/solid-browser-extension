import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import http from 'http';

let serverProcess: ChildProcess | null = null;

const CSS_PORT = 3000;
const CSS_BASE_URL = `http://localhost:${CSS_PORT}`;

export async function startCSSServer(): Promise<void> {
  const seedConfig = path.resolve(__dirname, 'seed.json');
  const cssConfig = path.resolve(__dirname, 'css-config.json');
  const skipConsentPatch = path.resolve(__dirname, 'skip-consent-patch.cjs');

  // Load a --require patch that removes the OIDC consent prompt from the
  // CSS interaction policy. The extension's per-client silent re-auth
  // (prompt=none) then succeeds without the IdP pausing for a consent
  // screen, which is required to demonstrate per-client identity in e2e.
  const nodeOptions = [process.env.NODE_OPTIONS, `--require ${skipConsentPatch}`]
    .filter(Boolean)
    .join(' ');

  serverProcess = spawn('npx', [
    '@solid/community-server',
    '-p', String(CSS_PORT),
    '-c', cssConfig,
    '--seedConfig', seedConfig,
    '-l', 'warn',
  ], {
    stdio: 'pipe',
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
  });

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

export { CSS_PORT, CSS_BASE_URL };
