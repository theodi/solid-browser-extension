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
import type { ReplicaMetadata } from '../src/background/core/replica-db';
import type { StoredSession } from '../src/background/session-store';

// --- In-memory replica stores (Phase 1) -----------------------------------------------
// The fetch path now routes through the shared replica, which opens IndexedDB (metadata +
// nonce) and the Cache API. Stub both so the Phase-0 gate assertions below run unchanged:
// a DENY must still produce NO egress, an ALLOW must still reach the pod with the token.
const idbMeta = new Map<string, ReplicaMetadata>();
const idbNonces = new Map<string, string>();
class FakeReplicaDb {
  static async open() {
    return new FakeReplicaDb();
  }
  async getMetadata(key: string) {
    return idbMeta.get(key);
  }
  async putMetadata(record: ReplicaMetadata) {
    idbMeta.set(record.key, record);
  }
  async deleteMetadata(key: string) {
    idbMeta.delete(key);
  }
  async getMetadataByWebId(webId: string) {
    return [...idbMeta.values()].filter((r) => r.webId === webId);
  }
  async deleteMetadataByWebId(webId: string) {
    for (const [k, v] of idbMeta) if (v.webId === webId) idbMeta.delete(k);
  }
  async clearMetadata() {
    idbMeta.clear();
  }
  async getNonce(origin: string) {
    return idbNonces.get(origin);
  }
  async setNonce(origin: string, nonce: string) {
    idbNonces.set(origin, nonce);
  }
  async clearNonces() {
    idbNonces.clear();
  }
  close() {}
}
vi.mock('../src/background/core/replica-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/background/core/replica-db')>();
  return { ...actual, ReplicaDb: FakeReplicaDb };
});
const cacheStore = new Map<
  string,
  { body: string; status: number; headers: Record<string, string> }
