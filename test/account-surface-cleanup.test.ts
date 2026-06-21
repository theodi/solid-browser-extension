// @vitest-environment jsdom
// AUTHORED-BY Claude Opus 4.8
/**
 * Listener-lifecycle for the shared account surface (account-surface.ts) — the roborev finding
 * that the long-lived side panel must NOT leak / accumulate `chrome.runtime.onMessage` listeners.
 *
 * The popup is ephemeral (torn down with its document) so it may ignore the return value, but
 * the side panel is LONG-LIVED, so mountAccountSurface():
 *   (1) returns a `cleanup()` that removes the onMessage listener it added;
 *   (2) guards against double-mounting the SAME document (a second mount stacks no listeners).
 *
 * These run on the real custom elements (jsdom + @jeswr/solid-elements) so they exercise the
 * real wiring path, not a stub.
 */

import '@jeswr/solid-elements';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type MountedAccountSurface,
  mountAccountSurface,
  resolveAccountSurfaceElements,
} from '../src/popup/account-surface';

let onMessageListeners: Array<(message: { type?: string }) => void>;

/**
 * Mount the surface AND track the handle so afterEach can tear it down. The mount guard is keyed
 * on the (shared, per-file) jsdom `document`, so a test that left a live mount would otherwise
 * leak the guard entry into the next test — tracking + cleanup keeps the tests independent.
 */
const liveMounts: MountedAccountSurface[] = [];
function mount(): MountedAccountSurface {
  const handle = mountAccountSurface(resolveAccountSurfaceElements());
  liveMounts.push(handle);
  return handle;
}

/** Build the surface markup exactly as popup.html / sidepanel.html do. */
function mountSurfaceDom(): void {
  document.body.innerHTML = `
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

/** A chrome stub whose onMessage add/removeListener are observable. */
function installChrome(): void {
  onMessageListeners = [];
  vi.stubGlobal('chrome', {
    runtime: {
      lastError: undefined as { message?: string } | undefined,
      sendMessage: (message: { type?: string }, callback: (response: unknown) => void) => {
        if (message?.type === 'SOLID_GET_STATE') {
          callback({
            webId: null,
            isActive: false,
            name: null,
            photoUrl: null,
            recentAccounts: [],
          });
        } else {
          callback({ ok: true });
        }
      },
      onMessage: {
        addListener: (fn: (message: { type?: string }) => void) => {
          onMessageListeners.push(fn);
        },
        removeListener: (fn: (message: { type?: string }) => void) => {
          onMessageListeners = onMessageListeners.filter((l) => l !== fn);
        },
      },
    },
  });
}

beforeEach(() => {
  mountSurfaceDom();
  installChrome();
});

afterEach(() => {
  // Tear down any still-live mount so its guard entry doesn't leak into the next test.
  for (const m of liveMounts) m.cleanup();
  liveMounts.length = 0;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('mountAccountSurface — listener lifecycle (long-lived side panel)', () => {
  it('registers exactly one onMessage listener on mount', () => {
    mount();
    expect(onMessageListeners).toHaveLength(1);
  });

  it('cleanup() removes the onMessage listener it added', () => {
    const { cleanup } = mount();
    expect(onMessageListeners).toHaveLength(1);
    cleanup();
    expect(onMessageListeners).toHaveLength(0);
  });

  it('cleanup() is idempotent (a second call does not throw / under-remove)', () => {
    const { cleanup } = mount();
    cleanup();
    expect(() => cleanup()).not.toThrow();
    expect(onMessageListeners).toHaveLength(0);
  });

  it('guards a double-mount on the SAME document — no second listener is stacked', () => {
    const first = mount();
    const second = mount();
    // Still exactly one listener; the second call returned the existing handle.
    expect(onMessageListeners).toHaveLength(1);
    expect(second).toBe(first);
  });

  it('after cleanup() a fresh mount works again (re-registers a single listener)', () => {
    const { cleanup } = mount();
    cleanup();
    expect(onMessageListeners).toHaveLength(0);
    mount();
    expect(onMessageListeners).toHaveLength(1);
  });

  it('exposes the live bridge controller via .controller', () => {
    const { controller } = mount();
    expect(controller).toBeDefined();
  });
});
