# Model provenance

While Fable is unavailable, everything authored by **Claude Opus 4.8** is tagged so it can
be targeted for re-review / upgrade when Fable returns.

- **Commit trailers:** `Model: claude-opus-4-8` + the `Provenance:` line +
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **New source files:** an `AUTHORED-BY Claude Opus 4.8` top-of-file marker.

## Ledger

| Artifact | Branch | Notes |
|---|---|---|
| Suite build/gate scaffold (biome, vitest, pinned @jeswr deps, ignore-scripts) | `feat/rewrite-core` | re-review/upgrade candidate |
| `src/background/core/*` (dpop, origin-policy, www-authenticate, authenticated-fetch, webid) | `feat/rewrite-core` | security-critical — re-review/upgrade candidate |
| `src/background/{service-worker,auth-flow,session-store,action-icon}.ts` | `feat/rewrite-core` | re-review/upgrade candidate |
| `src/{inject,content,popup}/*`, `src/shared/messages.ts`, `src/manifest.json` | `feat/rewrite-core` | re-review/upgrade candidate |
| `test/*.test.ts` (51 unit cases) + updated `e2e/` suite | `feat/rewrite-core` | re-review/upgrade candidate |
| `docs/access-management-seam.md`, `README.md`, `CLAUDE.md` updates | `feat/rewrite-core` | re-review/upgrade candidate |
| MV3 side panel (`src/sidepanel/*`, `src/background/side-panel.ts`) + shared `src/popup/account-surface.ts` (popup/side-panel surface extraction) | `feat/sidepanel-and-clientid` | re-review/upgrade candidate |
| Static Client ID Document (`public/clientid.jsonld`, `src/background/client-id.ts`) + `auth-flow.ts` published-client-id wiring | `feat/sidepanel-and-clientid` | published-URL hosting = needs:user; re-review/upgrade candidate |
| `test/{client-id,side-panel}.test.ts` (+21 cases) | `feat/sidepanel-and-clientid` | re-review/upgrade candidate |
| Phase-0 per-requesting-origin gate (`src/background/core/requesting-origin.ts`) + SW wiring (`service-worker.ts` gate/PII-scoping, `session-store.ts` grant store, `content-script.ts` origin stamp, `shared/messages.ts`) | `phase-0-origin-gate` | SECURITY-CRITICAL — re-review/upgrade candidate |
| `test/{requesting-origin,service-worker-gate}.test.ts` (+53 adversarial cases) + `docs/manifest-permissions.md` | `phase-0-origin-gate` | re-review/upgrade candidate |
