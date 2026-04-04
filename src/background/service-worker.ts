import { initiateLogin, refreshAccessToken, createDpopProof } from './auth-flow';
import {
  loadSession,
  clearSession,
  clearProfile,
  importDpopKeyPair,
  saveClientId,
  loadClientIds,
  saveProfile,
  loadProfile,
  loadPastProfiles,
  type StoredSession,
} from './session-database';
import { Parser } from 'n3';
import { Agent, WebIdDataset } from '@solid/object';
import { DataFactory } from 'n3';

let currentSession: StoredSession | null = null;
let currentKeyPair: CryptoKeyPair | null = null;

async function ensureSession(): Promise<{ session: StoredSession; keyPair: CryptoKeyPair } | null> {
  if (!currentSession) {
    currentSession = await loadSession();
  }
  if (!currentSession) return null;

  if (!currentKeyPair) {
    currentKeyPair = await importDpopKeyPair(currentSession.dpopKeyPair);
  }

  // Refresh token if expired or about to expire (30s buffer)
  if (currentSession.expiresAt < Date.now() + 30_000) {
    try {
      currentSession = await refreshAccessToken(currentSession, currentKeyPair);
    } catch {
      currentSession = null;
      currentKeyPair = null;
      await clearSession();
      return null;
    }
  }

  return { session: currentSession, keyPair: currentKeyPair };
}

function parseProfileFromTurtle(webId: string, turtle: string): { name: string | null; photoUrl: string | null } {
  const parser = new Parser({ baseIRI: webId.split('#')[0] });
  const store = new (require('n3').Store)();
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
  }
): Promise<{
  requestId: string;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
}> {
  const ctx = await ensureSession();
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
        currentSession = session;
        currentKeyPair = null;
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
      const ctx = await ensureSession();
      const profile = await loadProfile();
      const pastProfiles = await loadPastProfiles();
      sendResponse({
        webId: ctx?.session.webId ?? null,
        isActive: ctx !== null,
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
    currentSession = null;
    currentKeyPair = null;
    Promise.all([clearSession(), clearProfile()])
      .then(() => {
        broadcastStateChange(null);
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  return false;
});

// Restore session on service worker startup
ensureSession().then(async (ctx) => {
  if (ctx) {
    const profile = await loadProfile();
    broadcastStateChange(ctx.session.webId, profile?.turtle);
  }
});
