# Shared-Replica Routing for the Solid Browser Extension

> **Status:** Design proposal (research + design record). Authored by the PSS agent
> (Claude Opus 4.8). Target repo: `jeswr/solid-browser-extension` (PUBLIC, MV3).
> Couples to `full-solid-ecosystem/docs/design/access-management-solid-lws.md` (tt6).
> **This is an experimental design; the extension is under active development — not a
> production, live, or supported component.**

## 0. The problem in one paragraph

The extension already brings Solid sign-in to the browser: it injects `window.solid`
(a DPoP-authenticated `fetch` + the WebID), holds the DPoP key + tokens ONLY in the
service worker (SW), and proxies every pod request through the SW behind a fail-closed
TARGET-origin credential gate. The refinement this doc designs is the **offline-first**
layer. The naive approach — give every Solid app a `@jeswr/solid-offline` service worker
— **duplicates the same pod data N times across N apps**, because browser Cache/IndexedDB
are partitioned by the visiting app's top-level site. We instead make the **extension own
ONE live, authenticated local replica per (user, pod), in the extension's own
`chrome-extension://` storage (NOT partitioned by the visited app's origin), SHARED across
every app, origin, and window.** The SW is the sole egress (sole DPoP-key holder) and the
sole offline-cache owner; WebSocketChannel2023 invalidation runs ONCE centrally. The
consequence is that **per-origin access control becomes load-bearing**: one shared replica
means any app could otherwise read the whole pod, so the extension MUST enforce which app
may read/write which data at the browser boundary — the runtime home for the tt6 data-class
consent model.

## 1. Per-origin duplication — the problem this removes

Verified against Chrome's [Storage and cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)
and [Storage Partitioning](https://developer.chrome.com/en/docs/privacy-sandbox/storage-partitioning/)
docs:

- A normal web page's `CacheStorage` + `IndexedDB` are **partitioned by the top-level
  site**. App A at `a.example` and App B at `b.example` each get their OWN partition. If
  both register `solid-offline`, the user's pod `alice.pod/finance/…` is cached **twice** —
  once per app — and revalidated twice, with two WebSocket subscriptions. With N apps, N
  copies + N sockets.
- The **`chrome-extension://<id>` origin is a single top-level partition** shared across
  the SW, popup, side panel, and offscreen documents, and is **NOT partitioned by the
  visited site**. One physical store, reachable from one place.

So holding the replica in the extension's own storage collapses N copies to ONE, N sockets
to ONE, and N revalidation pipelines to ONE — and makes cross-app consistency automatic
(App B sees App A's confirmed write because they read the same bytes).

## 2. The single shared extension-owned replica

### 2.1 Storage layout

ONE replica per `(WebID, pod-origin)` in the extension SW's own storage, with
`unlimitedStorage`:

- **Bytes** → `CacheStorage` (survives SW restarts, available in the SW context), keyed by
  a canonical synthetic `(podResourceUrl, varyKey)` Request — reusing `@jeswr/solid-offline`
  `cache-coherence.ts` (`putCanonicalBytes` / `CANONICAL_TURTLE_VARY_KEY`) so there is one
  byte copy per resource, not per content-type-variant-per-app.
- **Metadata** (ETag, fetchedAt, max-age, variant set, the OWNING grant-scope) → `IndexedDB`
  via `@jeswr/solid-offline` `MetadataStore` (`metadata-store.ts`).
- **Session + DPoP key + grant table** → `chrome.storage.local` (page-unreachable; already
  the home of the keypair today).
- **DPoP nonce cache** → MOVED from the in-memory `nonceByOrigin` Map (service-worker.ts:59)
  to IndexedDB, so a cold SW wake does not pay the §8 nonce round-trip on every first request.

**LOAD-BEARING CACHE-KEY FIX (review finding).** `@jeswr/solid-offline` `scope.ts` states
verbatim that its WebID hash is "only a *namespacing discriminator*, NOT a security
boundary: the real boundary is the browser's origin isolation." In the extension partition
there IS no origin boundary underneath. So the cache key MUST include the active **WebID**
(and the grant-scope, §4), and every read MUST verify the active-WebID namespace, never just
the ETag — otherwise a same-URL+same-ETag collision across two users on one device (a shared
or public resource, or a re-provisioned WebID) serves user A's bytes to user B.

### 2.2 Consistency model

Read-from-cache + always-revalidate (never-authoritative stale-while-revalidate), reusing
`@jeswr/solid-offline` `swr.ts`. A cache value is provisional until a conditional
`If-None-Match` GET returns 304/200. Because every app reads the same replica:

- App B sees App A's write the instant the write-through completes AND the metadata ETag
  updates and the change is broadcast (see §2.3 for the MV3 caveat on broadcast atomicity).
- A single in-SW single-flight (the existing `SingleFlight`) coalesces concurrent reads of
  the same URL so N apps loading the same resource cause ONE egress.
- The replica is **never authoritative**: the real pod is the source of truth; on any
  ETag/cache mismatch the SW revalidates against the pod before serving (mirrors the PSS
  S3/QLever "cache is never authoritative" invariant).

### 2.3 Write path

A write (PUT/POST/PATCH/DELETE) from any app routes through the same patch→bridge→SW path.
The SW is the single write funnel. **Phase-1 = synchronous WRITE-THROUGH, not
optimistic** (a shared replica makes a bad optimistic write visible to every other app, so
writes must be authoritative-on-success):

1. **Access-control check FIRST** — does this requesting origin hold a *write* grant for this
   target/data-class? Default-deny (§4).
2. The SW issues the DPoP-signed write to the real pod, carrying `If-Match:<cached ETag>`
   when the app supplied none (cross-app lost-update guard — App B cannot silently clobber
   App A).
3. On 2xx: update the shared replica bytes + metadata ETag **from the pod's response** (not
   the app's optimistic copy) and broadcast `{url, event:'updated', etag}` to every tab.
   On 412: surface the conflict verbatim to the caller (same contract as a direct pod write)
   and revalidate. On 5xx/offline: **FAIL the write back to the app** (no silent queue in v1).
4. The optimistic-mutation UX invariant is delivered at the **app layer** (the app paints
   immediately, shows Saving/Saved) over a write-through that confirms; the replica stays
   coherent.

**MV3 write-visibility caveat (review finding).** The SW can be suspended AFTER the pod 2xx
but BEFORE step 3 persists+broadcasts. The write is not lost (the pod has it) but cross-app
visibility is not atomic with the write; other apps see it on next revalidation / WS frame.
Convergence is eventual, not instant — never-authoritative-revalidate keeps it *correct*.

**Offline write QUEUE is an explicit Phase-3 deferral** (matches tt6 + solid-offline both
deferring offline writes): a durable per-resource outbox replayed on reconnect must (a) be
keyed by the unforgeable requesting origin, (b) **re-check the grant at replay time** (a
grant may have been revoked between enqueue and replay), and (c) surface a 412 on replay,
never auto-merge. Do not ship until that conflict+revocation path is built.

## 3. The three routing mechanisms compared

| Mechanism | Can carry per-request DPoP at egress? | Can serve a replica body? | Boot-race? | Blocks cross-app leak? | Verdict |
|---|---|---|---|---|---|
| **MAIN-world global-fetch patch → ISOLATED bridge → SW** (RECOMMENDED) | **Yes** — the SW signs each proof; key never leaves SW | **Yes** — SW returns a serialized Response | Patch is racy + bypassable (verified), so it is **transparency only, zero security weight** | **Only if** the SW enforces a per-requesting-origin default-deny gate (the graft below) | **Recommended** |
| **declarativeNetRequest redirects the pod request to the SW** | **No** — DNR has no JS callback, cannot carry/sign a per-request proof | **No** — DNR cannot synthesize/modify a response body; redirect drops method+body | Race-free (installed before page scripts) but unusable as a data path | n/a — cannot route at all | **Infeasible as router** (3 verified blockers) |
| **DNR as a fail-closed bypass backstop** (defense-in-depth) | n/a | n/a | Race-free | **No** — cannot cleanly exempt the SW's own egress while blocking page bypass | **Best-effort observer only, never relied on** |

**Verified facts behind the table** (Chrome for Developers, June 2026):

- MAIN-world `document_start` content scripts are **NOT guaranteed to run before the page's
  own inline scripts** (inline scripts are parser-blocking; src scripts are not) — so a page
  can capture pristine `fetch` first. ([content-scripts manifest doc](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts), [chromium-extensions thread](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/eVZd_vOIryc))
- `declarativeNetRequest` **cannot modify response bodies** (headers only), a redirect target
  must be a static web-accessible resource (no JS callback), and **it DOES affect `fetch()`
  made in a service worker** — so the extension SW's own legitimate pod egress is itself
  subject to a pod-host DNR rule. The only way to exempt it (`excludedInitiatorDomains` /
  tabId -1) **also stops the rule matching website-service-worker-initiated requests**, so a
  malicious page can bypass the backstop via its own page SW. ([declarativeNetRequest API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)) The backstop is therefore NOT reliably fail-closed; the real guarantee must not depend on intercepting page traffic.

## 4. Security findings

### 4.1 Cross-app data leak — the headline (CRITICAL as code stands today)

All three adversarial reviews landed the same break against the ACTUAL code:

- `service-worker.ts` `handleFetch(message)` consumes `message.url/method/headers/body` and
  **ignores `_sender`** (line 253). There is no per-requesting-origin authorization.
- `content-script.ts` forwards the fetch with **no origin stamp** (lines 39-53); it stamps
  `window.location.origin` only for `SOLID_LOGIN` / `SOLID_SET_CLIENT_ID`.
- The only gate (`origin-policy.ts` `isOriginAllowed`) is about the **TARGET pod** ("don't
  send the token to evil.com"), not the **requesting app**.
- `inject.ts` `requestAccess()` **throws "not implemented"** (lines 138-145).
- The cache key has **no app/origin dimension**; `manifest.json` injects `window.solid` on
  `<all_urls>`.

So **today any origin can call `window.solid.fetch(podUrl)` and read/write the whole pod.**
That is tolerable in the current single-user product (no shared replica, no per-app promise),
but it is FATAL the instant a shared replica exists. **`crossAppLeakBlocked = false` as
written.** This is a pre-existing exposure worth a tracked security bead on
`solid-browser-extension` regardless of the shared-replica work.

### 4.2 Key custody — the strongest property (PRESERVED, do not touch)

Refuted by all reviewers. The DPoP keypair lives only as JWK in `chrome.storage.local`,
reachable only from extension contexts; `createDpopProof` (`dpop.ts`) exports ONLY the
public components (kty/crv/x/y, never `d`); the page receives only a WebID + a reconstructed
Response; page-supplied `Authorization`/`DPoP` headers are stripped (`authenticated-fetch.ts`
`HOP_BY_HOP`). Residual LOW: the key is generated **extractable** (an MV3 necessity — a
non-extractable key is lost on SW suspension, breaking the jkt-bound refresh) and co-located
with the refresh token in `chrome.storage.local`, so any extension-context compromise
exfiltrates both from one store. Not page-reachable; a concentrated single point worth noting.

### 4.3 Other verified findings (graft the mitigation into the recommendation)

- **Forge the access-control anchor.** `sender.origin` is renderer-spoofable; the
  content-script stamp is read in the same renderer. Mitigation: default-deny + SW-sole-
  enforcement so a forged origin only reaches THAT origin's grants; require BOTH anchors to
  agree; never trust a page/bridge-supplied origin FIELD — read `chrome.runtime` `sender`.
- **Boot-race / page-SW / XHR bypass.** Fail-safe for the credential (a bypassed request is
  unauthenticated → pod 401), but can reach PUBLIC pod data. Mitigation: server-side WAC is
  the ultimate boundary; the SW gate + the (best-effort) DNR observer are layers, not the
  guarantee.
- **Cross-USER stale bytes.** `logout.ts` purge is async/best-effort and MV3-interruptible;
  the WebID-omitted cache key collides. Mitigation: WebID in the key + **synchronous-before-
  serve purge** (block a new session's reads until the prior identity's stores are fully
  dropped).
- **Refresh-token rotation across SW suspension.** A mid-refresh kill can burn the rotation-
  bound refresh token (DoS). Mitigation: persist the rotated token atomically BEFORE use; the
  existing `refreshGate` single-flight is in-memory and must be re-derivable on wake.
- **resolveClass widening (tt6 §6.2).** A pod-controlled Type Index / SHACL shape can widen a
  data-class grant. Mitigation: SHACL-validate at resolution; pin the exact shape IRI at
  consent; read-only Phase-1; write-by-class pins explicit targets.
- **Foreign-origin fetch ambient cookies.** `window.solid.fetch('https://tracker/')` is run
  by the SW as a plain fetch carrying extension-context ambient cookies (CSP-free tracking
  amplification). Mitigation: same-origin-or-deny policy for foreign SW fetches.
- **PII broadcast.** The WebID (and any pod-origin allowlist) is pushed to every script on
  `<all_urls>`. Mitigation: scope presence/WebID to apps that opt in.

## 5. Recommended architecture (implementable)

### 5.1 Routing

PRIMARY = **MAIN-world global-fetch patch → ISOLATED bridge → SW**, a generalization of the
existing `window.solid.fetch` proxy:

- In `inject.ts`, in addition to defining `window.solid`, install a global wrapper anchored
  on the captured pristine fetch:
  `const real = window.fetch; window.fetch = (i,init) => isPodUrl(i) ? solidFetch(i,init) : real(i,init)`.
  Reuse the `@jeswr/solid-elements` `installProactiveAuthFetch` discipline (snapshot the
  pristine fetch, build once, re-assert ownership, never re-read a possibly-patched global),
  but its `base` transport is the postMessage→SW bridge, NOT a page-side authenticated fetch.
- `isPodUrl` diverts only known pod origins; everything else hits the untouched native fetch
  (no proxy tax, no breakage of unrelated requests). Do NOT broadcast the full pod-origin
  list to the page (PII); use a minimal predicate or route everything and let the SW gate
  decide.
- **Register the MAIN-world script programmatically from the SW**
  (`chrome.scripting.registerContentScripts({world:'MAIN', runAt:'document_start',
  persistAcrossSessions:true})`) — the most reliable MAIN injection (the MetaMask
  `window.ethereum` pattern).
- **The patch is best-effort transparency with ZERO security weight.** It is racy and
  bypassable (verified). A missed/bypassed request is a plain unauthenticated fetch (pod 401,
  fail-safe for the credential) and the server's own WAC governs what it returns.
- DNR is retained ONLY as a best-effort defense-in-depth observer/blocker; it is NEVER the
  router and NEVER relied on as fail-closed (its self-egress exclusion hole is verified).

### 5.2 Replica + key in the SW

As §2: bytes in `CacheStorage`, metadata in `IndexedDB`, key+session+grants in
`chrome.storage.local`, nonce cache moved to IndexedDB; cache key includes WebID + grant-
scope; everything re-hydratable on SW wake (no load-bearing in-memory state).

### 5.3 Egress DPoP (preserve verbatim — strongest property)

The SW is the SOLE egress and SOLE key holder. Per-request signing via the existing
`createDpopProof` (Web Crypto + jose; ES256; public-only `jwk` header; `htm/htu/iat/jti`;
`ath` = base64url(SHA-256(token)); §8 nonce echoed on challenge), one §8 nonce retry with a
per-origin nonce cache, exactly-one retry. Proactive refresh ~30s before expiry, single-
flighted via `refreshGate`, same keypair reused so the pod `jkt` binding holds. Refresh-token
persistence + the fail-closed silent-restore decision reuse `@jeswr/solid-session-restore`.
The page only ever receives a WebID + a proxied Response. (Note: the live PSS RS runs
`allowMissingAth` compat, so end-to-end token-binding at the RS is weaker than the proof
shape implies — orthogonal to the extension but relevant to the PoP story.)

### 5.4 Per-origin default-deny access control + the tt6 data-class hook

THE load-bearing graft. Enforced in the SW, BEFORE any cache hit or egress, on every read,
**every cache hit**, and every write:

1. **Forward + enforce the true requesting origin on EVERY fetch.** Change the
   `SOLID_FETCH_REQUEST` relay to stamp `window.location.origin` (as it already does for
   login), AND have `handleFetch` read `chrome.runtime` `sender.origin` (browser-attested).
   Both must agree. **Never** trust a page-supplied origin field. **Fail-closed on
   opaque/null origins** (sandboxed iframe, `srcdoc`, `about:blank`, `data:`) — never a
   shared "null" bucket.
2. **Default-deny.** Resolve `(origin, target-URL, method) → grant decision`. No grant ⇒ the
   SW returns a 403-equivalent WITHOUT touching the replica or the pod (so the shared replica
   cannot serve cached private bytes to a non-consented app). NOT sent unauthenticated.
3. **Re-check the gate on cache HITS, not just egress** — the central authenticated
   revalidation lands bytes in one replica that multiple un-equal-trust origins can read, so
   the gate must mediate every read of the shared bucket. Partition the cache by grant-scope
   so a missing grant cannot even reach a shared body.
4. **tt6 data-class hook = the policy source.** The gate consults a per-origin grant store
   whose grants are tt6 `accm:`/SAI `AccessGrant` records resolved to concrete targets via
   the tt6 ladder (`accm:resolvesTo`: SAI `interop:DataRegistration.registeredShapeTree` →
   Type-Index `solid:instanceContainer` → **SHACL-validate**). "This app may read finance
   data" compiles to "origin X may read {container set Y}". Consent UI renders in EXTENSION
   chrome (popup/side-panel), unspoofable by the requesting origin; the grant is bound to the
   content-script-stamped+sender-attested true origin. The `window.solid.requestAccess` seam
   (today a throwing stub) is wired to `requestAccess`/`listGrants`/`revokeGrant`/
   `resolveClass`.
5. **Read-only Phase-1 grants**; write-by-class pins exact targets (tt6 §2.3 — never let an
   app-influenced class definition broaden its write surface). **Revocation must invalidate
   already-served/replica bytes + any queued writes, not just future fetches.**

### 5.5 Offline-first + WS invalidation (the inversion)

Reuse `@jeswr/solid-offline` modules INVERTED for the authenticated extension SW:

- Verbatim: `swr.ts` (never-authoritative SWR), `cache-coherence.ts` (synthetic-key keying),
  `metadata-store.ts`, `invalidation.ts` (WS-frame → revalidate-or-purge with the ETag self-
  write short-circuit).
- **The inversion:** `solid-offline`'s SW is UNAUTHENTICATED by design — `notifications.ts`
  states verbatim "THE WEBSOCKET LIVES IN THE PAGE (decision 5), NEVER THE SW … the SW only
  invalidates." In the EXTENSION the SW IS the authenticated owner, so (a) the injected
  `fetch` port given to swr/invalidation is the AUTHENTICATED DPoP egress (private resources
  revalidate, not 401), and (b) the WebSocketChannel2023 subscription lives in the EXTENSION
  SW — ONE socket per pod container for ALL apps. This re-opens `solid-offline`'s threat model
  (authenticated subscribe POST + one-socket-per-pod fan-out) and **needs its own audit before
  reuse** — flagged, not assumed safe. Discovery + subscribe use the suite
  `solid-notifications` path; the notification `state` field === the resource ETag (the join
  invalidation already exploits). A central invalidation broadcasts to every tab so all apps
  re-render.

### 5.6 MV3 persistence

- The MV3 SW is terminated after ~30s idle (verified) — durable state must survive: bytes
  (Cache), metadata + nonce (IndexedDB), key+session+grants (`chrome.storage.local`). On
  every wake re-open handles + rebuild in-memory nonce/single-flight lazily.
- The WS does NOT survive suspension. A live WS extends SW lifetime (Chrome 116+: WS
  send/receive resets the idle timer — verified), but Chrome still reclaims on memory
  pressure. On every wake run `resyncSweep` (conditional-revalidate the warmed set) then
  re-subscribe; a `chrome.alarms` heartbeat (min 30s) re-asserts subscriptions + sweeps.
  Reads are never-authoritative, so a momentarily-missed invalidation is one stale-then-
  revalidated read, never a wrong write.

### 5.7 Trustworthy presence signal

- Presence = `window.solid` present + `window.solid.webId` + a `solid:ready` CustomEvent +
  a frozen capability handshake `{present:true, version, capabilities:['fetch',
  'globalFetchPatch','accessControl','sharedReplica']}`. `window.solid` is installed with
  `Object.defineProperty(window,'solid',{configurable:false})` (already done) so a later page
  script cannot replace it.
- **Presence is a UX/cooperation signal, NOT a security boundary** — a page can pre-define a
  fake `window.solid` (boot race) to lie to its own scripts, but gains no cross-origin trust
  and no data (the SW gate is the boundary; a forged presence cannot mint a DPoP proof). The
  only TRUE presence proof is capability: a successful DPoP-authed pod read the page did not
  supply a token for.
- Apps use presence to skip their own login and hide their own profile chrome; the pinned
  toolbar avatar is the user-facing signal. **Scope the WebID broadcast to opt-in apps**, not
  every script on `<all_urls>` (PII).

## 6. Coupling to tt6 (access-management) — what ships first

- **Ships BEFORE access-mgmt lands — owner-only single-user default.** The extension's strong,
  already-built single-user mode: ONE user, the existing per-user pod-origin allowlist as the
  grant store, the SW as sole key holder + egress, the DPoP egress preserved. In this mode
  there is no cross-app boundary to enforce because there is effectively one trust principal
  (the owner) and a coarse per-pod allowlist — which is exactly why the **shared replica must
  NOT be turned on in this mode** (a coarse per-pod-origin grant is per-USER, not per-APP, so
  it provides NO cross-app isolation). Ship offline-first per-app-cache OR single-user only
  until the gate lands.
- **What the browser-side enforcement needs from tt6 (the access-mgmt design):** the
  `client→consent→grant` RUNTIME — a per-origin grant store keyed by `(requesting-origin →
  data-class → mode → expiry)`, resolved to concrete targets via `accm:resolvesTo` (SAI
  DataRegistration → Type Index → SHACL-validate). The extension is tt6's browser-side
  enforcement point: it authors SAI/ACL grants as ordinary authenticated writes (no server
  change for read grants) and gates every routed request against the resolved grant set.
- **What tt6 sequences AFTER (CORE-PSS, maintainer-gated):** the server-native Authorization
  Agent + request-inbox (LDN) + class→target resolver + WAC/ACP materialisation for the
  seamless, scalable flow. The extension can do client-side class→target resolution today;
  server help is wanted for materialization at scale. **tt6 itself sequences the extension
  consent path LAST and flags the confused-deputy mislabelling attack as open** — so the
  shared replica is gated behind the per-app/per-data-class grant store, not the coarse store.

## 7. Phased build plan

The non-negotiable ordering: **build the boundary, prove it adversarially, THEN turn on the
shared replica.**

- **Phase 0 — Hardening prerequisite (security-critical; build + prove FIRST).** Forward the
  true requesting origin on every `SOLID_FETCH_REQUEST` (content-script stamp + `sender`
  cross-check); add a SW default-deny per-origin gate as the FIRST check on read/cache-hit/
  write; fail-closed on opaque/null origins; add the same-origin-or-deny foreign-fetch policy;
  stop broadcasting the pod-origin allowlist + scope the WebID to opt-in. Adversarial tests:
  forged `sender.origin` → DENY, whole-pod read by an ungranted origin → DENY, app-A requests
  app-B-only resource → DENY, opaque-origin → DENY, race the boot patch → fail-safe. Land this
  on the single-user product BEFORE any replica work. File the pre-existing `<all_urls>`
  full-pod-exposure security bead.
- **Phase 1 — Shared-replica + routing + egress-DPoP core (behind the Phase-0 gate).** The
  global-fetch patch (programmatic MAIN injection); the `(WebID, pod-origin, grant-scope)`-
  keyed replica in `CacheStorage`+`IndexedDB`; nonce cache → IndexedDB; synchronous-before-
  serve logout purge + atomic rotated-refresh-token persistence; preserve the DPoP egress
  verbatim. Read-from-cache+revalidate; synchronous write-through. Re-check the gate on cache
  hits.
- **Phase 2 — Per-origin access-control enforcement + tt6 data-class hook.** Wire
  `window.solid.requestAccess`/`listGrants`/`revokeGrant`/`resolveClass` to the tt6 grant
  store; consent UI in extension chrome bound to the true origin; SHACL-validate `resolveClass`;
  read-only class grants; revocation invalidates served/replica bytes.
- **Phase 3 — `@jeswr/solid-offline` central sync.** WebSocketChannel2023 subscription in the
  SW (one per pod container), authenticated revalidation, central invalidation broadcast,
  `resyncSweep` + `chrome.alarms` heartbeat on wake. **Re-audit `solid-offline`'s
  notifications/invalidation under the inverted (authenticated-SW) threat model before reuse.**
  (Offline write QUEUE is deferred past v1 — see §2.3.)
- **Phase 4 — Consolidate the 10 apps onto `<jeswr-account-menu>` with hide-when-extension-
  present.** Standardise the suite apps (7 pod-apps + PM + solid-issues + app-store) on the
  Lit `@jeswr/solid-elements` `<jeswr-account-menu>` (exists; `webid` attribute), feature-
  detecting `window.solid` + the `solid:ready` capability handshake to suppress the app's own
  login/profile chrome and defer to the extension identity. Add a `hide-when-extension-present`
  capability to the element. Update the `create-solid-app` template to standardise the check.
- **Phase 5 — Playwright-with-extension tests vs a LOCAL Solid server.** E2E with the
  unpacked extension loaded (`--load-extension`, persistent context), pointed at a **local
  CSS / local `prod-solid-server` (`docker compose up`), never the live deploy** (house rule).
  Cover: cross-app read+write denial (two app origins, one pod), forged-origin denial, cross-
  user purge race, boot-race fail-safe, single-replica-shared-across-origins, offline-load-
  from-cache, central WS invalidation. Use the `playwright-best-practices` /
  `solid-test-infrastructure` skills.

## 8. What needs CORE-PSS server changes (maintainer approval, separate)

The tt6 server-native Authorization Agent (request-inbox LDN endpoint, class→target
resolver, WAC/ACP materialisation) is new security-critical surface on `prod-solid-server`
(`src/access-requests`, touching `src/authz`). It goes through auth-specialist +
storage-specialist + the conformance harness + roborev, and needs maintainer approval. The
extension's shared-replica + per-origin gate + client-side grant authoring need **no** PSS
server change; they work against any spec-conformant Solid server today, with server-side WAC
as the ultimate enforcement backstop.

## Appendix — Sources (verified June 2026)

- [Chrome: content scripts manifest (MAIN-world / document_start)](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)
- [chromium-extensions: MV3 MAIN-world injection ordering](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/eVZd_vOIryc)
- [Chrome: declarativeNetRequest API (body/redirect/SW-fetch limits)](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- [Chrome: Storage and cookies (extension origin not site-partitioned)](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)
- [Chrome: Storage Partitioning](https://developer.chrome.com/en/docs/privacy-sandbox/storage-partitioning/)
- [Chrome: service worker lifecycle (~30s idle; Chrome 116 WS keepalive)](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [RFC 9449 DPoP](https://www.rfc-editor.org/rfc/rfc9449.html) · [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068.html)
- In-repo: `solid-browser-extension/src/{inject/inject.ts,content/content-script.ts,background/service-worker.ts,background/core/{origin-policy.ts,authenticated-fetch.ts,dpop.ts}}`
- In-repo: `solid-offline/src/{scope.ts,notifications.ts,logout.ts,swr.ts,cache-coherence.ts,metadata-store.ts,invalidation.ts}` · `solid-elements/src/{auth/proactive-fetch.ts,components/account-menu.ts}`
- tt6: `full-solid-ecosystem/docs/design/access-management-solid-lws.md`