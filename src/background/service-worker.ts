// AUTHORED-BY Claude Opus 4.8
/**
 * The MV3 background service worker — the session manager + message router + the one
 * holder of the access token. It:
 *   - restores/refreshes the session (DPoP refresh grant, proactive 30s-before-expiry),
 *   - routes the page/popup message protocol (login / logout / fetch / get-state /
 *     set-client-id),
 *   - performs every authenticated fetch behind the core credential boundary
 *     (origin-gated, token-endpoint-guarded, §8 nonce retry), and
 *   - drives the toolbar action icon (the signed-in avatar) + state broadcasts.
 *
 * RE-ENTRANCY: discovery / token / refresh / profile fetches use the RAW `fetch`, never
 * the authenticatedFetch path — so a SW-internal request can never recurse into the
 * token-attaching path, and the access token is only ever sent to a vetted resource
 * origin.
 *
 * The MV3 worker is killed aggressively; all durable state lives in chrome.storage and is
 * re-hydrated on wake (the in-memory caches below are best-effort accelerators only).
 */

import type {
  ActionResult,
  FetchRequest,
  FetchResponse,
  GetStateRequest,
  LoginRequest,
  SessionState,
  SetClientIdRequest,
  WorkerRequest,
} from '../shared/messages';
import { setSignedInIcon, setSignedOutIcon } from './action-icon';
import { initiateLogin, refreshSession } from './auth-flow';
import { authenticatedFetch, type FetchSession } from './core/authenticated-fetch';
import { importDpopKeyPair } from './core/dpop';
import { computeAllowedOrigins, isValidClientIdUrl } from './core/origin-policy';
import {
  type EgressPort,
  purgeReplica,
  type ReplicaByteCache,
  SharedReplica,
} from './core/replica';
import { ReplicaDb } from './core/replica-db';
import {
  computeGrantedOrigins,
  decideRequestingOrigin,
  isRequestingOriginGranted,
  type MessageSender,
  resolveRequestingOrigin,
} from './core/requesting-origin';
import { filterResponseHeaders } from './core/response-headers';
import { SingleFlight } from './core/single-flight';
import { parseWebIdProfile } from './core/webid';
import { registerGlobalFetchInjection } from './global-fetch-register';
import {
  clearProfile,
  clearSession,
  grantOrigin,
  loadClientIds,
  loadGrantedOrigins,
  loadPodOrigins,
  loadProfile,
  loadRecentAccounts,
  loadSession,
  type StoredSession,
  saveClientId,
  saveProfile,
} from './session-store';
import { registerSidePanel } from './side-panel';

const ALLOW_INSECURE_LOOPBACK = true; // dev CSS over http://localhost; harmless for https issuers.
const EXPIRY_BUFFER_MS = 30_000;

/** The Cache API bucket holding the shared replica's bytes (one physical store, see replica.ts). */
const REPLICA_CACHE_NAME = 'solid-ext-replica-bytes';

/** Best-effort in-memory caches (re-hydrated from storage on SW wake). */
let cachedSession: StoredSession | null = null;
let cachedKeyPair: CryptoKeyPair | null = null;

/**
 * The replica IndexedDB handle (metadata + the DPoP nonce cache). Re-derivable on every SW
 * wake — a best-effort accelerator, never load-bearing in-memory state (MV3 invariant). The
 * DPoP nonce cache lives in IndexedDB (NOT an in-memory Map) so a cold wake does not pay the
 * RFC 9449 §8 nonce round-trip on its first request (design §2.1, §5.2).
 */
let replicaDbHandle: ReplicaDb | null = null;

/** Lazily open (once per wake) the replica DB. */
async function getReplicaDb(): Promise<ReplicaDb> {
  if (!replicaDbHandle) replicaDbHandle = await ReplicaDb.open();
  return replicaDbHandle;
}

