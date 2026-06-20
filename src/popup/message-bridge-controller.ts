// AUTHORED-BY Claude Opus 4.8
/**
 * MessageBridgeLoginController — a chrome.identity-backed {@link LoginController} that
 * lets the popup adopt `<jeswr-login-panel>` (the suite-wide login surface, for visual
 * parity with Pod Manager) WITHOUT breaking the extension's credential boundary.
 *
 * The conflict it resolves: the LoginController contract is SYNCHRONOUS + in-process —
 * `webId`/`publicFetch`/`authenticatedFetch` are read-only getters the panel reads
 * during render — but the MV3 extension splits the UI (popup) from the credential
 * holder (service worker). The token, the DPoP key, the OIDC flow and every
 * authenticated fetch live ONLY in the SW; the popup reaches it via the inherently
 * ASYNC `chrome.runtime` message protocol. We bridge the two by keeping a small
 * TOKEN-FREE popup-local mirror of the session metadata (so the sync getters can
 * answer) and proxying every real auth action/fetch to the SW.
 *
 * NO-TOKEN-LEAK INVARIANT (by construction):
 *   1. The only mutable fields are `#webId` (string|null) and `#recentAccounts`
 *      (display metadata). There is NO field that can hold an accessToken,
 *      refreshToken, or a DPoP CryptoKeyPair. Every value comes from `SessionState`,
 *      which deliberately carries no token.
 *   2. `publicFetch` is a MODULE-LOAD pristine `fetch` snapshot. The popup never
 *      patches `globalThis.fetch`, so this stays provably credential-free.
 *   3. `authenticatedFetch` is a PROXY: it forwards a `SOLID_FETCH_REQUEST` to the SW
 *      and rebuilds a `Response` from the reply. The DPoP-bound token is attached
 *      inside the SW's `handleFetch` (origin-gated, token-endpoint-guarded) and only
 *      status/filtered-headers/body come back — the popup never sees the credential.
 *
 * The credential core (auth-flow.ts / session-store.ts / the SW router) is UNTOUCHED:
 * this controller is expressed entirely over the EXISTING message protocol, with NO
 * new wire types.
 */

import type {
  LoginController,
  LoginResult,
  RecentLoginAccount,
  RestoreOutcome,
} from '@jeswr/solid-elements';
import type {
  ActionResult,
  FetchResponse,
  GetStateRequest,
  LoginRequest,
  LogoutRequest,
  SessionState,
} from '../shared/messages';

/**
 * The pristine native `fetch`, captured at MODULE LOAD before any code could patch the
 * global. This is the credential-free foreign-origin / public-read boundary the panel
 * exposes as `.publicFetch`. The popup never installs a patched global, so this remains
 * the genuine, uncredentialed `fetch`.
 */
const MODULE_PRISTINE_FETCH: typeof fetch = globalThis.fetch.bind(globalThis);

/**
 * Caller-supplied credential/transport headers that must NEVER cross to the worker: the
 * worker is the SOLE credential authority and attaches its own DPoP-bound Authorization.
 * Defense-in-depth (the worker's own `authenticatedFetch` re-strips these too) — stripping
 * popup-side keeps the wire clean and the boundary robust even if a caller passes one.
 */
const STRIPPED_REQUEST_HEADERS = new Set(['authorization', 'dpop']);

/**
 * HTTP statuses that MUST NOT carry a body (the Fetch spec "null body status" set).
 * `new Response(body, { status })` throws for these unless `body` is null — and Solid
 * write/delete operations commonly return `204 No Content`.
 */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Whether an EXPLICIT request `Content-Type` is text-safe to carry over the (text-only)
 * protocol. NOTE the asymmetry vs. {@link isBinaryRequestBody}, which is intentional:
 *
 *   - A PRESENT content-type is authoritative. `multipart/*` and any non-text/non-json/
 *     non-urlencoded type returns `false` → the body is REJECTED (never silently
 *     `.text()`-coerced, which would corrupt a binary resource write).
 *   - A MISSING content-type (`null`) returns `true` here — preserving the common Solid
 *     RDF (Turtle) write case where a body may arrive without a declared type — BUT the
 *     ambiguous missing-CT path is NOT trusted blindly: the proxy ALSO runs
 *     {@link isBinaryRequestBody} over the actual bytes for a missing-CT Request body, so
 *     a genuinely binary payload with no content-type still fails loudly. See
 *     `#proxyFetch` for the combined policy.
 */
function isTextContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  const ct = contentType.split(';', 1)[0].trim().toLowerCase();
  if (ct.startsWith('multipart/')) return false;
  return (
    ct.startsWith('text/') ||
    ct === 'application/json' ||
    ct.endsWith('+json') ||
    ct.endsWith('+xml') ||
    ct === 'application/xml' ||
    ct === 'application/x-www-form-urlencoded' ||
    ct === 'application/sparql-update' ||
    ct === 'application/sparql-query' ||
    ct === 'application/ld+json' ||
    ct === 'application/trig' ||
    ct === 'application/n-quads' ||
    ct === 'application/n-triples'
  );
}

/**
 * Detect a genuinely BINARY request body by inspecting the raw bytes — the guard for the
 * AMBIGUOUS "missing Content-Type" path, where the declared type can't tell us whether
 * the source was a string or a binary blob.
 *
 * Why bytes, not the body-source object: a `Request` exposes its body only as an opaque
 * `ReadableStream`, so we cannot recover whether it was constructed from a string vs a
 * Blob/ArrayBuffer/typed-array. We CAN, however, decode the bytes as strict UTF-8 and see
 * whether they round-trip losslessly: a `TextDecoder('utf-8', { fatal: true })` THROWS on
 * any byte sequence that is not valid UTF-8 (PNG/gzip/most binary). Valid-UTF-8 text — the
 * Solid Turtle/RDF write case — decodes cleanly and is treated as text. (The Request
 * constructor itself auto-sets `text/plain` for a string body, so a missing CT already
 * signals a non-string source; this bytes check is the belt-and-braces confirmation that
 * still admits the legitimate untyped-text case.)
 *
 * Returns `true` ⇒ reject as unsupported binary; `false` ⇒ safe to carry as text.
 */
function isBinaryRequestBody(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false; // valid UTF-8 → safe to send as text
  } catch {
    return true; // invalid UTF-8 → genuinely binary, must not be text-coerced
  }
}

/** Promise-wrap the callback form of `chrome.runtime.sendMessage`. */
function send<T>(message: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message ?? 'Message channel error'));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Map the SW's credential-free recent-account record onto the panel's
 * {@link RecentLoginAccount}. Only the three KNOWN display fields are copied — a
 * (hypothetical / hostile) extra field on the reply is never surfaced.
 */
function toRecentLoginAccount(account: {
  webId: string;
  name: string | null;
  photoUrl: string | null;
}): RecentLoginAccount {
  return {
    webId: account.webId,
    displayName: account.name ?? account.webId,
    avatarUrl: account.photoUrl ?? undefined,
  };
}

export class MessageBridgeLoginController implements LoginController {
  /** Token-free mirror: the active WebID, or null. Populated from `SessionState`. */
  #webId: string | null = null;

  /** Token-free mirror: recent accounts for the returning-user affordance. */
  #recentAccounts: RecentLoginAccount[] = [];

  /**
   * The pristine native fetch — provably credential-free (see {@link MODULE_PRISTINE_FETCH}).
   * Foreign-origin / public reads run uncredentialed in the popup realm.
   */
  get publicFetch(): typeof fetch {
    return MODULE_PRISTINE_FETCH;
  }

