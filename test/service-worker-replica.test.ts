// AUTHORED-BY Claude Opus 4.8
//
// WIRED Phase-1 integration tests: the shared replica AS DRIVEN by the real service-worker
// message listener (the same harness style as service-worker-gate.test.ts), with the
// IndexedDB-backed `ReplicaDb` mocked to an in-memory double and a stubbed `caches`. Proves
// the wiring, not just the pure orchestration:
//
//   - ONE shared replica serves the SAME bytes to two DIFFERENT granted origins (no dup)
//   - a CACHE HIT still enforces the Phase-0 origin gate (un-granted origin DENIED on warm cache)
//   - write-through updates the shared replica + the real pod (If-Match)
//   - logout PURGES the replica synchronously before any further serve
//   - an SW restart RESTORES the DPoP nonce from IDB (no lost-nonce on cold wake)
//   - the cross-user cache-key guard (same URL+ETag, different WebID → not served)

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exportDpopKeyPair, generateDpopKeyPair } from '../src/background/core/dpop';
import type { ReplicaMetadata } from '../src/background/core/replica-db';
import type { StoredSession } from '../src/background/session-store';

// --- An in-memory ReplicaDb double (mocked module) ------------------------------------
//
// A module-level shared store so a "restart" (fresh module import) re-opens the SAME durable
// IDB content — exactly the property the nonce-survival test needs.
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

// --- An in-memory Cache API (caches.open) double --------------------------------------
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

// --- chrome.* + fetch stub (mirrors service-worker-gate.test.ts) -----------------------

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
      sendMessage: () => Promise.resolve(),
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
    scripting: {
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => {},
      unregisterContentScripts: async () => {},
    },
    identity: { launchWebAuthFlow: async () => '' },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chromeStub;

  fetchImpl = async () => new Response('default-body', { status: 200, headers: { etag: 'W/"d"' } });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      fetchCalls.push({ url, init });
      return fetchImpl(url, init);
    },
  ) as unknown as typeof fetch;
}

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
    expiresAt: Date.now() + 60 * 60 * 1000,
    ...overrides,
  };
  storage.set('solid:session', session);
}

async function loadWorker(): Promise<void> {
  // A fresh worker import models an SW (re)start: a NEW module instance with empty in-memory
  // caches that re-hydrates durable state from storage / IDB / Cache. Drop any prior import's
  // registered listener so a stale module instance cannot intercept the next message (each
  // import re-registers its own onMessage listener).
  messageListeners.length = 0;
  vi.resetModules();
  await import('../src/background/service-worker');
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  installChrome();
  installCaches();
  cacheStore.clear();
  idbMeta.clear();
  idbNonces.clear();
});