/** The named Cache bucket for replica bytes (re-opened lazily; available in the SW context). */
function getReplicaCache(): Promise<ReplicaByteCache> {
  return caches.open(REPLICA_CACHE_NAME) as Promise<ReplicaByteCache>;
}
/**
 * Single-flight refresh: concurrent near-expiry requests must NOT each start a refresh
 * with the same (rotation-bound) refresh token — that races, so one grant succeeds and the
 * others fail with invalid_grant and would wrongly tear down the freshly-refreshed session.
 * All callers await the one in-flight refresh instead.
 */
const refreshGate = new SingleFlight<StoredSession>();

/** Refresh `session` exactly once even under concurrency; rejects on a genuine failure. */
function refreshOnce(session: StoredSession): Promise<StoredSession> {
  return refreshGate.run(async () => {
    const updated = await refreshSession(session);
    cachedSession = updated;
    cachedKeyPair = null;
    return updated;
  });
}

/** Load + refresh-if-needed the active session and its (imported) keypair. */
async function ensureSession(): Promise<{ session: StoredSession; keyPair: CryptoKeyPair } | null> {
  if (!cachedSession) cachedSession = await loadSession();
  if (!cachedSession) return null;

  if (cachedSession.expiresAt < Date.now() + EXPIRY_BUFFER_MS) {
    const toRefresh = cachedSession;
    try {
      await refreshOnce(toRefresh);
    } catch {
      // Only tear down if nothing newer has landed: a concurrent single-flight refresh (or
      // a fresh login) may already have replaced the session this caller tried to refresh.
      if (cachedSession === toRefresh) {
        await teardownSession();
        return null;
      }
    }
  }

  if (!cachedSession) return null;
  if (!cachedKeyPair) cachedKeyPair = await importDpopKeyPair(cachedSession.dpopKeyPair);
  return { session: cachedSession, keyPair: cachedKeyPair };
}

/**
 * Tear down the session AND SYNCHRONOUSLY purge the shared replica BEFORE returning, so no
 * subsequent (returning / different-user) read can be served a single departed-identity byte
 * (design §4.3 "Cross-USER stale bytes", §5.4 point 5). The logout handler AWAITS this; the
 * purge (replica bytes + metadata + cached DPoP nonces) completes before any further serve.
 * `priorWebId` scopes the purge to exactly that identity's rows; a missing prior WebID purges
 * everything (fail-closed). The WebID-in-key already makes a cross-user collision impossible;
 * this removes the prior rows entirely so even a same-key re-provision cannot collide.
 */
async function teardownSession(): Promise<void> {
  const priorWebId = (cachedSession ?? (await loadSession()))?.webId ?? null;
  cachedSession = null;
  cachedKeyPair = null;

  // SYNCHRONOUS-BEFORE-SERVE replica purge. Best-effort on the stores (a missing DB must not
  // block sign-out), but AWAITED so it precedes any new serve.
  try {
    const [cache, db] = await Promise.all([getReplicaCache(), getReplicaDb()]);
    await purgeReplica(cache, db, priorWebId);
  } catch {
    // If the replica stores are unavailable, sign-out still proceeds (no bytes to leak when
    // the store never opened). The WebID-scoped key means a future session cannot read them.
  }

  await Promise.all([clearSession(), clearProfile()]);
  await setSignedOutIcon();
}

