# Solid Browser Extension - Implementation Plan

## Context

Build a Chrome browser extension that enables Solid authentication at the browser level. The extension injects `window.solid` (with `.fetch`, `.webId`, and `.login()`) into all pages, allowing any website to perform authenticated Solid requests. Websites can optionally declare their own client identifier so the Solid server knows which application is making the request. E2E tests verify the full flow against a local Community Solid Server.

The repo is a blank slate (only LICENSE exists). Auth uses `@uvdsl/solid-oidc-client-browser/core` with a manually adapted login flow for MV3 service workers. Tests target Chrome only via Playwright.

---

## 1. Project Structure

```
solid-browser-extension/
  .github/
    workflows/
      ci.yml                       # Build + e2e tests with xvfb
  .skills/                         # LLM skill documents (see section 8)
  src/
    manifest.json                  # MV3 manifest
    background/
      service-worker.ts            # Session mgmt, message handling, auth fetch proxy
      session-database.ts          # chrome.storage.local adapter for token/key persistence
      auth-flow.ts                 # Manual OIDC authorization URL construction + redirect handling
    popup/
      popup.html                   # Login UI (Solid branding: #7C4DFF)
      popup.ts                     # Sends login request to background
      popup.css                    # Styled per Solid brand guidelines
    content/
      content-script.ts            # ISOLATED world: relays messages page <-> background
    inject/
      inject.ts                    # MAIN world: defines window.solid, fetch proxy via postMessage
    redirect/
      redirect.html               # OAuth redirect landing page
      redirect.ts                  # Sends auth code to background
  test-site/
    index.html                     # Uses window.solid to display WebID + fetch private doc
    app.js
  e2e/
    playwright.config.ts
    fixtures.ts                    # Extension loading, ID discovery
    setup/
      global-setup.ts              # Start CSS + test site server
      global-teardown.ts           # Stop servers
      css-server.ts                # CSS lifecycle management
      seed.json                    # Pre-registered test user
    tests/
      login.spec.ts
      authenticated-fetch.spec.ts
      session-restore.spec.ts
  package.json
  tsconfig.json
  webpack.config.ts
  .gitignore
  .claude/
    settings.json                  # MCP servers (Context7), hooks
  CLAUDE.md                        # Project conventions for AI agents
  LICENSE
```

---

## 2. Extension Architecture (Manifest V3)

### manifest.json

- `manifest_version: 3`
- **Background**: Service worker (`background/service-worker.js`, type: module)
- **Popup**: `popup/popup.html` via `action.default_popup`
- **Content scripts** (two entries, both `<all_urls>`, `run_at: document_start`):
  - `inject/inject.js` with `world: "MAIN"` — injects `window.solid`
  - `content/content-script.js` with `world: "ISOLATED"` — bridges page <-> background
- **Permissions**: `storage`, `activeTab`
- **Host permissions**: `<all_urls>` (needed for authenticated fetches to any pod)
- **Web accessible resources**: `redirect/redirect.html`

### Message flow

```
Page (MAIN world)  <--postMessage-->  Content Script (ISOLATED)  <--chrome.runtime-->  Service Worker
    inject.ts                          content-script.ts                               service-worker.ts
```

### Message types

| Message | Direction | Payload |
|---------|-----------|---------|
| `SOLID_LOGIN` | Popup -> Background | `{ idpUrl }` |
| `SOLID_HANDLE_REDIRECT` | Redirect page -> Background | `{ code, state, iss }` |
| `SOLID_FETCH_REQUEST` | Inject -> Content -> Background | `{ requestId, url, method, headers, body, clientId? }` |
| `SOLID_FETCH_RESPONSE` | Background -> Content -> Inject | `{ requestId, status, statusText, headers, body }` |
| `SOLID_GET_STATE` | Inject -> Content -> Background | (none) |
| `SOLID_STATE_UPDATE` | Content -> Inject | `{ webId }` |
| `SOLID_STATE_CHANGED` | Background -> Content (broadcast) | `{ webId }` |
| `SOLID_SET_CLIENT_ID` | Inject -> Content -> Background | `{ origin, clientId }` |

---

## 3. Injected API (`window.solid`)

### Core API

