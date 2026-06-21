// AUTHORED-BY Claude Opus 4.8
/**
 * The single, extension-owned SHARED REPLICA (design §2, §5.2).
 *
 * ONE replica per `(WebID, pod-origin)` in the EXTENSION's own storage (NOT partitioned by
 * the visited app's site, unlike a page service worker): bytes → Cache API, metadata →
 * IndexedDB (replica-db.ts). Both are keyed on the SECURITY-SCOPED synthetic key
 * (replica-key.ts) so the cache key itself is the cross-user / cross-grant boundary.
 *
 * Consistency = read-from-cache + ALWAYS-revalidate, never-authoritative
 * stale-while-revalidate (the `@jeswr/solid-offline` `swr.ts` discipline, the PSS "cache is
 * never authoritative" invariant): a cached body is provisional; a conditional
 * `If-None-Match` GET confirms (304) or replaces (200) it. Writes are SYNCHRONOUS
 * WRITE-THROUGH (design §2.3, Phase-1 is write-through NOT optimistic): the pod is written
 * first with `If-Match`, and only a 2xx updates the shared replica from the POD's response.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TWO LOAD-BEARING SECURITY PROPERTIES this module structurally enforces:
 *
 *  (1) GATE-ON-EVERY-READ, INCLUDING A CACHE HIT (design §5.4 point 3). The gate is an
 *      INJECTED predicate that this module calls as the FIRST thing on read AND on write —
 *      there is no code path that returns a cached body without first awaiting `gate()`. A
 *      cache HIT is gated identically to an egress, so a body landed in the shared replica
 *      by one granted origin can never be served to a non-granted origin off a warm cache.
 *
 *  (2) SECURITY-SCOPED KEY. Every Cache/metadata access goes through `replicaKeyRequest` /
 *      `computeReplicaKey`, which embed the WebID + grant-scope. A read for (webId=B) can
 *      never `match()` bytes written for (webId=A) even at the same URL+ETag.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Pure I/O ports are injected (the gate, the authenticated egress, the Cache, the DB) so the
 * whole orchestration is unit-testable without a packed extension or a live pod.
 */

import type { ReplicaMetadata } from './replica-db';
import {
  CANONICAL_RDF_ACCEPT,
  computeReplicaKey,
  computeVaryKey,
  type ReplicaScope,
  replicaKeyRequest,
} from './replica-key';

/**
 * The metadata-store surface the replica depends on (dependency inversion so the
 * security-critical orchestration is unit-testable with an in-memory double, while the live
 * SW passes the IndexedDB-backed `ReplicaDb`). A subset of `ReplicaDb`'s methods.
 */
export interface ReplicaMetaStore {
  getMetadata(key: string): Promise<ReplicaMetadata | undefined>;
  putMetadata(record: ReplicaMetadata): Promise<void>;
  deleteMetadata(key: string): Promise<void>;
  getMetadataByWebId(webId: string): Promise<ReplicaMetadata[]>;
  deleteMetadataByWebId(webId: string): Promise<void>;
  clearMetadata(): Promise<void>;
  clearNonces(): Promise<void>;
}

/** A served replica result — a real `Response` plus whether it came from the warm cache. */
export interface ReplicaResult {
  readonly response: Response;
  readonly fromCache: boolean;
  /** The freshest server DPoP nonce observed on an egress (cache the next call), if any. */
  readonly nonce?: string;
}

/** The authenticated-egress port — the SW's sole DPoP egress (authenticated-fetch.ts). */
export interface EgressPort {
  /**
   * Perform the authenticated egress for a request. `extraHeaders` carries the conditional
   * (`If-None-Match` / `If-Match`) header the replica adds. Returns the live Response + the
   * freshest server nonce.
   */
  fetch(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
    nonce: string | undefined,
  ): Promise<{ response: Response; nonce?: string }>;
}

/**
 * The injected, fail-closed access gate — re-run as the FIRST step on EVERY read and write
 * (the gate-on-cache-hit invariant). Resolves to the verified grant-scope (the granted
 * requesting origin) on ALLOW, or an error Response on DENY. The replica NEVER touches the
 * cache or the pod before this resolves to ALLOW.
 */
export type ReplicaGate = () => Promise<{ grantScope: string } | { deny: Response }>;

/** The minimal Cache-API surface the replica uses (the SW's own named cache). */
export interface ReplicaByteCache {
  match(request: Request, options?: CacheQueryOptions): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request, options?: CacheQueryOptions): Promise<boolean>;
}

/**
 * We key the byte cache on our own synthetic canonical Request, so a stored response's own
 * `Vary` must not cause the Cache API to re-apply header matching. Pass `ignoreVary` on every
 * match/delete (the solid-offline `IGNORE_VARY` discipline).
 */
const IGNORE_VARY: CacheQueryOptions = { ignoreVary: true };

/** Build the request headers the egress should carry, with the conditional header merged in. */
function withConditional(
  headers: Record<string, string>,
  conditional: { name: string; value: string } | null,
): Record<string, string> {
  if (conditional === null) return headers;
  return { ...headers, [conditional.name]: conditional.value };
}

