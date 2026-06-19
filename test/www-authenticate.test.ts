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
});