/** Build the per-request fetch session (the credential boundary) from the stored session. */
async function buildFetchSession(
  session: StoredSession,
  keyPair: CryptoKeyPair,
): Promise<FetchSession> {
  const podOrigins = await loadPodOrigins();
  const allowedOrigins = computeAllowedOrigins({
    webId: session.webId,
    issuer: session.issuer,
    podOrigins,
    allowInsecureLoopback: ALLOW_INSECURE_LOOPBACK,
  });
  return {
    accessToken: session.accessToken,
    dpopKeyPair: keyPair,
    allowedOrigins,
    tokenEndpoint: session.tokenEndpoint,
  };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const DENY_MESSAGE = {
  'forbidden-origin': 'Forbidden origin',
  'origin-not-granted': 'Origin not granted access',
  'cross-origin-foreign': 'Cross-origin fetch denied',
} as const;

/**
 * The grant + foreign-fetch half of the per-requesting-origin gate, run BEFORE any pod
 * egress or cache read (the dual-origin/opaque half already ran in {@link handleFetch}). It
 * re-reads the grant store and re-runs the FULL decision (idempotent on the same inputs) so
 * the single audited `decideRequestingOrigin` is the one boundary. Fail-closed on DENY.
 *
 * NOTE: the per-origin gate is applied to EVERY fetch up-front. Once a shared replica /
 * cache exists (Phase 1) this same gate must be the first check on a cache hit too — it is
 * deliberately separated here so a future cached-response path cannot bypass it.
 */
async function gateRequestingOrigin(
  message: FetchRequest,
  requestingOrigin: string,
  sender: MessageSender | undefined,
  allowedTargetOrigins: ReadonlySet<string>,
): Promise<{ requestingOrigin: string } | { error: FetchResponse }> {
  // The grant set is re-read from durable storage on EVERY request (no load-bearing
  // in-memory gate state), so a cold SW wake is fail-CLOSED: if nothing has loaded yet the
  // grant set is empty and every origin is denied — never a serve-while-loading window.
  const explicitGrants = await loadGrantedOrigins();
  const decision = decideRequestingOrigin(sender, message.stampedOrigin, message.url, {
    explicitGrants,
    credentialOrigins: allowedTargetOrigins,
  });
  // Defence-in-depth: the re-resolved origin must match the one resolved earlier in this
  // request (it always will for identical inputs); a divergence is treated as DENY.
  if (decision.deny !== null || decision.requestingOrigin !== requestingOrigin) {
    return {
      error: {
        requestId: message.requestId,
        status: 403,
        error: decision.deny ? DENY_MESSAGE[decision.deny] : DENY_MESSAGE['forbidden-origin'],
      },
    };
  }
  return { requestingOrigin: decision.requestingOrigin };
}

const READ_METHODS = new Set(['GET', 'HEAD']);

async function handleFetch(
  message: FetchRequest,
  sender: MessageSender | undefined,
): Promise<FetchResponse> {
  // FIRST, before ANY session work (which may trigger a token refresh): the cheap,
  // session-independent half of the gate — dual-origin agreement + opaque/null rejection. A
  // forged/opaque origin is denied here so it cannot even cause a session-refresh side
  // effect (refresh-token amplification). The browser-attested sender is the authority.
  const requestingOrigin = resolveRequestingOrigin(sender, message.stampedOrigin);
  if (requestingOrigin === null) {
    return {
      requestId: message.requestId,
      status: 403,
      error: DENY_MESSAGE['forbidden-origin'],
    };
  }

  const ctx = await ensureSession();
  if (!ctx) return { requestId: message.requestId, error: 'Not authenticated' };

  try {
    const fetchSession = await buildFetchSession(ctx.session, ctx.keyPair);

    // The INJECTED gate the replica runs as the FIRST step on EVERY read AND write — including
    // on a CACHE HIT (design §5.4 point 3). It re-runs the SAME audited `gateRequestingOrigin`
    // decision (idempotent) and returns the verified grant-scope on ALLOW; the replica never
    // touches the cache or the pod before this resolves to ALLOW, so a warm cache can never
    // bypass the per-origin gate.
    const gate = async (): Promise<{ grantScope: string } | { deny: Response }> => {
      const decision = await gateRequestingOrigin(
        message,
        requestingOrigin,
        sender,
        fetchSession.allowedOrigins,
      );
      if ('error' in decision) {
        return { deny: denyResponse(decision.error.error ?? DENY_MESSAGE['forbidden-origin']) };
      }
      return { grantScope: decision.requestingOrigin };
    };

    const origin = originOf(message.url);
    const db = await getReplicaDb();
    const cache = await getReplicaCache();
    const nonce = origin ? await db.getNonce(origin) : undefined;

    // The SW's sole DPoP egress (authenticated-fetch.ts), wrapped as the replica's egress
    // port. The DPoP-bound, origin-gated, §8-nonce-retry egress is PRESERVED VERBATIM — the
    // replica only chooses WHEN to call it (revalidate vs write-through) and adds the
    // conditional header; it never re-implements the credential path.
    const egress: EgressPort = {
      fetch: async (url, method, headers, body, n) => {
        const result = await authenticatedFetch(fetchSession, {
          url,
          method,
          headers,
          body,
          nonce: n,
        });
        return { response: result.response, nonce: result.nonce };
      },
    };

    const replica = new SharedReplica({
      gate,
      egress,
      cache,
      db,
      webId: ctx.session.webId,
    });

    const isRead = READ_METHODS.has(message.method.toUpperCase());
    const result = isRead
      ? await replica.read(message.url, message.method, message.headers, nonce)
      : await replica.write(message.url, message.method, message.headers, message.body, nonce);

    if ('deny' in result) {
      // The gate denied (incl. on a would-be cache hit) — relay the 403 verbatim.
      return {
        requestId: message.requestId,
        status: result.deny.status,
        error: await result.deny.text(),
      };
    }

    // Persist the freshest server nonce to IndexedDB so it survives an SW restart.
    if (origin && result.nonce) await db.setNonce(origin, result.nonce);

    // Defense-in-depth: relay only the allowlisted, app-relevant response headers back to
    // the page rather than every header the server emitted (see response-headers.ts).
    const headers = filterResponseHeaders(result.response.headers);
    return {
      requestId: message.requestId,
      status: result.response.status,
      statusText: result.response.statusText,
      headers,
      body: await result.response.text(),
    };
  } catch (err) {
    return {
      requestId: message.requestId,
      error: err instanceof Error ? err.message : 'Fetch failed',
    };
  }
}

/** A small Response carrying a gate-deny reason, for the replica's injected gate port. */
function denyResponse(error: string): Response {
  return new Response(error, { status: 403 });
}

/** Best-effort: fetch + parse the WebID profile (name/photo) and persist it. */
async function refreshProfile(webId: string): Promise<void> {
  try {
    const response = await fetch(webId, { headers: { Accept: 'text/turtle' } });
    if (!response.ok) return;
    const { name, photoUrl } = parseWebIdProfile(webId, await response.text());
    await saveProfile({ webId, name, photoUrl });
    await setSignedInIcon({ webId, name, photoUrl });
  } catch {
    // cosmetic — leave whatever profile/icon we have.
  }
}

/**
 * Broadcast an auth-state change. The WebID (PII) is sent to a tab ONLY when that tab's
 * origin holds a grant — a non-granted page is told the WebID is `null` (it learns nothing
 * about who is signed in), closing the design §4.3 PII-broadcast over-exposure. A logout
 * (`webId === null`) is sent to every tab so granted apps clear their state. The popup/side
 * panel (extension contexts) always get the real value via the runtime broadcast.
 */
async function broadcastStateChange(webId: string | null): Promise<void> {
  let granted: ReadonlySet<string> = new Set();
  if (webId !== null) {
    const ctx = await ensureSession();
    if (ctx) {
      const explicitGrants = await loadGrantedOrigins();
      granted = computeGrantedOrigins({
        explicitGrants,
        credentialOrigins: await sessionCredentialOrigins(ctx.session, ctx.keyPair),
      });
    }
  }

  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const tabOrigin = tab.url ? originOf(tab.url) : null;
    // A signed-in WebID is only revealed to a granted tab; everyone else (and every tab on
    // logout) gets null. Fail-closed: an unparseable tab URL never receives the WebID.
    const tabWebId = webId !== null && tabOrigin !== null && granted.has(tabOrigin) ? webId : null;
    chrome.tabs
      .sendMessage(tab.id, { type: 'SOLID_STATE_CHANGED', webId: tabWebId })
      .catch(() => {});
  }
  // The popup/side panel are trusted extension contexts — give them the real value.
  chrome.runtime.sendMessage({ type: 'SOLID_STATE_CHANGED', webId }).catch(() => {});
}

