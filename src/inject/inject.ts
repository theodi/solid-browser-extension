export {};

import { Parser, Store, DataFactory } from 'n3';
import { Agent, WebIdDataset } from '@solid/object';

const SOLID_EXT_PREFIX = 'solid-browser-ext';

interface SolidExtension {
  readonly webId: string | null;
  readonly profile: Agent | null;
  readonly clientId: string | undefined;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  setClientId(clientId: string): void;
  login(webId: string): Promise<void>;
  logout(): Promise<void>;
}

const pendingRequests = new Map<string, {
  resolve: (value: Response) => void;
  reject: (reason: Error) => void;
}>();

const pendingActions = new Map<string, {
  resolve: (value: void) => void;
  reject: (reason: Error) => void;
}>();

let currentWebId: string | null = null;
let currentProfile: Agent | null = null;

function buildProfile(webId: string, turtle: string): Agent | null {
  try {
    const parser = new Parser({ baseIRI: webId.split('#')[0] });
    const store = new Store();
    store.addQuads(parser.parse(turtle));
    const dataset = new WebIdDataset(store, DataFactory);
    return dataset.mainSubject ?? null;
  } catch {
    return null;
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.source !== SOLID_EXT_PREFIX) return;

  const { type } = event.data;

  if (type === 'SOLID_FETCH_RESPONSE') {
    const pending = pendingRequests.get(event.data.requestId);
    if (!pending) return;
    pendingRequests.delete(event.data.requestId);

    if (event.data.error) {
      pending.reject(new Error(event.data.error));
    } else {
      pending.resolve(new Response(event.data.body, {
        status: event.data.status,
        statusText: event.data.statusText,
        headers: new Headers(event.data.headers),
      }));
    }
  }

  if (type === 'SOLID_STATE_UPDATE') {
    currentWebId = event.data.webId ?? null;
    if (currentWebId && event.data.profileTurtle) {
      currentProfile = buildProfile(currentWebId, event.data.profileTurtle);
    } else {
      currentProfile = null;
    }
  }

  if (type === 'SOLID_ACTION_RESPONSE') {
    const pending = pendingActions.get(event.data.actionId);
    if (!pending) return;
    pendingActions.delete(event.data.actionId);

    if (event.data.error) {
      pending.reject(new Error(event.data.error));
    } else {
      pending.resolve();
    }
  }
});

function solidFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    pendingRequests.set(requestId, { resolve, reject });

    window.postMessage({
      source: SOLID_EXT_PREFIX,
      type: 'SOLID_FETCH_REQUEST',
      requestId,
      url: input.toString(),
      method: init?.method || 'GET',
      headers: init?.headers
        ? Object.fromEntries(new Headers(init.headers).entries())
        : {},
      body: init?.body ?? null,
    }, '*');
  });
}

let currentClientId: string | undefined;

function setClientId(clientId: string): void {
  currentClientId = clientId;
  window.postMessage({
    source: SOLID_EXT_PREFIX,
    type: 'SOLID_SET_CLIENT_ID',
    origin: window.location.origin,
    clientId,
  }, '*');
}

function login(webId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const actionId = crypto.randomUUID();
    pendingActions.set(actionId, { resolve, reject });

    window.postMessage({
      source: SOLID_EXT_PREFIX,
      type: 'SOLID_LOGIN',
      actionId,
      webId,
      origin: window.location.origin,
      clientId: currentClientId,
    }, '*');
  });
}

function logout(): Promise<void> {
  return new Promise((resolve, reject) => {
    const actionId = crypto.randomUUID();
    pendingActions.set(actionId, { resolve, reject });

    window.postMessage({
      source: SOLID_EXT_PREFIX,
      type: 'SOLID_LOGOUT',
      actionId,
    }, '*');
  });
}

const solid: SolidExtension = {
  get webId() {
    return currentWebId;
  },
  get profile() {
    return currentProfile;
  },
  get clientId() {
    return currentClientId;
  },
  fetch: solidFetch,
  setClientId,
  login,
  logout,
};

Object.defineProperty(window, 'solid', {
  value: solid,
  writable: false,
  configurable: false,
});

// Request current session state on load
window.postMessage({
  source: SOLID_EXT_PREFIX,
  type: 'SOLID_GET_STATE',
}, '*');
