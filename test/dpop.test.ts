// AUTHORED-BY Claude Opus 4.8

import * as jose from 'jose';
import { describe, expect, it } from 'vitest';
import {
  accessTokenHash,
  canonicalHtu,
  createDpopProof,
  DPOP_ALG,
  exportDpopKeyPair,
  generateDpopKeyPair,
  importDpopKeyPair,
} from '../src/background/core/dpop';

describe('canonicalHtu', () => {
  it('strips the query and fragment (RFC 9449 §4.2)', () => {
    expect(canonicalHtu('https://pod.example/a/b.ttl?x=1#frag')).toBe(
      'https://pod.example/a/b.ttl',
    );
  });

  it('preserves scheme, host, port and path', () => {
    expect(canonicalHtu('https://pod.example:8443/private/notes.ttl')).toBe(
      'https://pod.example:8443/private/notes.ttl',
    );
  });

  it('throws on a non-URL', () => {
    expect(() => canonicalHtu('not a url')).toThrow();
  });
});

describe('accessTokenHash', () => {
  it('is the base64url SHA-256 of the ASCII token', async () => {
    const token = 'abc123';
    const expected = jose.base64url.encode(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),
    );
    expect(await accessTokenHash(token)).toBe(expected);
  });
});

describe('createDpopProof', () => {
  it('produces a verifiable JWS with the correct header and required claims', async () => {
    const keyPair = await generateDpopKeyPair();
    const proof = await createDpopProof({
      keyPair,
      htm: 'get',
      htu: 'https://pod.example/x?q=1',
    });

    const { payload, protectedHeader } = await jose.jwtVerify(proof, keyPair.publicKey);
    expect(protectedHeader.typ).toBe('dpop+jwt');
    expect(protectedHeader.alg).toBe(DPOP_ALG);
    expect(payload.htm).toBe('GET'); // upper-cased
    expect(payload.htu).toBe('https://pod.example/x'); // canonicalised
    expect(typeof payload.jti).toBe('string');
    expect(typeof payload.iat).toBe('number');
    expect(payload.ath).toBeUndefined(); // no access token => no ath
    expect(payload.nonce).toBeUndefined();
  });

  it('embeds ONLY public JWK components in the header (never the private `d`)', async () => {
    const keyPair = await generateDpopKeyPair();
    const proof = await createDpopProof({ keyPair, htm: 'GET', htu: 'https://pod.example/x' });
    const header = jose.decodeProtectedHeader(proof);
    const jwk = header.jwk as Record<string, unknown>;
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(jwk.x).toBeTypeOf('string');
    expect(jwk.y).toBeTypeOf('string');
    expect(jwk.d).toBeUndefined();
  });

  it('includes ath when an access token is presented and nonce when supplied', async () => {
    const keyPair = await generateDpopKeyPair();
    const proof = await createDpopProof({
      keyPair,
      htm: 'POST',
      htu: 'https://pod.example/x',
      accessToken: 'tok',
      nonce: 'srv-nonce',
    });
    const { payload } = await jose.jwtVerify(proof, keyPair.publicKey);
    expect(payload.ath).toBe(await accessTokenHash('tok'));
    expect(payload.nonce).toBe('srv-nonce');
  });

  it('mints a fresh jti every call (single-use proofs)', async () => {
    const keyPair = await generateDpopKeyPair();
    const a = jose.decodeJwt(
      await createDpopProof({ keyPair, htm: 'GET', htu: 'https://pod.example/x' }),
    );
    const b = jose.decodeJwt(
      await createDpopProof({ keyPair, htm: 'GET', htu: 'https://pod.example/x' }),
    );
    expect(a.jti).not.toBe(b.jti);
  });
});

describe('keypair export/import round-trip (service-worker persistence)', () => {
  it('re-imported key produces proofs verifiable against the original public key', async () => {
    const keyPair = await generateDpopKeyPair();
    const stored = await exportDpopKeyPair(keyPair);
    expect(stored.privateKey.d).toBeTypeOf('string'); // extractable private key persisted
    const reimported = await importDpopKeyPair(stored);

    const proof = await createDpopProof({
      keyPair: reimported,
      htm: 'GET',
      htu: 'https://pod.example/x',
    });
    // verify against the ORIGINAL public key — same jkt survives a SW restart.
    await expect(jose.jwtVerify(proof, keyPair.publicKey)).resolves.toBeTruthy();
  });
});