  /**
   * The session-bound fetch. BEFORE login (no WebID in the mirror) this is the pristine
   * native fetch — matching the LoginController contract that pre-login `authenticatedFetch`
   * behaves like {@link publicFetch} (there is no session to bind), so a panel `.fetch`
   * consumer is not broken before a session exists. AFTER login it is a PROXY closure:
   * each call forwards a `SOLID_FETCH_REQUEST` to the SW (which attaches the DPoP-bound
   * token) and reconstructs a `Response` from the returned `FetchResponse`. The popup
   * never holds the token, the DPoP key, or a session-bound fetch handle — only the
   * forwarding closure.
   */
  get authenticatedFetch(): typeof fetch {
    if (this.#webId === null) return MODULE_PRISTINE_FETCH;
    return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      this.#proxyFetch(input, init);
  }

  /** The active WebID, read synchronously from the mirror (no await). */
  get webId(): string | null {
    return this.#webId;
  }

  /** Recent accounts, read synchronously from the mirror. */
  recentAccounts(): RecentLoginAccount[] {
    return this.#recentAccounts;
  }

  /**
   * Silent restore on load: ask the SW whether a session already exists
   * (`SOLID_GET_STATE`). This is the correct MV3 expression of silent restore — the
   * durable refresh token lives in the SW/chrome.storage, never the popup; the SW
   * re-hydrates (and refreshes) its session, and we just ask whether one is active.
   * Fail-closed: ANY send/shape error resolves to `{ outcome: 'login' }` (never throws).
   */
  async restore(): Promise<RestoreOutcome> {
    try {
      const state = await this.#getState();
      if (state.isActive && state.webId) {
        return { outcome: 'restored', webId: state.webId };
      }
      return { outcome: 'login' };
    } catch {
      return { outcome: 'login' };
    }
  }

  /**
   * Run the interactive login for `webId` (or, when omitted, a re-login of the single
   * recent account). The SW runs the full chrome.identity OIDC/PKCE/DPoP flow. On
   * `ok` we update the mirror and resolve with the WebID; on `error` we REJECT and do
   * NOT mutate the mirror (the panel surfaces the message).
   */
  async login(webId?: string): Promise<LoginResult> {
    const target = webId ?? this.#defaultLoginWebId();
    if (!target) {
      throw new Error('No WebID provided and no recent account to re-login.');
    }
    const request: LoginRequest = { type: 'SOLID_LOGIN', webId: target };
    const result = await send<ActionResult>(request);
    if (result?.error) {
      throw new Error(result.error);
    }
    if (!result?.ok || !result.webId) {
      throw new Error('Login failed.');
    }
    this.#webId = result.webId;
    return { webId: result.webId };
  }

  /**
   * Log out via the SW. Clear `#webId` ONLY on an `ok` result; on `error` reject AND
   * leave `#webId` intact so the panel's reconcile-against-`controller.webId` keeps the
   * signed-in UI and surfaces the error (rather than falsely showing a logged-out
   * prompt while the SW still holds a session).
   */
  async logout(): Promise<void> {
    const request: LogoutRequest = { type: 'SOLID_LOGOUT' };
    const result = await send<ActionResult>(request);
    if (result?.error) {
      throw new Error(result.error);
    }
    if (!result?.ok) {
      throw new Error('Logout failed.');
    }
    this.#webId = null;
  }

  /**
   * Re-read `SOLID_GET_STATE` and refresh the mirror. The popup calls this on a
   * `SOLID_STATE_CHANGED` broadcast (an external context changed the session) so the
   * sync getters reflect reality on the next panel render. Fail-soft: a send error
   * leaves the mirror unchanged (the next broadcast/restore self-corrects).
   */
  async hydrate(): Promise<void> {
    try {
      await this.#getState();
    } catch {
      // Leave the mirror as-is; SOLID_STATE_CHANGED / restore will retry.
    }
  }

  /**
   * Fetch state from the SW and refresh the token-free mirror; returns the state.
   * Maps the WHOLE response into locals FIRST (so a malformed shape throws before any
   * field is written) and only then assigns `#webId` + `#recentAccounts` together —
   * keeping restore()/hydrate() genuinely fail-closed (a throw never leaves the mirror
   * half-updated with a non-null webId).
   */
  async #getState(): Promise<SessionState> {
    const request: GetStateRequest = { type: 'SOLID_GET_STATE' };
    const state = await send<SessionState>(request);
    const webId = state.isActive && state.webId ? state.webId : null;
    const recentAccounts = (state.recentAccounts ?? []).map(toRecentLoginAccount);
    // Atomic commit — only reached if the mapping above did not throw.
    this.#webId = webId;
    this.#recentAccounts = recentAccounts;
    return state;
  }

