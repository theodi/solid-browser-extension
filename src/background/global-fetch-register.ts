// AUTHORED-BY Claude Opus 4.8
/**
 * Programmatic registration of the MAIN-world injection (design §5.1).
 *
 * The manifest already declares the `inject.js` MAIN-world content script. This module ALSO
 * registers it via `chrome.scripting.registerContentScripts({ world: 'MAIN', runAt:
 * 'document_start', persistAcrossSessions: true })` — the most reliable MAIN-world injection
 * (the MetaMask `window.ethereum` pattern). The two are belt-and-braces: the dynamic
 * registration is idempotent (it removes a stale prior registration first), survives across
 * browser sessions, and gives a single code path to evolve the injection without a manifest
 * edit.
 *
 * SECURITY NOTE: the injected script is BEST-EFFORT TRANSPARENCY with ZERO security weight
 * (design §5.1) — it is racy + bypassable, and the SW gate remains the sole boundary on every
 * routed request. Registration failing (older Chrome, missing `scripting` permission) is
 * therefore NON-FATAL: the manifest-declared content script still provides the path, and even
 * with NO injection at all the security posture is unchanged (a plain fetch hits the pod and
 * gets a 401 / WAC decision). So this function swallows errors and never throws into SW boot.
 */

const SCRIPT_ID = 'solid-main-world-inject';
const INJECT_JS = 'inject/inject.js';

/** The chrome.scripting surface we touch (typed minimally so a stub can satisfy it in tests). */
interface ScriptingApi {
  getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<Array<{ id: string }>>;
  registerContentScripts(scripts: chrome.scripting.RegisteredContentScript[]): Promise<void>;
  unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
}

/**
 * Register (idempotently) the MAIN-world global-fetch-patch injection. Removes any stale prior
 * registration of the same id first so a reload/upgrade does not error on a duplicate id.
 * Best-effort: any failure is swallowed (the manifest content script + the SW gate stand).
 */
export async function registerGlobalFetchInjection(
  scripting: ScriptingApi | undefined = (globalThis as { chrome?: { scripting?: ScriptingApi } })
    .chrome?.scripting,
): Promise<boolean> {
  if (!scripting?.registerContentScripts) return false;
  try {
    const existing = await scripting
      .getRegisteredContentScripts({ ids: [SCRIPT_ID] })
      .catch(() => [] as Array<{ id: string }>);
    if (existing.some((s) => s.id === SCRIPT_ID)) {
      await scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => {});
    }
    await scripting.registerContentScripts([
      {
        id: SCRIPT_ID,
        js: [INJECT_JS],
        matches: ['<all_urls>'],
        runAt: 'document_start',
        world: 'MAIN',
        persistAcrossSessions: true,
        allFrames: false,
      },
    ]);
    return true;
  } catch {
    // Non-fatal — the manifest-declared MAIN-world script still injects, and the SW gate is
    // the sole security boundary regardless of whether the patch ran (design §5.1).
    return false;
  }
}
