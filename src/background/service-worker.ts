import { initiateLogin, refreshAccessToken, createDpopProof } from './auth-flow';
import {
  loadSession,
  clearSession,
  importDpopKeyPair,
  saveClientId,
  loadClientIds,
  type StoredSession,
} from './session-database';

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
      // Refresh failed — session is dead
      currentSession = null;
      currentKeyPair = null;
      await clearSession();
      return null;
    }
  }

  return { session: currentSession, keyPair: currentKeyPair };
}

function broadcastStateChange(webId: string | null): void {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'SOLID_STATE_CHANGED',
          webId,
        }).catch(() => {
          // Tab may not have content script loaded
        });
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
    initiateLogin(message.idpUrl)
      .then((session) => {
        currentSession = session;
        currentKeyPair = null; // Will be reimported on next use
        broadcastStateChange(session.webId);
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
    ensureSession().then((ctx) => {
      sendResponse({
        webId: ctx?.session.webId ?? null,
        isActive: ctx !== null,
      });
    });
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
    clearSession()
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
ensureSession().then((ctx) => {
  if (ctx) {
    broadcastStateChange(ctx.session.webId);
  }
});
