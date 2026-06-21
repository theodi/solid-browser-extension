// AUTHORED-BY Claude Opus 4.8
/**
 * The per-REQUESTING-origin access gate — the browser-side credential boundary that decides
 * WHICH page (app) origin is allowed to drive `window.solid.fetch`, before any pod egress
 * OR any cache hit is served.
 *
 * This is distinct from `origin-policy.ts`, which gates the TARGET pod ("don't send the
 * token to evil.com"). THIS module gates the REQUESTER ("is the app at https://a.example
 * allowed to read/write this pod at all?"). Both run on every fetch; this one runs FIRST.
 *
 * THREAT MODEL (design §4.3 "Forge the access-control anchor"):
 *   - `sender.origin` is the browser-ATTESTED origin of the content script that relayed the
 *     message. It is set by Chrome, not the page, so it cannot be forged from page JS.
 *   - The content script ALSO stamps `window.location.origin` (the page-supplied value).
 *     A compromised renderer could lie about this, so it is NEVER trusted alone.
 *   - Therefore we require BOTH anchors to AGREE and use the browser-attested value as the
 *     authority. A forged stamp only ever DENIES (mismatch) — it can never widen access.
 *
 * FAIL-CLOSED everywhere:
 *   - An opaque / `null` / missing origin (sandboxed `srcdoc` iframe, `about:blank`,
 *     `data:`, `file:`, `javascript:`) → DENY. We never bucket these into a shared "null"
 *     grant. (A `blob:` URL is NOT opaque — it inherits its creator's real origin, which the
 *     browser fixes and a page cannot forge across origins, so it resolves normally.)
 *   - A `sender` with no `origin` but a usable `url` → we derive the origin from the URL and
 *     STILL require it to match the stamp; an underivable origin → DENY.
 *   - Default-deny: an origin that is not in the granted set → DENY, without touching the
 *     pod or the cache.
 */

/** Parse a string to its URL `origin`, or `null` if it is not a usable URL. */
function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const o = new URL(value).origin;
    // An opaque origin parses to the literal string "null" (`about:blank`, `data:`, `file:`,
    // `javascript:`); a sandboxed `srcdoc` frame reports "null" too (which then throws here).
    // Treat the opaque sentinel as no-origin (fail-closed), never a shared bucket.
    if (o === 'null' || o === '') return null;
    return o;
  } catch {
    return null;
  }
}

/**
 * The browser-attested sender identity, as Chrome populates it on a `chrome.runtime`
 * message. `origin` is present for content-script senders on a real http(s) page; `url` is
 * the document URL. Both can be absent for an opaque context. We treat this object as the
 * SOLE authority for the requesting origin.
 */
export interface MessageSender {
  readonly origin?: string;
  readonly url?: string;
}

/**
 * Resolve the TRUE requesting origin from the browser-attested `sender` and the
 * page-supplied stamp, requiring them to AGREE. Returns the canonical origin string when
 * both agree on a usable (non-opaque) origin, else `null` (DENY).
 *
 * Authority order:
 *   1. The browser-attested origin is `sender.origin`, falling back to the origin OF
 *      `sender.url` (Chrome omits `origin` for some sender types but always has `url`).
 *      This value is set by the browser and cannot be forged by page JS.
 *   2. The page-supplied `stampedOrigin` is the value the content script read from
 *      `window.location.origin` and forwarded. It is advisory only.
 *   3. BOTH must resolve to the SAME non-opaque origin. Any mismatch, or either being
 *      opaque/absent, → `null`.
 *
 * PURE so the boundary is exhaustively unit-tested.
 */
export function resolveRequestingOrigin(
  sender: MessageSender | null | undefined,
  stampedOrigin: string | null | undefined,
): string | null {
  // Browser-attested origin: prefer sender.origin, else derive from sender.url.
  const attested = originOf(sender?.origin) ?? originOf(sender?.url);
  if (attested === null) return null; // opaque / missing attested origin → DENY.

  // The page-supplied stamp must be present and parse to a usable origin.
  const stamped = originOf(stampedOrigin);
  if (stamped === null) return null; // missing / opaque stamp → DENY.

  // Dual-origin agreement: the page-supplied value must match the browser truth EXACTLY.
  if (attested !== stamped) return null;

  return attested;
}

/**
 * The default-deny per-requesting-origin gate. `granted` is the set of app origins the user
 * has authorised to drive the extension. An origin not in the set is DENIED — no pod egress,
 * no cache read. PURE; fail-closed on a `null` requesting origin or an empty granted set.
 */
export function isRequestingOriginGranted(
  granted: ReadonlySet<string>,
  requestingOrigin: string | null,
): boolean {
  if (requestingOrigin === null) return false; // opaque/unresolved → DENY.
  return granted.has(requestingOrigin);
}

export interface GrantedOriginInputs {
  /** App origins the owner explicitly granted (login / setClientId / consent). */
  readonly explicitGrants?: readonly string[];
  /** The active session's credential origins (WebID/issuer/pod) — apps served from the */
  /** pod itself are owner-trusted requesters and need no separate grant. */
  readonly credentialOrigins?: ReadonlySet<string>;
}

