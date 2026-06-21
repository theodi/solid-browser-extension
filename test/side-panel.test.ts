// AUTHORED-BY Claude Opus 4.8
/**
 * Tests for the service-worker side-panel wiring (background/side-panel.ts).
 *
 * The toolbar ACTION keeps its existing popup; the PERSISTENT side panel is opened via a
 * right-click "Open Solid side panel" action-menu entry. These assert:
 *   (1) registerSidePanel() creates exactly that menu entry (on the action context);
 *   (2) clicking it opens the side panel for the clicked window — in the click handler
 *       (the user-gesture turn chrome.sidePanel.open() requires);
 *   (3) an unrelated menu click is ignored;
 *   (4) it is a no-op (never throws) when chrome.sidePanel / chrome.contextMenus are absent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSidePanel } from '../src/background/side-panel';

type MenuClickListener = (
  info: { menuItemId: string },
  tab?: { id?: number; windowId?: number },
) => void;

interface CreatedMenu {
  id?: string;
  title?: string;
  contexts?: string[];
}

let createdMenus: CreatedMenu[];
let menuClickListeners: MenuClickListener[];
let removeAllCalls: number;
let removedIds: string[];
let openCalls: Array<{ windowId?: number; tabId?: number }>;

function installChrome(opts: { sidePanel?: boolean; contextMenus?: boolean } = {}): void {
  const { sidePanel = true, contextMenus = true } = opts;
  createdMenus = [];
  menuClickListeners = [];
  removeAllCalls = 0;
  removedIds = [];
  openCalls = [];

  const chromeStub: Record<string, unknown> = {
    runtime: {
      lastError: undefined as { message?: string } | undefined,
      onInstalled: { addListener: (_fn: () => void) => {} },
    },
  };
  if (contextMenus) {
    chromeStub.contextMenus = {
      // removeAll MUST NOT be used by the production code (it would clobber other menus); we
      // keep the stub so a regression to removeAll() is observable via removeAllCalls.
      removeAll: () => {
        removeAllCalls += 1;
        return Promise.resolve();
      },
      remove: (id: string, callback?: () => void) => {
        removedIds.push(id);
        callback?.();
      },
      create: (menu: CreatedMenu) => {
        createdMenus.push(menu);
      },
      onClicked: {
        addListener: (fn: MenuClickListener) => {
          menuClickListeners.push(fn);
        },
      },
    };
  }
  if (sidePanel) {
    chromeStub.sidePanel = {
      open: (opts2: { windowId?: number; tabId?: number }) => {
        openCalls.push(opts2);
        return Promise.resolve();
      },
    };
  }
  vi.stubGlobal('chrome', chromeStub);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registerSidePanel — context-menu entry', () => {
  beforeEach(() => installChrome());

  it('creates a single "Open Solid side panel" entry on the action context (idempotent remove-OWN-id first)', async () => {
    registerSidePanel();
    // createSidePanelMenu is async (remove → create); let it settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(createdMenus).toHaveLength(1);
    expect(createdMenus[0].title).toBe('Open Solid side panel');
    expect(createdMenus[0].contexts).toEqual(['action']);
    expect(typeof createdMenus[0].id).toBe('string');
  });

  it('removes ONLY its own menu id before re-creating — never removeAll() (would clobber other menus)', async () => {
    registerSidePanel();
    await Promise.resolve();
    await Promise.resolve();
    // The fix: a targeted remove of exactly the side-panel id, NOT a blanket removeAll().
    expect(removeAllCalls).toBe(0);
    expect(removedIds).toHaveLength(1);
    // The removed id is the same id that is then (re-)created — idempotent for just our item.
    expect(removedIds[0]).toBe(createdMenus[0].id);
  });

  it('registers a click listener', () => {
    registerSidePanel();
    expect(menuClickListeners).toHaveLength(1);
  });
});

describe('the click handler opens the side panel', () => {
  beforeEach(() => installChrome());

  it('opens for the clicked window when the menu entry is clicked', async () => {
    registerSidePanel();
    await Promise.resolve();
    const menuId = createdMenus[0].id as string;
    menuClickListeners[0]({ menuItemId: menuId }, { id: 7, windowId: 42 });
    expect(openCalls).toEqual([{ windowId: 42 }]);
  });

  it('falls back to the tab id when no windowId is present', async () => {
    registerSidePanel();
    await Promise.resolve();
    const menuId = createdMenus[0].id as string;
    menuClickListeners[0]({ menuItemId: menuId }, { id: 7 });
    expect(openCalls).toEqual([{ tabId: 7 }]);
  });

  it('IGNORES an unrelated menu click (does not open)', async () => {
    registerSidePanel();
    await Promise.resolve();
    menuClickListeners[0]({ menuItemId: 'some-other-menu' }, { windowId: 42 });
    expect(openCalls).toHaveLength(0);
  });
});

describe('graceful absence (older Chromium / test)', () => {
  it('is a no-op and never throws when chrome.contextMenus is absent', () => {
    installChrome({ contextMenus: false });
    expect(() => registerSidePanel()).not.toThrow();
  });

  it('does not open and never throws when chrome.sidePanel is absent', async () => {
    installChrome({ sidePanel: false });
    expect(() => registerSidePanel()).not.toThrow();
    await Promise.resolve();
    expect(menuClickListeners).toHaveLength(1);
    // Clicking the entry must not throw even though sidePanel.open is missing.
    const menuId = createdMenus[0].id as string;
    expect(() => menuClickListeners[0]({ menuItemId: menuId }, { windowId: 1 })).not.toThrow();
  });
});
