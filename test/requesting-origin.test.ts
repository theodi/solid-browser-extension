// AUTHORED-BY Claude Opus 4.8
//
// Adversarial unit tests for the per-REQUESTING-origin gate — the Phase-0 browser-side
// access boundary. These prove the load-bearing security properties as PURE functions:
//   - dual-origin agreement (browser-attested sender ∧ page stamp), forged stamp → DENY
//   - fail-closed on opaque / null / missing / mismatched origins
//   - default-deny per-origin gate
//   - same-origin-or-deny foreign-fetch policy
//   - the granted-origin set computation (credential origins ∪ explicit grants)

import { describe, expect, it } from 'vitest';
import {
  computeGrantedOrigins,
  decideRequestingOrigin,
  isForeignFetchAllowed,
  isRequestingOriginGranted,
  resolveRequestingOrigin,
} from '../src/background/core/requesting-origin';

describe('resolveRequestingOrigin — dual-origin agreement', () => {
  it('resolves when the browser-attested sender.origin agrees with the page stamp', () => {
    const o = resolveRequestingOrigin({ origin: 'https://app.example' }, 'https://app.example');
    expect(o).toBe('https://app.example');
  });

  it('derives the attested origin from sender.url when sender.origin is absent', () => {
    const o = resolveRequestingOrigin(
      { url: 'https://app.example/page.html?x=1' },
      'https://app.example',
    );
    expect(o).toBe('https://app.example');
  });

  it('DENIES a FORGED stamp that disagrees with the browser-attested origin', () => {
    // A compromised renderer stamps a victim origin, but the browser attests the real one.
    const o = resolveRequestingOrigin(
      { origin: 'https://attacker.example' },
      'https://victim.example',
    );
    expect(o).toBeNull();
  });

  it('DENIES when the stamp claims a credential origin but the sender is the attacker', () => {
    const o = resolveRequestingOrigin(
      { origin: 'https://attacker.example' },
      'https://alice.pod.example',
    );
    expect(o).toBeNull();
  });

  it('DENIES a missing browser-attested origin (no origin, no url) — fail-closed', () => {
    expect(resolveRequestingOrigin({}, 'https://app.example')).toBeNull();
    expect(resolveRequestingOrigin(undefined, 'https://app.example')).toBeNull();
    expect(resolveRequestingOrigin(null, 'https://app.example')).toBeNull();
  });

  it('DENIES a missing page stamp even when the sender is attested — fail-closed', () => {
    expect(resolveRequestingOrigin({ origin: 'https://app.example' }, undefined)).toBeNull();
    expect(resolveRequestingOrigin({ origin: 'https://app.example' }, null)).toBeNull();
    expect(resolveRequestingOrigin({ origin: 'https://app.example' }, '')).toBeNull();
  });

  // These all yield an OPAQUE origin (the literal "null" sentinel, or unparseable). They must
  // NEVER resolve to a usable origin and must NEVER share a "null" bucket. (Verified against
  // Node's URL parser: about:blank / data: / file: / javascript: → origin "null"; the literal
  // string "null" — what a sandboxed `srcdoc` iframe reports as location.origin — throws.)
  it.each([
    ['about:blank', 'about:blank'],
    ['data: URL', 'data:text/html,<x>'],
    ['file: URL', 'file:///etc/passwd'],
    ['javascript: URL', 'javascript:alert(1)'],
    ['srcdoc literal null', 'null'],
  ])('DENIES an opaque %s stamp/sender (no shared null bucket)', (_label, opaque) => {
    // opaque on BOTH sides
    expect(resolveRequestingOrigin({ origin: opaque }, opaque)).toBeNull();
    // opaque attested, real stamp
    expect(resolveRequestingOrigin({ url: opaque }, 'https://app.example')).toBeNull();
    // real attested, opaque stamp
    expect(resolveRequestingOrigin({ origin: 'https://app.example' }, opaque)).toBeNull();
  });

  it('a blob: URL legitimately inherits its creator origin (allowed when both agree)', () => {
    // A blob URL cannot be forged across origins — the browser fixes its embedded origin to
    // the creating context, so `sender` + stamp still agree on the real origin. This is the
    // app reading through its own blob document, which is the genuine origin and is allowed.
    expect(
      resolveRequestingOrigin({ url: 'blob:https://app.example/uuid' }, 'https://app.example'),
    ).toBe('https://app.example');
    // But a blob whose creator is the attacker cannot impersonate a victim stamp → DENY.
    expect(
      resolveRequestingOrigin(
        { url: 'blob:https://attacker.example/uuid' },
        'https://victim.example',
      ),
    ).toBeNull();
  });

  it('treats a port difference as a mismatch (different origin) → DENY', () => {
    expect(
      resolveRequestingOrigin({ origin: 'https://app.example:8443' }, 'https://app.example'),
    ).toBeNull();
  });

  it('treats a scheme difference as a mismatch → DENY', () => {
    expect(
      resolveRequestingOrigin({ origin: 'http://app.example' }, 'https://app.example'),
    ).toBeNull();
  });

  it('DENIES an unparseable stamp', () => {
    expect(resolveRequestingOrigin({ origin: 'https://app.example' }, 'not a url')).toBeNull();
  });
});

