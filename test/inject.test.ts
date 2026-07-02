// AUTHORED-BY Claude Opus 4.8
//
// The MAIN-world inject (window.solid + the global-fetch transparency patch). These cover the
// two roborev findings against inject.ts:
//   - HIGH #1: the global-fetch patch routes a cross-origin request but marks it `autoDivert`
//     so the SW can native-passthrough a non-pod/un-granted request (the page-compat invariant
//     is enforced SW-side; here we prove the inject sends the flag + leaves same-origin native).
//   - MEDIUM #2: a DOUBLE injection (manifest + dynamic registration) is INERT — the second run
//     is a no-op, never a throw on the `configurable:false` defineProperty.
//
// Each test gets a FRESH JSDOM window (the inject defines `window.solid` non-configurable, so a
// shared window could not be reset between tests). We rebind the relevant globals to that
// window, then re-import the module (which installs at import) under a reset module registry.

import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dom: JSDOM;
let posted: Array<Record<string, unknown>>;
let nativeFetch: ReturnType<typeof vi.fn>;
const savedGlobals: Record<string, PropertyDescriptor | undefined> = {};

function setGlobal(name: string, value: unknown): void {
  if (!(name in savedGlobals)) {
    savedGlobals[name] = Object.getOwnPropertyDescriptor(globalThis, name);
  }
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function freshWindow(): void {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://app.example/page.html',
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  posted = [];
  // Capture page→content messages.
  win.postMessage = ((msg: unknown) => {
    posted.push(msg as Record<string, unknown>);
  }) as typeof win.postMessage;
  // jsdom does NOT implement fetch/Response; Node's globals do. Keep Node's Response/Headers/URL
  // (the inject builds Responses with them) and only swap in the jsdom window + a stub fetch.
  nativeFetch = vi.fn(async () => new Response('native', { status: 200 }));
  win.fetch = nativeFetch as unknown as typeof fetch;
  let n = 0;
  const cryptoStub = { randomUUID: () => `uuid-${n++}` };
  // jsdom's window.crypto is a getter-only accessor — redefine it.
  Object.defineProperty(win, 'crypto', { configurable: true, value: cryptoStub });
  // The module references the bare globals `window` + `crypto`; `Response`/`Headers`/`URL` stay
  // Node's (jsdom's are non-functional here), which the inject's `new URL(...)` etc. need.
  setGlobal('window', win);
  setGlobal('crypto', cryptoStub);
}

/** Fresh module each test (the inject installs at import). */
async function importInject(): Promise<void> {
  vi.resetModules();
  await import('../src/inject/inject');
}

beforeEach(() => {
  freshWindow();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, desc] of Object.entries(savedGlobals)) {
    if (desc) Object.defineProperty(globalThis, name, desc);
    else delete (globalThis as Record<string, unknown>)[name];
    delete savedGlobals[name];
  }
  dom.window.close();
});

describe('inject — installs window.solid + patches fetch', () => {
  it('defines window.solid and patches window.fetch on first run', async () => {
    expect('solid' in dom.window).toBe(false);
    await importInject();
    expect('solid' in dom.window).toBe(true);
    expect(typeof (dom.window as { solid?: { fetch?: unknown } }).solid?.fetch).toBe('function');
    // It asked the worker for state on load.
    expect(posted.some((m) => m.type === 'SOLID_GET_STATE')).toBe(true);
    // The global fetch is no longer the pristine sentinel.
    expect(dom.window.fetch).not.toBe(nativeFetch);
  });

  it('announces presence: a sticky <html data-solid-extension> marker + a solid-extension:ready event', async () => {
    // A page hides its own account chrome when the extension is present; it needs a reliable,
    // race-free presence signal. Assert BOTH announce channels the inject sets up.
    const readyEvents: Event[] = [];
    dom.window.addEventListener('solid-extension:ready', (e) => readyEvents.push(e));
    expect(dom.window.document.documentElement.getAttribute('data-solid-extension')).toBeNull();
    await importInject();
    // 1. the STICKY DOM marker — readable synchronously by app code regardless of load order.
    expect(dom.window.document.documentElement.getAttribute('data-solid-extension')).toBe('1');
    // 2. the one-shot event — for a listener attached before the inject ran.
    expect(readyEvents).toHaveLength(1);
    // The announce carries NO identity: webId stays on window.solid (null until auth).
    expect((dom.window as unknown as { solid: { webId: unknown } }).solid.webId).toBeNull();
  });
});

