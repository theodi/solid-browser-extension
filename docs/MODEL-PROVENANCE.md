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
