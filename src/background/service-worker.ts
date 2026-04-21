import { initiateLogin, initiateSilentLogin, refreshAccessToken, createDpopProof, EXTENSION_CLIENT_ID } from './auth-flow';
import {
  clearAllSessions,
  clearProfile,
  clearActiveWebId,
  clearSessionForClient,
  importDpopKeyPair,
  loadActiveWebId,
  loadClientIds,
  loadPastProfiles,
  loadProfile,
  loadSessionForClient,
  loadSessions,
  saveActiveWebId,
  saveClientId,
  saveProfile,
  saveSession,
  type StoredSession,
} from './session-database';
import { Parser, Store, DataFactory } from 'n3';
import { Agent, WebIdDataset } from '@solid/object';

interface SessionContext {
  session: StoredSession;
  keyPair: CryptoKeyPair;
}

const sessionCache = new Map<string, SessionContext>();
const pendingSilentAuth = new Map<string, Promise<SessionContext | null>>();

async function resolveClientIdForOrigin(origin: string | undefined): Promise<string> {
  if (!origin) return EXTENSION_CLIENT_ID;
  const mapping = await loadClientIds();
  return mapping[origin] ?? EXTENSION_CLIENT_ID;
}

async function loadSessionContextFromStorage(clientId: string): Promise<SessionContext | null> {
  const stored = await loadSessionForClient(clientId);
  if (!stored) return null;
  const keyPair = await importDpopKeyPair(stored.dpopKeyPair);
  return { session: stored, keyPair };
}

async function silentlyAuthenticate(clientId: string): Promise<SessionContext | null> {
  const webId = await loadActiveWebId();
  if (!webId) return null;

  const existing = pendingSilentAuth.get(clientId);
  if (existing) return existing;

  const promise = (async (): Promise<SessionContext | null> => {
    try {
      const session = await initiateSilentLogin(webId, clientId);
      // Recheck the active WebID: if the user logged out or switched accounts
      // while we were off awaiting the IdP, initiateSilentLogin has already
      // persisted a session for a user that is no longer active. Drop it.
      const currentActive = await loadActiveWebId();
      if (currentActive !== session.webId) {
        await clearSessionForClient(clientId);
        return null;
      }
      const keyPair = await importDpopKeyPair(session.dpopKeyPair);
      const ctx: SessionContext = { session, keyPair };
      sessionCache.set(clientId, ctx);
      return ctx;
    } catch {
      // Silent auth fails when the IdP requires interactive consent for this
      // client ID (OIDC consent_required). The page can recover by calling
      // solid.login() explicitly.
      return null;
    } finally {
      pendingSilentAuth.delete(clientId);
    }
  })();

  pendingSilentAuth.set(clientId, promise);
  return promise;
}

async function loadFallbackSessionContext(excludeClientId: string): Promise<SessionContext | null> {
  // Prefer the extension's own client session (the one the user consented to
  // in the popup) so that fetches from arbitrary pages transparently reuse
  // the authenticated identity. If that isn't available, any other existing
  // session will do.
  const sessions = await loadSessions();
  const candidates = [EXTENSION_CLIENT_ID, ...Object.keys(sessions)]
    .filter((id) => id !== excludeClientId && id in sessions);
  const fallbackId = candidates[0];
  if (!fallbackId) return null;
  const cached = sessionCache.get(fallbackId);
  if (cached) return cached;
  const ctx = await loadSessionContextFromStorage(fallbackId);
  if (ctx) sessionCache.set(fallbackId, ctx);
  return ctx;
}

async function refreshIfNeeded(
  clientId: string,
  ctx: SessionContext,
): Promise<SessionContext | null> {
  if (ctx.session.expiresAt >= Date.now() + 30_000) return ctx;
  try {
    ctx.session = await refreshAccessToken(ctx.session, ctx.keyPair);
    sessionCache.set(clientId, ctx);
    return ctx;
  } catch {
    sessionCache.delete(clientId);
    await clearSessionForClient(clientId);
    return silentlyAuthenticate(clientId);
  }
}

async function ensureSessionForClient(clientId: string): Promise<SessionContext | null> {
  let ctx = sessionCache.get(clientId) ?? await loadSessionContextFromStorage(clientId);
  if (ctx) {
    sessionCache.set(clientId, ctx);
    return refreshIfNeeded(clientId, ctx);
  }

  // No stored session for this client ID. Try a silent OIDC re-auth first;
  // this succeeds for clients the user has previously consented to (e.g. a
  // cleared cache where the IdP SSO cookie is still valid).
  ctx = await silentlyAuthenticate(clientId);
  if (ctx) return refreshIfNeeded(clientId, ctx);

  // Silent re-auth failed — typically because the IdP would require explicit
  // consent for this new client. Transparently fall back to any existing
  // session (preferring the extension's default) so the user doesn't get a
  // consent popup every time a new page with its own client ID issues a
  // fetch. Pages that want per-client identity can still opt in by calling
  // solid.login() explicitly.
  const fallback = await loadFallbackSessionContext(clientId);
  if (!fallback) return null;
  return refreshIfNeeded(fallback.session.clientId, fallback);
}

