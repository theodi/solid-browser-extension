// AUTHORED-BY Claude Opus 4.8
/**
 * The message protocol shared across the four contexts (MAIN-world inject, ISOLATED
 * content script, service worker, popup). All payloads MUST be JSON-serialisable —
 * `window.postMessage` (page ↔ content) and `chrome.runtime` (content/popup ↔ worker)
 * both structured-clone, and Response bodies are serialised as text (Solid resources are
 * predominantly text/RDF; binary support is a documented future extension).
 *
 * The injected `window.solid` NEVER receives a token — only the WebID + a proxied fetch
 * result. The credential boundary is enforced entirely in the service worker.
 */

/** A namespacing tag on every page↔content postMessage so we ignore unrelated messages. */
export const CHANNEL = 'solid-browser-ext' as const;

// --- Requests (page/popup -> worker) --------------------------------------------------

export interface FetchRequest {
  readonly type: 'SOLID_FETCH_REQUEST';
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
  /**
   * The page-supplied requesting origin (`window.location.origin`), stamped by the content
   * script. ADVISORY ONLY — the worker cross-checks it against the browser-attested
   * `sender.origin` and trusts the browser value. A mismatch is denied; this is never the
   * sole authority. (Per design §4.3 "Forge the access-control anchor".)
   */
  readonly stampedOrigin?: string;
}

export interface LoginRequest {
  readonly type: 'SOLID_LOGIN';
  readonly webId: string;
  /** The requesting page's origin (for per-origin client-id resolution). */
  readonly origin?: string;
  /** A page-supplied Client Identifier Document URL. */
  readonly clientId?: string;
}

export interface LogoutRequest {
  readonly type: 'SOLID_LOGOUT';
}

export interface GetStateRequest {
  readonly type: 'SOLID_GET_STATE';
  /**
   * The page-supplied requesting origin, stamped by the content script. ADVISORY ONLY —
   * cross-checked against the browser-attested `sender` so the worker only exposes the WebID
   * (PII) to a verified, granted page origin. Absent for the extension's own contexts.
   */
  readonly stampedOrigin?: string;
}

export interface SetClientIdRequest {
  readonly type: 'SOLID_SET_CLIENT_ID';
  readonly origin: string;
  readonly clientId: string;
}

export type WorkerRequest =
  | FetchRequest
  | LoginRequest
  | LogoutRequest
  | GetStateRequest
  | SetClientIdRequest;

// --- Responses (worker -> caller) -----------------------------------------------------

export interface FetchResponse {
  readonly requestId: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly error?: string;
}

/**
 * The popup's ONLY window into the session — pure display metadata, NO token. This is
 * what the popup's `MessageBridgeLoginController` mirrors to answer the synchronous
 * LoginController getters; `recentAccounts` is mapped to `RecentLoginAccount` consumer-side.
 * No new wire type is needed to adopt `<jeswr-login-panel>`.
 */
export interface SessionState {
  readonly webId: string | null;
  readonly isActive: boolean;
  readonly name: string | null;
  readonly photoUrl: string | null;
  readonly recentAccounts: ReadonlyArray<{
    webId: string;
    name: string | null;
    photoUrl: string | null;
  }>;
}

export interface ActionResult {
  readonly ok?: boolean;
  readonly webId?: string;
  readonly error?: string;
}

/** Broadcast from the worker to all tabs/popup when auth state changes. */
export interface StateChanged {
  readonly type: 'SOLID_STATE_CHANGED';
  readonly webId: string | null;
}
