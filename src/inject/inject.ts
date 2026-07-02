// AUTHORED-BY Claude Opus 4.8
/**
 * The MAIN-world injection: defines `window.solid` on every page. This script runs in the
 * page's own JS world (so the page can call it), but it holds NO credential — every
 * privileged operation is a `postMessage` to the ISOLATED content script, which relays to
 * the service worker (the sole token holder). The page only ever sees the WebID + a
 * proxied fetch Response. The credential boundary is enforced in the worker, not here.
 */

export {};

const CHANNEL = 'solid-browser-ext';

// --- Idempotency guard (Medium #2) -----------------------------------------------------
//
// inject.js is now injected by a SINGLE mechanism — the SW's dynamic
// `chrome.scripting.registerContentScripts` (the manifest MAIN-world declaration was removed,
// see manifest.json / global-fetch-register.ts — declaring it BOTH ways let it run twice and
// the second run THREW on `Object.defineProperty(window,'solid',{configurable:false})` below).
// This guard remains as DEFENCE-IN-DEPTH: even an accidental double-run (a reload race, a
// re-registration) must be an inert no-op, never a throw. The marker covers a re-run after our
// own install; the `'solid' in window` check covers a prior install from any other code path.
declare global {
  interface Window {
    __solidInjected?: boolean;
  }
}

/**
 * The `window.solid` API surface. Deliberately small + stable so the access-management
 * track (a later `requestAccess(...)` method — see the SEAM below) slots in without a
 * breaking change.
 */
interface SolidExtension {
  /** The authenticated user's WebID, or null when signed out. */
  readonly webId: string | null;
  /** A DPoP-authenticated fetch, proxied through the extension (origin-gated, fail-closed). */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Declare this origin's Client Identifier Document URL so the pod sees the page's identity. */
  setClientId(clientId: string): void;
  /** Start the interactive login for a WebID (same as the popup). */
  login(webId: string): Promise<void>;
  /** Clear the session (app-local logout). */
  logout(): Promise<void>;

  // --- ACCESS-MANAGEMENT SEAM (NOT IMPLEMENTED) -------------------------------------
  // The access-request JS API (requestAccess / consent UI / queued-request handling) is
  // a SEPARATE, design-first track and is intentionally out of scope for this core. The
  // method is declared here so adding it later is non-breaking, but calling it throws so
  // a consumer can feature-detect. Do NOT wire access management onto this stub without
  // the access-management design.
  requestAccess?(request: unknown): Promise<never>;
}

type Pending<T> = { resolve: (v: T) => void; reject: (e: Error) => void };

/**
 * A pending `solidFetch`, plus the ORIGINAL `input`/`init` it was called with. The original
 * args are retained so that if the SW returns a PASSTHROUGH SENTINEL (round-2 High #1 — the SW
 * declined an autoDivert request and did NO network), the page-side handler can complete the
 * request by calling the page's OWN native fetch (PRISTINE_FETCH) with full CORS / credentials
 * / header fidelity — the SW never fetches cross-origin bytes on a page's behalf.
 */
type PendingFetch = Pending<Response> & {
  readonly input: RequestInfo | URL;
  readonly init?: RequestInit;
};

// Install exactly once, even if inject.js runs twice (Medium #2). The marker covers a re-run
// after our own install; the `'solid' in window` check covers a prior install from a different
// code path. A double-run is then an inert no-op, NOT a throw on the `configurable:false`
// defineProperty below.
if (!window.__solidInjected && !('solid' in window)) {
  window.__solidInjected = true;
  installSolidInjection();
}