```typescript
interface SolidExtension {
  /** The authenticated user's WebID, or null if not logged in */
  readonly webId: string | null;

  /** Perform an authenticated fetch using the extension's Solid session */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

  /**
   * Set the client identifier for the current origin.
   * This is a dereferenceable URI pointing to a Client ID Document (JSON-LD).
   * If not set, the extension uses dynamic client registration.
   */
  setClientId(clientId: string): void;

  /** Open the extension login flow (convenience — same as clicking the popup) */
  login(idpUrl: string): Promise<void>;

  /** Log out the current session */
  logout(): Promise<void>;
}

declare global {
  interface Window {
    solid: SolidExtension;
  }
}
```

### Client Identifier Design

**Problem**: When the extension proxies `solid.fetch` for a website, the Solid server sees the extension as the client — not the website. Websites need a way to declare their own identity.

**Solution**: Websites call `solid.setClientId()` with a dereferenceable client identifier URI. This URI must resolve to a JSON-LD Client ID Document per the Solid-OIDC spec.

```javascript
// Website declares its client identity
solid.setClientId("https://myapp.example/.well-known/solid-client");

// Now authenticated fetches identify as "myapp.example" to the Solid server
const response = await solid.fetch("https://pod.example/private/data.ttl");
```

**Behavior**:
- `setClientId(uri)` stores the mapping `origin -> clientId` in the background service worker
- The background validates the URI is dereferenceable (fetches the Client ID Document) and caches the result
- Authenticated fetches from that origin use the declared client_id in DPoP proofs
- If no client ID is set for an origin, the extension falls back to dynamic client registration using the extension itself as the client

**Post-logout redirect URI limitation**: When using dereferenceable client identifiers, the Client ID Document must include `post_logout_redirect_uris`. For the extension flow, the logout redirect goes to the extension's redirect page, not the website. This means:
- IDP logout redirects to `chrome-extension://<id>/redirect/redirect.html` regardless of the website's client ID
- The website's Client ID Document should include the extension's redirect URI in its `post_logout_redirect_uris` if IDP logout is needed (impractical for general use since the extension ID is dynamic)
- **Pragmatic default**: App-only logout (clear local tokens) rather than IDP logout. IDP logout is only feasible when the website controls its own Client ID Document AND knows the extension ID

**Open question**: Whether a more ergonomic pattern exists for Solid post-logout flows in the extension context. This is a known limitation of the current Solid-OIDC spec when applied to browser extensions.

---

## 4. Authentication Flow

Using `@uvdsl/solid-oidc-client-browser/core` with manual adaptations for service worker context:

1. **User opens popup**, enters IDP URL, clicks Login
2. **Background `auth-flow.ts`** (no `window` available):
   - Fetches IDP's `.well-known/openid-configuration`
   - Dynamically registers client (redirect_uri = `chrome-extension://${chrome.runtime.id}/redirect/redirect.html`)
   - Generates PKCE code_verifier + challenge
   - Generates CSRF state token
   - Stores auth params in `chrome.storage.local`
   - Opens IDP auth URL via `chrome.tabs.create()`
3. **IDP authenticates user**, redirects to `redirect.html?code=...&state=...&iss=...`
4. **redirect.ts** extracts params, sends `SOLID_HANDLE_REDIRECT` to background
5. **Background** exchanges code for tokens (with DPoP proof + PKCE verifier), stores tokens + WebID
6. **Broadcasts** `SOLID_STATE_CHANGED` to all tabs

### Key technical decisions

- **DPoP keys**: Generated as **extractable**, exported as JWK to `chrome.storage.local`, re-imported on service worker wake-up (non-extractable keys are lost on suspension)
- **SessionCore usage**: Used for `authFetch()` and `restore()` only; `login()` bypassed in favor of manual auth URL construction
- **Response serialization**: Bodies serialized as text over chrome.runtime messaging (Solid resources are predominantly text/RDF); binary support can be added later via base64
- **Per-origin client IDs**: Background maintains a `Map<origin, clientId>` persisted in `chrome.storage.local`. When making an authenticated fetch, the DPoP proof includes the appropriate client_id for the requesting origin

---

## 5. Popup UI (Solid Branding)

