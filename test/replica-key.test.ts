// AUTHORED-BY Claude Opus 4.8
//
// The SECURITY-CRITICAL cache-key derivation for the shared replica. The key IS the
// cross-user / cross-grant boundary in the extension's single shared storage partition
// (design §2.1 LOAD-BEARING CACHE-KEY FIX), so these tests assert the key is injective over
// EVERY dimension and fail-closed (un-keyable) without both security dimensions.

import { describe, expect, it } from 'vitest';
import {
  canonicalAccept,
  computeReplicaKey,
  computeVaryKey,
  replicaKeyRequest,
} from '../src/background/core/replica-key';

const URL_A = 'https://alice.pod.example/finance/budget.ttl';
const WEBID_A = 'https://alice.pod.example/profile/card#me';
const WEBID_B = 'https://bob.pod.example/profile/card#me';
const SCOPE_PM = 'https://pm.example';
const SCOPE_OTHER = 'https://other.example';
const VARY = computeVaryKey('text/turtle');

describe('computeReplicaKey — the security-scoped composite key', () => {
  it('embeds the WebID: same URL+vary, DIFFERENT user → DIFFERENT key (no cross-user collision)', () => {
    const kA = computeReplicaKey({ webId: WEBID_A, grantScope: SCOPE_PM }, URL_A, VARY);
    const kB = computeReplicaKey({ webId: WEBID_B, grantScope: SCOPE_PM }, URL_A, VARY);
    expect(kA).not.toBeNull();
    expect(kB).not.toBeNull();
    expect(kA).not.toBe(kB);
  });

  it('embeds the grant-scope: same URL+user, DIFFERENT granted origin → DIFFERENT key', () => {
    const k1 = computeReplicaKey({ webId: WEBID_A, grantScope: SCOPE_PM }, URL_A, VARY);
    const k2 = computeReplicaKey({ webId: WEBID_A, grantScope: SCOPE_OTHER }, URL_A, VARY);
    expect(k1).not.toBe(k2);
  });

  it('is STABLE: identical (webId, grantScope, url, vary) → identical key', () => {
    const k1 = computeReplicaKey({ webId: WEBID_A, grantScope: SCOPE_PM }, URL_A, VARY);
    const k2 = computeReplicaKey({ webId: WEBID_A, grantScope: SCOPE_PM }, URL_A, VARY);
    expect(k1).toBe(k2);
  });

  it('FAIL-CLOSED: a null WebID → un-keyable (null), never a shared bucket', () => {
    expect(computeReplicaKey({ webId: null, grantScope: SCOPE_PM }, URL_A, VARY)).toBeNull();
  });

  it('FAIL-CLOSED: a null grant-scope → un-keyable (null)', () => {
    expect(computeReplicaKey({ webId: WEBID_A, grantScope: null }, URL_A, VARY)).toBeNull();
  });

  it('is injective across components even for adversarially-crafted values (NUL delimiter)', () => {
    // The key delimiter is a NUL byte, impossible in any real WebID/origin/URL — so even an
    // attacker who could place a SPACE at a component boundary cannot forge a colliding key.
    // (A SPACE-delimited join would COLLIDE on this pair; the NUL join keeps them distinct.)
    const k1 = computeReplicaKey({ webId: 'https://a', grantScope: 'https://b c' }, URL_A, VARY);
    const k2 = computeReplicaKey({ webId: 'https://a https://b', grantScope: 'c' }, URL_A, VARY);
    expect(k1).not.toBe(k2);
  });
});

describe('replicaKeyRequest — the synthetic Cache-API key', () => {
  it('produces an injective sentinel-origin Request URL per distinct tuple', () => {
    const rA = replicaKeyRequest({ webId: WEBID_A, grantScope: SCOPE_PM }, URL_A, VARY);
    const rB = replicaKeyRequest({ webId: WEBID_B, grantScope: SCOPE_PM }, URL_A, VARY);
    expect(rA?.url).not.toBe(rB?.url);
    expect(rA?.url.startsWith('https://solid-extension-replica.invalid/')).toBe(true);
  });

  it('FAIL-CLOSED: a null security dimension → null Request (cannot key bytes)', () => {
    expect(replicaKeyRequest({ webId: null, grantScope: SCOPE_PM }, URL_A, VARY)).toBeNull();
    expect(replicaKeyRequest({ webId: WEBID_A, grantScope: null }, URL_A, VARY)).toBeNull();
  });

  it('the sentinel key cannot collide with any real pod URL (different origin)', () => {
    const r = replicaKeyRequest({ webId: WEBID_A, grantScope: SCOPE_PM }, URL_A, VARY);
    expect(new URL(r?.url ?? '').origin).toBe('https://solid-extension-replica.invalid');
    expect(new URL(r?.url ?? '').origin).not.toBe(new URL(URL_A).origin);
  });
});

describe('canonicalAccept / computeVaryKey — RDF variant collapse (one byte copy)', () => {
  it('collapses every RDF media type + */* to text/turtle (Turtle & JSON-LD share one entry)', () => {
    expect(canonicalAccept('application/ld+json')).toBe('text/turtle');
    expect(canonicalAccept('text/turtle')).toBe('text/turtle');
    expect(canonicalAccept('application/n-triples, text/turtle;q=0.9')).toBe('text/turtle');
    expect(canonicalAccept('*/*')).toBe('text/turtle');
    expect(canonicalAccept(null)).toBe('text/turtle');
  });

  it('keys a non-RDF Accept on what was requested (image/png stays distinct)', () => {
    expect(canonicalAccept('image/png')).toBe('image/png');
    expect(computeVaryKey('image/png')).toBe('accept=image/png');
  });

  it('a Turtle read and a JSON-LD read of the SAME resource compute the SAME key', () => {
    const scope = { webId: WEBID_A, grantScope: SCOPE_PM };
    const kTurtle = computeReplicaKey(scope, URL_A, computeVaryKey('text/turtle'));
    const kJsonLd = computeReplicaKey(scope, URL_A, computeVaryKey('application/ld+json'));
    expect(kTurtle).toBe(kJsonLd);
  });
});