/** Reconstruct a servable Response from cached bytes + the stored metadata's status/headers. */
function responseFromCache(bytes: Response, meta: ReplicaMetadata): Response {
  const headers = new Headers(bytes.headers);
  if (meta.etag && !headers.has('etag')) headers.set('etag', meta.etag);
  if (meta.contentType && !headers.has('content-type'))
    headers.set('content-type', meta.contentType);
  return new Response(bytes.body, { status: meta.status, headers });
}

export interface ReplicaConfig {
  readonly gate: ReplicaGate;
  readonly egress: EgressPort;
  readonly cache: ReplicaByteCache;
  readonly db: ReplicaMetaStore;
  /** The active session's WebID (the security key dimension). */
  readonly webId: string | null;
}

/**
 * The shared replica. Constructed per-request from the SW with the active session's WebID +
 * the injected ports; cheap (the ports are re-derivable on every wake).
 */
export class SharedReplica {
  constructor(private readonly cfg: ReplicaConfig) {}

  /**
   * Read a resource through the replica (GET/HEAD): gate FIRST (incl. on a cache hit), then
   * serve-from-cache + revalidate (never-authoritative SWR). Returns the gate's DENY Response
   * untouched when access is refused — without touching the cache or the pod.
   */
  async read(
    url: string,
    method: string,
    headers: Record<string, string>,
    nonce: string | undefined,
  ): Promise<ReplicaResult | { deny: Response }> {
    // (1) GATE FIRST — applies to a cache HIT exactly as to an egress. No cached body is ever
    // returned before this resolves to ALLOW.
    const decision = await this.cfg.gate();
    if ('deny' in decision) return { deny: decision.deny };

    const scope: ReplicaScope = { webId: this.cfg.webId, grantScope: decision.grantScope };
    const varyKey = computeVaryKey(headers.Accept ?? headers.accept);
    const keyReq = replicaKeyRequest(scope, url, varyKey);
    const metaKey = computeReplicaKey(scope, url, varyKey);

    // No WebID / no grant-scope ⇒ un-keyable ⇒ never cache: a plain authenticated egress.
    if (keyReq === null || metaKey === null) {
      const { response, nonce: n } = await this.cfg.egress.fetch(url, method, headers, null, nonce);
      return { response, fromCache: false, nonce: n };
    }

    const cachedBytes = await this.cfg.cache.match(keyReq, IGNORE_VARY);
    const meta = await this.cfg.db.getMetadata(metaKey);

    // Conditional revalidation: carry the cached ETag so a 304 confirms the provisional body.
    const conditional =
      cachedBytes && meta?.etag ? { name: 'If-None-Match', value: meta.etag } : null;
    const reqHeaders = withConditional(headers, conditional);

    const { response, nonce: serverNonce } = await this.cfg.egress.fetch(
      url,
      method,
      reqHeaders,
      null,
      nonce,
    );

    // 304 Not Modified: the provisional cached body is confirmed fresh — serve it, touch it.
    if (response.status === 304 && cachedBytes && meta) {
      await this.cfg.db.putMetadata({ ...meta, fetchedAt: Date.now() });
      return {
        response: responseFromCache(cachedBytes.clone(), meta),
        fromCache: true,
        nonce: serverNonce,
      };
    }

    // 2xx: replace the shared replica bytes + metadata FROM the pod's response (never-stale).
    if (response.status >= 200 && response.status < 300 && method.toUpperCase() === 'GET') {
      const stored = await this.store(scope, url, varyKey, metaKey, keyReq, response);
      return { response: stored, fromCache: false, nonce: serverNonce };
    }

    // Any other status (incl. a now-403/404 — access changed, or not-found): do NOT serve a
    // stale cached body; surface the live response. Drop any now-invalid cached entry.
    if (cachedBytes || meta) {
      await this.invalidate(metaKey, keyReq);
    }
    return { response, fromCache: false, nonce: serverNonce };
  }