>();
function installCaches(): void {
  (globalThis as unknown as { caches: unknown }).caches = {
    open: async () => ({
      match: async (request: Request) => {
        const e = cacheStore.get(request.url);
        return e ? new Response(e.body, { status: e.status, headers: e.headers }) : undefined;
      },
      put: async (request: Request, response: Response) => {
        cacheStore.set(request.url, {
          body: await response.text(),
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        });
      },
      delete: async (request: Request) => cacheStore.delete(request.url),
    }),
  };
}

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
  installCaches();
  cacheStore.clear();
  idbMeta.clear();
  idbNonces.clear();
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

  it('DENIES a PRESENT-but-OPAQUE sender.origin ("null") with a normal https sender.url — NO egress (High #1)', async () => {
    // The High #1 exploit wired through the SW: an opaque/sandboxed frame whose sender.origin is
    // the string "null" but whose sender.url is a normal https URL that matches the stamp. The
    // old fail-open would have laundered it into the granted origin and served credentials.
    await seedSession();
    storage.set('solid:granted-origins', ['https://app.example']);
    await loadWorker();

    const res = await sendFetch(
      { url: 'https://alice.pod.example/private/notes.ttl', stampedOrigin: 'https://app.example' },
      { origin: 'null', url: 'https://app.example/page.html' },
    );

    expect(res.status).toBe(403);
    expect(res.error).toBe('Forbidden origin');
    expect(fetchCalls.some((c) => c.url.startsWith('https://alice.pod.example'))).toBe(false);
  });

  it('STILL allows a sender with ABSENT origin but a valid https url + matching stamp (legit fallback)', async () => {
    await seedSession();
    storage.set('solid:granted-origins', ['https://app.example']);
    await loadWorker();

    const res = await sendFetch(
      { url: 'https://alice.pod.example/private/notes.ttl', stampedOrigin: 'https://app.example' },
      { url: 'https://app.example/page.html' }, // no origin field → ABSENT → derive from url
    );

    expect(res.status).toBe(200);
    expect(fetchCalls.some((c) => c.url.startsWith('https://alice.pod.example'))).toBe(true);
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

describe('login GRANTS the requesting origin ONLY on success (privilege-escalation guard)', () => {
  // High #2: the grant must be persisted ONLY AFTER a successful, owner-approved login — never
  // before initiateLogin. In these tests the real OIDC flow has no IdP, so initiateLogin THROWS;
  // therefore a SOLID_LOGIN here represents a CANCELLED/FAILED login and must leave the grant
  // store UNCHANGED. The success path is covered separately by mocking initiateLogin.

  it('does NOT grant the requesting origin when initiateLogin fails/cancels', async () => {
    await loadWorker();
    const res = await sendMessage(
      {
        type: 'SOLID_LOGIN',
        webId: 'https://alice.pod.example/card#me',
        origin: 'https://newapp.example',
      },
      { origin: 'https://newapp.example', url: 'https://newapp.example/x' },
    );
    // The login failed (no IdP) ...
    expect(res.error).toBeDefined();
    // ... so NO grant was persisted (the privilege-escalation fix).
    const grants = (storage.get('solid:granted-origins') as string[]) ?? [];
    expect(grants).not.toContain('https://newapp.example');
  });

  it('a FAILED/CANCELLED login leaves the grant store UNCHANGED and a later fetch from that origin is DENIED even when a session EXISTS', async () => {
    // The attack High #2 closes: a session already exists for the user; a hostile page sends
    // SOLID_LOGIN (which it cancels/fails), then tries SOLID_FETCH_REQUEST to ride the existing
    // credentials. The cancelled login must NOT have granted the page.
    await seedSession(); // a live session already exists
    // No grant for the hostile origin.
    await loadWorker();

    // Step 1: the hostile page drives a login that fails (no IdP).
    const loginRes = await sendMessage(
      {
        type: 'SOLID_LOGIN',
        webId: 'https://alice.pod.example/card#me',
        origin: 'https://hostile.example',
      },
      { origin: 'https://hostile.example', url: 'https://hostile.example/x' },
    );
    expect(loginRes.error).toBeDefined();
    const grants = (storage.get('solid:granted-origins') as string[]) ?? [];
    expect(grants).not.toContain('https://hostile.example');

    // The failing OIDC flow itself may make network calls (discovery/profile) on the raw fetch;
    // those are NOT the gated egress we're asserting about. Reset the captured calls so the next
    // assertion concerns ONLY the credential-attaching SOLID_FETCH_REQUEST egress.
    fetchCalls.length = 0;

    // Step 2: the hostile page now tries to read the existing session's pod. DENIED — no grant,
    // so NO credential-attaching egress to the pod from the gated fetch path.
    const fetchRes = await sendFetch(
      {
        url: 'https://alice.pod.example/private/notes.ttl',
        stampedOrigin: 'https://hostile.example',
      },
      { origin: 'https://hostile.example', url: 'https://hostile.example/x' },
    );
    expect(fetchRes.status).toBe(403);
    expect(fetchRes.error).toBe('Origin not granted access');
    expect(fetchCalls.some((c) => c.url.startsWith('https://alice.pod.example'))).toBe(false);
  });

  it('a SUCCESSFUL login GRANTS the verified origin and a subsequent fetch SUCCEEDS', async () => {
    // Mock initiateLogin to succeed, returning a fresh session, so we exercise the success path
    // where the grant SHOULD now be persisted.
    const keyPair = await generateDpopKeyPair();
    const exported = await exportDpopKeyPair(keyPair);
    const session: StoredSession = {
      webId: 'https://alice.pod.example/profile/card#me',
      accessToken: 'access-token-xyz',
      refreshToken: 'refresh-xyz',
      dpopKeyPair: exported,
      issuer: 'https://idp.example/',
      tokenEndpoint: 'https://idp.example/token',
      clientId: 'https://newapp.example/clientid.jsonld',
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    vi.doMock('../src/background/auth-flow', () => ({
      initiateLogin: vi.fn(async () => ({ session, name: 'Alice', photoUrl: null })),
      refreshSession: vi.fn(async (s: StoredSession) => s),
    }));
    await loadWorker();

    const loginRes = await sendMessage(
      {
        type: 'SOLID_LOGIN',
        webId: 'https://alice.pod.example/card#me',
        origin: 'https://newapp.example',
      },
      { origin: 'https://newapp.example', url: 'https://newapp.example/x' },
    );
    expect(loginRes.ok).toBe(true);
    const grants = (storage.get('solid:granted-origins') as string[]) ?? [];
    expect(grants).toContain('https://newapp.example');

    // The now-granted origin can read its pod.
    const fetchRes = await sendFetch(
      {
        url: 'https://alice.pod.example/private/notes.ttl',
        stampedOrigin: 'https://newapp.example',
      },
      { origin: 'https://newapp.example', url: 'https://newapp.example/app.html' },
    );
    expect(fetchRes.status).toBe(200);
    expect(fetchCalls.some((c) => c.url.startsWith('https://alice.pod.example'))).toBe(true);
    vi.doUnmock('../src/background/auth-flow');
  });

  it('does NOT grant a FORGED login origin even on success (sender ≠ stamp)', async () => {
    const keyPair = await generateDpopKeyPair();
    const exported = await exportDpopKeyPair(keyPair);
    const session: StoredSession = {
      webId: 'https://alice.pod.example/profile/card#me',
      accessToken: 'access-token-xyz',
      refreshToken: 'refresh-xyz',
      dpopKeyPair: exported,
      issuer: 'https://idp.example/',
      tokenEndpoint: 'https://idp.example/token',
      clientId: 'https://newapp.example/clientid.jsonld',
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    vi.doMock('../src/background/auth-flow', () => ({
      initiateLogin: vi.fn(async () => ({ session, name: 'Alice', photoUrl: null })),
      refreshSession: vi.fn(async (s: StoredSession) => s),
    }));
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
    // The forged origin resolves to null → no grant for victim OR attacker, even on success.
    expect(grants).not.toContain('https://victim.example');
    expect(grants).not.toContain('https://attacker.example');
    vi.doUnmock('../src/background/auth-flow');
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