async function handleLogin(
  message: LoginRequest,
  sender: MessageSender | undefined,
): Promise<ActionResult> {
  try {
    // A login driven FROM a web page is a deliberate owner opt-in. Resolve + REMEMBER the
    // verified requesting origin now (to bind the flow), but do NOT grant it yet — verify the
    // origin via the same dual-origin agreement (browser-attested ∧ page stamp) and never trust
    // the page-supplied field alone. A popup/side-panel login has no web sender → nothing to grant.
    //
    // SECURITY (privilege-escalation guard): the grant is persisted ONLY AFTER initiateLogin
    // succeeds (the success path below). Granting BEFORE login would let any page send
    // SOLID_LOGIN, have its origin persisted as granted even if the auth flow is cancelled or
    // fails, and then — if a session already existed — read the existing credentials via
    // SOLID_FETCH_REQUEST. A failed/cancelled login must leave the grant store UNCHANGED.
    const requestingOrigin = resolveRequestingOrigin(sender, message.origin);

    const clientIds = await loadClientIds();
    const candidate =
      message.clientId || (message.origin ? clientIds[message.origin] : undefined) || undefined;
    // A page-declared client-id is only honoured if it is a valid (https / loopback) URL;
    // an invalid one is ignored (fall back to the extension's own client / dynamic reg)
    // rather than passing a tamperable plaintext client-id into the auth flow.
    const clientId = candidate && isValidClientIdUrl(candidate) ? candidate : undefined;

    const { session, name, photoUrl } = await initiateLogin({
      webId: message.webId,
      clientId,
    });
    // Login succeeded (owner-approved): NOW grant the verified requesting origin so its
    // subsequent window.solid.fetch calls pass the per-origin gate.
    if (requestingOrigin !== null) await grantOrigin(requestingOrigin);
    cachedSession = session;
    cachedKeyPair = null;
    await saveProfile({ webId: session.webId, name, photoUrl });
    await setSignedInIcon({ webId: session.webId, name, photoUrl });
    // best-effort fresher profile from the post-auth WebID (handles webid != input).
    void refreshProfile(session.webId);
    await broadcastStateChange(session.webId);
    return { ok: true, webId: session.webId };
  } catch (err) {
    // A cancelled / failed login persists NO grant — the grant store is untouched above.
    return { error: err instanceof Error ? err.message : 'Login failed' };
  }
}

