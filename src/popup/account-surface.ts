// AUTHORED-BY Claude Opus 4.8
/**
 * The shared account UI surface, wired ONCE and reused by BOTH the ephemeral toolbar
 * popup (popup.ts) and the persistent MV3 side panel (sidepanel/sidepanel.ts).
 *
 * Both surfaces show the EXACT same thing — `<jeswr-login-panel>` when signed out,
 * `<jeswr-account-menu>` + pod shortcuts when signed in — driven by the SAME
 * `MessageBridgeLoginController` (the token-free, service-worker-backed bridge in
 * message-bridge-controller.ts). The controller is NOT duplicated: this module imports it
 * and both entry points call {@link mountAccountSurface} against their own DOM. The auth
 * always runs in the service worker (the sole token holder); this surface only reflects
 * state and proxies actions over the existing `chrome.runtime` message protocol.
 *
 * Every invariant the popup hard-won is preserved here verbatim (they are load-bearing):
 *   - the panel's OWN auto-restore is disabled via the `.autoRestore = false` PROPERTY
 *     (NOT the ambiguous `auto-restore="false"` markup attribute) so the surface owns the
 *     restore flow and the panel never races it;
 *   - a generation token guards refresh() so a slow in-flight refresh can't apply a stale
 *     view over a newer one;
 *   - showSignedOut() SWAPS in a fresh hydrated controller (the panel's supported reset)
 *     so a prior `authenticated` phase can never bleed through inside #signed-out;
 *   - a logged-OUT session-change only reveals #signed-out (no re-swap → no recursion).
 */

import type { LoginDetail, SessionChangeDetail } from '@jeswr/solid-elements';
import type { SessionState } from '../shared/messages';
import { MessageBridgeLoginController } from './message-bridge-controller';

/** The `<jeswr-login-panel>` element surface this module drives (see popup.ts notes). */
export interface LoginPanelElement extends HTMLElement {
  controller?: MessageBridgeLoginController;
  /**
   * The panel's own silent-restore-on-connect. We set this FALSE: this surface owns the
   * restore flow (refresh() → SOLID_GET_STATE → renderSignedIn), so the panel must NOT
   * independently run controller.restore() and flip its internal phase — which would race
   * the surface's explicit view control inside the #signed-out section.
   */
  autoRestore: boolean;
  requestUpdate(): void;
}

/** The DOM handles a hosting page (popup.html / sidepanel.html) provides to this surface. */
export interface AccountSurfaceElements {
  readonly signedOut: HTMLElement;
  readonly busy: HTMLElement;
  readonly signedIn: HTMLElement;
  readonly loginPanel: LoginPanelElement;
  readonly accountMenu: HTMLElement;
  readonly shortcutProfile: HTMLAnchorElement;
}

type View = 'signed-out' | 'busy' | 'signed-in';

/**
 * What {@link mountAccountSurface} returns: the live bridge controller (so callers/tests can
 * inspect it) plus a `cleanup` that detaches every listener this mount added (notably the
 * long-lived `chrome.runtime.onMessage` listener). The ephemeral popup can ignore the result;
 * the persistent side panel MUST call `cleanup()` on teardown, otherwise a remount accumulates
 * duplicate `onMessage` listeners (and duplicate refresh() calls) on the long-lived document.
 */
export interface MountedAccountSurface {
  readonly controller: MessageBridgeLoginController;
  readonly cleanup: () => void;
}

/**
 * A weak guard against double-mounting the SAME document: each mount tags its host document so a
 * second mount (e.g. an accidental re-import in the long-lived side panel) is a no-op that just
 * returns the existing mount's handle rather than stacking a second set of listeners.
 */
const MOUNTED = new WeakMap<Document, MountedAccountSurface>();

/** Resolve the standard surface elements from a root document by their shared ids. */
export function resolveAccountSurfaceElements(doc: Document = document): AccountSurfaceElements {
  const byId = <T extends HTMLElement>(id: string): T => doc.getElementById(id) as T;
  return {
    signedOut: byId('signed-out'),
    busy: byId('busy'),
    signedIn: byId('signed-in'),
    loginPanel: byId<LoginPanelElement>('login-panel'),
    accountMenu: byId('account-menu'),
    shortcutProfile: byId<HTMLAnchorElement>('shortcut-profile'),
  };
}

function send<T>(message: unknown): Promise<T> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

/**
 * Wire the shared account surface against `els` and kick off the initial paint
 * ("Restoring…" → state read → signed-in / signed-out). Returns the live controller
 * instance (the bridge) plus a `cleanup` that detaches every listener added here (so the
 * long-lived side panel can tear down without leaking the `chrome.runtime.onMessage`
 * listener). Guarded against double-mounting the same document: a second call on a document
 * already mounted returns the existing handle without stacking another set of listeners.
 *
 * The ephemeral popup may ignore the return (it is torn down with its document); the
 * persistent side panel MUST call `cleanup()` on teardown / before any remount.
 */
