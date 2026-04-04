import { chromium } from 'playwright';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { startTestSiteServer } from '../test-site/server';

const CSS_PORT = 3000;
const BASIC_SITE_PORT = 8080;
const CLIENT_ID_SITE_PORT = 8081;
const ROOT = path.resolve(__dirname, '..');

const children: ChildProcess[] = [];
const servers: http.Server[] = [];

function cleanup() {
  for (const child of children) child.kill();
  for (const server of servers) server.close();
  process.exit();
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

async function waitForServer(url: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(url, (res) => { res.resume(); resolve(); });
        req.on('error', reject);
        req.setTimeout(1000, () => { req.destroy(); reject(); });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`${url} did not start in ${timeoutMs}ms`);
}

const extPath = path.join(ROOT, 'dist');
const extArgs = [
  `--disable-extensions-except=${extPath}`,
  `--load-extension=${extPath}`,
];

async function discoverExtensionId(userDataDir: string): Promise<string> {
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: false,
    args: extArgs,
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];
  await ctx.close();
  return extensionId;
}

function pinExtension(userDataDir: string, extensionId: string) {
  const prefsPath = path.join(userDataDir, 'Default', 'Preferences');
  const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
  prefs.extensions = prefs.extensions || {};
  prefs.extensions.pinned_extensions = prefs.extensions.pinned_extensions || [];
  if (!prefs.extensions.pinned_extensions.includes(extensionId)) {
    prefs.extensions.pinned_extensions.push(extensionId);
  }
  fs.writeFileSync(prefsPath, JSON.stringify(prefs));
}

(async () => {
  // 1. Build
  console.log('Building extension...');
  const build = spawn('npx', ['webpack'], { cwd: ROOT, stdio: 'inherit' });
  await new Promise<void>((resolve, reject) => {
    build.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Build failed (${code})`))));
  });

  // 2. Start CSS
  console.log('Starting Community Solid Server...');
  const css = spawn('npx', [
    '@solid/community-server',
    '-p', String(CSS_PORT),
    '-c', path.join(ROOT, 'e2e/setup/css-config.json'),
    '--seedConfig', path.join(ROOT, 'e2e/setup/seed.json'),
    '-l', 'warn',
  ], { stdio: 'pipe' });
  children.push(css);
  css.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString();
    if (msg.includes('Error')) console.error('[CSS]', msg);
  });
  await waitForServer(`http://localhost:${CSS_PORT}`);
  console.log(`  CSS ready on http://localhost:${CSS_PORT}`);

  // 3. Discover extension ID (needed to build the client ID URL)
  console.log('Configuring browser...');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-ext-dev-'));
  const extensionId = await discoverExtensionId(userDataDir);
  pinExtension(userDataDir, extensionId);

  // 4. Start two test site servers, both configured with the extension's redirect URI
  const redirectUri = `https://${extensionId}.chromiumapp.org/callback`;
  const appClientIdUrl = `http://localhost:${CLIENT_ID_SITE_PORT}/client-id`;

  console.log('Starting test sites...');

  const basicServer = await startTestSiteServer({
    port: BASIC_SITE_PORT,
    redirectUri,
    clientName: 'Solid Browser Extension',
  });
  servers.push(basicServer);
  console.log(`  Basic site ready on http://localhost:${BASIC_SITE_PORT}`);

  const clientIdServer = await startTestSiteServer({
    port: CLIENT_ID_SITE_PORT,
    redirectUri,
    clientName: 'My Test App',
    clientIdUrl: appClientIdUrl,
  });
  servers.push(clientIdServer);
  console.log(`  Client ID site ready on http://localhost:${CLIENT_ID_SITE_PORT}`);

  // 6. Relaunch with extension pinned, open both sites
  console.log('Launching browser...');
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: false,
    args: extArgs,
  });

  const page1 = context.pages()[0] || await context.newPage();
  await page1.goto(`http://localhost:${BASIC_SITE_PORT}/`);

  const page2 = await context.newPage();
  await page2.goto(`http://localhost:${CLIENT_ID_SITE_PORT}/with-client-id.html`);

  console.log('\n-----------------------------------------------');
  console.log('  Ready! Browser is open with the extension.');
  console.log('');
  console.log('  Test user credentials:');
  console.log('    WebID:    http://localhost:3000/test-pod/profile/card#me');
  console.log('    Email:    test@example.com');
  console.log('    Password: test-password-123');
  console.log('');
  console.log('  Sample sites (open in browser tabs):');
  console.log('');
  console.log('    1. Basic site (dynamic registration):');
  console.log(`       http://localhost:${BASIC_SITE_PORT}/`);
  console.log('');
  console.log('    2. App with static client ID (solid.setClientId):');
  console.log(`       http://localhost:${CLIENT_ID_SITE_PORT}/with-client-id.html`);
  console.log('');
  console.log('  CSS:  http://localhost:3000');
  console.log('-----------------------------------------------');
  console.log('  Close the browser or press Ctrl+C to stop.\n');

  context.on('close', cleanup);
})();
