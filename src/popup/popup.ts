// AUTHORED-BY Claude Opus 4.8
/**
 * The popup IS the account UI — sign in / out, switch WebID, pod shortcuts, theme —
 * built with @jeswr/solid-elements (`jeswr-login-panel` + `jeswr-account-menu` +
 * `jeswr-theme-toggle`) so it is visually consistent with Pod Manager and the rest of
 * the suite. The popup does NOT run its own auth: it talks to the service worker (the
 * sole token holder) over the message protocol and reflects state.
 *
 * The signed-out surface is now adopted via `<jeswr-login-panel>` driven by a
 * `MessageBridgeLoginController` — a chrome.identity-backed LoginController whose
 * synchronous getters answer from a TOKEN-FREE popup-local mirror of SessionState and
 * whose login/logout/fetch are proxied to the worker (see message-bridge-controller.ts).
 * The credential never leaves the worker; the bridge proxies, it does not hold. The
 * signed-IN surface stays the `jeswr-account-menu` (the panel's own authenticated view
 * is not used — we drive view switching from the panel's events + SessionState).
 */

// Side-effect import: registers <jeswr-login-panel>, <jeswr-account-menu>, <jeswr-theme-toggle>, etc.
import '@jeswr/solid-elements';
import type { LoginDetail, SessionChangeDetail } from '@jeswr/solid-elements';
import type { SessionState } from '../shared/messages';
import { MessageBridgeLoginController } from './message-bridge-controller';

interface LoginPanelElement extends HTMLElement {
  controller?: MessageBridgeLoginController;
  requestUpdate(): void;
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const signedOut = el('signed-out');
const busy = el('busy');
const signedIn = el('signed-in');
const loginPanel = el<LoginPanelElement>('login-panel');
const accountMenu = el('account-menu');
const shortcutProfile = el<HTMLAnchorElement>('shortcut-profile');
const pinNudge = el('pin-nudge');

// The bridge: the panel's synchronous LoginController, backed by the worker over the
// async message protocol. Holds no token — see message-bridge-controller.ts. It is a
// `let` so we can SWAP it for a fresh instance when transitioning to signed-out: a
// controller swap is the panel's supported reset path (its willUpdate reconcile drops
// `_phase` back to the prompt and re-runs restore), which a bare `requestUpdate()`
// does NOT do — so without the swap an externally-triggered logout could leave the
// panel showing its stale signed-in view inside the #signed-out section.
let bridge = new MessageBridgeLoginController();
loginPanel.controller = bridge;

type View = 'signed-out' | 'busy' | 'signed-in';
function show(view: View): void {
  signedOut.hidden = view !== 'signed-out';
  busy.hidden = view !== 'busy';
  signedIn.hidden = view !== 'signed-in';
}

// A monotonic generation token: each refresh() bumps it and captures its own value, so a
// slower in-flight refresh that resolves AFTER a newer one cannot apply a stale view
// (e.g. an old "show signed-out" clobbering a freshly-rendered signed-in surface).
let refreshGeneration = 0;

/**
 * Show the signed-out surface with the panel reset to the login prompt. Builds a fresh
 * controller (the panel's supported reset, so a prior `authenticated` phase can never
 * bleed through), HYDRATES it first (so the panel renders the recent-accounts list on
 * the swap render), THEN assigns it. Returns false if a newer refresh superseded this
 * one before the section was shown (so the caller doesn't apply a stale view).
 */
async function showSignedOut(generation: number): Promise<boolean> {
  const fresh = new MessageBridgeLoginController();
  // Populate the token-free mirror (recent accounts) BEFORE the swap, so the panel reads
  // a hydrated controller during its reset render — hydrate() mutates private fields and
  // does not itself trigger a Lit update.
  await fresh.hydrate();
  if (generation !== refreshGeneration) return false; // superseded mid-hydrate
  bridge = fresh;
  loginPanel.controller = bridge; // swap → panel reconciles _phase to the prompt
  show('signed-out');
  return true;
}

function send<T>(message: unknown): Promise<T> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
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

/**
 * Read state from the worker and switch the view. When signed in, render the
 * account-menu surface; otherwise reset + show the panel (the signed-out surface).
 * Generation-guarded so a stale in-flight refresh cannot apply an outdated view.
 */
async function refresh(): Promise<void> {
  const generation = ++refreshGeneration;
  const state = await send<SessionState>({ type: 'SOLID_GET_STATE' });
  if (generation !== refreshGeneration) return; // a newer refresh superseded this one
  if (state?.isActive && state.webId) {
    renderSignedIn(state);
  } else {
    await showSignedOut(generation);
  }
}

// --- Wiring ---------------------------------------------------------------------------

// The panel drives login via the bridge (chrome.identity flow in the worker). On a
// successful login the panel emits `login` / `session-change`; reflect signed-in.
loginPanel.addEventListener('login', (e) => {
  const detail = (e as CustomEvent<LoginDetail>).detail;
  if (detail?.webId) void refresh();
});
loginPanel.addEventListener('session-change', (e) => {
  const detail = (e as CustomEvent<SessionChangeDetail>).detail;
  // A logged-IN change → confirm with the worker and render the signed-in surface. A
  // logged-OUT change (incl. the one the panel emits during the showSignedOut() swap)
  // only needs the signed-out section visible — NOT another swap (which would re-emit
  // and recurse), so just reveal it here; showSignedOut() already reset the panel.
  if (detail?.loggedIn) void refresh();
  else show('signed-out');
});

// The account-menu emits `sign-out` → tear down in the worker, then re-render.
accountMenu.addEventListener('sign-out', () => {
  void send({ type: 'SOLID_LOGOUT' }).then(() => refresh());
});

// React to background state broadcasts while the popup is open (e.g. a web page logs in,
// or the worker's token expires/logs out): re-read state and re-render. refresh() routes
// a now-inactive session through showSignedOut(), which swaps in a fresh controller so
// the panel resets to the login prompt (never a stale signed-in view).
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