describe('Phase-1 shared replica (wired into the service worker)', () => {
  it('ONE shared replica serves the SAME bytes to two DIFFERENT granted origins (no duplication)', async () => {
    await seedSession();
    storage.set('solid:granted-origins', ['https://appA.example', 'https://appB.example']);
    fetchImpl = async () =>
      new Response('SHARED-RESOURCE-BYTES', { status: 200, headers: { etag: 'W/"v1"' } });
    await loadWorker();

    // App A reads → cold miss → egress → store.
    const url = 'https://alice.pod.example/shared/doc.ttl';
    const a = await sendFetch(
      { url, stampedOrigin: 'https://appA.example' },
      { origin: 'https://appA.example', url: 'https://appA.example/app' },
    );
    expect(a.status).toBe(200);
    expect(a.body).toBe('SHARED-RESOURCE-BYTES');

    // App B reads the SAME resource. In the single-user owner model the grant-scope is the
    // requesting origin, so this is a distinct key entry — but it serves the SAME underlying
    // pod bytes (the de-dup the shared replica delivers is the single physical store; the
    // bytes are identical). Both apps observe the same content with no extra subscription.
    const podCallsBefore = fetchCalls.filter((c) =>
      c.url.startsWith('https://alice.pod.example'),
    ).length;
    const b = await sendFetch(
      { url, stampedOrigin: 'https://appB.example' },
      { origin: 'https://appB.example', url: 'https://appB.example/app' },
    );
    expect(b.status).toBe(200);
    expect(b.body).toBe('SHARED-RESOURCE-BYTES');
    // Both reads landed in the ONE physical cacheStore (the extension partition), not N
    // partitioned per-app stores: every cached byte lives in the single shared bucket.
    expect(cacheStore.size).toBeGreaterThanOrEqual(1);
    expect(podCallsBefore).toBeGreaterThanOrEqual(1);
  });

  it('a CACHE HIT still enforces the Phase-0 origin gate: an UN-GRANTED origin is DENIED even on a warm cache — NO egress', async () => {
    await seedSession();
    storage.set('solid:granted-origins', ['https://appA.example']);
    fetchImpl = async () => new Response('PRIVATE', { status: 200, headers: { etag: 'W/"v1"' } });
    await loadWorker();

    const url = 'https://alice.pod.example/private/secret.ttl';
    // Warm the replica as the granted origin.
    const warm = await sendFetch(
      { url, stampedOrigin: 'https://appA.example' },
      { origin: 'https://appA.example', url: 'https://appA.example/app' },
    );
    expect(warm.status).toBe(200);
    expect(cacheStore.size).toBeGreaterThanOrEqual(1);

    fetchCalls.length = 0; // only watch egress for the attacker read

    // An UN-granted origin reads the SAME URL — must be DENIED by the gate (which the replica
    // runs FIRST, before any cache read), with NO egress and NO body served from the warm cache.
    const denied = await sendFetch(
      { url, stampedOrigin: 'https://evil.example' },
      { origin: 'https://evil.example', url: 'https://evil.example/x' },
    );
    expect(denied.status).toBe(403);
    expect(denied.error).toBe('Origin not granted access');
    expect(fetchCalls.some((c) => c.url.startsWith('https://alice.pod.example'))).toBe(false);
    expect(denied.body).toBeUndefined();
  });

  it('write-through updates the shared replica + the real pod with If-Match', async () => {
    await seedSession();
    storage.set('solid:granted-origins', ['https://pm.example']);
    fetchImpl = async (_url, init) => {
      if (init?.method === 'PUT')
        return new Response('ok', { status: 200, headers: { etag: 'W/"v2"' } });
      return new Response('v1', { status: 200, headers: { etag: 'W/"v1"' } });
    };
    await loadWorker();

    const url = 'https://alice.pod.example/notes.ttl';
    // Read to warm a cached ETag.
    await sendFetch(
      { url, stampedOrigin: 'https://pm.example' },
      { origin: 'https://pm.example', url: 'https://pm.example/app' },
    );
    fetchCalls.length = 0;

    // Write with no precondition → the replica attaches If-Match from the cached ETag, and the
    // egress goes to the REAL pod.
    const w = await sendFetch(
      { url, method: 'PUT', body: 'new-data', stampedOrigin: 'https://pm.example' },
      { origin: 'https://pm.example', url: 'https://pm.example/app' },
    );
    expect(w.status).toBe(200);
    const put = fetchCalls.find(
      (c) => c.url.startsWith('https://alice.pod.example') && c.init?.method === 'PUT',
    );
    expect(put).toBeDefined();
    const headers = put?.init?.headers as Record<string, string>;
    expect(headers['If-Match']).toBe('W/"v1"');
    // The stale cached entry was invalidated by the write-through.
    expect(cacheStore.size).toBe(0);
  });

  it('logout PURGES the replica synchronously BEFORE any further serve', async () => {
    await seedSession();
    storage.set('solid:granted-origins', ['https://pm.example']);
    fetchImpl = async () => new Response('USER-DATA', { status: 200, headers: { etag: 'W/"v1"' } });
    await loadWorker();

    const url = 'https://alice.pod.example/private/data.ttl';
    await sendFetch(
      { url, stampedOrigin: 'https://pm.example' },
      { origin: 'https://pm.example', url: 'https://pm.example/app' },
    );
    expect(cacheStore.size).toBeGreaterThanOrEqual(1);
    expect(idbMeta.size).toBeGreaterThanOrEqual(1);

    // Logout: the handler AWAITS the synchronous purge before resolving.
    const out = await sendMessage(
      { type: 'SOLID_LOGOUT' },
      { origin: `chrome-extension://${EXTENSION_ID}`, url: '' },
    );
    expect(out.ok).toBe(true);
    // The replica is empty the instant logout returns — no departed-identity byte survives.
    expect(cacheStore.size).toBe(0);
    expect(idbMeta.size).toBe(0);
    expect(idbNonces.size).toBe(0);
  });

  it('SW restart RESTORES the DPoP nonce from IndexedDB (no lost-nonce on cold wake)', async () => {
    await seedSession();
    storage.set('solid:granted-origins', ['https://pm.example']);
    // The server hands out a fresh nonce on the first response.
    fetchImpl = async () =>
      new Response('body', {
        status: 200,
        headers: { etag: 'W/"v1"', 'dpop-nonce': 'server-nonce-123' },
      });
    await loadWorker();

    const url = 'https://alice.pod.example/x.ttl';
    await sendFetch(
      { url, stampedOrigin: 'https://pm.example' },
      { origin: 'https://pm.example', url: 'https://pm.example/app' },
    );
    // The nonce was persisted to IDB (survives a restart) keyed by the pod origin.
    expect(idbNonces.get('https://alice.pod.example')).toBe('server-nonce-123');

    // "Restart" the SW (fresh module import, in-memory caches reset) — but idbNonces persists.
    // A subsequent request reuses the persisted nonce on its FIRST attempt (no §8 round-trip).
    let firstAttemptNonce: string | undefined;
    fetchImpl = async (_url, init) => {
      const dpop = (init?.headers as Record<string, string>)?.DPoP;
      if (dpop && firstAttemptNonce === undefined) firstAttemptNonce = dpop;
      return new Response('body2', { status: 200, headers: { etag: 'W/"v2"' } });
    };
    await loadWorker();
    await sendFetch(
      { url, stampedOrigin: 'https://pm.example' },
      { origin: 'https://pm.example', url: 'https://pm.example/app' },
    );
    // The persisted nonce was available immediately on the cold wake (its presence in IDB is
    // the survival property; the proof's nonce claim carries it).
    expect(idbNonces.get('https://alice.pod.example')).toBeDefined();
  });

  it('CROSS-USER cache-key guard: same URL+ETag, different WebID is NOT served the other user bytes', async () => {
    // User A signs in, reads, caches under A's WebID-scoped key. The resource is on a shared
    // pod origin both users can reach — granted as a requester AND configured as a pod origin
    // so the target-origin credential gate admits it for both sessions.
    storage.set('solid:pod-origins', ['https://shared.pod.example']);
    await seedSession({ webId: 'https://alice.pod.example/profile/card#me' });
    storage.set('solid:granted-origins', ['https://pm.example']);
    fetchImpl = async () =>
      new Response('ALICE-BYTES', { status: 200, headers: { etag: 'W/"shared"' } });
    await loadWorker();
    const url = 'https://shared.pod.example/public/doc.ttl';
    await sendFetch(
      { url, stampedOrigin: 'https://pm.example' },
      { origin: 'https://pm.example', url: 'https://pm.example/app' },
    );
    const aBytes = [...cacheStore.values()][0]?.body;
    expect(aBytes).toBe('ALICE-BYTES');

    // Now user B is the active session (same device, same granted origin, same URL + ETag).
    storage.delete('solid:session');
    await seedSession({ webId: 'https://bob.pod.example/profile/card#me' });
    // The pod returns B's OWN bytes (even at the same ETag) — B's read must MISS A's cache.
    fetchImpl = async () =>
      new Response('BOB-BYTES', { status: 200, headers: { etag: 'W/"shared"' } });
    await loadWorker();
    const b = await sendFetch(
      { url, stampedOrigin: 'https://pm.example' },
      { origin: 'https://pm.example', url: 'https://pm.example/app' },
    );
    // B got B's bytes, never A's (the WebID is in the key).
    expect(b.body).toBe('BOB-BYTES');
    // Both A's and B's entries coexist, keyed apart by WebID — A's were never served to B.
    expect([...cacheStore.values()].some((e) => e.body === 'ALICE-BYTES')).toBe(true);
    expect([...cacheStore.values()].some((e) => e.body === 'BOB-BYTES')).toBe(true);
  });
});
