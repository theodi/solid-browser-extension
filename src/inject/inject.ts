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
const pendingFetches = new Map<string, Pending<Response>>();
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
      if (data.error) {
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

function solidFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    pendingFetches.set(requestId, { resolve, reject });
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

const solid: SolidExtension = {
  get webId() {
    return currentWebId;
  },
  fetch: solidFetch,
  setClientId(clientId: string) {
    postToContent({ type: 'SOLID_SET_CLIENT_ID', clientId });
  },
  login(webId: string) {
    return action('SOLID_LOGIN', { webId });
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

// Ask the worker for the current session state on load (populates window.solid.webId).
postToContent({ type: 'SOLID_GET_STATE' });
