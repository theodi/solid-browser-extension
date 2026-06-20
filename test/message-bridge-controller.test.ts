// AUTHORED-BY Claude Opus 4.8
/**
 * Unit tests for the popup's MessageBridgeLoginController — the chrome.identity-backed
 * LoginController that bridges the panel's SYNCHRONOUS getter contract to the ASYNC
 * service worker over the existing message protocol, WITHOUT ever holding a token.
 *
 * The credential boundary is the load-bearing assertion: the bridge must (a) expose the
 * module-pristine fetch as publicFetch, (b) never carry a token in any own property,
 * (c) never surface a (hypothetical) token field from a GET_STATE reply, and (d) proxy
 * authenticatedFetch via SOLID_FETCH_REQUEST with NO Authorization/DPoP header attached
 * popup-side (the token is SW-side only).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBridgeLoginController } from '../src/popup/message-bridge-controller';
import type { SessionState } from '../src/shared/messages';

/** A mock of `chrome.runtime.sendMessage` (callback form) returning a canned reply. */
type SendImpl = (message: unknown) => unknown;
let sendImpl: SendImpl;
const sentMessages: unknown[] = [];

function installChrome(impl: SendImpl): void {
  sendImpl = impl;
  vi.stubGlobal('chrome', {
    runtime: {
      lastError: undefined as { message?: string } | undefined,
      sendMessage: (message: unknown, callback: (response: unknown) => void) => {
        sentMessages.push(message);
        // Resolve asynchronously, like the real callback channel.
        Promise.resolve(sendImpl(message)).then((r) => callback(r));
      },
    },
  });
}

function activeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    webId: 'https://alice.pod.example/profile/card#me',
    isActive: true,
    name: 'Alice',
    photoUrl: 'https://alice.pod.example/avatar.png',
    recentAccounts: [],
    ...overrides,
  };
}

