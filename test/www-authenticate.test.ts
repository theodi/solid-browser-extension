// AUTHORED-BY Claude Opus 4.8
import { describe, expect, it } from 'vitest';
import {
  isUseDpopNonceChallenge,
  parseWwwAuthenticate,
} from '../src/background/core/www-authenticate';

function res(wwwAuth: string | null): Response {
  const headers = new Headers();
  if (wwwAuth !== null) headers.set('www-authenticate', wwwAuth);
  return new Response(null, { status: 401, headers });
}

describe('parseWwwAuthenticate', () => {
  it('parses a single DPoP challenge with params', () => {
    const out = parseWwwAuthenticate('DPoP error="use_dpop_nonce", error_description="x"');
    expect(out).toHaveLength(1);
    expect(out[0].scheme).toBe('DPoP');
    expect(out[0].params.get('error')).toBe('use_dpop_nonce');
    expect(out[0].params.get('error_description')).toBe('x');
  });

  it('parses multiple challenges (Bearer + DPoP)', () => {
    const out = parseWwwAuthenticate('Bearer realm="solid", DPoP error="use_dpop_nonce"');
    expect(out.map((c) => c.scheme)).toEqual(['Bearer', 'DPoP']);
    expect(out[1].params.get('error')).toBe('use_dpop_nonce');
  });

  it('handles quoted values containing commas and equals', () => {
    const out = parseWwwAuthenticate('DPoP error_description="a, b=c", error="use_dpop_nonce"');
    expect(out[0].params.get('error_description')).toBe('a, b=c');
    expect(out[0].params.get('error')).toBe('use_dpop_nonce');
  });

  it('splits a DPoP-nonce + Bearer-invalid_token mix into two distinct challenges', () => {
    const out = parseWwwAuthenticate('DPoP error="use_dpop_nonce", Bearer error="invalid_token"');
    expect(out.map((c) => [c.scheme, c.params.get('error')])).toEqual([
      ['DPoP', 'use_dpop_nonce'],
      ['Bearer', 'invalid_token'],
    ]);
  });

  it('keeps the LAST value for a duplicate error param', () => {
    const out = parseWwwAuthenticate('DPoP error="use_dpop_nonce", error="invalid_token"');
    expect(out[0].params.get('error')).toBe('invalid_token');
  });
});

describe('isUseDpopNonceChallenge — conservative RFC 9449 §8 classifier', () => {
  it('true ONLY for a DPoP challenge with error=use_dpop_nonce', () => {
    expect(isUseDpopNonceChallenge(res('DPoP error="use_dpop_nonce"'))).toBe(true);
  });

  it('false for invalid_token (force-refresh path, not a nonce retry)', () => {
    expect(isUseDpopNonceChallenge(res('DPoP error="invalid_token"'))).toBe(false);
  });

  it('false for a Bearer challenge that merely mentions the nonce string', () => {
    expect(isUseDpopNonceChallenge(res('Bearer error="use_dpop_nonce"'))).toBe(false);
  });

  it('false when there is no WWW-Authenticate header', () => {
    expect(isUseDpopNonceChallenge(res(null))).toBe(false);
  });

  it('true when DPoP is the second challenge', () => {
    expect(isUseDpopNonceChallenge(res('Bearer realm="x", DPoP error="use_dpop_nonce"'))).toBe(
      true,
    );
  });

  // Regression (roborev Medium): a MIXED header that signals both a nonce AND a dead
  // token must NOT be treated as a pure nonce challenge — retrying would loop on the
  // dead token; we must force-refresh instead.
  it('false for a mixed header with use_dpop_nonce AND another auth error', () => {
    expect(
      isUseDpopNonceChallenge(res('DPoP error="use_dpop_nonce", Bearer error="invalid_token"')),
    ).toBe(false);
  });

  it('false when a SECOND DPoP challenge carries invalid_token alongside the nonce one', () => {
    expect(
      isUseDpopNonceChallenge(res('DPoP error="use_dpop_nonce", DPoP error="invalid_token"')),
    ).toBe(false);
  });

  it('false when a duplicate error param overwrites use_dpop_nonce with another error', () => {
    // The parser keeps the LAST value for a duplicate key; if that is not the nonce error
    // the classifier must not retry.
    expect(isUseDpopNonceChallenge(res('DPoP error="use_dpop_nonce", error="invalid_token"'))).toBe(
      false,
    );
  });
});
