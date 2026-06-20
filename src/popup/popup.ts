// AUTHORED-BY Claude Opus 4.8
/**
 * The popup IS the account UI — sign in / out, switch WebID, pod shortcuts, theme —
 * built with @jeswr/solid-elements (`jeswr-login-panel` + `jeswr-account-menu` +
 * `jeswr-theme-toggle`) so it is visually consistent with Pod Manager and the rest of
 * the suite. The popup does NOT run its own auth: it talks to the service worker (the
 * sole token holder) over the message protocol and reflects state.
 *
 * The account surface (view switching + the MessageBridgeLoginController wiring) is
 * shared with the persistent side panel via {@link mountAccountSurface} — the popup and
 * the side panel render the IDENTICAL signed-in/signed-out surface from the SAME
 * controller seam (see account-surface.ts; the controller is reused, never duplicated).
 * The only popup-specific chrome here is the first-run "pin me" nudge (extensions cannot
 * self-pin), which the side panel has no need for.
 */

// Side-effect import: registers <jeswr-login-panel>, <jeswr-account-menu>, <jeswr-theme-toggle>, etc.
import '@jeswr/solid-elements';
import { mountAccountSurface, resolveAccountSurfaceElements } from './account-surface';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// Wire the shared account surface (busy → signed-in / signed-out, all the auth invariants).
mountAccountSurface(resolveAccountSurfaceElements());

// First-run pin nudge (extensions can't self-pin) — popup-only onboarding.
const pinNudge = el('pin-nudge');
chrome.storage.local.get('solid:show-pin-nudge').then((result) => {
  if (result['solid:show-pin-nudge']) pinNudge.hidden = false;
});
el<HTMLButtonElement>('pin-nudge-dismiss').addEventListener('click', () => {
  pinNudge.hidden = true;
  void chrome.storage.local.remove('solid:show-pin-nudge');
});
