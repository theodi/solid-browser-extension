// AUTHORED-BY Claude Opus 4.8
/**
 * Tests for the static Solid-OIDC Client Identifier Document + its in-code mirror.
 *
 * The published Client ID Document (`public/clientid.jsonld`, copied into the build) lets
 * the extension log in with a STABLE named identity instead of throwaway dynamic
 * registration. These assert:
 *   (1) the shipped JSON has every member Solid-OIDC requires, with the right values;
 *   (2) the in-code mirror CLIENT_ID_DOCUMENT agrees byte-for-byte with the shipped JSON
 *       (so the asset can never silently drift from what the flow expects);
 *   (3) the document's redirect_uri shape matches auth-flow.ts's chromiumapp.org callback;
 *   (4) the reachability probe is fail-closed: the shipped placeholder URL is treated as
 *       unreachable so initiateLogin() falls back to dynamic client registration.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_ID_DOCUMENT,
  CLIENT_ID_SCOPE,
  isPlaceholderClientId,
  isPublishedClientIdReachable,
  PUBLISHED_CLIENT_ID_URL,
  SOLID_OIDC_CONTEXT,
} from '../src/background/client-id';

const shippedJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('../public/clientid.jsonld', import.meta.url)), 'utf8'),
) as Record<string, unknown>;

describe('the shipped Client Identifier Document (public/clientid.jsonld)', () => {
  it('declares the Solid-OIDC @context', () => {
    expect(shippedJson['@context']).toBe(SOLID_OIDC_CONTEXT);
    expect(SOLID_OIDC_CONTEXT).toBe('https://www.w3.org/ns/solid/oidc-context.jsonld');
  });

  it('has the spec-required members for a public-client app', () => {
    expect(typeof shippedJson.client_id).toBe('string');
    expect(shippedJson.client_name).toBe('Solid Browser Extension');
    expect(shippedJson.scope).toBe(CLIENT_ID_SCOPE);
    expect(shippedJson.scope).toBe('openid webid offline_access');
    // A browser-extension app is a PUBLIC client → no client secret → auth method "none".
    expect(shippedJson.token_endpoint_auth_method).toBe('none');
    expect(shippedJson.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(shippedJson.response_types).toEqual(['code']);
  });

  it('redirect_uris is the chromiumapp.org callback shape (matches auth-flow getRedirectURL("callback"))', () => {
    const uris = shippedJson.redirect_uris as string[];
    expect(Array.isArray(uris)).toBe(true);
    expect(uris).toHaveLength(1);
    // chrome.identity.getRedirectURL('callback') => https://<extension-id>.chromiumapp.org/callback
    expect(uris[0]).toMatch(/^https:\/\/[^/]+\.chromiumapp\.org\/callback$/);
  });

  it('client_id self-references the published URL (spec: the doc client_id MUST equal its URL)', () => {
    // Both are the placeholder today — the maintainer sets them to the real hosted URL.
    expect(shippedJson.client_id).toBe(PUBLISHED_CLIENT_ID_URL);
  });

  it('the in-code mirror CLIENT_ID_DOCUMENT agrees byte-for-byte with the shipped JSON', () => {
    // The single source of truth check: if either side changes, this fails loudly.
    expect(JSON.parse(JSON.stringify(CLIENT_ID_DOCUMENT))).toEqual(shippedJson);
  });
});

describe('PUBLISHED_CLIENT_ID_URL placeholder (needs:user — hosting)', () => {
  it('is a clearly-marked, non-real placeholder so the maintainer must fill it in', () => {
    expect(PUBLISHED_CLIENT_ID_URL).toContain('REPLACE-ME');
    expect(isPlaceholderClientId(PUBLISHED_CLIENT_ID_URL)).toBe(true);
    // It IS at least a well-formed https: URL (so wiring/validation paths are exercised).
    expect(() => new URL(PUBLISHED_CLIENT_ID_URL)).not.toThrow();
    expect(new URL(PUBLISHED_CLIENT_ID_URL).protocol).toBe('https:');
  });
});

describe('isPublishedClientIdReachable — fail-closed fallback to dynamic registration', () => {
  it('returns false for the placeholder WITHOUT making a network call', async () => {
    let called = false;
    const fetchSpy = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    expect(await isPublishedClientIdReachable(PUBLISHED_CLIENT_ID_URL, fetchSpy)).toBe(false);
    expect(called).toBe(false); // short-circuited on the placeholder sentinel
  });

  it('returns false for an empty URL', async () => {
    expect(await isPublishedClientIdReachable('')).toBe(false);
  });

  it('returns false for a non-HTTPS URL (the published doc must be HTTPS)', async () => {
    const fetchSpy = (async () => new Response('{}')) as unknown as typeof fetch;
    expect(await isPublishedClientIdReachable('http://example.com/cid.jsonld', fetchSpy)).toBe(
      false,
    );
  });

  it('returns false on a non-2xx response', async () => {
    const fetchSpy = (async () =>
      new Response('not found', { status: 404 })) as unknown as typeof fetch;
    expect(await isPublishedClientIdReachable('https://real.example/cid.jsonld', fetchSpy)).toBe(
      false,
    );
  });

  it('returns false when the doc client_id does NOT self-reference its URL', async () => {
    const fetchSpy = (async () =>
      new Response(JSON.stringify({ client_id: 'https://other.example/x' }), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(await isPublishedClientIdReachable('https://real.example/cid.jsonld', fetchSpy)).toBe(
      false,
    );
  });

  it('returns false on a network error (never throws)', async () => {
    const fetchSpy = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(
      isPublishedClientIdReachable('https://real.example/cid.jsonld', fetchSpy),
    ).resolves.toBe(false);
  });

  it('returns TRUE for a reachable, self-referencing https doc', async () => {
    const url = 'https://real.example/cid.jsonld';
    const fetchSpy = (async () =>
      new Response(JSON.stringify({ client_id: url, client_name: 'X' }), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(await isPublishedClientIdReachable(url, fetchSpy)).toBe(true);
  });

  it('tolerates a trailing-slash difference in the self-reference', async () => {
    const url = 'https://real.example/cid.jsonld/';
    const fetchSpy = (async () =>
      new Response(JSON.stringify({ client_id: 'https://real.example/cid.jsonld' }), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(await isPublishedClientIdReachable(url, fetchSpy)).toBe(true);
  });
});
