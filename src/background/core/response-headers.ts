// AUTHORED-BY Claude Opus 4.8
/**
 * Response-header allowlist (defense-in-depth) for the proxied `window.solid.fetch`.
 *
 * The service worker performs the authenticated fetch and relays the server's Response
 * back to the page (worker -> content -> page). It is NOT a credential leak to forward
 * response headers — the access token is a REQUEST header, and `Set-Cookie` is on the
 * Forbidden-Response-Header list so it can never be read off the page-side `Response`
 * anyway. But forwarding EVERY server response header is needlessly broad: it hands the
 * page whatever the origin chose to emit (server fingerprints, internal infra headers,
 * future auth/state headers we have not vetted). So we tighten the relay to an ALLOWLIST
 * of the response headers a Solid app legitimately consumes, and drop the rest.
 *
 * The allowlist is the conservative Solid/LDP + standard HTTP read surface: content
 * metadata, validators (ETag / Last-Modified) for conditional writes, the LDP/Solid `Link`
 * relations, the `Accept-*` advertisement headers, WAC-Allow, the auth challenge, Range
 * support, and the Solid-notifications discovery header. Anything not on the list is
 * stripped before the Response is reconstructed page-side.
 */

/**
 * Response headers a Solid app legitimately needs to read. Lower-case (HTTP header names
 * are case-insensitive; we normalise before the membership test). Keep this list tight —
 * add a header only when an app genuinely needs to consume it.
 */
export const ALLOWED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  // Content metadata
  'content-type',
  'content-length',
  'content-language',
  'content-encoding',
  'content-disposition',
  // Validators (needed for conditional writes: If-Match / If-None-Match round-trips)
  'etag',
  'last-modified',
  // Range support
  'accept-ranges',
  'content-range',
  // LDP / Solid relations + capability advertisement
  'link',
  'allow',
  'accept-patch',
  'accept-post',
  'accept-put',
  // LDP `Prefer` round-trip: tells the client which representation preference was honored
  // (e.g. container `return=representation` / omit-minimal — LDP §7.2, Solid Protocol)
  'preference-applied',
  // Web Access Control: the effective access modes for the resource
  'wac-allow',
  // Auth challenge (so the app can react to a 401 / re-auth)
  'www-authenticate',
  // Redirect target
  'location',
  // Solid Notifications: the subscription/discovery endpoint advertisement
  'updates-via',
  // Standard caching / freshness metadata
  'cache-control',
  'expires',
  'age',
  'vary',
  'date',
]);

/**
 * Filter a server Response's headers down to the {@link ALLOWED_RESPONSE_HEADERS} allowlist,
 * returning a plain `Record` (the wire shape the page<->worker message protocol uses).
 * Header-name matching is case-insensitive; the returned keys preserve the server's casing.
 */
export function filterResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (ALLOWED_RESPONSE_HEADERS.has(key.toLowerCase())) out[key] = value;
  });
  return out;
}