describe('inject — HIGH #1: the global-fetch patch marks routed requests autoDivert', () => {
  it('a CROSS-ORIGIN fetch is routed to the SW with autoDivert=true (so the SW can native-pass)', async () => {
    await importInject();
    posted.length = 0;
    // Fire a cross-origin fetch (a third-party API the app calls). It is routed (not awaited).
    void dom.window.fetch('https://api.thirdparty.example/data');
    const routed = posted.find((m) => m.type === 'SOLID_FETCH_REQUEST');
    expect(routed).toBeDefined();
    expect(routed?.url).toBe('https://api.thirdparty.example/data');
    // The flag that lets the SW native-passthrough instead of hard-failing the page.
    expect(routed?.autoDivert).toBe(true);
    // It did NOT go straight to the native fetch (it was diverted to the bridge).
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('a SAME-ORIGIN fetch stays on the untouched NATIVE fetch (no proxy tax, never routed)', async () => {
    await importInject();
    posted.length = 0;
    await dom.window.fetch('https://app.example/assets/app.js');
    // No routing message — same-origin asset went straight to native.
    expect(posted.some((m) => m.type === 'SOLID_FETCH_REQUEST')).toBe(false);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('a RELATIVE fetch stays native (resolves to same-origin)', async () => {
    await importInject();
    posted.length = 0;
    await dom.window.fetch('/api/local');
    expect(posted.some((m) => m.type === 'SOLID_FETCH_REQUEST')).toBe(false);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('a non-http(s) scheme (data:) stays native (never routed)', async () => {
    await importInject();
    posted.length = 0;
    await dom.window.fetch('data:text/plain,hello');
    expect(posted.some((m) => m.type === 'SOLID_FETCH_REQUEST')).toBe(false);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('an EXPLICIT window.solid.fetch carries autoDivert=false (keeps the SW 403, not passthrough)', async () => {
    await importInject();
    posted.length = 0;
    const solid = (dom.window as unknown as { solid: { fetch: (u: string) => Promise<Response> } })
      .solid;
    void solid.fetch('https://alice.pod.example/private/notes.ttl');
    const routed = posted.find((m) => m.type === 'SOLID_FETCH_REQUEST');
    expect(routed).toBeDefined();
    // The explicit API path is NOT auto-diverted — a deny here is the caller's expected 403.
    expect(routed?.autoDivert).toBe(false);
  });
});

// --- Round-2 High #1: the page-side passthrough sentinel handler ------------------------
//
// When the SW returns `{ passthrough: true }` (it declined an autoDivert request and did NO
// network), the inject MUST complete the pending promise by calling the page's OWN native fetch
// (PRISTINE_FETCH) with the ORIGINAL input/init — never fabricate a Response from SW data.

/** Deliver a `to-page` message into the inject's window 'message' listener. */
function deliverToPage(message: Record<string, unknown>): void {
  const win = dom.window as unknown as Window;
  const event = new dom.window.MessageEvent('message', {
    data: { channel: 'solid-browser-ext', dir: 'to-page', ...message },
    source: win as unknown as MessageEventSource,
  });
  win.dispatchEvent(event);
}

describe('inject — Round-2 High #1: a passthrough sentinel is completed by the page native fetch', () => {
  it('resolves a routed fetch by calling PRISTINE_FETCH with the ORIGINAL input + init, NOT a fabricated Response', async () => {
    await importInject();
    posted.length = 0;
    // Make the native fetch return a distinctive body so we can prove the resolved Response came
    // from PRISTINE_FETCH, not from any SW-supplied bytes.
    nativeFetch.mockResolvedValueOnce(new Response('NATIVE-IN-PAGE-BYTES', { status: 207 }));

    const init: RequestInit = { method: 'POST', headers: { 'X-App': 'v1' }, body: 'payload' };
    const promise = (
      dom.window as unknown as { fetch: (u: string, i?: RequestInit) => Promise<Response> }
    ).fetch('https://api.thirdparty.example/data', init);

    // The request was routed to the SW with autoDivert=true; nativeFetch not called YET.
    const routed = posted.find((m) => m.type === 'SOLID_FETCH_REQUEST');
    expect(routed).toBeDefined();
    expect(routed?.autoDivert).toBe(true);
    expect(nativeFetch).not.toHaveBeenCalled();
    const requestId = routed?.requestId as string;

    // The SW replies with the passthrough SENTINEL (no body/status — it did no network).
    deliverToPage({ type: 'SOLID_FETCH_RESPONSE', requestId, passthrough: true });

    const response = await promise;
    // The promise resolved with the PAGE's native fetch result (the SW gave no bytes).
    expect(await response.text()).toBe('NATIVE-IN-PAGE-BYTES');
    expect(response.status).toBe(207);
    // PRISTINE_FETCH was called with the ORIGINAL input + a faithful init SNAPSHOT (round-3
    // Medium: the init is COPIED at call time, so it is value-equal but NOT the same reference).
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    const [calledInput, calledInit] = nativeFetch.mock.calls[0] as [string, RequestInit];
    expect(calledInput).toBe('https://api.thirdparty.example/data');
    expect(calledInit).not.toBe(init); // a snapshot copy, not the caller's object
    expect(calledInit.method).toBe('POST');
    expect(calledInit.body).toBe('payload');
    expect(new Headers(calledInit.headers).get('X-App')).toBe('v1');
  });

  it('round-3 Medium: the passthrough request is SNAPSHOT at call time — a later mutation of init.headers / init.credentials / a URL input cannot change it', async () => {
    await importInject();
    posted.length = 0;
    nativeFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));

    // A mutable URL object + an init the caller will mutate AFTER the call (as native fetch would
    // have already snapshotted them synchronously).
    const url = new dom.window.URL('https://api.thirdparty.example/data');
    const headers = new dom.window.Headers({ 'X-App': 'v1' });
    const init: RequestInit = {
      method: 'GET',
      headers: headers as unknown as HeadersInit,
      credentials: 'include',
    };
    const promise = (
      dom.window as unknown as { fetch: (u: URL, i?: RequestInit) => Promise<Response> }
    ).fetch(url as unknown as URL, init);

    const routed = posted.find((m) => m.type === 'SOLID_FETCH_REQUEST');
    const requestId = routed?.requestId as string;
    expect(nativeFetch).not.toHaveBeenCalled();

    // MUTATE the caller's objects after the call but BEFORE the sentinel arrives.
    url.pathname = '/HIJACKED';
    headers.set('X-App', 'TAMPERED');
    headers.set('X-Injected', 'yes');
    init.credentials = 'omit';

    deliverToPage({ type: 'SOLID_FETCH_RESPONSE', requestId, passthrough: true });
    await promise;

    // PRISTINE_FETCH saw the values AS THEY WERE AT CALL TIME, not the mutated ones.
    const [calledInput, calledInit] = nativeFetch.mock.calls[0] as [
      string | URL,
      RequestInit | undefined,
    ];
    expect(calledInput.toString()).toBe('https://api.thirdparty.example/data');
    expect(new Headers(calledInit?.headers).get('X-App')).toBe('v1');
    expect(new Headers(calledInit?.headers).has('X-Injected')).toBe(false);
    expect(calledInit?.credentials).toBe('include');
  });

  it('a passthrough sentinel that REJECTS (CORS block) rejects the page promise exactly as native', async () => {
    await importInject();
    posted.length = 0;
    const corsError = new TypeError('Failed to fetch');
    nativeFetch.mockRejectedValueOnce(corsError);

    const promise = (dom.window as unknown as { fetch: (u: string) => Promise<Response> }).fetch(
      'https://blocked.example/data',
    );
    const routed = posted.find((m) => m.type === 'SOLID_FETCH_REQUEST');
    const requestId = routed?.requestId as string;

    deliverToPage({ type: 'SOLID_FETCH_RESPONSE', requestId, passthrough: true });

    await expect(promise).rejects.toBe(corsError);
  });

  it('a NON-passthrough SW response (gated path) still resolves from SW data, never the native fetch', async () => {
    await importInject();
    posted.length = 0;
    const solid = (
      dom.window as unknown as {
        solid: { fetch: (u: string) => Promise<Response> };
      }
    ).solid;
    // Explicit window.solid.fetch → autoDivert=false → never a passthrough sentinel.
    const promise = solid.fetch('https://alice.pod.example/private/notes.ttl');
    const routed = posted.find((m) => m.type === 'SOLID_FETCH_REQUEST');
    expect(routed?.autoDivert).toBe(false);
    const requestId = routed?.requestId as string;

    // The SW returns real (gated, authenticated) bytes — no passthrough flag.
    deliverToPage({
      type: 'SOLID_FETCH_RESPONSE',
      requestId,
      status: 200,
      body: 'GATED-POD-BYTES',
      headers: {},
    });

    const response = await promise;
    expect(await response.text()).toBe('GATED-POD-BYTES');
    expect(response.status).toBe(200);
    // The native fetch was NOT used on the gated path.
    expect(nativeFetch).not.toHaveBeenCalled();
  });
});

describe('inject — MEDIUM #2: a double injection is INERT (no throw on the second run)', () => {
  it('importing/running the inject TWICE does not throw and installs window.solid once', async () => {
    await importInject();
    expect('solid' in dom.window).toBe(true);
    const firstSolid = (dom.window as unknown as { solid: unknown }).solid;

    // A second run (the other injection mechanism / a reload) must be a silent no-op — NOT a
    // throw on Object.defineProperty(window,'solid',{configurable:false}).
    await expect(importInject()).resolves.toBeUndefined();
    // window.solid is unchanged (the configurable:false property was never re-defined).
    expect((dom.window as unknown as { solid: unknown }).solid).toBe(firstSolid);
  });

  it('the guard short-circuits when window.solid already exists (different prior code path)', async () => {
    // Simulate a prior install from another path (window.solid present, marker absent).
    Object.defineProperty(dom.window, 'solid', {
      value: Object.freeze({ sentinel: true }),
      configurable: false,
    });
    delete (dom.window as { __solidInjected?: boolean }).__solidInjected;
    // Must not throw, and must NOT clobber the existing (frozen, non-configurable) property.
    await expect(importInject()).resolves.toBeUndefined();
    expect((dom.window as unknown as { solid: { sentinel?: boolean } }).solid.sentinel).toBe(true);
  });
});