The popup follows Solid brand guidelines (from `.skills/style-guide.md`):

- **Primary color**: `#7C4DFF` (Solid purple)
- **Logo**: Solid logo displayed at the top of the popup
- **Typography**: Clean, modern sans-serif
- **Layout**: Simple form — IDP URL input + Login button. When logged in, show WebID + Logout button
- **States**: Not logged in / Logging in (spinner) / Logged in (shows WebID)

---

## 6. Build Configuration

- **Bundler**: Webpack with `ts-loader`
- **5 entry points**: service-worker, popup, content-script, inject, redirect
- **CopyWebpackPlugin**: copies manifest.json, HTML, CSS to dist/
- **TypeScript**: ES2022 target, strict mode, `@types/chrome`

### Dependencies

**Runtime**: `@uvdsl/solid-oidc-client-browser`, `jose`
**Dev**: `typescript`, `webpack`, `webpack-cli`, `ts-loader`, `copy-webpack-plugin`, `@types/chrome`, `@playwright/test`, `@solid/community-server`, `http-server`, `ts-node`

---

## 7. E2E Testing

### Infrastructure
- **Community Solid Server**: Started in `global-setup.ts` with in-memory config + `seed.json` (pre-registered test user at `http://localhost:3000`)
- **Test site**: Served via `http-server` on a separate port
- **Playwright**: Persistent context with `--load-extension`, `headless: false`, chromium channel

### Fixtures (`e2e/fixtures.ts`)
- Launch persistent Chromium context with extension loaded from `dist/`
- Discover extension ID from service worker URL

### Test scenarios

**login.spec.ts**
1. Navigate to `chrome-extension://${extensionId}/popup.html`
2. Enter IDP URL (`http://localhost:3000`), click Login
3. Handle CSS login form (fill email/password, submit)
4. Verify redirect completes and popup shows WebID

**authenticated-fetch.spec.ts**
1. Complete login
2. Navigate to test site
3. Assert `#webid` displays the authenticated WebID
4. Assert `#fetch-result` contains private document content

**session-restore.spec.ts**
1. Complete login
2. Navigate away and back to test site
3. Assert session is still active (WebID still displayed)

### CI
- GitHub Actions with `xvfb-run` for headed Chrome on Linux
- Build extension, install Playwright, run tests

---

## 8. Implementation Order

1. **Skills & agent config**: CLAUDE.md, .skills/, .claude/settings.json (MCP + hooks), roborev setup
2. **Scaffold**: package.json, tsconfig, webpack config, .gitignore, manifest.json
3. **inject.ts**: Define `window.solid` with fetch proxy via postMessage
4. **content-script.ts**: Message bridge between page and background
5. **session-database.ts**: chrome.storage.local adapter with JWK key serialization
6. **auth-flow.ts**: Manual OIDC flow (discovery, registration, PKCE, auth URL)
7. **service-worker.ts**: Message handler, session management, auth fetch proxy, client ID management
8. **popup**: HTML + TS + CSS for login UI (Solid branded)
9. **redirect**: HTML + TS for OAuth callback
10. **Test site**: Simple HTML/JS using window.solid
11. **E2E setup**: Playwright config, fixtures, CSS server lifecycle
12. **E2E tests**: Login, authenticated fetch, session restore
13. **CI**: GitHub Actions workflow

---

## 9. Key Files to Create/Modify

| File | Purpose |
|------|---------|
| `src/background/service-worker.ts` | Central session manager, message handler, auth fetch proxy, client ID registry |
| `src/background/session-database.ts` | Token/key persistence via chrome.storage.local |
| `src/background/auth-flow.ts` | OIDC authorization URL construction for service worker context |
| `src/inject/inject.ts` | Defines `window.solid` in MAIN world (fetch, webId, setClientId, login, logout) |
| `src/content/content-script.ts` | Message bridge (ISOLATED world) |
| `src/popup/popup.ts` + `.html` + `.css` | Login UI with Solid branding |
| `src/redirect/redirect.ts` + `.html` | OAuth callback handler |
| `e2e/fixtures.ts` | Playwright extension fixtures |
| `e2e/setup/css-server.ts` | CSS server lifecycle for tests |

