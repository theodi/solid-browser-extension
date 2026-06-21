// AUTHORED-BY Claude Opus 4.8
//
// INTEGRATION tests for the Phase-0 per-requesting-origin gate AS WIRED INTO the service
// worker. These drive the REAL `chrome.runtime.onMessage` listener the worker registers,
// with an in-memory `chrome.storage.local` and a captured `fetch`, proving the wiring — not
// just the pure gate logic (covered in requesting-origin.test.ts):
//
//   - a forged/mismatched sender.origin vs the page stamp → DENY, NO pod egress
//   - an un-granted origin attempting a whole-pod read → DENY, NO egress
//   - app-A requesting app-B-only data (A un-granted) → DENY
//   - opaque/null origin → DENY (fail-safe)
//   - a boot/SW-restart race (grant store not yet populated) → fail-CLOSED
//   - the legitimate single-user owner path (granted origin) → SUCCEEDS with egress
//   - login from an app origin GRANTS that origin (the opt-in), unlocking subsequent fetches
//   - SOLID_GET_STATE withholds the WebID (PII) from a non-granted page, exposes to granted

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exportDpopKeyPair, generateDpopKeyPair } from '../src/background/core/dpop';
import type { StoredSession } from '../src/background/session-store';

// --- An in-memory chrome.* stub + a captured fetch ------------------------------------

interface CapturedSender {
  origin?: string;
  url?: string;
  id?: string;
}
type MessageListener = (
  message: unknown,
  sender: CapturedSender,
  sendResponse: (r: unknown) => void,
) => boolean | undefined;

let storage: Map<string, unknown>;
let messageListeners: MessageListener[];
let fetchCalls: Array<{ url: string; init?: RequestInit }>;
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

function installChrome(): void {
  storage = new Map();
  messageListeners = [];
  fetchCalls = [];

  const chromeStub = {
    runtime: {
      id: EXTENSION_ID,
      lastError: undefined as { message?: string } | undefined,
      onMessage: { addListener: (fn: MessageListener) => messageListeners.push(fn) },
      onInstalled: { addListener: (_fn: () => void) => {} },
      sendMessage: (_m: unknown, _cb?: (r: unknown) => void) => Promise.resolve(),
    },
    storage: {
      local: {
        get: async (key: string) => {
          const out: Record<string, unknown> = {};
          if (storage.has(key)) out[key] = storage.get(key);
          return out;
        },
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) storage.set(k, v);
        },
        remove: async (key: string) => {
          storage.delete(key);
        },
      },
    },
    tabs: {
      query: async () => [] as Array<{ id?: number; url?: string }>,
      sendMessage: async () => {},
    },
    action: {
      setIcon: async () => {},
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    contextMenus: {
      create: () => {},
      remove: (_id: string, cb?: () => void) => cb?.(),
      onClicked: { addListener: () => {} },
    },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    identity: { launchWebAuthFlow: async () => '' },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chromeStub;

  // A captured global fetch: default deny-with-401 so an UNGATED egress is observable.
  fetchImpl = async () => new Response('ok', { status: 200 });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      fetchCalls.push({ url, init });
      return fetchImpl(url, init);
    },
  ) as unknown as typeof fetch;
}

/** Drive the worker's registered SOLID_FETCH_REQUEST listener and await its response. */
function sendFetch(
  message: Record<string, unknown>,
  sender: CapturedSender,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    for (const listener of messageListeners) {
      const handled = listener(
        {
          type: 'SOLID_FETCH_REQUEST',
          requestId: 'r1',
          method: 'GET',
          headers: {},
          body: null,
          ...message,
        },
        sender,
        (r) => resolve(r as Record<string, unknown>),
      );
      if (handled) return;
    }
    resolve({ error: 'no listener handled' });
  });
}

function sendMessage(
  message: Record<string, unknown>,
  sender: CapturedSender,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    for (const listener of messageListeners) {
      const handled = listener(message, sender, (r) => resolve(r as Record<string, unknown>));
      if (handled) return;
    }
    resolve({ error: 'no listener handled' });
  });
}

async function seedSession(overrides: Partial<StoredSession> = {}): Promise<void> {
  const keyPair = await generateDpopKeyPair();
  const session: StoredSession = {
    webId: 'https://alice.pod.example/profile/card#me',
    accessToken: 'access-token-xyz',
    refreshToken: 'refresh-xyz',
    dpopKeyPair: await exportDpopKeyPair(keyPair),
    issuer: 'https://idp.example/',
    tokenEndpoint: 'https://idp.example/token',
    clientId: 'https://pm.example/clientid.jsonld',
    expiresAt: Date.now() + 60 * 60 * 1000, // far in the future: no refresh needed
    ...overrides,
  };
  storage.set('solid:session', session);
}

