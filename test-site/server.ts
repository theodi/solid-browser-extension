import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This package is `"type": "module"`; this file is loaded as ESM (by the Playwright e2e
// global-setup and by scripts/dev.ts), where `__dirname` is not defined. Derive it from
// `import.meta.url`.
const STATIC_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.jsonld': 'application/ld+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export interface TestSiteOptions {
  port: number;
  /** The redirect URI to include in the Client ID Document served at /client-id. */
  redirectUri?: string;
  /** The client name for the Client ID Document. Defaults to the server's role. */
  clientName?: string;
  /** If set, the /config.json endpoint returns this as the clientIdUrl for the app. */
  clientIdUrl?: string;
}

export function createTestSiteServer(opts: TestSiteOptions): http.Server {
  const { port, redirectUri, clientName, clientIdUrl } = opts;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    // Client ID Document endpoint — clean URL, no query params in the client_id
    if (url.pathname === '/client-id') {
      if (!redirectUri) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Server not configured with a redirectUri');
        return;
      }
      const selfUrl = `http://localhost:${port}/client-id`;
      const doc = {
        '@context': ['https://www.w3.org/ns/solid/oidc-context.jsonld'],
        client_id: selfUrl,
        client_name: clientName || 'Solid Application',
        redirect_uris: [redirectUri],
        scope: 'openid profile offline_access webid',
        grant_types: ['refresh_token', 'authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
      res.writeHead(200, {
        'Content-Type': 'application/ld+json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(doc, null, 2));
      return;
    }

    // Injected config endpoint — returns runtime configuration for the app
    if (url.pathname === '/config.json') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ clientIdUrl: clientIdUrl || null }));
      return;
    }

    // Static file serving
    const filePath = path.join(STATIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
    });
  });

  return server;
}

export function startTestSiteServer(opts: TestSiteOptions): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = createTestSiteServer(opts);
    server.listen(opts.port, () => resolve(server));
  });
}
