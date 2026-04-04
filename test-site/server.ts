import http from 'http';
import fs from 'fs';
import path from 'path';

const STATIC_DIR = __dirname;
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
  /** If set, the server injects this client ID into the app config. */
  clientIdUrl?: string;
}

export function createTestSiteServer(opts: TestSiteOptions): http.Server {
  const { port, clientIdUrl } = opts;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    // Dynamic Client ID Document endpoint
    // GET /client-id?redirect_uri=...&client_name=...
    if (url.pathname === '/client-id') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const clientName = url.searchParams.get('client_name') || 'Test Application';
      if (!redirectUri) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing redirect_uri parameter');
        return;
      }
      const clientId = `http://localhost:${port}/client-id?redirect_uri=${encodeURIComponent(redirectUri)}&client_name=${encodeURIComponent(clientName)}`;
      const doc = {
        '@context': ['https://www.w3.org/ns/solid/oidc-context.jsonld'],
        client_id: clientId,
        client_name: clientName,
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
