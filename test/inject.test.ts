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