function installSolidInjection(): void {
  // --- Snapshot the PRISTINE fetch FIRST (the @jeswr/solid-elements discipline) -----------
  //
  // Captured up-front, before the global patch below, so a later page script that overwrites
  // `window.fetch` cannot poison it. This is ALSO the function the SW passthrough path falls
  // back to: when the SW returns a passthrough sentinel, the page completes the request with
  // its OWN native fetch in the page's origin context (round-2 High #1) — so the extension is
  // never a cross-origin proxy and native CORS / credentials / header semantics are preserved.
  const PRISTINE_FETCH = window.fetch.bind(window);

  /**
   * Duck-type a `URL`-like input rather than `instanceof URL`. `instanceof` is CROSS-REALM
   * UNRELIABLE: a `URL` minted in another JS realm (an iframe, or — in tests — a JSDOM window
   * whose `URL` differs from the module's bare-global `URL`) is NOT an instance of the realm-local
   * `URL`, so `input instanceof URL` would wrongly be `false` and we'd mis-classify the input
   * (treating a cross-origin pod URL as same-origin and skipping the gate). A `RequestInfo | URL`
   * that is a non-null object exposing a string `href` is a URL (a `Request` has no `href` — it
   * carries `url` — so this never mis-takes a `Request` for a `URL`). `WHATWG URL` is fully
   * specified by its `href`, so we snapshot/serialise via `href` and never depend on identity.
   */
  function urlLike(input: unknown): input is URL {
    return (
      typeof input === 'object' &&
      input !== null &&
      'href' in input &&
      typeof (input as { href: unknown }).href === 'string'
    );
  }

  const pendingFetches = new Map<string, PendingFetch>();
  const pendingActions = new Map<string, Pending<void>>();

  let currentWebId: string | null = null;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.dir !== 'to-page') return;

    switch (data.type) {
      case 'SOLID_FETCH_RESPONSE': {
        const pending = pendingFetches.get(data.requestId);
        if (!pending) return;
        pendingFetches.delete(data.requestId);
        if (data.passthrough === true) {
          // PASSTHROUGH SENTINEL (round-2 High #1): the SW declined this autoDivert request and
          // did NO network. Complete it with the page's OWN native fetch, in the page's origin
          // context, using the ORIGINAL input/init — so CORS / credentials / headers behave
          // EXACTLY as if the extension were not installed (if CORS blocks, this rejects /
          // returns opaque exactly as native). We NEVER fabricate a Response from SW data on
          // this path: the SW returned no bytes (it cannot be a cross-origin read proxy).
          PRISTINE_FETCH(pending.input as RequestInfo, pending.init).then(
            pending.resolve,
            pending.reject,
          );
        } else if (data.error) {
          pending.reject(new Error(data.error));
        } else {
          pending.resolve(
            new Response(data.body ?? null, {
              status: data.status,
              statusText: data.statusText,
              headers: new Headers(data.headers ?? {}),
            }),
          );
        }
        break;
      }
      case 'SOLID_ACTION_RESPONSE': {
        const pending = pendingActions.get(data.actionId);
        if (!pending) return;
        pendingActions.delete(data.actionId);
        if (data.error) pending.reject(new Error(data.error));
        else pending.resolve();
        break;
      }
      case 'SOLID_STATE_UPDATE':
        currentWebId = data.webId ?? null;
        break;
    }
  });

  function postToContent(message: Record<string, unknown>): void {
    window.postMessage({ channel: CHANNEL, dir: 'to-content', ...message }, window.location.origin);
  }

  /**
   * Route a fetch through the gated SW path. `autoDivert` marks a request that came from the
   * best-effort global-fetch patch (NOT an explicit `window.solid.fetch` call) so the SW can
   * native-passthrough a non-pod / un-granted request instead of hard-failing the page (High #1).
   */
  function solidFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
    autoDivert = false,
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      // Retain the input/init so a passthrough sentinel can be completed with the page's own
      // native fetch verbatim (round-2 High #1). SNAPSHOT them at CALL TIME (round-3 Medium):
      // native `fetch` reads the URL/init synchronously, but a passthrough fetch happens only
      // AFTER the async SW round-trip — so without a snapshot, a page that mutates the `URL`,
      // the `Headers`, or `init.credentials` between the call and the sentinel would change the
      // eventual request. Copy the URL (a mutable `URL` object), the init object, and the
      // headers into fresh values so a later mutation of the caller's objects cannot leak in. A
      // string input + string body are immutable, so they need no copy. A `URL` is detected by
      // duck-typing (`urlLike`, cross-realm-safe) and snapshotted to its `href` STRING: a WHATWG
      // URL is fully specified by `href`, native fetch accepts a string URL identically, and a
      // string can't be mutated — so a later `url.pathname = …` on the caller's object cannot leak
      // into the deferred passthrough. (Snapshotting to a fresh `URL` would also work but only if
      // `URL` is the same realm; a string is robust in both browser and JSDOM.)
      const snapInput: RequestInfo | URL = urlLike(input) ? input.href : input;
      const snapInit: RequestInit | undefined = init
        ? { ...init, ...(init.headers ? { headers: new Headers(init.headers) } : {}) }
        : undefined;
      pendingFetches.set(requestId, { resolve, reject, input: snapInput, init: snapInit });
      let body: string | null = null;
      if (init?.body != null) {
        if (typeof init.body !== 'string') {
          pendingFetches.delete(requestId);
          reject(new Error('window.solid.fetch currently supports only string request bodies.'));
          return;
        }
        body = init.body;
      }
      postToContent({
        type: 'SOLID_FETCH_REQUEST',
        requestId,
        url: input.toString(),
        method: init?.method ?? 'GET',
        headers: init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {},
        body,
        autoDivert,
      });
    });
  }

  function action(type: string, extra: Record<string, unknown> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const actionId = crypto.randomUUID();
      pendingActions.set(actionId, { resolve, reject });
      postToContent({ type, actionId, ...extra });
    });
  }

  // The client-id declared via setClientId(), carried directly on the login message so a
  // page that calls setClientId() then immediately login() can't race the storage write.
  let currentClientId: string | undefined;

  const solid: SolidExtension = {
    get webId() {
      return currentWebId;
    },
    fetch: solidFetch,
    setClientId(clientId: string) {
      currentClientId = clientId;
      postToContent({ type: 'SOLID_SET_CLIENT_ID', clientId });
    },
    login(webId: string) {
      return action('SOLID_LOGIN', { webId, clientId: currentClientId });
    },
    logout() {
      return action('SOLID_LOGOUT');
    },
    requestAccess() {
      return Promise.reject(
        new Error(
          'window.solid.requestAccess is not implemented: access management is a separate, ' +
            'design-first track and is not part of the core extension.',
        ),
      );
    },
  };

  Object.defineProperty(window, 'solid', { value: Object.freeze(solid), configurable: false });

  // --- Presence announce (apps de-dupe their own account chrome) --------------------------
  //
  // A page needs a RELIABLE, RACE-FREE way to know the Solid extension is installed so it can
  // hide its OWN profile/logout controls (the extension already shows a pinned account menu —
  // showing both is duplicate chrome). `'solid' in window` is the API, but a page script that
  // runs BEFORE this MAIN-world inject (a race, since inject is document_start) would sniff a
  // bare window and wrongly conclude "no extension". So we announce presence two ways, both
  // credential-free (this only says "an extension is here", never who the user is):
  //   1. a STICKY DOM marker on <html> — readable SYNCHRONOUSLY by app code whenever it runs,
  //      even long after inject (it persists), so there is no ordering dependency; and
  //   2. a one-shot CustomEvent for a listener that was already attached before inject ran.
  // The webId still lives ONLY on `window.solid.webId` (null until auth) — the marker/event
  // carry no identity. Wrapped defensively: an announce failure must never break `window.solid`.
  try {
    window.document.documentElement.setAttribute('data-solid-extension', '1');
    // Use the page realm's own CustomEvent (window.CustomEvent === CustomEvent in a real page)
    // so the event is same-realm with the window it is dispatched on.
    window.dispatchEvent(new window.CustomEvent('solid-extension:ready'));
  } catch {
    // Non-fatal — the `window.solid` API above is the source of truth; the marker is a hint.
  }

  // --- The MAIN-world global-`fetch` patch (design §5.1) ---------------------------------
  //
  // Generalises the `window.solid.fetch` proxy: transparently route a page's PLAIN
  // `fetch(podUrl)` through the extension (→ ISOLATED bridge → SW → DPoP egress) so an
  // unmodified Solid app gets authenticated, replica-backed reads/writes with no code change.
  //
  // SECURITY (load-bearing): this patch is BEST-EFFORT TRANSPARENCY with ZERO security weight
  // (design §5.1). The SW gate remains the SOLE boundary — EVERY routed request still goes
  // through the Phase-0 per-requesting-origin gate as the FIRST check (in the SW). The patch is
  // racy + bypassable by design; a missed/bypassed request is a plain unauthenticated fetch
  // (pod 401, fail-safe for the credential) governed by the server's own WAC. The patch can
  // NEVER widen access — it only forwards to the same gated `solid.fetch` path.
  //
  // Re-assert discipline (the @jeswr/solid-elements `installProactiveAuthFetch` pattern):
  // snapshot the PRISTINE fetch FIRST (done at the TOP of installSolidInjection above, before
  // any page script could overwrite `window.fetch`), install once (idempotent), and never
  // re-read a possibly-patched global. A later page script that overwrites `window.fetch` only
  // affects ITS OWN requests — it gains no credential (the SW gate is the boundary). The same
  // PRISTINE_FETCH also services the SW passthrough sentinel (round-2 High #1).

  /**
   * A CHEAP page-side pre-filter for which requests are even WORTH routing to the SW — NOT the
   * security/compat decision (that is the SW's, see below). We route only http(s) CROSS-origin
   * absolute URLs: a Solid pod is on a different origin than the app, so a same-origin or
   * relative request is the app's own asset/API and stays on the untouched native fetch (no
   * proxy tax). The inject deliberately does NOT know the pod-origin set (it must not, to avoid
   * leaking the pod list / PII to an arbitrary page — design §5.1) — it stays DUMB and lets the
   * SW (the SOLE boundary) decide.
   *
   * HIGH #1 — THE KEY INVARIANT: routing here must NEVER break the page's normal web traffic.
   * Routing a NON-pod cross-origin request (an app's call to a third-party API/CDN) must end in
   * a plain NATIVE UNAUTHENTICATED fetch, not a 403. That is achieved on the SW side: a routed
   * request carries `autoDivert: true`, and when the SW gate does not ALLOW (a non-pod target,
   * or an un-granted requesting origin) the SW performs a native unauthenticated passthrough
   * instead of returning a gate-deny. The credential + replica path is taken ONLY on an explicit
   * gate ALLOW (a known pod origin from a granted requesting origin). Over-routing is therefore
   * harmless: the worst case for any non-pod request is the same plain fetch the page would have
   * done itself. (An EXPLICIT `window.solid.fetch` carries `autoDivert: false` and keeps the 403.)
   */
  function shouldDivert(input: RequestInfo | URL): boolean {
    try {
      const url = new URL(
        typeof input === 'string' ? input : urlLike(input) ? input.href : (input as Request).url,
        window.location.href,
      );
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
      // Same-origin requests are the app's own assets/APIs — leave them on native fetch.
      return url.origin !== window.location.origin;
    } catch {
      return false;
    }
  }

  const patchedFetch: typeof fetch = (input, init) => {
    if (shouldDivert(input)) {
      // A Request object (not a plain URL/string) carries a body/headers the bridge can't
      // currently serialise structurally — pass it through solidFetch via its URL + init only
      // for the simple (string/URL) case; a complex Request falls back to native fetch (the SW
      // gate still governs the eventual pod read if the app re-issues it through window.solid).
      if (typeof input === 'string' || urlLike(input)) {
        // autoDivert=true: this is the transparency patch, NOT an explicit window.solid.fetch —
        // the SW native-passes-through (no 403) when the request is non-pod / un-granted (High #1).
        return solidFetch(input, init, true);
      }
    }
    return PRISTINE_FETCH(input as RequestInfo, init);
  };

  try {
    window.fetch = patchedFetch;
  } catch {
    // If a page froze `fetch`, transparency is simply unavailable on it (the SW path via
    // window.solid.fetch still works). The patch is best-effort by design.
  }

  // Ask the worker for the current session state on load (populates window.solid.webId).
  postToContent({ type: 'SOLID_GET_STATE' });
}
