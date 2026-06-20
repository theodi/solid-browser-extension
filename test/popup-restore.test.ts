// @vitest-environment jsdom
// AUTHORED-BY Claude Opus 4.8
/**
 * Popup silent-session-restore wiring (roborev finding: the `auto-restore` markup trap).
 *
 * The popup OWNS the restore flow: on open it shows "Restoring…" and asks the service
 * worker for state (SOLID_GET_STATE) via refresh(); a returning user with a live SW
 * session lands signed-in with NO re-auth. The `<jeswr-login-panel>`'s OWN
 * auto-restore-on-connect is deliberately DISABLED — set via the `.autoRestore = false`
 * PROPERTY in popup.ts, not the ambiguous `auto-restore="false"` markup attribute — so the
 * panel does not independently run controller.restore() and race the popup's explicit view
 * control. These tests assert BOTH halves on the real DOM (jsdom + the real custom element):
 *   (1) silent restore still works (returning user → #signed-in, no login prompt);
 *   (2) the panel's autoRestore property is actually false (popup-driven, unambiguous);
 *   (3) no active session → #signed-out (the login surface), restore fell back correctly.
 *
 * popup.ts is a side-effecting module that wires everything at import time, so each test
 * resets the module registry + DOM + a fresh chrome stub, then imports it once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface PopupChromeOptions {
  /** The SOLID_GET_STATE reply (the SW's restored-session decision). */
  state: Record<string, unknown>;
}

/** Build the popup's markup exactly as popup.html does (the bits popup.ts queries). */
function mountPopupDom(): void {
  document.body.innerHTML = `
    <div id="pin-nudge" hidden></div>
    <button id="pin-nudge-dismiss" type="button"></button>
    <section id="signed-out" hidden>
      <jeswr-login-panel id="login-panel"></jeswr-login-panel>
    </section>
    <section id="busy" hidden></section>
    <section id="signed-in" hidden>
      <jeswr-account-menu id="account-menu"></jeswr-account-menu>
      <a id="shortcut-profile" href="#"></a>
    </section>
  `;
}

/** Stub chrome.* so popup.ts's SOLID_GET_STATE / storage calls resolve deterministically. */
function installPopupChrome({ state }: PopupChromeOptions): void {
  vi.stubGlobal('chrome', {
    runtime: {
      lastError: undefined as { message?: string } | undefined,
      sendMessage: (message: { type?: string }, callback: (response: unknown) => void) => {
        if (message?.type === 'SOLID_GET_STATE') callback(state);
        else callback({ ok: true });
      },
      onMessage: { addListener: () => {} },
    },
    storage: {
      local: {
        get: () => Promise.resolve({}),
        remove: () => Promise.resolve(),
      },
    },
  });
}

/** Load the side-effecting popup module fresh, then let its async refresh() settle. */
async function loadPopup(): Promise<void> {
  vi.resetModules();
  await import('../src/popup/popup');
  // refresh() is async (awaits SOLID_GET_STATE); flush microtasks + the controller render.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const visible = (id: string): boolean =>
  !(document.getElementById(id) as HTMLElement | null)?.hidden;

beforeEach(() => {
  mountPopupDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.innerHTML = '';
});

describe('popup silent session restore (panel autoRestore disabled; popup owns restore)', () => {
  it('a returning user with a live SW session lands SIGNED-IN with no re-auth', async () => {
    installPopupChrome({
      state: {
        webId: 'https://alice.pod.example/profile/card#me',
        isActive: true,
        name: 'Alice',
        photoUrl: null,
        recentAccounts: [],
      },
    });
    await loadPopup();

    // Silent restore succeeded: the signed-in surface is shown, NOT the login prompt.
    expect(visible('signed-in')).toBe(true);
    expect(visible('signed-out')).toBe(false);
    expect(visible('busy')).toBe(false);
    // The account menu reflects the restored identity.
    expect(document.getElementById('account-menu')?.getAttribute('webid')).toBe(
      'https://alice.pod.example/profile/card#me',
    );
  });

  it('the panel.autoRestore PROPERTY is false (unambiguous popup-driven restore; no markup trap)', async () => {
    installPopupChrome({
      state: { webId: null, isActive: false, name: null, photoUrl: null, recentAccounts: [] },
    });
    await loadPopup();

    const panel = document.getElementById('login-panel') as HTMLElement & { autoRestore: boolean };
    // The PROPERTY is the source of truth — explicitly false (popup.ts sets it), not relying
    // on hand-authored ambiguous `auto-restore="false"` markup that reads like the Lit
    // boolean-attribute trap.
    expect(panel.autoRestore).toBe(false);
    // The panel REFLECTS the property back to the attribute as "false" (its custom converter's
    // toAttribute) — confirming the disable came from the property, and the reflected value is
    // the converter's explicit disabling token (never a bare/present attribute reading "true").
    expect(panel.getAttribute('auto-restore')).toBe('false');
  });

  it('no active SW session → falls back to the SIGNED-OUT login surface', async () => {
    installPopupChrome({
      state: { webId: null, isActive: false, name: null, photoUrl: null, recentAccounts: [] },
    });
    await loadPopup();

    expect(visible('signed-out')).toBe(true);
    expect(visible('signed-in')).toBe(false);
    expect(visible('busy')).toBe(false);
  });
});
