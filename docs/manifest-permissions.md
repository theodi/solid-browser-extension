# Manifest permissions — rationale (Phase 0)

> AUTHORED-BY Claude Opus 4.8

`manifest.json` cannot carry comments, so this file is the durable record of WHY each
permission and host-permission is requested, and what the Phase-0 hardening reviewed.
Reviewed against the shared-replica design `docs/design/shared-replica-architecture.md`
§4.3 ("PII broadcast", "Foreign-origin fetch") and §5.7.

## `permissions`

| Permission | Why it is required | Could it be narrowed? |
|---|---|---|
| `storage` | The SOLE home of the DPoP keypair, session tokens, profile, recent accounts, per-origin client-ids, and the **granted-origins grant store** (`chrome.storage.local`, page-unreachable). | No — load-bearing for the credential boundary. |
| `identity` | `chrome.identity.launchWebAuthFlow` drives the Solid-OIDC auth-code + PKCE redirect (a service worker has no `window`). | No. |
| `sidePanel` | The persistent side-panel account surface. | No. |
| `contextMenus` | The right-click "Open Solid side panel" entry. | No. |

No `tabs` permission is requested: `broadcastStateChange` reads tab URLs via the existing
`<all_urls>` host permission (host access implies tab-URL visibility), and the WebID it
sends is scoped per-tab to GRANTED origins only (a non-granted tab receives `webId: null`).

## `host_permissions: ["<all_urls>"]`

**Required, and genuinely broad — documented rather than removed.** The service worker is
the sole egress: it makes cross-origin `fetch`es to **arbitrary, user-chosen** Solid pod
origins, IdP issuer origins, token endpoints, and WebID profile documents (discovery, token
exchange, refresh, profile, and every authenticated resource read/write). A Solid pod can be
hosted on **any** origin the owner picks, so the set of origins the SW must reach is
unbounded at install time. Without `<all_urls>` host permission these credentialed
cross-origin fetches would be subject to extension CORS restrictions and could not reliably
read response bodies/headers, breaking the core auth flow against arbitrary pods.

This breadth is NOT the security boundary. The boundary is the SW-enforced, fail-closed
gates, all of which run regardless of host permissions:

- **Target-origin credential gate** (`origin-policy.ts`): the access token is attached ONLY
  to the WebID / issuer / configured-pod origins — never a foreign origin, never `/token`,
  never over cleartext (loopback dev excepted). A fetch to any other origin is a plain,
  token-free fetch.
- **Per-requesting-origin default-deny gate** (`requesting-origin.ts`, Phase 0): the calling
  app's origin must be GRANTED (an explicit per-origin grant, or a session credential/pod
  origin) before any pod egress or cache read. The requesting origin is the **browser-
  attested** `sender` cross-checked against the page stamp; opaque/`null`/mismatched → DENY.
- **Same-origin-or-deny foreign-fetch policy** (Phase 0): a request to a non-credential
  ("foreign") origin is allowed only when it targets the requesting app's OWN origin, so the
  extension cannot be used as an ambient-cookie proxy to arbitrary third parties.

## `content_scripts` matches: `["<all_urls>"]`

**Required.** `window.solid` (the cooperation surface) must be available on any page that
might be a Solid app — the owner chooses which apps to use, so the match set is unbounded.
Presence of `window.solid` is a UX/cooperation signal, NOT a security boundary (design
§5.7): the credential never leaves the SW, and the per-requesting-origin gate denies any
non-granted origin even though the script is injected everywhere. Identity (the WebID) is
NOT exposed to a page merely because the script is injected — `SOLID_GET_STATE` returns the
WebID only to a verified, granted origin.
