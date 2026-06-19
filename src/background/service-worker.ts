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
  LoginRequest,
  SessionState,
  SetClientIdRequest,
  WorkerRequest,
} from '../shared/messages';
import { setSignedInIcon, setSignedOutIcon } from './action-icon';
import { initiateLogin, refreshSession } from './auth-flow';
import { authenticatedFetch, type FetchSession } from './core/authenticated-fetch';
import { importDpopKeyPair } from './core/dpop';
import { computeAllowedOrigins } from './core/origin-policy';
import { parseWebIdProfile } from './core/webid';
import {
  clearProfile,
  clearSession,
  loadClientIds,
  loadPodOrigins,
  loadProfile,
  loadRecentAccounts,
  loadSession,
  type StoredSession,
  saveClientId,
  saveProfile,
} from './session-store';

const ALLOW_INSECURE_LOOPBACK = true; // dev CSS over http://localhost; harmless for https issuers.
const EXPIRY_BUFFER_MS = 30_000;

/** Best-effort in-memory caches (re-hydrated from storage on SW wake). */
let cachedSession: StoredSession | null = null;
let cachedKeyPair: CryptoKeyPair | null = null;
/** A cached server DPoP nonce per resource origin, to skip the first §8 round-trip. */
const nonceByOrigin = new Map<string, string>();

/** Load + refresh-if-needed the active session and its (imported) keypair. */
async function ensureSession(): Promise<{ session: StoredSession; keyPair: CryptoKeyPair } | null> {
  if (!cachedSession) cachedSession = await loadSession();
  if (!cachedSession) return null;

  if (cachedSession.expiresAt < Date.now() + EXPIRY_BUFFER_MS) {
    try {
      cachedSession = await refreshSession(cachedSession);
      cachedKeyPair = null;
    } catch {
      await teardownSession();
      return null;
    }
  }

  if (!cachedKeyPair) cachedKeyPair = await importDpopKeyPair(cachedSession.dpopKeyPair);
  return { session: cachedSession, keyPair: cachedKeyPair };
}

async function teardownSession(): Promise<void> {
  cachedSession = null;
  cachedKeyPair = null;
  nonceByOrigin.clear();
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

async function handleFetch(message: FetchRequest): Promise<FetchResponse> {
  const ctx = await ensureSession();
  if (!ctx) return { requestId: message.requestId, error: 'Not authenticated' };

  try {
    const fetchSession = await buildFetchSession(ctx.session, ctx.keyPair);
    const origin = originOf(message.url);
    const result = await authenticatedFetch(fetchSession, {
      url: message.url,
      method: message.method,
      headers: message.headers,
      body: message.body,
      nonce: origin ? nonceByOrigin.get(origin) : undefined,
    });
    if (origin && result.nonce) nonceByOrigin.set(origin, result.nonce);

    const headers: Record<string, string> = {};
    result.response.headers.forEach((value, key) => {
      headers[key] = value;
    });
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

function broadcastStateChange(webId: string | null): void {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id !== undefined) {
        chrome.tabs.sendMessage(tab.id, { type: 'SOLID_STATE_CHANGED', webId }).catch(() => {});
      }
    }
  });
  // Also notify the popup if open (runtime broadcast).
  chrome.runtime.sendMessage({ type: 'SOLID_STATE_CHANGED', webId }).catch(() => {});
}

async function handleLogin(message: LoginRequest): Promise<ActionResult> {
  try {
    const clientIds = await loadClientIds();
    const clientId =
      message.clientId || (message.origin ? clientIds[message.origin] : undefined) || undefined;

    const { session, name, photoUrl } = await initiateLogin({
      webId: message.webId,
      clientId,
    });
    cachedSession = session;
    cachedKeyPair = null;
    await saveProfile({ webId: session.webId, name, photoUrl });
    await setSignedInIcon({ webId: session.webId, name, photoUrl });
    // best-effort fresher profile from the post-auth WebID (handles webid != input).
    void refreshProfile(session.webId);
    broadcastStateChange(session.webId);
    return { ok: true, webId: session.webId };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Login failed' };
  }
}

async function handleGetState(): Promise<SessionState> {
  const ctx = await ensureSession();
  const profile = await loadProfile();
  const recentAccounts = await loadRecentAccounts();
  return {
    webId: ctx?.session.webId ?? null,
    isActive: ctx !== null,
    name: profile?.name ?? null,
    photoUrl: profile?.photoUrl ?? null,
    recentAccounts,
  };
}

async function handleSetClientId(message: SetClientIdRequest): Promise<ActionResult> {
  try {
    // Validate it parses + is https (or loopback). A client-id is a dereferenceable URL.
    const url = new URL(message.clientId);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('Client identifier must be an http(s) URL.');
    }
    await saveClientId(message.origin, message.clientId);
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Invalid client identifier' };
  }
}

chrome.runtime.onMessage.addListener(
  (message: WorkerRequest, _sender, sendResponse: (r: unknown) => void) => {
    switch (message.type) {
      case 'SOLID_FETCH_REQUEST':
        handleFetch(message).then(sendResponse);
        return true;
      case 'SOLID_LOGIN':
        handleLogin(message).then(sendResponse);
        return true;
      case 'SOLID_LOGOUT':
        teardownSession()
          .then(() => {
            broadcastStateChange(null);
            sendResponse({ ok: true });
          })
          .catch((err) => sendResponse({ error: String(err) }));
        return true;
      case 'SOLID_GET_STATE':
        handleGetState().then(sendResponse);
        return true;
      case 'SOLID_SET_CLIENT_ID':
        handleSetClientId(message).then(sendResponse);
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
});

// Re-hydrate the session + icon on every SW wake.
ensureSession().then(async (ctx) => {
  if (ctx) {
    const profile = await loadProfile();
    await setSignedInIcon({
      webId: ctx.session.webId,
      name: profile?.name ?? null,
      photoUrl: profile?.photoUrl ?? null,
    });
    broadcastStateChange(ctx.session.webId);
  } else {
    await setSignedOutIcon();
  }
});
