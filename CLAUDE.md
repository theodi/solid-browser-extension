# Solid Browser Extension

## Overview

A Chrome browser extension that enables Solid authentication at the browser level. Injects `window.solid` into all pages providing `.fetch`, `.webId`, `.setClientId()`, `.login()`, and `.logout()`.

## Architecture

```
Page (MAIN world)  <--postMessage-->  Content Script (ISOLATED)  <--chrome.runtime-->  Service Worker
    inject.ts                          content-script.ts                               service-worker.ts
```

- **inject.ts**: MAIN world script defining `window.solid` (no credential; postMessage only)
- **content-script.ts**: ISOLATED world bridge — the trust boundary; stamps the real page origin
- **service-worker.ts**: Background session manager + message router + the SOLE token holder
- **core/**: the security-critical, unit-testable core —
  - `dpop.ts` (RFC 9449 DPoP proofs on Web Crypto + jose),
  - `origin-policy.ts` (the fail-closed per-origin credential boundary),
  - `authenticated-fetch.ts` (origin-gated resource fetch + §8 nonce retry),
  - `www-authenticate.ts` (the use_dpop_nonce classifier),
  - `webid.ts` (RDF issuer/profile resolution via N3.js)
- **auth-flow.ts**: Solid-OIDC auth-code + PKCE + DPoP via `chrome.identity.launchWebAuthFlow`
- **action-icon.ts**: the toolbar avatar (OffscreenCanvas render of photo/initials)
- **session-store.ts**: token/key/profile/recent-accounts persistence via `chrome.storage.local`
- **shared/messages.ts**: the JSON-serialisable 4-context message protocol

## Auth + suite packages

Solid-OIDC **authorization-code + PKCE + DPoP** via `chrome.identity.launchWebAuthFlow` (no
`window` in a service worker). DPoP proofs mirror `@jeswr/solid-dpop`'s RFC 9449 discipline but
are reimplemented on Web Crypto + jose because the service worker has no `node:crypto`. Reused
suite packages (pinned `git+https#<sha>`): `@jeswr/solid-elements` (the popup web components),
`@jeswr/solid-session-restore` (the audited silent-restore decision), `@jeswr/solid-dpop` (the
proof-spec reference). **Never re-alias the components' own theme tokens; scope filled button
styles to `#login-form`** (the suite CSS-leak guards).

## Security invariants (do not weaken)

- The page NEVER receives a token; only the WebID + proxied fetch results.
- `core/origin-policy.ts` fails CLOSED: the token attaches only to the WebID/issuer/pod
  origins, never a foreign origin, never `/token`, never over cleartext (loopback dev excepted).
- Page-supplied `Authorization`/`DPoP` headers are stripped; the content script stamps the REAL
  page origin so a page can't impersonate another origin's client-id mapping.
- **Access management is OUT OF SCOPE** — `window.solid.requestAccess?` is a declared,
  throwing SEAM only. Do not implement it without the access-management design track.

## Gate

`npm run gate` = lint (biome) + typecheck (tsc) + test (vitest, the core) + build (webpack).
e2e (`npm run test:e2e`) runs against a LOCAL Community Solid Server only, never the live box.

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
- `jose` (DPoP proof signing / JWK)
- `@jeswr/solid-elements`, `@jeswr/solid-session-restore`, `@jeswr/solid-dpop`
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

- TypeScript throughout, strict mode; biome lint + format
- Webpack bundler, 4 entry points (service-worker, popup, content-script, inject)
- Manifest V3 with `world: "MAIN"` for the `window.solid` injection
- DPoP keys stored as extractable JWK (the MV3 worker is killed and would lose a
  non-extractable key, breaking the jkt-bound refresh) — kept in page-unreachable
  `chrome.storage.local`
- Per-origin client ID via `solid.setClientId()`; a published Client Identifier Document
  client_id with dynamic-registration dev fallback
- Popup themed via the app-shell OKLCH tokens (light/dark), consistent with Pod Manager
- WebID issuer + profile parsed with N3.js (proper RDF, never regex over Turtle)
- New source files carry an `AUTHORED-BY Claude Opus 4.8` marker; commits carry the Opus
  provenance trailers
