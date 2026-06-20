// AUTHORED-BY Claude Opus 4.8
/**
 * The extension's own published Solid-OIDC Client Identifier Document.
 *
 * Logging in with a STABLE, published Client ID Document (instead of throwaway dynamic
 * client registration) makes the IdP consent screen show a stable name + the
 * `token_endpoint_auth_method: "none"` public-client behaviour, and lets the pod recognise
 * the app across logins. The document is a dereferenceable HTTPS URL; the IdP fetches it
 * during the authorization request and reads `redirect_uris`, `client_name`, etc.
 *
 * The static document lives at `public/clientid.jsonld` (committed; copied into the build
 * by webpack). {@link CLIENT_ID_DOCUMENT} below is its canonical in-code mirror — the test
 * suite asserts the two agree, so the shipped JSON can never silently drift from the shape
 * the spec + this flow require.
 *
 *   ┌──────────────────────────────────────────────────────────────────────────────────┐
 *   │  needs:user — HOSTING. {@link PUBLISHED_CLIENT_ID_URL} is a PLACEHOLDER. To go      │
 *   │  live the maintainer must:                                                          │
 *   │    1. host `public/clientid.jsonld` at a stable HTTPS URL,                          │
 *   │    2. set its `client_id` member to THAT URL (it must self-reference),              │
 *   │    3. set `redirect_uris` to the packed extension's real callback                   │
 *   │       (`https://<extension-id>.chromiumapp.org/callback` — must equal              │
 *   │       `chrome.identity.getRedirectURL('callback')` in auth-flow.ts), and            │
 *   │    4. replace the `REPLACE-ME...` placeholder URL below with the hosted URL.        │
 *   │  Until then the URL is unreachable, so initiateLogin() falls back to dynamic        │
 *   │  client registration — the extension keeps working with no published client-id.    │
 *   └──────────────────────────────────────────────────────────────────────────────────┘
 */

/**
 * The hosted URL of the extension's Client ID Document. PLACEHOLDER — `REPLACE-ME.example`
 * is deliberately not a real domain (see the needs:user box above). Because it is
 * unreachable as-shipped, the auth flow auto-falls-back to dynamic client registration, so
 * shipping this placeholder does NOT break login. A page may still supply its own client-id.
 *
 * Overridable at runtime via `chrome.storage` (the e2e harness injects a localhost doc).
 */
export const PUBLISHED_CLIENT_ID_URL =
  'https://REPLACE-ME.example/solid-browser-extension/clientid.jsonld';

/** The OIDC context every Solid Client Identifier Document must declare. */
export const SOLID_OIDC_CONTEXT = 'https://www.w3.org/ns/solid/oidc-context.jsonld';

/** The OAuth scope the extension requests (kept in sync with auth-flow.ts SCOPE). */
export const CLIENT_ID_SCOPE = 'openid webid offline_access';

/**
 * The canonical Client Identifier Document shape. Mirrors `public/clientid.jsonld`; the
 * test suite asserts byte-for-byte agreement so the published asset can't drift.
 *
 * NOTE the placeholders: `client_id` must self-reference {@link PUBLISHED_CLIENT_ID_URL},
 * and `redirect_uris[0]` must be the packed extension's real chromiumapp.org callback. Both
 * are needs:user values the maintainer fills in at hosting time.
 */
export const CLIENT_ID_DOCUMENT = {
  '@context': SOLID_OIDC_CONTEXT,
  client_id: PUBLISHED_CLIENT_ID_URL,
  client_name: 'Solid Browser Extension',
  client_uri: 'https://github.com/jeswr/solid-browser-extension',
  logo_uri: 'https://REPLACE-ME.example/solid-browser-extension/icon128.png',
  redirect_uris: ['https://REPLACE-ME-EXTENSION-ID.chromiumapp.org/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  scope: CLIENT_ID_SCOPE,
  token_endpoint_auth_method: 'none',
  application_type: 'web',
} as const;

/**
 * Whether `url` looks like the still-unconfigured placeholder hosted URL (the `REPLACE-ME`
 * sentinel). Used to skip a doomed reachability probe when the maintainer has not yet
 * hosted the document — fall straight through to dynamic registration.
 */
export function isPlaceholderClientId(url: string): boolean {
  return url.includes('REPLACE-ME');
}

/**
 * Is the published Client ID Document actually reachable + well-formed (so the IdP will be
 * able to dereference it)? A HEAD/GET to the URL that resolves 2xx with a JSON-ish body
 * whose `client_id` self-references the URL. ANY failure (placeholder, network error,
 * non-2xx, malformed, mismatched self-reference) returns false → the caller falls back to
 * dynamic client registration. Never throws.
 *
 * `fetchImpl` is injectable for tests; defaults to the global `fetch`.
 */
export async function isPublishedClientIdReachable(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!url || isPlaceholderClientId(url)) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false; // the published doc must be HTTPS.
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/ld+json, application/json' },
    });
    if (!response.ok) return false;
    const doc = (await response.json()) as { client_id?: unknown };
    // Spec: the document's client_id MUST equal the URL it is served from.
    return (
      typeof doc.client_id === 'string' &&
      doc.client_id.replace(/\/$/, '') === url.replace(/\/$/, '')
    );
  } catch {
    return false;
  }
}