describe('isRequestingOriginGranted — default-deny', () => {
  const granted = new Set(['https://app.example', 'https://alice.pod.example']);

  it('allows a granted origin', () => {
    expect(isRequestingOriginGranted(granted, 'https://app.example')).toBe(true);
  });

  it('DENIES an un-granted origin (default-deny)', () => {
    expect(isRequestingOriginGranted(granted, 'https://other.example')).toBe(false);
  });

  it('DENIES a null requesting origin (opaque/unresolved) — fail-closed', () => {
    expect(isRequestingOriginGranted(granted, null)).toBe(false);
  });

  it('DENIES everything when the granted set is empty (no session, no grants)', () => {
    expect(isRequestingOriginGranted(new Set(), 'https://app.example')).toBe(false);
    expect(isRequestingOriginGranted(new Set(), null)).toBe(false);
  });
});

describe('isForeignFetchAllowed — same-origin-or-deny', () => {
  it('allows an app to fetch its OWN origin through the proxy', () => {
    expect(isForeignFetchAllowed('https://app.example', 'https://app.example/data.json')).toBe(
      true,
    );
  });

  it('DENIES an app fetching an unrelated third-party origin (ambient-cookie proxy abuse)', () => {
    expect(isForeignFetchAllowed('https://app.example', 'https://tracker.example/collect')).toBe(
      false,
    );
  });

  it('DENIES a null requesting origin', () => {
    expect(isForeignFetchAllowed(null, 'https://app.example/x')).toBe(false);
  });

  it('DENIES an unparseable target', () => {
    expect(isForeignFetchAllowed('https://app.example', 'not a url')).toBe(false);
  });

  it('treats a port/scheme difference as a different (denied) origin', () => {
    expect(isForeignFetchAllowed('https://app.example', 'https://app.example:9000/x')).toBe(false);
    expect(isForeignFetchAllowed('https://app.example', 'http://app.example/x')).toBe(false);
  });
});

describe('computeGrantedOrigins — credential origins ∪ explicit grants', () => {
  it('unions the session credential origins and explicit grants', () => {
    const granted = computeGrantedOrigins({
      credentialOrigins: new Set(['https://alice.pod.example', 'https://idp.example']),
      explicitGrants: ['https://pm.example', 'https://issues.example'],
    });
    expect(granted.has('https://alice.pod.example')).toBe(true);
    expect(granted.has('https://idp.example')).toBe(true);
    expect(granted.has('https://pm.example')).toBe(true);
    expect(granted.has('https://issues.example')).toBe(true);
  });

  it('drops opaque / non-URL candidates (fail-closed)', () => {
    const granted = computeGrantedOrigins({
      credentialOrigins: new Set(['null', '']),
      explicitGrants: ['about:blank', 'not a url', 'https://ok.example'],
    });
    expect(granted.has('null')).toBe(false);
    expect(granted.has('https://ok.example')).toBe(true);
    expect(granted.size).toBe(1);
  });

  it('yields an EMPTY set with no inputs (default-deny for every origin)', () => {
    expect(computeGrantedOrigins({}).size).toBe(0);
  });

  it('canonicalises a credential URL down to its origin', () => {
    const granted = computeGrantedOrigins({
      explicitGrants: ['https://app.example/some/path?q=1#f'],
    });
    expect(granted.has('https://app.example')).toBe(true);
    expect(granted.size).toBe(1);
  });
});

