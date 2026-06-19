# Access management — the seam (deferred, design-first track)

Access management — letting a page *request access* to specific resources/data-types, the
user *consent* to it, and the extension *manage queued requests* — is **out of scope for the
extension core** and is a separate, design-first initiative. This note documents the **seam**
the core leaves so that track can land later without a breaking change. It is a forward
reference, not a checklist of pending work.

## What the core deliberately does NOT do

- No `requestAccess(...)` implementation (no access-request JS API).
- No consent UI / data-type selection UI.
- No queued-request handling / pending-request inbox.

## The seam that IS present

`window.solid` declares an **optional, throwing** `requestAccess?` method
(`src/inject/inject.ts`):

```ts
interface SolidExtension {
  // ... webId, fetch, setClientId, login, logout ...
  requestAccess?(request: unknown): Promise<never>; // SEAM — not implemented
}
```

- It is **declared** so a consumer can feature-detect (`typeof window.solid.requestAccess`)
  and so adding the real method later is **non-breaking** (the surface already accounts for it).
- It currently **rejects** with a clear "not implemented: access management is a separate,
  design-first track" message, so a caller fails loudly rather than silently no-op.

## Constraints for the future track (so it composes with the core, not around it)

When the access-management design is approved and implemented, it MUST:

1. **Go through the existing credential boundary**, not around it. Any access-mediated fetch
   still passes `core/origin-policy.ts` + `core/authenticated-fetch.ts` — the per-origin,
   fail-closed token gate is not relaxed for access requests.
2. **Keep the page credential-free.** Consent state, granted scopes, and any access-grant
   tokens live in the service worker / `chrome.storage` (page-unreachable), exactly like the
   session does today.
3. **Reuse the message protocol** (`src/shared/messages.ts`) and the content-script trust
   boundary (the real page origin is stamped server-side, never page-supplied).
4. **Not weaken any security invariant** listed in `CLAUDE.md` / `README.md`.

Until that design exists, do not wire access management onto the `requestAccess` stub.