beforeEach(() => {
  sentMessages.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('restore() — silent restore round-trip + fail-closed', () => {
  it('sends SOLID_GET_STATE and resolves restored when isActive && webId', async () => {
    installChrome(() => activeState());
    const c = new MessageBridgeLoginController();
    const outcome = await c.restore();
    expect(sentMessages).toContainEqual({ type: 'SOLID_GET_STATE' });
    expect(outcome).toEqual({
      outcome: 'restored',
      webId: 'https://alice.pod.example/profile/card#me',
    });
  });

  it('resolves login when no active session', async () => {
    installChrome(() => activeState({ webId: null, isActive: false, name: null, photoUrl: null }));
    const c = new MessageBridgeLoginController();
    expect(await c.restore()).toEqual({ outcome: 'login' });
  });

  it('FAIL-CLOSED: resolves login (never throws) when the send rejects', async () => {
    installChrome(() => {
      throw new Error('channel error');
    });
    const c = new MessageBridgeLoginController();
    await expect(c.restore()).resolves.toEqual({ outcome: 'login' });
  });

  it('FAIL-CLOSED: a malformed state shape never leaves a half-set non-null webId', async () => {
    // First a clean active session (sets the mirror), THEN a malformed reply on hydrate.
    let call = 0;
    installChrome(() => {
      call += 1;
      if (call === 1) return activeState(); // restore() → logged in
      // hydrate() → recentAccounts is not an array → toRecentLoginAccount map throws.
      return { webId: 'https://x/#me', isActive: true, recentAccounts: 'not-an-array' };
    });
    const c = new MessageBridgeLoginController();
    await c.restore();
    expect(c.webId).toBe('https://alice.pod.example/profile/card#me');
    // hydrate() swallows the throw — and must NOT have committed the malformed webId.
    await c.hydrate();
    expect(c.webId).toBe('https://alice.pod.example/profile/card#me'); // unchanged, atomic
  });
});

describe('the synchronous seam is satisfied from the async source', () => {
  it('webId + recentAccounts read synchronously after restore()/hydrate()', async () => {
    installChrome(() =>
      activeState({
        recentAccounts: [
          { webId: 'https://bob.pod.example/card#me', name: 'Bob', photoUrl: null },
          { webId: 'https://carol.pod.example/card#me', name: null, photoUrl: 'https://c/p.png' },
        ],
      }),
    );
    const c = new MessageBridgeLoginController();
    await c.restore();

    // Synchronous getters now answer from the mirror.
    expect(c.webId).toBe('https://alice.pod.example/profile/card#me');
    expect(c.recentAccounts()).toEqual([
      { webId: 'https://bob.pod.example/card#me', displayName: 'Bob', avatarUrl: undefined },
      {
        webId: 'https://carol.pod.example/card#me',
        displayName: 'https://carol.pod.example/card#me',
        avatarUrl: 'https://c/p.png',
      },
    ]);
  });
});

describe('login()', () => {
  it('sends SOLID_LOGIN, sets the mirror and resolves on ok', async () => {
    installChrome((m) => {
      if ((m as { type: string }).type === 'SOLID_LOGIN') {
        return { ok: true, webId: 'https://x.example/#me' };
      }
      return activeState();
    });
    const c = new MessageBridgeLoginController();
    const result = await c.login('https://x.example/#me');
    expect(sentMessages).toContainEqual({ type: 'SOLID_LOGIN', webId: 'https://x.example/#me' });
    expect(result).toEqual({ webId: 'https://x.example/#me' });
    expect(c.webId).toBe('https://x.example/#me');
  });

  it('REJECTS with the error message and does NOT mutate #webId on error', async () => {
    installChrome(() => ({ error: 'User cancelled' }));
    const c = new MessageBridgeLoginController();
    await expect(c.login('https://x.example/#me')).rejects.toThrow('User cancelled');
    expect(c.webId).toBeNull();
  });

  it('defaults to the single recent account webId when none is passed', async () => {
    installChrome((m) => {
      if ((m as { type: string }).type === 'SOLID_GET_STATE') {
        return activeState({
          webId: null,
          isActive: false,
          name: null,
          photoUrl: null,
          recentAccounts: [{ webId: 'https://recent.example/#me', name: 'R', photoUrl: null }],
        });
      }
      return { ok: true, webId: 'https://recent.example/#me' };
    });
    const c = new MessageBridgeLoginController();
    await c.hydrate(); // populate the recent-accounts mirror
    await c.login();
    expect(sentMessages).toContainEqual({
      type: 'SOLID_LOGIN',
      webId: 'https://recent.example/#me',
    });
  });
});

describe('logout()', () => {
  it('sends SOLID_LOGOUT and clears #webId on ok', async () => {
    installChrome((m) => {
      if ((m as { type: string }).type === 'SOLID_LOGOUT') return { ok: true };
      return activeState();
    });
    const c = new MessageBridgeLoginController();
    await c.restore(); // sets #webId
    expect(c.webId).not.toBeNull();
    await c.logout();
    expect(sentMessages).toContainEqual({ type: 'SOLID_LOGOUT' });
    expect(c.webId).toBeNull();
  });

  it('on error rejects AND leaves #webId intact (panel keeps signed-in UI)', async () => {
    installChrome((m) => {
      const type = (m as { type: string }).type;
      if (type === 'SOLID_GET_STATE') return activeState();
      if (type === 'SOLID_LOGOUT') return { error: 'Logout failed' };
      return {};
    });
    const c = new MessageBridgeLoginController();
    await c.restore();
    const before = c.webId;
    await expect(c.logout()).rejects.toThrow('Logout failed');
    expect(c.webId).toBe(before);
    expect(c.webId).not.toBeNull();
  });
});

describe('NO-TOKEN-LEAK invariant', () => {
  it('publicFetch is STRICTLY the module-pristine fetch snapshot (not the live global)', async () => {
    installChrome(() => activeState());
    const c = new MessageBridgeLoginController();
    const before = c.publicFetch;

    // Even if some later code patches globalThis.fetch, publicFetch keeps the pristine snapshot.
    const original = globalThis.fetch;
    try {
      const patched = (() => Promise.resolve(new Response('patched'))) as typeof fetch;
      globalThis.fetch = patched;
      expect(c.publicFetch).toBe(before);
      expect(c.publicFetch).not.toBe(patched);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('the controller has NO own property holding a token, even after a session is active', async () => {
    installChrome(() => activeState());
    const c = new MessageBridgeLoginController();
    await c.restore();

    // Private #fields are not enumerable/own-accessible; assert no public surface leaks one.
    const ownKeys = [
      ...Object.getOwnPropertyNames(c),
      ...Object.keys(c as unknown as Record<string, unknown>),
    ];
    const serialised = JSON.stringify(Object.getOwnPropertyDescriptors(c));
    for (const forbidden of ['accessToken', 'refreshToken', 'dpop', 'privateKey', 'idToken']) {
      expect(ownKeys.some((k) => k.toLowerCase().includes(forbidden.toLowerCase()))).toBe(false);
      expect(serialised.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('a hypothetical accessToken in a GET_STATE reply is NEVER surfaced via any getter', async () => {
    // A hostile/extra field on the wire must not flow into the mirror or its outputs.
    installChrome(() => ({
      ...activeState({
        recentAccounts: [{ webId: 'https://bob/#me', name: 'Bob', photoUrl: null }],
      }),
      accessToken: 'SECRET-TOKEN',
      refreshToken: 'SECRET-REFRESH',
    }));
    const c = new MessageBridgeLoginController();
    await c.restore();

    expect(c.webId).toBe('https://alice.pod.example/profile/card#me');
    const recents = JSON.stringify(c.recentAccounts());
    expect(recents).not.toContain('SECRET-TOKEN');
    expect(recents).not.toContain('SECRET-REFRESH');
    // No recent account carries a token field.
    for (const acct of c.recentAccounts()) {
      expect(Object.keys(acct).sort()).toEqual(['avatarUrl', 'displayName', 'webId']);
    }
  });

  it('authenticatedFetch sends SOLID_FETCH_REQUEST with NO Authorization/DPoP header popup-side', async () => {
    installChrome((m) => {
      if ((m as { type: string }).type === 'SOLID_FETCH_REQUEST') {
        return {
          requestId: (m as { requestId: string }).requestId,
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'text/turtle' },
          body: '<#it> a <#Note>.',
        };
      }
      return activeState();
    });
    const c = new MessageBridgeLoginController();
    await c.restore(); // log in so authenticatedFetch is the proxy (not pristine)
    const res = await c.authenticatedFetch('https://alice.pod.example/private/notes.ttl');

    // It went over SOLID_FETCH_REQUEST, not a direct fetch.
    const fetchReq = sentMessages.find(
      (m) => (m as { type?: string }).type === 'SOLID_FETCH_REQUEST',
    ) as { url: string; method: string; headers: Record<string, string> };
    expect(fetchReq).toBeDefined();
    expect(fetchReq.url).toBe('https://alice.pod.example/private/notes.ttl');
    expect(fetchReq.method).toBe('GET');
    // CRITICAL: no credential attached popup-side — the SW attaches the DPoP token.
    const headerKeys = Object.keys(fetchReq.headers).map((k) => k.toLowerCase());
    expect(headerKeys).not.toContain('authorization');
    expect(headerKeys).not.toContain('dpop');

    // The Response is faithfully reconstructed from the FetchResponse.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/turtle');
    expect(await res.text()).toBe('<#it> a <#Note>.');
  });

  it('authenticatedFetch surfaces a SW error (e.g. the SW session expired mid-popup)', async () => {
    installChrome((m) => {
      if ((m as { type: string }).type === 'SOLID_FETCH_REQUEST') {
        return { requestId: (m as { requestId: string }).requestId, error: 'Not authenticated' };
      }
      return activeState();
    });
    const c = new MessageBridgeLoginController();
    await c.restore(); // log in so authenticatedFetch is the proxy (not pristine)
    await expect(c.authenticatedFetch('https://alice.pod.example/x')).rejects.toThrow(
      'Not authenticated',
    );
  });

  it('BEFORE login, authenticatedFetch is the pristine fetch (contract: no session to bind)', async () => {
    installChrome(() => activeState({ webId: null, isActive: false, name: null, photoUrl: null }));
    const c = new MessageBridgeLoginController();
    await c.restore(); // no active session → #webId stays null
    expect(c.webId).toBeNull();
    // It is the pristine fetch (no proxy) — does NOT round-trip to the SW.
    expect(c.authenticatedFetch).toBe(c.publicFetch);
  });

  it('rebuilds a 204 No Content response (null-body status) without throwing', async () => {
    installChrome((m) => {
      if ((m as { type: string }).type === 'SOLID_FETCH_REQUEST') {
        // The SW serialises an empty body as '' even for null-body statuses.
        return {
          requestId: (m as { requestId: string }).requestId,
          status: 204,
          statusText: 'No Content',
          headers: {},
          body: '',
        };
      }
      return activeState();
    });
    const c = new MessageBridgeLoginController();
    await c.restore(); // log in so authenticatedFetch is the proxy
    // A naive `new Response('', { status: 204 })` would THROW — this must not.
    const res = await c.authenticatedFetch('https://alice.pod.example/c/r.ttl', {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(await res.text()).toBe('');
  });

  it('authenticatedFetch normalises a Request input (url/method/headers/body) like fetch', async () => {
    installChrome((m) => {
      if ((m as { type: string }).type === 'SOLID_FETCH_REQUEST') {
        return { requestId: (m as { requestId: string }).requestId, status: 201, body: 'ok' };
      }
      return activeState();
    });
    const c = new MessageBridgeLoginController();
    await c.restore(); // log in so authenticatedFetch is the proxy (not pristine)
    const req = new Request('https://alice.pod.example/c/r.ttl', {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle' },
      body: '<#it> a <#Note>.',
    });
    await c.authenticatedFetch(req);

    const sent = sentMessages.find(
      (m) => (m as { type?: string }).type === 'SOLID_FETCH_REQUEST',
    ) as { url: string; method: string; headers: Record<string, string>; body: string | null };
    // NOT "[object Request]" — the Request's fields are read.
    expect(sent.url).toBe('https://alice.pod.example/c/r.ttl');
    expect(sent.method).toBe('PUT');
    expect(sent.headers['content-type']).toBe('text/turtle');
    expect(sent.body).toBe('<#it> a <#Note>.');
    // Still no credential popup-side.
    const headerKeys = Object.keys(sent.headers).map((k) => k.toLowerCase());
    expect(headerKeys).not.toContain('authorization');
    expect(headerKeys).not.toContain('dpop');
  });

  it('REJECTS a Request with a binary/multipart body (text-only protocol; no silent coercion)', async () => {
    installChrome((m) => {
      if ((m as { type: string }).type === 'SOLID_FETCH_REQUEST') {
        return { requestId: (m as { requestId: string }).requestId, status: 200, body: '' };
      }
      return activeState();
    });
    const c = new MessageBridgeLoginController();
    await c.restore(); // log in so authenticatedFetch is the proxy
    const form = new FormData();
    form.append('f', new Blob([new Uint8Array([1, 2, 3])]), 'b.bin');
    const req = new Request('https://alice.pod.example/upload', { method: 'POST', body: form });
    await expect(c.authenticatedFetch(req)).rejects.toThrow(/only text request bodies/);
    // It refused BEFORE sending anything over the wire.
    expect(sentMessages.some((m) => (m as { type?: string }).type === 'SOLID_FETCH_REQUEST')).toBe(
      false,
    );
  });

  // --- Content-Type / body-shape policy (roborev finding: missing-CT must not corrupt binary) ---

  it('a missing-Content-Type Turtle (string) Request body still round-trips as text', async () => {
    installChrome((m) => {
      if ((m as { type: string }).type === 'SOLID_FETCH_REQUEST') {
        return { requestId: (m as { requestId: string }).requestId, status: 201, body: '' };
      }
      return activeState();
    });
    const c = new MessageBridgeLoginController();
    await c.restore(); // log in so authenticatedFetch is the proxy
    // A Request whose body is RDF text but with NO declared content-type. The Solid write
    // case must keep working: it is valid UTF-8 text, so it must be carried, not rejected.
    // (Constructing from a string would auto-set text/plain, so build from UTF-8 bytes with
    // the auto CT removed to exercise the genuinely-missing-CT path.)
    const turtle = '<#it> a <#Note> ; <#label> "héllo ünïçödé" .';
    const req = new Request('https://alice.pod.example/c/note.ttl', {
      method: 'PUT',
      body: new TextEncoder().encode(turtle),
    });
    req.headers.delete('content-type'); // ensure the ambiguous missing-CT path
    expect(req.headers.get('content-type')).toBeNull();

    const res = await c.authenticatedFetch(req);
    expect(res.status).toBe(201);
    const sent = sentMessages.find(
      (m) => (m as { type?: string }).type === 'SOLID_FETCH_REQUEST',
    ) as { body: string | null };
    expect(sent).toBeDefined();
    expect(sent.body).toBe(turtle); // faithfully decoded, not corrupted
  });

  it('REJECTS a Request with an EXPLICIT binary content-type (e.g. image/png)', async () => {
    installChrome((m) => {
      if ((m as { type: string }).type === 'SOLID_FETCH_REQUEST') {
        return { requestId: (m as { requestId: string }).requestId, status: 201, body: '' };
      }
      return activeState();
    });
    const c = new MessageBridgeLoginController();
    await c.restore(); // log in so authenticatedFetch is the proxy
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], {
      type: 'image/png',
    });
    const req = new Request('https://alice.pod.example/c/logo.png', { method: 'PUT', body: png });
    expect(req.headers.get('content-type')).toBe('image/png');
    await expect(c.authenticatedFetch(req)).rejects.toThrow(/only text request bodies/);
    // Refused before any wire send — no corrupted write.
    expect(sentMessages.some((m) => (m as { type?: string }).type === 'SOLID_FETCH_REQUEST')).toBe(
      false,
    );
  });

  it('REJECTS a Request with a binary body and NO content-type (no silent .text() corruption)', async () => {
    installChrome((m) => {
      if ((m as { type: string }).type === 'SOLID_FETCH_REQUEST') {
        return { requestId: (m as { requestId: string }).requestId, status: 201, body: '' };
      }
      return activeState();
    });
    const c = new MessageBridgeLoginController();
    await c.restore(); // log in so authenticatedFetch is the proxy
    // A genuinely binary (non-UTF-8) payload constructed from bytes → the Request carries
    // NO content-type. This is the ambiguous path the old isTextContentType(null)===true let
    // through and corrupted; it must now FAIL LOUDLY (detected via the raw bytes).
    const binary = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0xfe, 0xc0]); // gzip-ish
    const req = new Request('https://alice.pod.example/c/blob.bin', {
      method: 'PUT',
      body: binary,
    });
    expect(req.headers.get('content-type')).toBeNull();
    await expect(c.authenticatedFetch(req)).rejects.toThrow(/only text request bodies/);
    // Refused before any wire send — the corrupted text was never transmitted.
    expect(sentMessages.some((m) => (m as { type?: string }).type === 'SOLID_FETCH_REQUEST')).toBe(
      false,
    );
  });

  it('REJECTS a binary body with an EMPTY/whitespace Content-Type (empty CT == missing, roborev 3495)', async () => {
    installChrome((m) => {
      if ((m as { type: string }).type === 'SOLID_FETCH_REQUEST') {
        return { requestId: (m as { requestId: string }).requestId, status: 201, body: '' };
      }
      return activeState();
    });
    const c = new MessageBridgeLoginController();
    await c.restore(); // log in so authenticatedFetch is the proxy
    // An empty (or whitespace-only) Content-Type must be normalised to "missing" so the
    // byte guard runs — otherwise isTextContentType('')===true let a binary body through and
    // corrupted it (the empty-header gap roborev job 3495 flagged on the prior fix).
    const binary = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0xfe, 0xc0]); // gzip-ish
    const req = new Request('https://alice.pod.example/c/blob.bin', {
      method: 'PUT',
      body: binary,
    });
    req.headers.set('content-type', '   '); // empty/whitespace-only → must NOT be trusted as text
    await expect(c.authenticatedFetch(req)).rejects.toThrow(/only text request bodies/);
    expect(sentMessages.some((m) => (m as { type?: string }).type === 'SOLID_FETCH_REQUEST')).toBe(
      false,
    );
  });

  it('a missing/empty-CT Turtle text body still round-trips (empty CT does not break the Solid write)', async () => {
    installChrome((m) => {
      if ((m as { type: string }).type === 'SOLID_FETCH_REQUEST') {
        return { requestId: (m as { requestId: string }).requestId, status: 201, body: '' };
      }
      return activeState();
    });
    const c = new MessageBridgeLoginController();
    await c.restore();
    const turtle = '<#it> a <#Note> ; <#label> "héllo ünïçödé" .';
    const req = new Request('https://alice.pod.example/c/note.ttl', {
      method: 'PUT',
      body: new TextEncoder().encode(turtle),
    });
    req.headers.set('content-type', ''); // empty CT, but valid UTF-8 text → must still carry
    const res = await c.authenticatedFetch(req);
    expect(res.status).toBe(201);
    const sent = sentMessages.find(
      (m) => (m as { type?: string }).type === 'SOLID_FETCH_REQUEST',
    ) as { body: string | null };
    expect(sent.body).toBe(turtle);
  });

  it('authenticatedFetch lets an explicit init override a Request (fetch semantics)', async () => {
    installChrome((m) => {
      if ((m as { type: string }).type === 'SOLID_FETCH_REQUEST') {
        return { requestId: (m as { requestId: string }).requestId, status: 200, body: '' };
      }
      return activeState();
    });
    const c = new MessageBridgeLoginController();
    await c.restore(); // log in so authenticatedFetch is the proxy (not pristine)
    const req = new Request('https://alice.pod.example/r', { method: 'GET' });
    await c.authenticatedFetch(req, { method: 'DELETE' });

    const sent = sentMessages.find(
      (m) => (m as { type?: string }).type === 'SOLID_FETCH_REQUEST',
    ) as { method: string };
    expect(sent.method).toBe('DELETE');
  });

  it('STRIPS caller-supplied Authorization/DPoP headers (init AND Request) — worker is the credential authority', async () => {
    installChrome((m) => {
      if ((m as { type: string }).type === 'SOLID_FETCH_REQUEST') {
        return { requestId: (m as { requestId: string }).requestId, status: 200, body: '' };
      }
      return activeState();
    });
    const c = new MessageBridgeLoginController();
    await c.restore(); // log in so authenticatedFetch is the proxy (not pristine)

    // via init.headers
    await c.authenticatedFetch('https://alice.pod.example/r', {
      headers: { Authorization: 'Bearer ATTACKER', DPoP: 'forged-proof', 'x-keep': 'yes' },
    });
    // via a Request object
    const req = new Request('https://alice.pod.example/r2', {
      headers: { authorization: 'Bearer ATTACKER2', dpop: 'forged-proof-2', 'x-keep': 'also' },
    });
    await c.authenticatedFetch(req);

    const reqs = sentMessages.filter(
      (m) => (m as { type?: string }).type === 'SOLID_FETCH_REQUEST',
    ) as Array<{ headers: Record<string, string> }>;
    expect(reqs).toHaveLength(2);
    for (const sent of reqs) {
      const keys = Object.keys(sent.headers).map((k) => k.toLowerCase());
      expect(keys).not.toContain('authorization');
      expect(keys).not.toContain('dpop');
      // Non-credential headers are preserved.
      expect(keys).toContain('x-keep');
    }
    // And no attacker value rode along anywhere.
    const wire = JSON.stringify(reqs);
    expect(wire).not.toContain('ATTACKER');
    expect(wire).not.toContain('forged-proof');
  });
});