/**
 * Whether a message sender is one of the extension's OWN trusted contexts (popup, side
 * panel, options) rather than a web page. Chrome stamps these with the extension's own
 * origin/URL; a web content script is stamped with the page origin. The owner UI is fully
 * trusted; a web page is not. Fail-closed: an unknown/opaque sender is treated as NOT the
 * extension (a web page), so it gets the scoped (PII-free) view.
 */
function isExtensionContext(sender: MessageSender | undefined): boolean {
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
  if (sender?.origin && sender.origin === extensionOrigin) return true;
  if (sender?.url?.startsWith(`${extensionOrigin}/`)) return true;
  return false;
}

/**
 * Answer `SOLID_GET_STATE`. The extension's OWN contexts (popup/side panel) get the full
 * session view. A WEB PAGE gets identity (WebID + profile) ONLY if its verified+granted
 * origin holds a grant — otherwise the PII is withheld (design §4.3 "PII broadcast"): a page
 * the owner never opted in learns nothing about who is signed in.
 */
async function handleGetState(
  message: GetStateRequest,
  sender: MessageSender | undefined,
): Promise<SessionState> {
  const ctx = await ensureSession();
  const profile = await loadProfile();

  if (isExtensionContext(sender)) {
    const recentAccounts = await loadRecentAccounts();
    return {
      webId: ctx?.session.webId ?? null,
      isActive: ctx !== null,
      name: profile?.name ?? null,
      photoUrl: profile?.photoUrl ?? null,
      recentAccounts,
    };
  }

  // Web page: scope identity exposure to opt-in/granted origins only.
  const requestingOrigin = resolveRequestingOrigin(sender, message.stampedOrigin);
  let mayExpose = false;
  if (requestingOrigin !== null && ctx) {
    const explicitGrants = await loadGrantedOrigins();
    const granted = computeGrantedOrigins({
      explicitGrants,
      credentialOrigins: await sessionCredentialOrigins(ctx.session, ctx.keyPair),
    });
    mayExpose = isRequestingOriginGranted(granted, requestingOrigin);
  }

  return {
    webId: mayExpose ? (ctx?.session.webId ?? null) : null,
    isActive: mayExpose && ctx !== null,
    name: mayExpose ? (profile?.name ?? null) : null,
    photoUrl: mayExpose ? (profile?.photoUrl ?? null) : null,
    // Never leak the cross-pod recent-accounts list to a web page.
    recentAccounts: [],
  };
}

