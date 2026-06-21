// AUTHORED-BY Claude Opus 4.8
/**
 * Side-panel wiring for the service worker. The toolbar ACTION keeps its existing popup
 * (clicking the icon opens the ephemeral popup, unchanged). The PERSISTENT side panel —
 * which Chrome keeps open as the user navigates — is opened on demand via a right-click
 * context-menu entry on the action icon ("Open Solid side panel").
 *
 * Why a context menu and not `setPanelBehavior({ openPanelOnActionClick: true })`: the
 * action already declares a `default_popup`, and Chrome ignores open-on-action-click when
 * a popup is set — the popup wins. A context-menu entry lets BOTH surfaces coexist: a
 * left-click → popup (quick glance), a right-click → "Open Solid side panel" (persistent).
 *
 * `chrome.sidePanel.open()` must be called in the same turn as the user gesture (the
 * contextMenus.onClicked handler is a valid gesture), so we open it directly there.
 *
 * All chrome.* calls are guarded: `chrome.sidePanel` / `chrome.contextMenus` may be absent
 * on older Chromium or under test, so this module is a no-op there and never throws.
 */

const OPEN_SIDE_PANEL_MENU_ID = 'solid-open-side-panel';

/**
 * Remove ONLY our own side-panel menu entry (if present), ignoring the "item not found"
 * error so first-create is fine. We must NOT use `contextMenus.removeAll()` here: that would
 * delete EVERY context-menu item the extension owns, clobbering any other/future menu.
 */
function removeSidePanelMenu(): Promise<void> {
  return new Promise((resolve) => {
    if (!chrome.contextMenus?.remove) {
      resolve();
      return;
    }
    // The callback form lets us swallow chrome.runtime.lastError (the "Cannot find menu item"
    // error on first run / after a SW restart cleared the registry) without it surfacing.
    chrome.contextMenus.remove(OPEN_SIDE_PANEL_MENU_ID, () => {
      void chrome.runtime?.lastError; // read-and-discard so it isn't reported
      resolve();
    });
  });
}

/** Create the "Open Solid side panel" context-menu entry on the action icon. */
async function createSidePanelMenu(): Promise<void> {
  if (!chrome.contextMenus?.create) return;
  try {
    // Remove-OUR-id-then-create is idempotent across SW restarts / reinstalls (a duplicate id
    // throws) WITHOUT clobbering any other menu item — removeAll() would regress those.
    await removeSidePanelMenu();
    chrome.contextMenus.create({
      id: OPEN_SIDE_PANEL_MENU_ID,
      title: 'Open Solid side panel',
      contexts: ['action'],
    });
  } catch {
    // Menus are a convenience affordance — never let a failure break the worker.
  }
}

/**
 * Register the side-panel affordances. Call once at service-worker load. Wires:
 *   - the action-icon context-menu entry (created on install AND on every wake, since the
 *     in-memory menu registry is cleared when the MV3 worker is torn down), and
 *   - the click handler that opens the side panel for the active tab.
 */
export function registerSidePanel(): void {
  if (chrome.runtime?.onInstalled?.addListener) {
    chrome.runtime.onInstalled.addListener(() => {
      void createSidePanelMenu();
    });
  }
  // Re-create on wake too: a killed MV3 worker loses its context-menu registry.
  void createSidePanelMenu();

  if (chrome.contextMenus?.onClicked?.addListener) {
    chrome.contextMenus.onClicked.addListener((info, tab) => {
      if (info.menuItemId !== OPEN_SIDE_PANEL_MENU_ID) return;
      if (!chrome.sidePanel?.open) return;
      // Open the panel in the same user-gesture turn. Prefer the clicked tab's window;
      // fall back to the tab id. Swallow errors (e.g. no window) rather than throw.
      const windowId = tab?.windowId;
      const opener =
        windowId !== undefined
          ? chrome.sidePanel.open({ windowId })
          : tab?.id !== undefined
            ? chrome.sidePanel.open({ tabId: tab.id })
            : undefined;
      opener?.catch?.(() => {});
    });
  }
}
