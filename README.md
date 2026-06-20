# Solid Browser Extension

A Manifest V3 browser extension that brings **Solid sign-in to the browser itself**. It
injects a `window.solid` API into every page (a DPoP-authenticated `fetch`, the user's
`webId`, `login`/`logout`/`setClientId`) and pins a top-right account menu whose icon is the
signed-in WebID's avatar. The UI is built with [`@jeswr/solid-elements`](https://github.com/jeswr/solid-elements)
so it is visually consistent with [Pod Manager](https://github.com/jeswr/solid-pod-manager)
and the rest of the [@jeswr Solid app suite](https://github.com/jeswr).

> **Scope:** this repo is the extension **CORE** — auth, `window.solid`, and the account
> popup. **Access management** (an access-request JS API, consent/data-type UI, queued
> requests) is a separate, design-first track and is intentionally **not** implemented
> here; only a clearly-marked, feature-detectable seam is left (see below).

## Architecture

Four contexts, with the access token held in exactly one of them (the service worker):

```
 Page (MAIN world)          Content script (ISOLATED)        Service worker (background)
   window.solid     ⇄          content-script.ts      ⇄            service-worker.ts
   inject.ts          postMessage                 chrome.runtime    ├─ auth-flow.ts (auth-code + PKCE + DPoP)
   (no credential)    (trust boundary:            (sole token       ├─ core/authenticated-fetch.ts (the boundary)
                       stamps real origin)          holder)         ├─ core/dpop.ts (RFC 9449 proofs, Web Crypto)
                                                                     ├─ core/origin-policy.ts (fail-closed gate)
   Popup = the account UI (@jeswr/solid-elements) ⇄ chrome.runtime  ├─ session-store.ts (chrome.storage)
                                                                     └─ action-icon.ts (avatar toolbar icon)
```

- **The page never sees a credential.** `window.solid` (MAIN world) can only `postMessage`
  to the content script, which relays to the worker. The page gets back the WebID and
  proxied `Response`s — never the access or refresh token.
- **The service worker is the sole token holder.** Tokens + the DPoP keypair live in
  `chrome.storage.local`, which is unreachable from any web page — satisfying the suite's
  "DPoP refresh token in non-page-reachable secure storage" invariant.

### The credential boundary (security heart)

Because `solid.fetch` is callable from **any** page, the worker must never hand a foreign
origin the user's token. `core/origin-policy.ts` + `core/authenticated-fetch.ts` enforce,
fail-closed:

- The token is attached **only** to an origin in the allowed set (the WebID's origin ∪ the
  issuer's origin ∪ user-configured pod origins). A request to any other origin
  (`solid.fetch("https://evil.example/")`) is sent as a **plain, credential-free fetch** —
  the token-leak attack is impossible.
- **Cleartext guard:** the token never rides over `http:` (loopback excepted, for dev CSS).
- The resource token is never attached to the issuer's `/token` endpoint.
- Page-supplied `Authorization` / `DPoP` headers are **stripped** (no header injection).
- DPoP proofs follow RFC 9449 §4.2 (the same proof shape as
  [`@jeswr/solid-dpop`](https://github.com/jeswr/solid-dpop), reimplemented on Web Crypto
  because a service worker has no `node:crypto`), with the §8 `use_dpop_nonce` single retry.

These invariants are pinned by an adversarial unit suite (`test/`), including a
WebID/origin-mismatch test that genuinely fails without the guard.

## `window.solid`

```ts
interface SolidExtension {
  readonly webId: string | null;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  setClientId(clientId: string): void;          // declare this origin's Client ID Document
  login(webId: string): Promise<void>;
  logout(): Promise<void>;
  requestAccess?(request: unknown): Promise<never>; // SEAM — not implemented (see below)
}
```

## Auth + session

- **Login:** Solid-OIDC **authorization-code + PKCE + DPoP**, driven by
  `chrome.identity.launchWebAuthFlow` (a service worker has no `window`). The WebID's
  `solid:oidcIssuer` is resolved by **proper RDF parsing** (N3.js, not regex). The extension's
  own published Solid-OIDC **Client Identifier Document** (committed at `public/clientid.jsonld`,
  copied into the build, mirrored + shape-tested in `src/background/client-id.ts`) is used as the
  `client_id` (stable consent-screen name + `token_endpoint_auth_method: "none"` public-client
  behaviour) **when its hosted URL is reachable**; otherwise the flow falls back to **dynamic
  client registration**. The hosted URL is a `REPLACE-ME` **placeholder** (`PUBLISHED_CLIENT_ID_URL`)
  — actually HOSTING the document at a stable HTTPS URL (and pinning the real extension-id
  `chromiumapp.org` redirect into it) is a **needs:user** step; until then the unreachable
  placeholder transparently falls back to dynamic registration, so login keeps working. A page
  may still declare its own Client ID Document via `solid.setClientId(...)`.
- **Session:** the access + refresh token + the DPoP keypair (as JWK — an MV3 worker is
  killed aggressively and a non-extractable key would be lost on suspension, breaking the
  `jkt`-bound refresh) are persisted in `chrome.storage.local`. The worker proactively
  refreshes ~30 s before expiry via the DPoP refresh grant, reusing the **same** keypair.
- **Silent restore:** reopening the browser re-hydrates the session from the persisted
  refresh token (no popup). The restore decision logic is the suite's audited
  [`@jeswr/solid-session-restore`](https://github.com/jeswr/solid-session-restore) (fail-closed,
  WebID-scoped).

## The pinned toolbar identity

The `chrome.action` icon is rendered (off-DOM, `OffscreenCanvas`) to the signed-in WebID's
**avatar** — the profile photo (circular crop) or coloured initials — with a green status
badge. The **popup is the account UI**: `@jeswr/solid-elements`' `jeswr-account-menu` +
`jeswr-theme-toggle`, a recent-accounts affordance, a pod shortcut, a "restoring" state, and
a **first-run pin nudge** (extensions can't self-pin). Light/dark themes the popup chrome and
the web components in lockstep via the app-shell OKLCH tokens.

### The side panel (persistent surface)

For users who want the account UI to **stay open** as they browse (vs the ephemeral popup),
the extension also ships an MV3 **side panel** (`sidepanel/sidepanel.html`). It renders the
**identical** signed-in/signed-out surface as the popup — the SAME `@jeswr/solid-elements`
components driven by the SAME token-free `MessageBridgeLoginController` seam — via the shared
`mountAccountSurface()` (`src/popup/account-surface.ts`), so there is exactly one copy of the
view-switching + auth-bridge logic. The popup is unchanged. **Open it** by right-clicking the
toolbar icon → **"Open Solid side panel"** (a left-click still opens the quick popup; Chrome
ignores open-on-action-click while a `default_popup` is set, so both surfaces coexist via the
context-menu entry).

## Offline

Offline of **arbitrary third-party pods** is **out of scope** (it is a fork-only concern for
this extension — a generic offline layer for any pod is the [`@jeswr/solid-offline`](https://github.com/jeswr/solid-offline)
SW track, not this one). The extension does no forced caching of third-party pod data; the
worker's in-memory session/nonce caches are best-effort accelerators only.

## Access management — the SEAM (NOT implemented)

The access-request JS API, the consent / data-type UI, and queued-request handling are a
**separate, design-first track** and are deliberately excluded from this core. The only thing
left here is a non-breaking seam: `window.solid.requestAccess?` is **declared** (so it is
feature-detectable) but **throws** "not implemented". Do **not** wire access management onto
this stub without the access-management design — adding the real method later is non-breaking.

## Build & load the unpacked extension

```bash
npm install            # @jeswr deps are pinned git+https (keyless npm ci); ignore-scripts=true
npm run build          # webpack -> dist/
```

Then in Chrome:

1. Open `chrome://extensions`, toggle **Developer mode** (top-right).
2. **Load unpacked** → select this repo's `dist/` folder.
3. Pin it (puzzle-piece icon → pin) — the popup is the account menu.
4. Click the icon, enter your WebID / Pod URL, sign in.

## Develop & test

```bash
npm run gate           # lint (biome) + typecheck (tsc) + test (vitest) + build (webpack)
npm run lint           # biome over src test e2e scripts
npm run typecheck      # tsc --noEmit
npm test               # vitest — the security-critical core (51 cases), no server needed
npm run build          # webpack bundle to dist/
npm run test:e2e       # build + Playwright against a LOCAL Community Solid Server
```

The unit suite stubs `fetch` / `chrome.*` and needs no server. The Playwright e2e suite
boots a **local** Community Solid Server (`e2e/setup`) and a local test site — **never** the
live deploy — and drives the real extension in headed Chromium.

## License

MIT © Jesse Wright
