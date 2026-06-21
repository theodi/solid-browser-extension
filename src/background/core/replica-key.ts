// AUTHORED-BY Claude Opus 4.8
/**
 * The SHARED-REPLICA cache key — the SECURITY-CRITICAL identity dimension of the
 * extension-owned offline replica (design §2.1 "LOAD-BEARING CACHE-KEY FIX").
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SECURITY BOUNDARY HERE (and is NOT in `@jeswr/solid-offline`):
 *
 * `@jeswr/solid-offline` (`scope.ts`) keys its byte/metadata stores on a hash of the
 * WebID, but states VERBATIM that the hash is "only a *namespacing discriminator*, NOT a
 * security boundary: the real boundary is the browser's origin isolation." That holds in a
 * normal web page, where each top-level site gets its OWN partitioned Cache/IndexedDB. It
 * does NOT hold in the extension: the `chrome-extension://<id>` origin is a SINGLE shared
 * partition (design §1) — there is no origin boundary underneath. ONE physical store holds
 * EVERY app's, EVERY user's bytes.
 *
 * Therefore in the extension the cache key MUST itself be the boundary:
 *   - it embeds the active WebID, so a same-URL+same-ETag collision across two users on one
 *     device (a shared/public resource, or a re-provisioned WebID) can NEVER serve user A's
 *     bytes to user B (design §2.1);
 *   - it embeds the GRANT-SCOPE (the requesting app's verified, granted origin), so a body
 *     landed in the shared replica by one granted origin lives in that origin's partition —
 *     a missing grant cannot even REACH a shared body (design §5.4 point 3: "Partition the
 *     cache by grant-scope so a missing grant cannot even reach a shared body").
 *
 * Single-user owner-only default (this Phase): there is ONE user, and the grant-scope is the
 * verified requesting origin from the Phase-0 gate. The shared replica's value here is the
 * SINGLE physical store (one byte store reachable from one place, no N-per-app duplication,
 * one revalidation pipeline) keyed by the WebID+url+varyKey dimension, with the grant-scope
 * PARTITIONING access. (Per-data-class grant scoping that lets several apps share one
 * grant-scope is Phase 2; here grant-scope === the requesting origin.)
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The byte cache (Cache API) and the metadata store (IndexedDB) are keyed TOGETHER on a
 * single synthetic, collision-free Request whose URL encodes the FULL
 * `(webId, grantScope, resourceUrl, varyKey)` composite — the same synthetic-key discipline
 * `@jeswr/solid-offline` `cache-policy.ts#keyRequest` uses (one canonical key, no
 * header-driven `Vary` divergence), EXTENDED with the two security dimensions above.
 *
 * PURE: no `caches` / `indexedDB` / `fetch` / SW globals, so the whole key derivation is
 * exhaustively unit-testable.
 */

/** Canonical Accept used to normalise RDF reads to a single cache variant (per solid-offline). */
export const CANONICAL_RDF_ACCEPT = 'text/turtle';

/** A fresh sentinel origin for the synthetic key — nothing the server sees can collide with it. */
export const REPLICA_KEY_ORIGIN = 'https://solid-extension-replica.invalid/';

/** RDF media types collapsed to {@link CANONICAL_RDF_ACCEPT} so all RDF variants share one entry. */
const RDF_ACCEPT_HINTS = [
  'text/turtle',
  'application/ld+json',
  'application/n-triples',
  'application/n-quads',
  'application/trig',
  'application/rdf+xml',
];

/**
 * Compute the canonical Accept header for keying + revalidation. An RDF (or `* /*`) Accept
 * collapses to `text/turtle` so JSON-LD and Turtle reads of the same resource share ONE byte
 * copy (the de-duplication the shared replica exists to deliver); a non-RDF Accept (image,
 * html) keys on what was actually requested. Mirrors solid-offline `cache-policy.ts`.
 */
export function canonicalAccept(accept: string | null | undefined): string {
  if (!accept) return CANONICAL_RDF_ACCEPT;
  const lower = accept.toLowerCase();
  if (lower.includes('*/*')) return CANONICAL_RDF_ACCEPT;
  if (RDF_ACCEPT_HINTS.some((t) => lower.includes(t))) return CANONICAL_RDF_ACCEPT;
  return accept.split(',')[0]?.trim() ?? CANONICAL_RDF_ACCEPT;
}

/**
 * The variant discriminator for a read. The shared replica normalises every read to the
 * canonical Accept (Phase 1 caches RDF + opaque bytes by request Accept); a richer
 * `Vary`-driven key is a later refinement. Deliberately SMALL + deterministic.
 */
export function computeVaryKey(accept: string | null | undefined): string {
  return `accept=${canonicalAccept(accept)}`;
}

/**
 * The identity tuple that scopes a replica entry. BOTH fields are part of the security
 * boundary (see the module note): `webId` prevents cross-USER leakage; `grantScope` (the
 * verified, granted requesting origin) prevents a non-granted origin reaching a shared body.
 */
export interface ReplicaScope {
  /** The active session's WebID. `null` ⇒ no session ⇒ no replica entry may be keyed. */
  readonly webId: string | null;
  /** The verified+granted requesting origin (Phase-0 gate output). `null` ⇒ DENY. */
  readonly grantScope: string | null;
}

/**
 * The delimiter joining the key's four components: a NUL byte (`U+0000`). A NUL can NEVER
 * appear in a WebID / origin / http(s) URL / the canonical-Accept varyKey (all are printable
 * once the URL parser has normalised them), so the join is UNAMBIGUOUS and INJECTIVE across
 * the whole tuple — no value can bleed from one component into another to forge a colliding
 * key, even for an adversary who can influence a component's contents. This is STRICTLY
 * STRONGER than the `${url} ${varyKey}` space join `@jeswr/solid-offline` uses (which is safe
 * only because its inputs never contain a raw space); here the key IS a security boundary, so
 * we pick a separator that is impossible in any input.
 */
const KEY_DELIMITER = '\u0000';

/**
 * The composite primary key string for the metadata store: the four security+coherence
 * dimensions, space-delimited. Distinct tuples ALWAYS produce distinct keys (injective — see
 * {@link KEY_DELIMITER}).
 *
 * Returns `null` (un-keyable ⇒ the caller must NOT cache) when either security dimension is
 * absent — fail-closed: an entry can never be written/read without a WebID AND a grant-scope.
 */
export function computeReplicaKey(
  scope: ReplicaScope,
  resourceUrl: string,
  varyKey: string,
): string | null {
  if (scope.webId === null || scope.grantScope === null) return null;
  return [scope.webId, scope.grantScope, resourceUrl, varyKey].join(KEY_DELIMITER);
}

/**
 * The CANONICAL synthetic Cache-API key Request for a replica entry. The full composite key
 * (which embeds WebID + grant-scope) is percent-encoded into ONE opaque path segment on a
 * sentinel origin — injective, and nothing the server ever returns can collide with it. The
 * byte cache and the metadata store are thus keyed 1:1 on the SAME security-scoped identity.
 *
 * Returns `null` when the entry is un-keyable (no WebID / no grant-scope) — fail-closed.
 */
export function replicaKeyRequest(
  scope: ReplicaScope,
  resourceUrl: string,
  varyKey: string,
): Request | null {
  const key = computeReplicaKey(scope, resourceUrl, varyKey);
  if (key === null) return null;
  return new Request(`${REPLICA_KEY_ORIGIN}${encodeURIComponent(key)}`, { method: 'GET' });
}