  /** The webId to use when `login()` is called without one: the single/first recent account. */
  #defaultLoginWebId(): string | null {
    return this.#recentAccounts[0]?.webId ?? null;
  }

  /**
   * The authenticatedFetch proxy: forward to the SW, rebuild a Response from the reply.
   * Normalises `RequestInfo | URL` the way `fetch` does — a `Request` contributes its
   * url/method/headers/body, and an explicit `init` overrides — rather than coercing the
   * input to a string (which would send `"[object Request]"` and drop method/headers/body).
   * Text-only bodies today (binary is a documented future protocol extension).
   */
  async #proxyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const url = isRequest ? input.url : input.toString();
    const method = init?.method ?? (isRequest ? input.method : 'GET');

    // Headers: a Request's headers first, then init overrides win (fetch semantics).
    const headers = new Headers(isRequest ? input.headers : undefined);
    if (init?.headers) {
      for (const [k, v] of new Headers(init.headers).entries()) headers.set(k, v);
    }
    // Strip any caller-supplied credential headers — the worker attaches its own.
    for (const h of STRIPPED_REQUEST_HEADERS) headers.delete(h);

    // Body: init.body wins; otherwise a Request's body. The protocol is text-only today
    // (binary is a documented future extension), so reject NON-text bodies LOUDLY rather
    // than silently text-coercing a binary payload (which would corrupt the write). The
    // policy (see isTextContentType / isBinaryRequestBody):
    //   • init.body — a non-string value is binary by construction → reject; a string is text.
    //   • a Request body with an EXPLICIT non-text Content-Type (multipart/image/…) → reject.
    //   • a Request body with a missing/ambiguous Content-Type — preserve the common Solid
    //     RDF (Turtle) untyped-text write, BUT confirm against the raw BYTES: valid UTF-8 is
    //     sent as text, non-UTF-8 (genuinely binary) is rejected, not corrupted.
    let body: string | null = null;
    if (init?.body != null) {
      if (typeof init.body !== 'string') {
        throw new Error('authenticatedFetch currently supports only string request bodies.');
      }
      body = init.body;
    } else if (isRequest && input.body) {
      // Normalize an EMPTY / whitespace-only Content-Type to "missing" (null) so it takes
      // the same ambiguous-but-byte-verified path as a no-Content-Type body — an empty
      // header must not be trusted as text-safe and bypass the binary guard (roborev 3495).
      const rawContentType = input.headers.get('content-type');
      const contentType = rawContentType && rawContentType.trim() !== '' ? rawContentType : null;
      if (!isTextContentType(contentType)) {
        throw new Error('authenticatedFetch currently supports only text request bodies.');
      }
      // Read the bytes once. For an explicitly text-typed body we trust the type and decode;
      // for the ambiguous MISSING/empty content-type we additionally verify the bytes are valid
      // UTF-8 text — a binary payload with no usable content-type must fail loudly, not be coerced.
      const bytes = new Uint8Array(await input.clone().arrayBuffer());
      if (contentType === null && isBinaryRequestBody(bytes)) {
        throw new Error(
          'authenticatedFetch currently supports only text request bodies (binary body with no Content-Type).',
        );
      }
      body = new TextDecoder().decode(bytes);
    }

    const requestId = crypto.randomUUID();
    const reply = await send<FetchResponse>({
      type: 'SOLID_FETCH_REQUEST',
      requestId,
      url,
      method,
      headers: Object.fromEntries(headers.entries()),
      body,
    });
    if (reply?.error) {
      throw new Error(reply.error);
    }
    // Null-body statuses (the Fetch spec set) MUST be constructed with a null body —
    // `new Response('', { status: 204 })` throws. The SW serialises an empty body as ''
    // for these, so coerce to null. Solid writes/deletes commonly return 204 No Content.
    const status = reply.status ?? 200;
    const nullBody = NULL_BODY_STATUSES.has(status);
    return new Response(nullBody ? null : (reply.body ?? null), {
      status,
      statusText: reply.statusText,
      headers: new Headers(reply.headers ?? {}),
    });
  }
}