---

## 10. Skills, MCP, & Agent Team Setup

### Skills Documents (`.skills/`)

**Solid-specific skills** (from https://github.com/solid/solid-llm-skills):
- `spec.md` — Solid Protocol, WebID, Solid-OIDC, ACP specifications
- `servers.md` — Community Solid Server deployment/CLI
- `style-guide.md` — Solid brand guidelines (#7C4DFF, logo, typography) — **used for popup UI**
- `data-modelling.md` — RDF vocabularies, SHACL
- `integration-guide.md` — Client libraries (N3.js, etc.)

**General engineering skills** (from https://github.com/solid/solid-llm-skills):
- `software-engineer.md`
- `security-engineer.md` (critical for auth extension)
- `qa-engineer.md` (for test strategy)

**Community skills** (from https://github.com/ComposioHQ/awesome-claude-skills — install relevant ones):
- **Playwright Browser Automation** (https://github.com/lackeyjb/playwright-skill) — e2e test writing guidance
- **test-driven-development** — TDD workflow skill
- **software-architecture** — SOLID principles, clean architecture
- **test-fixing** — detect and fix failing tests
- **using-git-worktrees** — isolated development environments

### MCP Servers (`.claude/settings.json`)

**Context7** — Use the Context7 MCP adapter for resolving up-to-date documentation for libraries used in this project. This avoids hallucinating APIs and ensures correct usage of:
- `@uvdsl/solid-oidc-client-browser` API
- Playwright extension testing APIs
- Community Solid Server configuration
- Chrome Extension APIs (MV3)
- Webpack configuration

Configure in `.claude/settings.json`:
```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"]
    }
  }
}
```

### CLAUDE.md

Project conventions file including:
- Build commands (`npm run build`, `npm run test:e2e`)
- Architecture overview (message flow, auth flow)
- Testing requirements (CSS must be running, headed Chrome)
- Links to skill documents in `.skills/`
- Instruction to use Context7 MCP for library documentation lookups

### Agent Team Configuration

**Implementation agent** (Claude Code, primary):
- Handles all code writing, building, debugging
- References `.skills/` for Solid-specific context
- Uses Context7 MCP for library documentation
- Uses CLAUDE.md for project conventions

**Review agent** (roborev):
- A background daemon that automatically reviews every git commit using AI agents
- Reviews are asynchronous — commits complete instantly, reviews happen in background

**roborev setup**:
```bash
# Install (choose one)
curl -fsSL https://roborev.io/install.sh | bash
# or: brew install roborev-dev/tap/roborev

# Initialize in repo (installs post-commit hook, starts daemon)
roborev init --agent claude-code
```

**roborev workflow**:
- Every `git commit` automatically triggers an async review via the post-commit hook
- View results: `roborev tui` (interactive terminal UI) or `roborev show` (current commit)
- Check daemon health: `roborev status`
- Auto-fix findings: `roborev fix` (runs agent in isolated worktree, applies patches)
- Iterative refinement: `roborev refine --max-iterations 5` (fix → re-review → repeat until clean)
- Verdicts: Pass (P), Fail (F), Warning (W)

**Custom review guidelines** in `.roborev.toml`:
- Security review rules (OAuth flows, token handling, message passing)
- Chrome extension best practices (MV3 service worker lifecycle)
- Solid protocol compliance checks

**Full team workflow**:
1. Claude Code implements features/fixes
2. Developer commits
3. roborev daemon automatically reviews the commit in background
4. Developer views findings in `roborev tui`
5. If issues found: `roborev fix` auto-remediates, or developer directs Claude Code to fix
6. `roborev refine` iterates until review passes

---

## 11. Verification

To verify the extension works end-to-end:

1. `npm install && npm run build` — extension builds to `dist/`
2. Load `dist/` as unpacked extension in Chrome
3. Start CSS: `npx @solid/community-server -p 3000`
4. Register a user at `http://localhost:3000`
5. Click extension icon, enter `http://localhost:3000`, login
6. Open test-site, verify WebID displays and private fetch succeeds
7. Test `solid.setClientId()` with a test Client ID Document

Automated: `npm run test:e2e` runs all of the above via Playwright.
