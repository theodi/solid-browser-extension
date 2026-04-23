# Solid Browser Extension

## Overview

A Chrome browser extension that enables Solid authentication at the browser level. Injects `window.solid` into all pages providing `.fetch`, `.webId`, `.setClientId()`, `.login()`, and `.logout()`.

## Architecture

```
Page (MAIN world)  <--postMessage-->  Content Script (ISOLATED)  <--chrome.runtime-->  Service Worker
    inject.ts                          content-script.ts                               service-worker.ts
```

- **inject.ts**: MAIN world script defining `window.solid`
- **content-script.ts**: ISOLATED world bridge relaying messages (attaches page origin to fetch)
- **service-worker.ts**: Background session manager. Maintains one session per client ID, routes `solid.fetch()` by origin → per-origin client ID → session, and performs silent re-auth (`prompt=none`, `chrome.identity.launchWebAuthFlow({interactive:false})`) when no session exists for the target client ID
- **auth-flow.ts**: Manual OIDC flow adapted for service worker; exposes `initiateLogin` (interactive, `prompt=consent`) and `initiateSilentLogin` (non-interactive, `prompt=none`)
- **session-database.ts**: Persists a `{ clientId → StoredSession }` map plus a shared `active WebID` in `chrome.storage.local`

## Architectural Requirements

- **Authentication Model**: Implement a **Token Broker** architecture. The extension acts as the primary holder of the Solid session, while web applications request scoped access via the extension.
- **Injected API**: Every web page must have a `window.solid` object injected with the following interface:
  - `fetch(url, init)`: Intercepts or proxies requests to ensure they are signed/authenticated using the correct session.
  - `webId`: A getter that returns the currently logged-in WebID.
  - `setClientId(clientId)`: Allows the web application to declare its Identity.
  - `clientId`: A getter that returns the client id
  - `login()`: Triggers the authentication flow. This must be **silent** (no visible UI/redirects for the app) if the extension already has a valid session.
  - `logout()`: Clears the session state for that specific application.
- **Permission Scoping**: 
  - The extension holds "High Permission" (long-lived/refresh tokens).
  - Each application must use its own `clientId` to ensure it operates within its own OIDC permission scope.
- **Silent Integration Rules**: Support a "managed" application flow where the extension intercepts OIDC redirects or uses background communication to bypass the standard web-based login UI.
- **Reactive Authentication & Session Management**: The extension must not automatically authenticate every tab. Sessions for external applications should be initialized **reactively** only when the application calls `login()` or attempts an authenticated `fetch()`.

## Auth Library

Uses `@uvdsl/solid-oidc-client-browser/core`. The `login()` method is bypassed (uses `window.location.href`) — we manually construct the auth URL and use `chrome.tabs.create()`. `authFetch()` and `restore()` are used directly.

## Resources

- Solid-OIDC specification https://solidproject.org/TR/oidc-primer
- https://docs.inrupt.com/sdk/java-sdk/authentication/solid-oidc-client-identifiers

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

### Specific Test Scenario: Identity Isolation (The 403 Test)

Identity isolation is a core acceptance invariant: a per-app client ID must never inherit the extension's master permission scope.
When an app origin uses its own client ID and fetches a private Pod resource, the request must be authenticated under that app-scoped session and return **403 Forbidden** when ACP denies that app.
See the canonical behavioral spec in `e2e/tests/client-registration.spec.ts` (test: "identity isolation: app client ID gets a silently brokered per-client session and is denied by the pod ACP").

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

## Development Workflow

This project uses **roborev** for continuous automated code review. Every git commit triggers an asynchronous review via a post-commit hook. Reviews are performed by GitHub Copilot (OpenAI o3) — a different model from the code-writing agent — to provide independent oversight.

### Commit practices

- **Commit frequently** — small, focused commits. Each commit is reviewed independently by roborev, so smaller commits produce more actionable feedback.
- **One concern per commit** — don't mix feature code, test changes, and config changes in a single commit.
- **Build before committing** — run `npm run build` to catch TypeScript/webpack errors. The reviewer can't run the build itself.
- **Run tests before committing** — run `npm run test:e2e` for any changes that touch the extension source, message protocol, or auth flow.

### Reviewing and fixing

After committing, roborev reviews asynchronously in the background. To interact with reviews:

```bash
roborev tui            # Interactive terminal UI — view all reviews
roborev show           # Show review for current commit
roborev status         # Check daemon health and queue
roborev fix            # Auto-fix findings (runs in isolated worktree)
roborev refine         # Iteratively fix → re-review → repeat until clean
```

Review verdicts: **P** (pass), **W** (warning), **F** (fail).

### When roborev flags an issue

1. Read the finding in `roborev tui` or `roborev show`
2. Either fix manually and commit, or run `roborev fix` to auto-remediate
3. If the finding is a false positive for this project (e.g. extractable DPoP keys, localhost CLIENT_ID), it is already suppressed in `.roborev.toml` review guidelines — if new patterns need suppressing, update the `review_guidelines` field there.

### For AI agents (IMPORTANT — read before making any changes)

**You MUST commit after every completed set of changes.** This is not optional. The roborev post-commit hook triggers an automated review by a separate model (GitHub Copilot / OpenAI o3), providing independent oversight of your work. If you do not commit, your changes are not reviewed, and issues may go undetected.

Workflow:
1. Make your changes (code, config, docs, tests — whatever the task requires).
2. **Commit immediately** once the changes are complete and working. Do not wait for the user to ask you to commit.
3. After committing, run `roborev show` to check if the review has completed and whether there are findings.
4. If roborev flags issues, fix them and **commit again** (a new commit, not an amend).
5. For automated fix-review loops, use `roborev refine`.

Rules:
- **Small, focused commits.** One concern per commit. Do not batch unrelated changes.
- **Build and test before committing.** Run `npm run build` and `npm run test:e2e` for source changes.
- **Never skip commits.** Even config-only or docs-only changes must be committed so they are reviewed.
- The `.roborev.toml` file configures review guidelines — read it to understand what the reviewer focuses on and what it ignores.

## Key Conventions

- TypeScript throughout, strict mode
- Webpack bundler with 5 entry points
- Manifest V3 with `world: "MAIN"` for injection
- DPoP keys stored as extractable JWK (service worker suspension)
- Per-origin client ID support via `solid.setClientId()`
- Extension uses a dereferenceable client identifier (not dynamic registration)
- Solid branding for popup: primary color #7C4DFF
- Profile data parsed with N3.js + `@solid/object` Agent class
