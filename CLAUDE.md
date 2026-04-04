# Solid Browser Extension

## Overview

A Chrome browser extension that enables Solid authentication at the browser level. Injects `window.solid` into all pages providing `.fetch`, `.webId`, `.setClientId()`, `.login()`, and `.logout()`.

## Architecture

```
Page (MAIN world)  <--postMessage-->  Content Script (ISOLATED)  <--chrome.runtime-->  Service Worker
    inject.ts                          content-script.ts                               service-worker.ts
```

- **inject.ts**: MAIN world script defining `window.solid`
- **content-script.ts**: ISOLATED world bridge relaying messages
- **service-worker.ts**: Background session manager, auth fetch proxy, client ID registry
- **auth-flow.ts**: Manual OIDC flow adapted for service worker (no `window`)
- **session-database.ts**: Token/key persistence via `chrome.storage.local`

## Auth Library

Uses `@uvdsl/solid-oidc-client-browser/core`. The `login()` method is bypassed (uses `window.location.href`) — we manually construct the auth URL and use `chrome.tabs.create()`. `authFetch()` and `restore()` are used directly.

## Build & Test

```bash
npm install           # Install dependencies
npm run build         # Build extension to dist/
npm run build:dev     # Build in watch mode
npm run test:e2e      # Build + run Playwright e2e tests
```

### E2E Testing

- Requires headed Chrome (extensions don't work in headless)
- Uses Community Solid Server on localhost:3000 with in-memory storage
- Test site served on a separate port
- Extension loaded from `dist/` via `--load-extension`

## Skills

Solid-specific skill documents are in `.skills/`:
- `spec.md` — Solid Protocol, WebID, Solid-OIDC, ACP
- `servers.md` — Community Solid Server
- `style-guide.md` — Solid brand guidelines (use for popup UI)
- `data-modelling.md` — RDF vocabularies, SHACL
- `integration-guide.md` — Client libraries

## Documentation Lookups

Use the Context7 MCP server for up-to-date library documentation. Prefer Context7 over training data for API specifics of:
- `@uvdsl/solid-oidc-client-browser`
- Playwright extension testing
- Community Solid Server configuration
- Chrome Extension MV3 APIs

## Key Conventions

- TypeScript throughout, strict mode
- Webpack bundler with 5 entry points
- Manifest V3 with `world: "MAIN"` for injection
- DPoP keys stored as extractable JWK (service worker suspension)
- Per-origin client ID support via `solid.setClientId()`
- Solid branding for popup: primary color #7C4DFF
