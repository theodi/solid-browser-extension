export {};

const SOLID_EXT_PREFIX = 'solid-browser-ext';

// Page -> Background: relay messages from MAIN world to service worker
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.source !== SOLID_EXT_PREFIX) return;

  const { type } = event.data;

  if (type === 'SOLID_FETCH_REQUEST') {
    chrome.runtime.sendMessage({
      type: 'SOLID_FETCH_REQUEST',
      requestId: event.data.requestId,
      url: event.data.url,
      method: event.data.method,
      headers: event.data.headers,
      body: event.data.body,
    }, (response) => {
      window.postMessage({
        source: SOLID_EXT_PREFIX,
        type: 'SOLID_FETCH_RESPONSE',
        ...response,
      }, '*');
    });
  }

  if (type === 'SOLID_GET_STATE') {
    chrome.runtime.sendMessage({ type: 'SOLID_GET_STATE' }, (response) => {
      window.postMessage({
        source: SOLID_EXT_PREFIX,
        type: 'SOLID_STATE_UPDATE',
        webId: response?.webId ?? null,
        profileTurtle: response?.profileTurtle ?? null,
      }, '*');
    });
  }

  if (type === 'SOLID_SET_CLIENT_ID') {
    chrome.runtime.sendMessage({
      type: 'SOLID_SET_CLIENT_ID',
      origin: event.data.origin,
      clientId: event.data.clientId,
    });
  }

  if (type === 'SOLID_LOGIN') {
    chrome.runtime.sendMessage({
      type: 'SOLID_LOGIN',
      actionId: event.data.actionId,
      webId: event.data.webId,
      origin: event.data.origin,
      clientId: event.data.clientId,
    }, (response) => {
      window.postMessage({
        source: SOLID_EXT_PREFIX,
        type: 'SOLID_ACTION_RESPONSE',
        actionId: event.data.actionId,
        error: response?.error ?? null,
      }, '*');
    });
  }

  if (type === 'SOLID_LOGOUT') {
    chrome.runtime.sendMessage({
      type: 'SOLID_LOGOUT',
      actionId: event.data.actionId,
    }, (response) => {
      window.postMessage({
        source: SOLID_EXT_PREFIX,
        type: 'SOLID_ACTION_RESPONSE',
        actionId: event.data.actionId,
        error: response?.error ?? null,
      }, '*');
    });
  }
});

// Background -> Page: listen for state broadcasts from service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SOLID_STATE_CHANGED') {
    window.postMessage({
      source: SOLID_EXT_PREFIX,
      type: 'SOLID_STATE_UPDATE',
      webId: message.webId,
      profileTurtle: message.profileTurtle ?? null,
    }, '*');
  }
});
