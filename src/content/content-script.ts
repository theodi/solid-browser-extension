// AUTHORED-BY Claude Opus 4.8
/**
 * The ISOLATED-world bridge between the page (MAIN-world `window.solid`) and the service
 * worker. It is the trust boundary: the page can only ASK; this script decides what to
 * forward and stamps the page's REAL origin (read here, not page-supplied) onto
 * origin-sensitive messages (login, set-client-id) so a page cannot impersonate another
 * origin's client-id mapping.
 */

export {};

const CHANNEL = 'solid-browser-ext';

interface PageMessage {
  channel: string;
  dir: string;
  type: string;
  requestId?: string;
  actionId?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  webId?: string;
  clientId?: string;
  autoDivert?: boolean;
}

function toPage(message: Record<string, unknown>): void {
  window.postMessage({ channel: CHANNEL, dir: 'to-page', ...message }, window.location.origin);
}

window.addEventListener('message', (event) => {
  // Only same-window, our-channel, page->content messages.
  if (event.source !== window) return;
  const data = event.data as PageMessage | undefined;
  if (!data || data.channel !== CHANNEL || data.dir !== 'to-content') return;

  switch (data.type) {
    case 'SOLID_FETCH_REQUEST':
      chrome.runtime.sendMessage(
        {
          type: 'SOLID_FETCH_REQUEST',
          requestId: data.requestId,
          url: data.url,
          method: data.method,
          headers: data.headers ?? {},
          body: data.body ?? null,
          // Forward whether this was the best-effort global-fetch patch (autoDivert) vs an
          // explicit window.solid.fetch — drives the SW's native-passthrough-vs-403 choice
          // (High #1). It is a behaviour HINT, never a security input: the SW still runs the
          // full origin gate; autoDivert only softens a DENY to a plain unauthenticated fetch.
          autoDivert: data.autoDivert === true,
          // Stamp the REAL page origin (read HERE in the ISOLATED world, not page-supplied)
          // so the worker's per-requesting-origin gate can cross-check it against the
          // browser-attested sender.origin. The worker trusts the browser value, not this.
          stampedOrigin: window.location.origin,
        },
        (response) => {
          toPage({ type: 'SOLID_FETCH_RESPONSE', ...(response ?? { error: 'No response' }) });
        },
      );
      break;

    case 'SOLID_GET_STATE':
      chrome.runtime.sendMessage(
        { type: 'SOLID_GET_STATE', stampedOrigin: window.location.origin },
        (response) => {
          toPage({ type: 'SOLID_STATE_UPDATE', webId: response?.webId ?? null });
        },
      );
      break;

    case 'SOLID_SET_CLIENT_ID':
      // Stamp the REAL page origin; the page cannot set it for another origin.
      chrome.runtime.sendMessage({
        type: 'SOLID_SET_CLIENT_ID',
        origin: window.location.origin,
        clientId: data.clientId,
      });
      break;

    case 'SOLID_LOGIN':
      chrome.runtime.sendMessage(
        {
          type: 'SOLID_LOGIN',
          webId: data.webId,
          origin: window.location.origin,
          // The page-declared client-id is carried directly (avoids racing the
          // fire-and-forget setClientId storage write). The worker still validates it.
          clientId: data.clientId,
        },
        (response) => {
          toPage({
            type: 'SOLID_ACTION_RESPONSE',
            actionId: data.actionId,
            error: response?.error ?? null,
          });
        },
      );
      break;

    case 'SOLID_LOGOUT':
      chrome.runtime.sendMessage({ type: 'SOLID_LOGOUT' }, (response) => {
        toPage({
          type: 'SOLID_ACTION_RESPONSE',
          actionId: data.actionId,
          error: response?.error ?? null,
        });
      });
      break;
  }
});

// Relay worker -> page state broadcasts.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'SOLID_STATE_CHANGED') {
    toPage({ type: 'SOLID_STATE_UPDATE', webId: message.webId ?? null });
  }
});
