// AUTHORED-BY Claude Opus 4.8
/**
 * The MV3 side panel — a PERSISTENT account surface (vs the ephemeral toolbar popup).
 * Chrome keeps the side panel open as the user navigates and switches tabs, so the
 * signed-in account / signed-out login stays a glance away without re-opening a popup.
 *
 * It renders the IDENTICAL surface as the popup — `<jeswr-login-panel>` signed out,
 * `<jeswr-account-menu>` + pod shortcuts signed in — by REUSING the popup's account
 * surface ({@link mountAccountSurface}) driven by the SAME `MessageBridgeLoginController`
 * (the token-free, service-worker-backed bridge). No auth runs here: the service worker
 * is the sole token holder; this panel only reflects state and proxies actions over the
 * existing `chrome.runtime` message protocol — exactly like the popup. The popup is
 * unchanged and keeps working; both share the one controller seam.
 */

// Side-effect import: registers <jeswr-login-panel>, <jeswr-account-menu>, <jeswr-theme-toggle>, etc.
import '@jeswr/solid-elements';
import { mountAccountSurface, resolveAccountSurfaceElements } from '../popup/account-surface';

// Wire the shared account surface (busy → signed-in / signed-out, all the auth invariants).
mountAccountSurface(resolveAccountSurfaceElements());