/** Fresh module + chrome per test (the worker registers listeners + state at import). */
async function loadWorker(): Promise<void> {
  vi.resetModules();
  await import('../src/background/service-worker');
  // Let the import-time ensureSession()/icon promise settle.
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  installChrome();
});

describe('service-worker per-requesting-origin gate (wired)', () => {
  it('the legitimate owner path: a GRANTED app reads its pod → SUCCEEDS with egress', async () => {
    await seedSession();
    storage.set('solid:granted-origins', ['https://pm.example']);
    await loadWorker();

    const res = await sendFetch(
      { url: 'https://alice.pod.example/private/notes.ttl', stampedOrigin: 'https://pm.example' },
      { origin: 'https://pm.example', url: 'https://pm.example/app.html' },
    );

    expect(res.status).toBe(200);
    // The token-bearing egress to the pod actually happened.
    const podCall = fetchCalls.find((c) => c.url.startsWith('https://alice.pod.example'));
    expect(podCall).toBeDefined();
    const headers = podCall?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('DPoP access-token-xyz');
  });

  it('a credential-origin app (served FROM the pod) reads without a separate grant', async () => {
    await seedSession();
    // no explicit grants — the pod origin is auto-granted as a requester.
    await loadWorker();
    const res = await sendFetch(
      { url: 'https://alice.pod.example/x.ttl', stampedOrigin: 'https://alice.pod.example' },
      { origin: 'https://alice.pod.example', url: 'https://alice.pod.example/app' },
    );
    expect(res.status).toBe(200);
  });

  it('DENIES a FORGED sender.origin (renderer spoofs a granted origin) — NO egress', async () => {
    await seedSession();
    storage.set('solid:granted-origins', ['https://pm.example']);
    await loadWorker();

    const res = await sendFetch(
      // The page stamps the granted origin, but the browser attests the attacker's.
      { url: 'https://alice.pod.example/private/notes.ttl', stampedOrigin: 'https://pm.example' },
      { origin: 'https://attacker.example', url: 'https://attacker.example/x' },
    );

    expect(res.status).toBe(403);
    expect(res.error).toBe('Forbidden origin');
    // CRITICAL: no request to the pod was ever made.
    expect(fetchCalls.some((c) => c.url.startsWith('https://alice.pod.example'))).toBe(false);
  });

  it('DENIES an UN-GRANTED origin attempting a whole-pod read — NO egress', async () => {
    await seedSession();
    storage.set('solid:granted-origins', ['https://pm.example']);
    await loadWorker();

    const res = await sendFetch(
      { url: 'https://alice.pod.example/', stampedOrigin: 'https://evil.example' },
      { origin: 'https://evil.example', url: 'https://evil.example/x' },
    );

    expect(res.status).toBe(403);
    expect(res.error).toBe('Origin not granted access');
    expect(fetchCalls.some((c) => c.url.startsWith('https://alice.pod.example'))).toBe(false);
  });

  it('DENIES app-A reading app-B-only data when A is not granted — NO egress', async () => {
    await seedSession();
    storage.set('solid:granted-origins', ['https://appB.example']); // only B
    await loadWorker();

    const res = await sendFetch(
      {
        url: 'https://alice.pod.example/appB-data/secret.ttl',
        stampedOrigin: 'https://appA.example',
      },
      { origin: 'https://appA.example', url: 'https://appA.example/x' },
    );

    expect(res.status).toBe(403);
    expect(fetchCalls.some((c) => c.url.startsWith('https://alice.pod.example'))).toBe(false);
  });

  it('DENIES an opaque/null requesting origin (fail-safe) — NO egress', async () => {
    await seedSession();
    storage.set('solid:granted-origins', ['https://pm.example']);
    await loadWorker();

    const res = await sendFetch(
      { url: 'https://alice.pod.example/x', stampedOrigin: 'null' },
      { origin: 'null', url: 'about:blank' },
    );

    expect(res.status).toBe(403);
    expect(res.error).toBe('Forbidden origin');
    expect(fetchCalls.some((c) => c.url.startsWith('https://alice.pod.example'))).toBe(false);
  });

  it('FAIL-CLOSED on a boot/SW-restart race: a request that arrives before the grant store is populated is DENIED', async () => {
    // Session exists, but the granted-origins store is EMPTY (e.g. a cold wake before the
    // owner has opted any web app in). pm.example is NOT a credential origin, so default-deny.
    await seedSession();
    // No 'solid:granted-origins' key set at all.
    await loadWorker();

    const res = await sendFetch(
      { url: 'https://alice.pod.example/private/notes.ttl', stampedOrigin: 'https://pm.example' },
      { origin: 'https://pm.example', url: 'https://pm.example/x' },
    );

    expect(res.status).toBe(403);
    expect(res.error).toBe('Origin not granted access');
    expect(fetchCalls.some((c) => c.url.startsWith('https://alice.pod.example'))).toBe(false);
  });

  it('DENIES a granted app proxying to an unrelated FOREIGN third party — NO egress to it', async () => {
    await seedSession();
    storage.set('solid:granted-origins', ['https://pm.example']);
    await loadWorker();

    const res = await sendFetch(
      { url: 'https://tracker.example/collect', stampedOrigin: 'https://pm.example' },
      { origin: 'https://pm.example', url: 'https://pm.example/x' },
    );

    expect(res.status).toBe(403);
    expect(res.error).toBe('Cross-origin fetch denied');
    expect(fetchCalls.some((c) => c.url.startsWith('https://tracker.example'))).toBe(false);
  });

  it('returns "Not authenticated" with NO gate egress when there is no session', async () => {
    // No session seeded.
    await loadWorker();
    const res = await sendFetch(
      { url: 'https://alice.pod.example/x', stampedOrigin: 'https://pm.example' },
      { origin: 'https://pm.example', url: 'https://pm.example/x' },
    );
    expect(res.error).toBe('Not authenticated');
    expect(fetchCalls.some((c) => c.url.startsWith('https://alice.pod.example'))).toBe(false);
  });
});