describe('decideRequestingOrigin — the COMPLETE gate (the adversarial scenarios)', () => {
  // A granted app reading its OWN pod through the extension.
  const credentialOrigins = new Set(['https://alice.pod.example', 'https://idp.example']);
  const explicitGrants = ['https://pm.example'];
  const inputs = { credentialOrigins, explicitGrants };

  it('ALLOWS a granted app reading a credential (pod) resource', () => {
    const d = decideRequestingOrigin(
      { origin: 'https://pm.example' },
      'https://pm.example',
      'https://alice.pod.example/private/notes.ttl',
      inputs,
    );
    expect(d.deny).toBeNull();
    expect(d.requestingOrigin).toBe('https://pm.example');
  });

  it('ALLOWS an app served from the pod origin itself (credential origin auto-granted)', () => {
    const d = decideRequestingOrigin(
      { origin: 'https://alice.pod.example' },
      'https://alice.pod.example',
      'https://alice.pod.example/private/notes.ttl',
      inputs,
    );
    expect(d.deny).toBeNull();
  });

  it('DENIES a FORGED sender.origin (renderer spoofs a granted origin)', () => {
    // The attacker's renderer stamps a granted origin, but the browser attests the attacker.
    const d = decideRequestingOrigin(
      { origin: 'https://attacker.example' },
      'https://pm.example',
      'https://alice.pod.example/private/notes.ttl',
      inputs,
    );
    expect(d.deny).toBe('forbidden-origin');
    expect(d.requestingOrigin).toBeNull();
  });

  it('DENIES an UN-GRANTED origin attempting a whole-pod read (default-deny)', () => {
    const d = decideRequestingOrigin(
      { origin: 'https://evil.example' },
      'https://evil.example',
      'https://alice.pod.example/', // the whole pod root
      inputs,
    );
    expect(d.deny).toBe('origin-not-granted');
    expect(d.requestingOrigin).toBeNull();
  });

  it('DENIES app-A reading app-B-only data when A is not granted (cross-app isolation)', () => {
    // appB is granted; appA is not. appA tries to read the pod resource appB uses.
    const withB = { credentialOrigins, explicitGrants: ['https://appB.example'] };
    const d = decideRequestingOrigin(
      { origin: 'https://appA.example' },
      'https://appA.example',
      'https://alice.pod.example/appB-data/secret.ttl',
      withB,
    );
    expect(d.deny).toBe('origin-not-granted');
  });

  it('DENIES an opaque/null requesting origin (fail-safe)', () => {
    const d = decideRequestingOrigin(
      { origin: 'null' },
      'null',
      'https://alice.pod.example/x',
      inputs,
    );
    expect(d.deny).toBe('forbidden-origin');
  });

  it('FAIL-CLOSED on a boot/SW-restart race: empty grant inputs deny everything', () => {
    // On a cold wake the SW re-reads storage; if nothing is loaded the grant set is empty.
    // A request that WOULD be allowed once loaded must be DENIED while unloaded — never served.
    const cold = decideRequestingOrigin(
      { origin: 'https://pm.example' },
      'https://pm.example',
      'https://alice.pod.example/private/notes.ttl',
      {}, // no credentialOrigins, no explicitGrants — nothing loaded yet
    );
    expect(cold.deny).toBe('origin-not-granted');
    expect(cold.requestingOrigin).toBeNull();
  });

  it('DENIES a granted app fetching an unrelated FOREIGN third party (ambient-cookie proxy)', () => {
    const d = decideRequestingOrigin(
      { origin: 'https://pm.example' },
      'https://pm.example',
      'https://tracker.example/collect', // foreign, not a credential origin, not same-origin
      inputs,
    );
    expect(d.deny).toBe('cross-origin-foreign');
  });

  it('ALLOWS a granted app fetching its OWN origin (same-origin foreign fetch)', () => {
    const d = decideRequestingOrigin(
      { origin: 'https://pm.example' },
      'https://pm.example',
      'https://pm.example/api/local.json', // same origin as the requester
      inputs,
    );
    expect(d.deny).toBeNull();
  });

  it('DENIES when the stamp is missing even with a valid attested+granted sender', () => {
    const d = decideRequestingOrigin(
      { origin: 'https://pm.example' },
      undefined,
      'https://alice.pod.example/x',
      inputs,
    );
    expect(d.deny).toBe('forbidden-origin');
  });
});
