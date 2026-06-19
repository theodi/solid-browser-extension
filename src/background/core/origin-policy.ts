// AUTHORED-BY Claude Opus 4.8
/**
 * The per-origin credential boundary — the security heart of a browser-level Solid
 * auth proxy.
 *
 * The extension injects `window.solid.fetch` into EVERY page and proxies the call
 * through the service worker, attaching the user's DPoP-bound access token. Without a
 * boundary, a malicious page could call `solid.fetch("https://evil.example/collect")`
 * and the extension would hand `evil.example` the user's pod token. That must be
 * impossible. This module is the **fail-closed** gate, mirroring the boundary in
 * `@jeswr/solid-elements`'s proactive-fetch (`computeAllowedOrigins`/`isOriginAllowed`):
 *
 *   - The token is attached ONLY to an HTTPS origin in the allowed set.
 *   - The allowed set is the WebID's own origin ∪ the issuer's origin ∪ any explicit
 *     pod origins the user configured (a pod on a different host than the WebID is a
 *     valid Solid topology and must be listed).
 *   - CLEARTEXT GUARD: a non-`https:` origin is DROPPED, so a token never rides over
 *     plaintext — EXCEPT a loopback `http:` origin when `allowInsecureLoopback` is set
 *     (local dev CSS only).
 *   - Fail-closed everywhere: an unparseable URL is never allowed; an empty allowed set
 *     means the token is attached to NOTHING.
 *
 * Two further invariants enforced by the caller (the authenticated-fetch path), pinned
 * here as pure helpers: the token is NEVER attached to the issuer's TOKEN endpoint via
 * the resource path ({@link isTokenEndpoint}), and the proxy is re-entrancy guarded so a
 * DPoP/discovery fetch the SW itself makes can never recurse into the authenticated path.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Whether a host is a loopback host (the only place `http:` is tolerated, in dev). */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** Parse a string to its URL `origin`, or `null` if it is not a usable URL. */
function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Whether an origin is permitted to carry the token given the transport policy.
 * `https:` always; `http:` only for a loopback host AND only when dev loopback is
 * allowed. Everything else (ws:, file:, http: on a real host) is rejected.
 */
function transportAllowed(origin: string, allowInsecureLoopback: boolean): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') {
    return allowInsecureLoopback && isLoopbackHost(url.hostname);
  }
  return false;
}

export interface AllowedOriginsInputs {
  /** The authenticated WebID (its origin is included unless disabled). */
  readonly webId?: string | null;
  /** The issuer URL (its origin is included unless disabled). */
  readonly issuer?: string | null;
  /** Explicit pod origins (any URL; compared by `origin`). */
  readonly podOrigins?: readonly string[];
  /** Include the WebID's origin. Default true. */
  readonly includeWebIdOrigin?: boolean;
  /** Include the issuer's origin. Default true. */
  readonly includeIssuerOrigin?: boolean;
  /** Allow `http:` for loopback hosts only (dev). Default false. */
  readonly allowInsecureLoopback?: boolean;
}

/**
 * The set of resource origins the session token may be attached to. PURE so the boundary
 * is unit-tested. Applies the cleartext guard to every candidate; an empty result means
 * the token is attached to NOTHING (strictly fail-closed).
 */
export function computeAllowedOrigins(inputs: AllowedOriginsInputs): ReadonlySet<string> {
  const {
    webId,
    issuer,
    podOrigins = [],
    includeWebIdOrigin = true,
    includeIssuerOrigin = true,
    allowInsecureLoopback = false,
  } = inputs;

  const candidates: string[] = [];
  if (includeWebIdOrigin && webId) {
    const o = originOf(webId);
    if (o) candidates.push(o);
  }
  if (includeIssuerOrigin && issuer) {
    const o = originOf(issuer);
    if (o) candidates.push(o);
  }
  for (const pod of podOrigins) {
    const o = originOf(pod);
    if (o) candidates.push(o);
  }

  const allowed = new Set<string>();
  for (const origin of candidates) {
    if (transportAllowed(origin, allowInsecureLoopback)) {
      allowed.add(origin);
    }
  }
  return allowed;
}

/**
 * Whether a request URL targets an allowed origin (the per-request credential gate).
 * PURE. Fail-closed: an unparseable URL, or an empty allowed set, is never allowed.
 */
export function isOriginAllowed(allowed: ReadonlySet<string>, requestUrl: string): boolean {
  const origin = originOf(requestUrl);
  if (origin === null) return false;
  return allowed.has(origin);
}

/**
 * Whether a string is an acceptable Solid-OIDC Client Identifier Document URL: it must
 * parse as a URL and be `https:`, OR `http:` only for a loopback host (dev). A remote
 * plaintext client-id document could be tampered with in transit, so cleartext is rejected
 * for real hosts. PURE; used to validate both a page-declared client-id (setClientId / the
 * login message) before it is trusted.
 */
export function isValidClientIdUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return isLoopbackHost(url.hostname);
  return false;
}

/**
 * Whether a request URL is the issuer's TOKEN endpoint. The user's access token must
 * NEVER be attached to the token endpoint via the resource-fetch path (it would leak the
 * resource token into a token-management request and could enable a confused-deputy
 * exchange). Compared by full canonical URL (scheme+host+port+path), query/fragment
 * ignored. PURE.
 */
export function isTokenEndpoint(requestUrl: string, tokenEndpoint: string | null): boolean {
  if (!tokenEndpoint) return false;
  let req: URL;
  let tok: URL;
  try {
    req = new URL(requestUrl);
    tok = new URL(tokenEndpoint);
  } catch {
    return false;
  }
  return req.origin === tok.origin && req.pathname === tok.pathname;
}