  /**
   * Write a resource through the replica (PUT/POST/PATCH/DELETE): gate FIRST, then SYNCHRONOUS
   * WRITE-THROUGH — the pod is written with `If-Match` (the cross-app lost-update guard when
   * the caller supplied none), and only a 2xx updates the shared replica FROM the pod's
   * response. A 412 / 5xx is surfaced verbatim (no silent queue in Phase 1).
   */
  async write(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
    nonce: string | undefined,
  ): Promise<ReplicaResult | { deny: Response }> {
    const decision = await this.cfg.gate();
    if ('deny' in decision) return { deny: decision.deny };

    const scope: ReplicaScope = { webId: this.cfg.webId, grantScope: decision.grantScope };
    const varyKey = computeVaryKey(CANONICAL_RDF_ACCEPT);
    const keyReq = replicaKeyRequest(scope, url, varyKey);
    const metaKey = computeReplicaKey(scope, url, varyKey);

    // Lost-update guard: if the caller supplied no precondition AND we hold a cached ETag,
    // attach `If-Match` so App B cannot silently clobber App A's confirmed write.
    let reqHeaders = headers;
    const hasPrecondition =
      'if-match' in lowerKeys(headers) || 'if-none-match' in lowerKeys(headers);
    if (!hasPrecondition && metaKey !== null) {
      const meta = await this.cfg.db.getMetadata(metaKey);
      if (meta?.etag) reqHeaders = withConditional(headers, { name: 'If-Match', value: meta.etag });
    }

    const { response, nonce: serverNonce } = await this.cfg.egress.fetch(
      url,
      method,
      reqHeaders,
      body,
      nonce,
    );

    // On a 2xx write, the cached copy is stale. A DELETE drops the entry; a PUT/PATCH/POST
    // re-fetches lazily on the next read (we do not trust the write response body as the new
    // GET representation). Either way invalidate the shared replica entry for this URL.
    if (response.status >= 200 && response.status < 300 && keyReq !== null && metaKey !== null) {
      await this.invalidate(metaKey, keyReq);
    }

    return { response, fromCache: false, nonce: serverNonce };
  }

  /** Store a 2xx GET response's bytes + metadata under the security-scoped key. */
  private async store(
    scope: ReplicaScope,
    url: string,
    varyKey: string,
    metaKey: string,
    keyReq: Request,
    response: Response,
  ): Promise<Response> {
    // Clone so the caller still gets a live body; store the clone UN-mutated under the key.
    await this.cfg.cache.put(keyReq, response.clone());
    const record: ReplicaMetadata = {
      key: metaKey,
      webId: scope.webId as string,
      grantScope: scope.grantScope as string,
      resourceUrl: url,
      varyKey,
      etag: response.headers.get('etag') ?? undefined,
      contentType: response.headers.get('content-type') ?? undefined,
      status: response.status,
      fetchedAt: Date.now(),
    };
    await this.cfg.db.putMetadata(record);
    return response;
  }

  /** Drop one entry's bytes + metadata (a no-leak partial-write sweep). */
  private async invalidate(metaKey: string, keyReq: Request): Promise<void> {
    await this.cfg.cache.delete(keyReq, IGNORE_VARY).catch(() => false);
    await this.cfg.db.deleteMetadata(metaKey).catch(() => {});
  }
}

/** Lower-cased header-name set for case-insensitive precondition detection. */
function lowerKeys(headers: Record<string, string>): Record<string, true> {
  const out: Record<string, true> = {};
  for (const k of Object.keys(headers)) out[k.toLowerCase()] = true;
  return out;
}

/**
 * SYNCHRONOUS-BEFORE-SERVE logout purge (design §4.3 "Cross-USER stale bytes", §5.4 point 5):
 * delete the prior identity's replica bytes + metadata + cached nonces BEFORE any new
 * session's read can be served. The SW awaits this in its logout handler, so a returning /
 * different user never reads a single departed-identity byte (the WebID-in-key makes a
 * cross-user collision impossible, and this purge removes the prior rows entirely).
 *
 * `webId === null` (a logout where the prior WebID is unknown / a full reset) drops EVERYTHING
 * — fail-closed: when in doubt, purge all, never leave a row behind.
 */
export async function purgeReplica(
  cache: ReplicaByteCache,
  db: ReplicaMetaStore,
  webId: string | null,
  cacheKeysForWebId?: () => Promise<Request[]>,
): Promise<{ bytesDropped: number; metaDropped: number }> {
  let metaDropped = 0;
  let bytesDropped = 0;

  if (webId !== null) {
    // Drop exactly this identity's rows + their byte entries.
    const rows = await db.getMetadataByWebId(webId);
    for (const row of rows) {
      const keyReq = new Request(
        // Reconstruct the exact synthetic key from the stored scope (injective — see replica-key.ts).
        replicaKeyUrlFor(row),
      );
      if (await cache.delete(keyReq, IGNORE_VARY).catch(() => false)) bytesDropped++;
    }
    await db.deleteMetadataByWebId(webId);
    metaDropped = rows.length;
  } else {
    // Unknown prior identity → purge ALL replica state (fail-closed, no row survives).
    if (cacheKeysForWebId) {
      for (const keyReq of await cacheKeysForWebId()) {
        if (await cache.delete(keyReq, IGNORE_VARY).catch(() => false)) bytesDropped++;
      }
    }
    await db.clearMetadata();
  }

  // Nonces are always cleared on logout (a new identity must never reuse a prior nonce).
  await db.clearNonces();
  return { bytesDropped, metaDropped };
}

/** Reconstruct the synthetic Cache key URL for a stored metadata row (the byte half of purge). */
function replicaKeyUrlFor(row: ReplicaMetadata): string {
  const keyReq = replicaKeyRequest(
    { webId: row.webId, grantScope: row.grantScope },
    row.resourceUrl,
    row.varyKey,
  );
  // A stored row always has both scope dimensions, so this is never null; assert for the type.
  return (keyReq as Request).url;
}