export function mountAccountSurface(els: AccountSurfaceElements): MountedAccountSurface {
  const { signedOut, busy, signedIn, loginPanel, accountMenu, shortcutProfile } = els;

  // Double-mount guard: if THIS document is already mounted, do not stack a second set of
  // listeners (the long-lived side panel's failure mode) — return the existing handle.
  const hostDoc = loginPanel.ownerDocument;
  const existing = MOUNTED.get(hostDoc);
  if (existing) return existing;

  // Disable the panel's OWN silent-restore-on-connect via the PROPERTY (not a markup
  // attribute — `auto-restore="false"` reads ambiguous next to Lit's boolean-attribute
  // trap). This surface OWNS restore: the initial paint shows "Restoring…" and calls
  // refresh() → SOLID_GET_STATE, landing a returning user signed-in with no re-auth.
  // Set BEFORE the controller is assigned so the willUpdate that assignment triggers
  // already sees autoRestore=false and never kicks the panel's own restore.
  loginPanel.autoRestore = false;

  // The bridge: the panel's synchronous LoginController, backed by the worker over the
  // async message protocol. Holds no token. A `let` so we can SWAP it for a fresh instance
  // when transitioning to signed-out (the panel's supported reset path).
  let bridge = new MessageBridgeLoginController();
  loginPanel.controller = bridge;

  function show(view: View): void {
    signedOut.hidden = view !== 'signed-out';
    busy.hidden = view !== 'busy';
    signedIn.hidden = view !== 'signed-in';
  }

  // A monotonic generation token: each refresh() bumps + captures its own value so a slower
  // in-flight refresh resolving AFTER a newer one cannot apply a stale view.
  let refreshGeneration = 0;

  /**
   * Show the signed-out surface with the panel reset to the login prompt. Builds a fresh
   * controller (the panel's supported reset), HYDRATES it first (so the panel renders the
   * recent-accounts list on the swap render), THEN assigns it. Returns false if a newer
   * refresh superseded this one before the section was shown.
   */
  async function showSignedOut(generation: number): Promise<boolean> {
    const fresh = new MessageBridgeLoginController();
    await fresh.hydrate();
    if (generation !== refreshGeneration) return false; // superseded mid-hydrate
    bridge = fresh;
    loginPanel.controller = bridge; // swap → panel reconciles _phase to the prompt
    show('signed-out');
    return true;
  }

  function renderSignedIn(state: SessionState): void {
    accountMenu.setAttribute('webid', state.webId ?? '');
    accountMenu.setAttribute('name', state.name ?? '');
    if (state.photoUrl) accountMenu.setAttribute('avatar-url', state.photoUrl);
    else accountMenu.removeAttribute('avatar-url');

    if (state.webId) {
      shortcutProfile.href = state.webId.split('#')[0];
      shortcutProfile.hidden = false;
    } else {
      shortcutProfile.hidden = true;
    }
    show('signed-in');
  }

  /**
   * Read state from the worker and switch the view. Generation-guarded so a stale in-flight
   * refresh cannot apply an outdated view.
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

  // --- Wiring -------------------------------------------------------------------------

  // Track every detach so cleanup() removes ALL listeners this mount added (the long-lived
  // side panel relies on this; the ephemeral popup may ignore it).
  const detachers: Array<() => void> = [];

  // The panel drives login via the bridge (chrome.identity flow in the worker).
  const onLogin = (e: Event): void => {
    const detail = (e as CustomEvent<LoginDetail>).detail;
    if (detail?.webId) void refresh();
  };
  loginPanel.addEventListener('login', onLogin);
  detachers.push(() => loginPanel.removeEventListener('login', onLogin));

  const onSessionChange = (e: Event): void => {
    const detail = (e as CustomEvent<SessionChangeDetail>).detail;
    // A logged-IN change → confirm with the worker and render signed-in. A logged-OUT
    // change (incl. the one emitted during the showSignedOut() swap) only needs the
    // signed-out section visible — NOT another swap (which would re-emit and recurse).
    if (detail?.loggedIn) void refresh();
    else show('signed-out');
  };
  loginPanel.addEventListener('session-change', onSessionChange);
  detachers.push(() => loginPanel.removeEventListener('session-change', onSessionChange));

  // The account-menu emits `sign-out` → tear down in the worker, then re-render.
  const onSignOut = (): void => {
    void send({ type: 'SOLID_LOGOUT' }).then(() => refresh());
  };
  accountMenu.addEventListener('sign-out', onSignOut);
  detachers.push(() => accountMenu.removeEventListener('sign-out', onSignOut));

  // React to background state broadcasts while the surface is open (a page logs in, or the
  // worker's token expires/logs out): re-read state and re-render. This is the LONG-LIVED
  // listener: the side panel persists across navigation, so a remount without cleanup would
  // accumulate duplicate onMessage listeners (and duplicate refresh() calls).
  const onRuntimeMessage = (message: { type?: string }): void => {
    if (message?.type === 'SOLID_STATE_CHANGED') void refresh();
  };
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  detachers.push(() => chrome.runtime?.onMessage?.removeListener?.(onRuntimeMessage));

  // Initial paint: show "Restoring" while we read state.
  show('busy');
  void refresh();

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return; // idempotent
    cleaned = true;
    refreshGeneration++; // fence: any in-flight refresh resolving after teardown is a no-op
    for (const detach of detachers) detach();
    MOUNTED.delete(hostDoc);
  };

  const mounted: MountedAccountSurface = {
    get controller() {
      return bridge;
    },
    cleanup,
  };
  MOUNTED.set(hostDoc, mounted);
  return mounted;
}