describe('login GRANTS the requesting origin (the opt-in)', () => {
  it('persists the verified origin to the grant store on a page-driven login', async () => {
    // We do not exercise the real OIDC flow (it needs the IdP); we assert the grant write,
    // which runs BEFORE initiateLogin. A login failure still leaves the grant recorded.
    await loadWorker();
    await sendMessage(
      {
        type: 'SOLID_LOGIN',
        webId: 'https://alice.pod.example/card#me',
        origin: 'https://newapp.example',
      },
      { origin: 'https://newapp.example', url: 'https://newapp.example/x' },
    );
    const grants = (storage.get('solid:granted-origins') as string[]) ?? [];
    expect(grants).toContain('https://newapp.example');
  });

  it('does NOT grant a FORGED login origin (sender ≠ stamp)', async () => {
    await loadWorker();
    await sendMessage(
      {
        type: 'SOLID_LOGIN',
        webId: 'https://alice.pod.example/card#me',
        origin: 'https://victim.example', // stamp claims the victim
      },
      { origin: 'https://attacker.example', url: 'https://attacker.example/x' }, // real sender
    );
    const grants = (storage.get('solid:granted-origins') as string[]) ?? [];
    expect(grants).not.toContain('https://victim.example');
    expect(grants).not.toContain('https://attacker.example');
  });
});

describe('SOLID_GET_STATE scopes the WebID (PII) to granted origins', () => {
  it('WITHHOLDS the WebID from a non-granted web page', async () => {
    await seedSession();
    storage.set('solid:granted-origins', ['https://pm.example']);
    await loadWorker();

    const res = await sendMessage(
      { type: 'SOLID_GET_STATE', stampedOrigin: 'https://random.example' },
      { origin: 'https://random.example', url: 'https://random.example/x' },
    );
    expect(res.webId).toBeNull();
    expect(res.isActive).toBe(false);
    expect(res.recentAccounts).toEqual([]);
  });

  it('EXPOSES the WebID to a granted web page', async () => {
    await seedSession();
    storage.set('solid:granted-origins', ['https://pm.example']);
    await loadWorker();

    const res = await sendMessage(
      { type: 'SOLID_GET_STATE', stampedOrigin: 'https://pm.example' },
      { origin: 'https://pm.example', url: 'https://pm.example/x' },
    );
    expect(res.webId).toBe('https://alice.pod.example/profile/card#me');
    expect(res.isActive).toBe(true);
  });

  it('gives the EXTENSION popup (own context) the full state incl. recent accounts', async () => {
    await seedSession();
    storage.set('solid:recent-accounts', [
      { webId: 'https://alice.pod.example/card#me', name: 'Alice', photoUrl: null },
    ]);
    await loadWorker();

    const res = await sendMessage(
      { type: 'SOLID_GET_STATE' }, // popup sends no stampedOrigin
      {
        origin: `chrome-extension://${EXTENSION_ID}`,
        url: `chrome-extension://${EXTENSION_ID}/popup/popup.html`,
      },
    );
    expect(res.webId).toBe('https://alice.pod.example/profile/card#me');
    expect((res.recentAccounts as unknown[]).length).toBe(1);
  });

  it('WITHHOLDS the WebID from a FORGED state request (sender ≠ stamp)', async () => {
    await seedSession();
    storage.set('solid:granted-origins', ['https://pm.example']);
    await loadWorker();

    const res = await sendMessage(
      { type: 'SOLID_GET_STATE', stampedOrigin: 'https://pm.example' }, // claims granted
      { origin: 'https://attacker.example', url: 'https://attacker.example/x' }, // real sender
    );
    expect(res.webId).toBeNull();
  });
});
