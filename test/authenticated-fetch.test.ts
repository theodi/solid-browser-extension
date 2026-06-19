// AUTHORED-BY Claude Opus 4.8

import * as jose from 'jose';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { authenticatedFetch, type FetchSession } from '../src/background/core/authenticated-fetch';
import { generateDpopKeyPair } from '../src/background/core/dpop';

async function makeSession(overrides: Partial<FetchSession> = {}): Promise<FetchSession> {
  return {
    accessToken: 'access-token-123',
    dpopKeyPair: await generateDpopKeyPair(),
    allowedOrigins: new Set(['https://alice.pod.example']),
    tokenEndpoint: 'https://idp.example/token',
    ...overrides,
  };
}

function ok(headers: Record<string, string> = {}): Response {
  return new Response('body', { status: 200, headers });
}

/** A fetch mock typed so `.mock.calls[i][1]` is the RequestInit (the credential carrier). */
type FetchMock = Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;
function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): FetchMock {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => impl(input.toString(), init));
}

describe('authenticatedFetch — credential boundary', () => {
  it('attaches a DPoP-bound token for an allowed origin', async () => {
    const session = await makeSession();
    const fetchImpl = mockFetch(async () => ok());
    const { authenticated } = await authenticatedFetch(session, {
      url: 'https://alice.pod.example/private/notes.ttl',
      method: 'GET',
      headers: {},
      fetchImpl,
    });

    expect(authenticated).toBe(true);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('DPoP access-token-123');
    expect(typeof headers.DPoP).toBe('string');
    // the proof carries the access-token hash + correct htu
    const proof = jose.decodeJwt(headers.DPoP);
    expect(proof.htu).toBe('https://alice.pod.example/private/notes.ttl');
    expect(proof.htm).toBe('GET');
    expect(proof.ath).toBeTypeOf('string');
  });

  it('the DPoP htu drops the query + fragment for a queried resource URL (RFC 9449 §4.2)', async () => {
    const session = await makeSession();
    const fetchImpl = mockFetch(async () => ok());
    await authenticatedFetch(session, {
      url: 'https://alice.pod.example/q.ttl?a=1&b=2#frag',
      method: 'GET',
      headers: {},
      fetchImpl,
    });
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(jose.decodeJwt(headers.DPoP).htu).toBe('https://alice.pod.example/q.ttl');
  });

  it('does NOT attach the token to a foreign origin (token-leak attack)', async () => {
    const session = await makeSession();
    const fetchImpl = mockFetch(async () => ok());
    const { authenticated } = await authenticatedFetch(session, {
      url: 'https://evil.example/collect',
      method: 'POST',
      headers: {},
      body: 'x',
      fetchImpl,
    });

    expect(authenticated).toBe(false);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers.DPoP).toBeUndefined();
  });

  it('does NOT attach the token to the issuer token endpoint even if its origin is allowed', async () => {
    const session = await makeSession({
      allowedOrigins: new Set(['https://idp.example']),
      tokenEndpoint: 'https://idp.example/token',
    });
    const fetchImpl = mockFetch(async () => ok());
    const { authenticated } = await authenticatedFetch(session, {
      url: 'https://idp.example/token',
      method: 'POST',
      headers: {},
      fetchImpl,
    });
    expect(authenticated).toBe(false);
  });

  it('strips a page-supplied Authorization / DPoP header (no header injection)', async () => {
    const session = await makeSession();
    const fetchImpl = mockFetch(async () => ok());
    await authenticatedFetch(session, {
      url: 'https://alice.pod.example/x',
      method: 'GET',
      headers: { Authorization: 'Bearer attacker', DPoP: 'forged', 'X-Keep': 'yes' },
      fetchImpl,
    });
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('DPoP access-token-123'); // ours, not the page's
    expect(headers['X-Keep']).toBe('yes'); // unrelated header preserved
  });

  // The attach-path assertion above is partially masked: that path UNCONDITIONALLY sets its
  // own Authorization/DPoP after the spread, so neutering `sanitizeHeaders` would not fail it.
  // The strip is the ONLY guard on the NON-attach (foreign origin / token endpoint) path —
  // there `safeHeaders` is passed straight to fetch with no overwrite — and it must also be
  // case-insensitive (page headers can be lower-cased). These assertions prove both, so a
  // neutered `sanitizeHeaders` genuinely fails (verified by temporarily neutering it).
  it('strips page-supplied auth headers on the NON-attach (foreign-origin) path — the only guard there', async () => {
    const session = await makeSession();
    const fetchImpl = mockFetch(async () => ok());
    const { authenticated } = await authenticatedFetch(session, {
      url: 'https://evil.example/collect',
      method: 'POST',
      headers: { Authorization: 'Bearer attacker', DPoP: 'forged', 'X-Keep': 'yes' },
      body: 'x',
      fetchImpl,
    });

    expect(authenticated).toBe(false); // foreign origin: sent as a plain fetch, no token
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    // No overwrite happens on this path, so if sanitizeHeaders were a no-op these would leak.
    expect(headers.Authorization).toBeUndefined();
    expect(headers.DPoP).toBeUndefined();
    expect(headers['X-Keep']).toBe('yes'); // unrelated header still forwarded to the foreign origin
  });

  it('strips page-supplied auth headers on the NON-attach (token-endpoint) path', async () => {
    const session = await makeSession({
      allowedOrigins: new Set(['https://idp.example']),
      tokenEndpoint: 'https://idp.example/token',
    });
    const fetchImpl = mockFetch(async () => ok());
    const { authenticated } = await authenticatedFetch(session, {
      url: 'https://idp.example/token',
      method: 'POST',
      headers: { Authorization: 'Bearer attacker', DPoP: 'forged' },
      fetchImpl,
    });

    expect(authenticated).toBe(false); // token endpoint: never gets the resource token
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers.DPoP).toBeUndefined();
  });

  it('strips LOWER-CASE page-supplied auth headers (case-insensitive) on the non-attach path', async () => {
    const session = await makeSession();
    const fetchImpl = mockFetch(async () => ok());
    await authenticatedFetch(session, {
      url: 'https://evil.example/collect',
      method: 'POST',
      headers: { authorization: 'Bearer attacker', dpop: 'forged', 'x-keep': 'yes' },
      body: 'x',
      fetchImpl,
    });
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    // case-insensitive strip: lower-cased auth headers must not survive on the foreign path
    expect(headers.authorization).toBeUndefined();
    expect(headers.dpop).toBeUndefined();
    expect(headers['x-keep']).toBe('yes');
  });

  it('strips a LOWER-CASE page-supplied auth header on the attach path too (no duplicate header)', async () => {
    const session = await makeSession();
    const fetchImpl = mockFetch(async () => ok());
    await authenticatedFetch(session, {
      url: 'https://alice.pod.example/x',
      method: 'GET',
      headers: { authorization: 'Bearer attacker', dpop: 'forged' },
      fetchImpl,
    });
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    // the page's lower-cased copies are stripped, so only our canonical-cased ones remain
    expect(headers.authorization).toBeUndefined();
    expect(headers.dpop).toBeUndefined();
    expect(headers.Authorization).toBe('DPoP access-token-123');
    expect(typeof headers.DPoP).toBe('string');
  });

  it('retries ONCE on an RFC 9449 §8 nonce challenge with the server nonce', async () => {
    const session = await makeSession();
    let call = 0;
    const fetchImpl = mockFetch(async () => {
      call += 1;
      if (call === 1) {
        return new Response('nonce required', {
          status: 401,
          headers: {
            'www-authenticate': 'DPoP error="use_dpop_nonce"',
            'dpop-nonce': 'server-nonce-xyz',
          },
        });
      }
      return ok({ 'dpop-nonce': 'server-nonce-2' });
    });

    const { response, nonce } = await authenticatedFetch(session, {
      url: 'https://alice.pod.example/x',
      method: 'GET',
      headers: {},
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(nonce).toBe('server-nonce-2');
    // the retry proof carried the server nonce
    const retryHeaders = (fetchImpl.mock.calls[1][1] as RequestInit).headers as Record<
      string,
      string
    >;
    const proof = jose.decodeJwt(retryHeaders.DPoP);
    expect(proof.nonce).toBe('server-nonce-xyz');
  });

  it('does NOT retry on a non-nonce 401 (e.g. invalid_token)', async () => {
    const session = await makeSession();
    const fetchImpl = mockFetch(
      async () =>
        new Response('nope', {
          status: 401,
          headers: { 'www-authenticate': 'DPoP error="invalid_token"' },
        }),
    );
    const { response } = await authenticatedFetch(session, {
      url: 'https://alice.pod.example/x',
      method: 'GET',
      headers: {},
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(401);
  });
});