/** The session's credential (pod/WebID/issuer) origins — the auto-granted requester set. */
async function sessionCredentialOrigins(
  session: StoredSession,
  keyPair: CryptoKeyPair,
): Promise<ReadonlySet<string>> {
  const fetchSession = await buildFetchSession(session, keyPair);
  return fetchSession.allowedOrigins;
}

async function handleSetClientId(
  message: SetClientIdRequest,
  sender: MessageSender | undefined,
): Promise<ActionResult> {
  try {
    // A Client Identifier Document is a dereferenceable URL. Require HTTPS so it cannot be
    // tampered with in transit; allow http: ONLY for a loopback host (dev CSS). A remote
    // plaintext client-id doc could be rewritten by a network attacker.
    if (!isValidClientIdUrl(message.clientId)) {
      throw new Error('Client identifier must be an https: URL (http: allowed for loopback only).');
    }
    // Cross-check the page-supplied origin against the browser-attested sender; store the
    // client-id (and grant the app) only under the VERIFIED origin, so a renderer cannot
    // map another origin's client-id or self-grant a foreign origin.
    const requestingOrigin = resolveRequestingOrigin(sender, message.origin);
    if (requestingOrigin === null) {
      throw new Error('Could not verify the requesting origin.');
    }
    await saveClientId(requestingOrigin, message.clientId);
    // Declaring a client-id is a deliberate owner opt-in from this app → grant it access.
    await grantOrigin(requestingOrigin);
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Invalid client identifier' };
  }
}

chrome.runtime.onMessage.addListener(
  (message: WorkerRequest, sender, sendResponse: (r: unknown) => void) => {
    switch (message.type) {
      case 'SOLID_FETCH_REQUEST':
        // Pass the browser-ATTESTED sender (origin/url set by Chrome, not the page) so the
        // per-requesting-origin gate can cross-check it against the page-supplied stamp.
        handleFetch(message, sender).then(sendResponse);
        return true;
      case 'SOLID_LOGIN':
        handleLogin(message, sender).then(sendResponse);
        return true;
      case 'SOLID_LOGOUT':
        teardownSession()
          .then(() => broadcastStateChange(null))
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ error: String(err) }));
        return true;
      case 'SOLID_GET_STATE':
        handleGetState(message, sender).then(sendResponse);
        return true;
      case 'SOLID_SET_CLIENT_ID':
        handleSetClientId(message, sender).then(sendResponse);
        return true;
      default:
        return false;
    }
  },
);

/** First-run onboarding: prompt the user to PIN the toolbar action (extensions can't self-pin). */
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({ 'solid:show-pin-nudge': true }).catch(() => {});
  }
  // (Re-)register the MAIN-world global-fetch-patch injection on install/update — the most
  // reliable MAIN injection (design §5.1). Belt-and-braces with the manifest content script;
  // non-fatal if unavailable (the SW gate is the sole security boundary regardless).
  void registerGlobalFetchInjection();
});

// Wire the persistent side panel: a right-click "Open Solid side panel" action-menu entry
// + its open handler. The toolbar action keeps its existing popup unchanged.
registerSidePanel();

// Re-hydrate the session + icon on every SW wake.
ensureSession().then(async (ctx) => {
  if (ctx) {
    const profile = await loadProfile();
    await setSignedInIcon({
      webId: ctx.session.webId,
      name: profile?.name ?? null,
      photoUrl: profile?.photoUrl ?? null,
    });
    await broadcastStateChange(ctx.session.webId);
  } else {
    await setSignedOutIcon();
  }
});
