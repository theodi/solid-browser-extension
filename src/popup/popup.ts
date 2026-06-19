// AUTHORED-BY Claude Opus 4.8
/**
 * The popup IS the account UI — sign in / out, switch WebID, pod shortcuts, theme —
 * built with @jeswr/solid-elements (`jeswr-account-menu` + `jeswr-theme-toggle`) so it is
 * visually consistent with Pod Manager and the rest of the suite. The popup does NOT run
 * its own auth: it talks to the service worker (the sole token holder) over the message
 * protocol and reflects state.
 *
 * Why not `jeswr-login-panel` for the signed-out form: that element drives the
 * @solid/reactive-authentication popup/redirect flow (a `LoginController`), which is the
 * normal-SPA login. The extension's login runs through `chrome.identity.launchWebAuthFlow`
 * in the worker instead, so the signed-out state uses a small native WebID form that asks
 * the worker to log in; the account-menu + theme-toggle web components give it the shared
 * look. (Adopting `jeswr-login-panel` would require a chrome.identity-backed
 * LoginController — a clean follow-up.)
 */

// Side-effect import: registers <jeswr-account-menu>, <jeswr-theme-toggle>, etc.
import '@jeswr/solid-elements';
import type { SessionState } from '../shared/messages';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const signedOut = el('signed-out');
const busy = el('busy');
const busyText = el('busy-text');
const signedIn = el('signed-in');
const loginForm = el<HTMLFormElement>('login-form');
const webidInput = el<HTMLInputElement>('webid-input');
const loginError = el('login-error');
const recentAccounts = el('recent-accounts');
const accountMenu = el('account-menu');
const shortcutProfile = el<HTMLAnchorElement>('shortcut-profile');
const pinNudge = el('pin-nudge');

type View = 'signed-out' | 'busy' | 'signed-in';
function show(view: View): void {
  signedOut.hidden = view !== 'signed-out';
  busy.hidden = view !== 'busy';
  signedIn.hidden = view !== 'signed-in';
}

function send<T>(message: unknown): Promise<T> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

function showError(message: string): void {
  loginError.textContent = message;
  loginError.hidden = false;
}

function renderSignedIn(state: SessionState): void {
  // <jeswr-account-menu> attributes: `webid`, `name`, `avatar-url` (see the component).
  accountMenu.setAttribute('webid', state.webId ?? '');
  accountMenu.setAttribute('name', state.name ?? '');
  if (state.photoUrl) accountMenu.setAttribute('avatar-url', state.photoUrl);
  else accountMenu.removeAttribute('avatar-url');

  // Pod shortcut: the user's profile document (drop the fragment).
  if (state.webId) {
    shortcutProfile.href = state.webId.split('#')[0];
    shortcutProfile.hidden = false;
  } else {
    shortcutProfile.hidden = true;
  }
  show('signed-in');
}

function renderRecentAccounts(state: SessionState): void {
  recentAccounts.replaceChildren();
  if (state.recentAccounts.length === 0) return;

  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = 'Recent accounts';
  recentAccounts.appendChild(label);

  for (const account of state.recentAccounts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'account-item';

    const avatar = document.createElement('span');
    avatar.className = 'account-avatar';
    if (account.photoUrl) {
      const img = document.createElement('img');
      img.src = account.photoUrl;
      img.alt = '';
      avatar.appendChild(img);
    } else {
      avatar.textContent = (account.name ?? account.webId).charAt(0).toUpperCase();
    }

    const name = document.createElement('span');
    name.className = 'account-name';
    name.textContent = account.name ?? account.webId;

    btn.append(avatar, name);
    btn.addEventListener('click', () => doLogin(account.webId));
    recentAccounts.appendChild(btn);
  }
}

async function doLogin(webId: string): Promise<void> {
  loginError.hidden = true;
  busyText.textContent = 'Signing in…';
  show('busy');
  const result = await send<{ ok?: boolean; webId?: string; error?: string }>({
    type: 'SOLID_LOGIN',
    webId,
  });
  if (result?.error) {
    showError(result.error);
    await refresh();
  }
  // Success path is driven by the SOLID_STATE_CHANGED broadcast -> refresh().
}

async function refresh(): Promise<void> {
  const state = await send<SessionState>({ type: 'SOLID_GET_STATE' });
  if (state?.isActive && state.webId) {
    renderSignedIn(state);
  } else {
    renderRecentAccounts(state);
    show('signed-out');
  }
}

// --- Wiring ---------------------------------------------------------------------------

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const webId = webidInput.value.trim();
  if (webId) void doLogin(webId);
});

// The account-menu emits `sign-out`.
accountMenu.addEventListener('sign-out', () => {
  void send({ type: 'SOLID_LOGOUT' }).then(() => refresh());
});

// React to background state broadcasts while the popup is open.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'SOLID_STATE_CHANGED') void refresh();
});

// First-run pin nudge (extensions can't self-pin).
chrome.storage.local.get('solid:show-pin-nudge').then((result) => {
  if (result['solid:show-pin-nudge']) pinNudge.hidden = false;
});
el<HTMLButtonElement>('pin-nudge-dismiss').addEventListener('click', () => {
  pinNudge.hidden = true;
  void chrome.storage.local.remove('solid:show-pin-nudge');
});

// Initial paint: show "Restoring" while we read state.
show('busy');
void refresh();