function parseProfileFromTurtle(webId: string, turtle: string): { name: string | null; photoUrl: string | null } {
  const parser = new Parser({ baseIRI: webId.split('#')[0] });
  const store = new Store();
  store.addQuads(parser.parse(turtle));

  const dataset = new WebIdDataset(store, DataFactory);
  const agent = dataset.mainSubject;
  return {
    name: agent?.name ?? null,
    photoUrl: agent?.photoUrl ?? null,
  };
}

async function fetchAndStoreProfile(webId: string): Promise<void> {
  try {
    const response = await fetch(webId, {
      headers: { Accept: 'text/turtle' },
    });
    if (!response.ok) return;
    const turtle = await response.text();
    const { name, photoUrl } = parseProfileFromTurtle(webId, turtle);
    await saveProfile({ webId, name, photoUrl, turtle });
  } catch {
    // Profile fetch is best-effort
  }
}

function broadcastStateChange(webId: string | null, profileTurtle?: string): void {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'SOLID_STATE_CHANGED',
          webId,
          profileTurtle: profileTurtle ?? null,
        }).catch(() => {});
      }
    }
  });
}

async function handleAuthFetch(
  message: {
    requestId: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
    origin?: string;
  }
): Promise<{
  requestId: string;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
}> {
  const clientId = await resolveClientIdForOrigin(message.origin);
  const ctx = await ensureSessionForClient(clientId);
  if (!ctx) {
    return { requestId: message.requestId, error: 'Not authenticated' };
  }

  const { session, keyPair } = ctx;

  try {
    const dpopProof = await createDpopProof(keyPair, message.method, message.url);

    const fetchHeaders: Record<string, string> = {
      ...message.headers,
      Authorization: `DPoP ${session.accessToken}`,
      DPoP: dpopProof,
    };

    const response = await fetch(message.url, {
      method: message.method,
      headers: fetchHeaders,
      body: message.body,
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const body = await response.text();

    return {
      requestId: message.requestId,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body,
    };
  } catch (err) {
    return {
      requestId: message.requestId,
      error: err instanceof Error ? err.message : 'Fetch failed',
    };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SOLID_LOGIN') {
    const loginWithClientId = async () => {
      const clientIds = await loadClientIds();
      const staticClientId = message.clientId || clientIds[message.origin] || undefined;
      return initiateLogin(message.webId, staticClientId);
    };
    loginWithClientId()
      .then(async (session) => {
        const previousWebId = await loadActiveWebId();
        if (previousWebId && previousWebId !== session.webId) {
          sessionCache.clear();
          pendingSilentAuth.clear();
          await clearAllSessions();
          // initiateLogin already persisted this session; re-save after purging the old user's map.
          await saveSession(session);
        }
        sessionCache.set(session.clientId, {
          session,
          keyPair: await importDpopKeyPair(session.dpopKeyPair),
        });
        await saveActiveWebId(session.webId);
        await fetchAndStoreProfile(session.webId);
        const profile = await loadProfile();
        broadcastStateChange(session.webId, profile?.turtle);
        sendResponse({ ok: true, webId: session.webId });
      })
      .catch((err) => {
        sendResponse({ error: err.message });
      });
    return true;
  }

  if (message.type === 'SOLID_FETCH_REQUEST') {
    handleAuthFetch(message).then(sendResponse);
    return true;
  }

  if (message.type === 'SOLID_GET_STATE') {
    (async () => {
      const webId = await loadActiveWebId();
      const profile = await loadProfile();
      const pastProfiles = await loadPastProfiles();
      sendResponse({
        webId,
        isActive: webId !== null,
        profileTurtle: profile?.turtle ?? null,
        profileName: profile?.name ?? null,
        profilePhotoUrl: profile?.photoUrl ?? null,
        pastProfiles,
      });
    })();
    return true;
  }

  if (message.type === 'SOLID_SET_CLIENT_ID') {
    saveClientId(message.origin, message.clientId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'SOLID_LOGOUT') {
    sessionCache.clear();
    pendingSilentAuth.clear();
    Promise.all([clearAllSessions(), clearActiveWebId(), clearProfile()])
      .then(() => {
        broadcastStateChange(null);
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  return false;
});

// Restore broadcast state on service worker startup
(async () => {
  const webId = await loadActiveWebId();
  if (!webId) return;
  // Warm the cache for any stored sessions so later fetches skip storage round-trips.
  const sessions = await loadSessions();
  for (const [clientId, session] of Object.entries(sessions)) {
    sessionCache.set(clientId, {
      session,
      keyPair: await importDpopKeyPair(session.dpopKeyPair),
    });
  }
  const profile = await loadProfile();
  broadcastStateChange(webId, profile?.turtle);
})();