/**
 * The full set of REQUESTING origins permitted to drive the extension, for the single-user
 * owner model: the explicit per-origin grants ∪ the session's credential (pod/WebID/issuer)
 * origins. Opaque / non-http(s) candidates are dropped (fail-closed). PURE.
 *
 * An empty result (no session, no grants) means default-deny for EVERY origin.
 */
export function computeGrantedOrigins(inputs: GrantedOriginInputs): ReadonlySet<string> {
  const granted = new Set<string>();
  for (const o of inputs.credentialOrigins ?? []) {
    const c = originOf(o);
    if (c) granted.add(c);
  }
  for (const g of inputs.explicitGrants ?? []) {
    const c = originOf(g);
    if (c) granted.add(c);
  }
  return granted;
}

/**
 * The same-origin-or-deny foreign-fetch policy (design §4.3 "Foreign-origin fetch ambient
 * cookies"). A request whose TARGET is NOT one of the session's pod/credential origins (a
 * "foreign" fetch — `window.solid.fetch('https://tracker/')`) is only permitted when its
 * target origin equals the REQUESTING app's own origin. This stops the extension being used
 * as a CSP-free, ambient-cookie-carrying proxy to arbitrary third parties: an app may reach
 * its OWN origin through the proxy, but not weaponise it against unrelated hosts.
 *
 * A request to a credential (pod) origin is NOT foreign and is governed by the per-origin
 * grant + the target-origin credential gate instead; this helper only decides foreign ones.
 *
 * PURE; fail-closed: an unresolved requesting/target origin → DENY.
 */
export function isForeignFetchAllowed(requestingOrigin: string | null, targetUrl: string): boolean {
  if (requestingOrigin === null) return false;
  const target = originOf(targetUrl);
  if (target === null) return false;
  return target === requestingOrigin;
}

/** Why a request was denied (for an actionable error + auditability). `null` reason = allow. */
export type DenyReason =
  | 'forbidden-origin' // dual-origin disagreement / opaque / missing
  | 'origin-not-granted' // default-deny: the app origin holds no grant
  | 'cross-origin-foreign'; // a foreign-target fetch that isn't same-origin

export interface GateDecision {
  /** The resolved, verified requesting origin when allowed; `null` when denied. */
  readonly requestingOrigin: string | null;
  /** `null` ⇒ ALLOW; otherwise the deny reason. */
  readonly deny: DenyReason | null;
}

export interface GateInputs {
  /** App origins the owner explicitly granted. */
  readonly explicitGrants?: readonly string[];
  /** The active session's credential (pod/WebID/issuer) origins. */
  readonly credentialOrigins?: ReadonlySet<string>;
}

/**
 * The COMPLETE per-requesting-origin gate decision, as ONE pure function so the whole
 * boundary is exhaustively unit-testable in isolation from `chrome.*`. Runs the three checks
 * in fail-closed order:
 *
 *   1. Dual-origin agreement (browser-attested sender ∧ page stamp) — forged/opaque → DENY.
 *   2. Default-deny per-origin grant (explicit grants ∪ session credential origins).
 *   3. Same-origin-or-deny for a foreign (non-credential) target.
 *
 * The service worker calls this BEFORE any cache read or pod egress, on every fetch (and, in
 * a later phase, on every cache hit), passing the storage-loaded grant inputs.
 */
export function decideRequestingOrigin(
  sender: MessageSender | null | undefined,
  stampedOrigin: string | null | undefined,
  requestUrl: string,
  inputs: GateInputs,
): GateDecision {
  const requestingOrigin = resolveRequestingOrigin(sender, stampedOrigin);
  if (requestingOrigin === null) return { requestingOrigin: null, deny: 'forbidden-origin' };

  const granted = computeGrantedOrigins({
    explicitGrants: inputs.explicitGrants,
    credentialOrigins: inputs.credentialOrigins,
  });
  if (!isRequestingOriginGranted(granted, requestingOrigin)) {
    return { requestingOrigin: null, deny: 'origin-not-granted' };
  }

  // A credential (pod) target is governed by the target-origin credential gate downstream;
  // only a NON-credential ("foreign") target is subject to same-origin-or-deny here.
  const targetIsCredential = isOriginAllowedSet(inputs.credentialOrigins, requestUrl);
  if (!targetIsCredential && !isForeignFetchAllowed(requestingOrigin, requestUrl)) {
    return { requestingOrigin: null, deny: 'cross-origin-foreign' };
  }

  return { requestingOrigin, deny: null };
}

/** Whether a request URL's origin is in a set (fail-closed on a missing set / bad URL). */
function isOriginAllowedSet(allowed: ReadonlySet<string> | undefined, requestUrl: string): boolean {
  if (!allowed) return false;
  const o = originOf(requestUrl);
  return o !== null && allowed.has(o);
}
