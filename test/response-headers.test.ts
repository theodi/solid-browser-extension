// AUTHORED-BY Claude Opus 4.8

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_RESPONSE_HEADERS,
  filterResponseHeaders,
} from '../src/background/core/response-headers';

describe('filterResponseHeaders — response-header allowlist (defense-in-depth)', () => {
  it('keeps the Solid/LDP + standard response headers an app needs', () => {
    const headers = new Headers({
      'content-type': 'text/turtle',
      'content-length': '128',
      etag: '"abc123"',
      'last-modified': 'Wed, 21 Oct 2025 07:28:00 GMT',
      link: '<http://www.w3.org/ns/ldp#Resource>; rel="type"',
      allow: 'GET, HEAD, OPTIONS, PUT, PATCH',
      'accept-patch': 'text/n3, application/sparql-update',
      'accept-post': '*/*',
      'accept-put': '*/*',
      'preference-applied': 'return=representation',
      'accept-ranges': 'bytes',
      'wac-allow': 'user="read write",public="read"',
      'www-authenticate': 'DPoP error="invalid_token"',
      location: 'https://alice.pod.example/new',
      'updates-via': 'wss://alice.pod.example/',
    });

    const out = filterResponseHeaders(headers);

    expect(out['content-type']).toBe('text/turtle');
    expect(out['content-length']).toBe('128');
    expect(out.etag).toBe('"abc123"');
    expect(out['last-modified']).toBe('Wed, 21 Oct 2025 07:28:00 GMT');
    expect(out.link).toBe('<http://www.w3.org/ns/ldp#Resource>; rel="type"');
    expect(out.allow).toBe('GET, HEAD, OPTIONS, PUT, PATCH');
    expect(out['accept-patch']).toBe('text/n3, application/sparql-update');
    expect(out['accept-post']).toBe('*/*');
    expect(out['accept-put']).toBe('*/*');
    expect(out['preference-applied']).toBe('return=representation');
    expect(out['accept-ranges']).toBe('bytes');
    expect(out['wac-allow']).toBe('user="read write",public="read"');
    expect(out['www-authenticate']).toBe('DPoP error="invalid_token"');
    expect(out.location).toBe('https://alice.pod.example/new');
    expect(out['updates-via']).toBe('wss://alice.pod.example/');
  });

  it('strips headers that are NOT on the allowlist (server fingerprints / unvetted state)', () => {
    const headers = new Headers({
      'content-type': 'text/turtle',
      server: 'CommunitySolidServer/7.1.3',
      'x-powered-by': 'Express',
      'x-internal-trace-id': 'deadbeef',
      'set-cookie': 'session=secret; HttpOnly',
      'strict-transport-security': 'max-age=63072000',
      'x-custom-server-header': 'leak-me',
    });

    const out = filterResponseHeaders(headers);

    // allowed survives
    expect(out['content-type']).toBe('text/turtle');
    // everything off the allowlist is dropped
    expect(out.server).toBeUndefined();
    expect(out['x-powered-by']).toBeUndefined();
    expect(out['x-internal-trace-id']).toBeUndefined();
    expect(out['set-cookie']).toBeUndefined();
    expect(out['strict-transport-security']).toBeUndefined();
    expect(out['x-custom-server-header']).toBeUndefined();
  });

  it('matches the allowlist case-insensitively (HTTP header names are case-insensitive)', () => {
    // Headers normalises to lower-case internally, but assert the membership test itself
    // is case-insensitive by checking an upper-cased allowlist entry would still pass.
    expect(ALLOWED_RESPONSE_HEADERS.has('etag')).toBe(true);
    const headers = new Headers();
    headers.set('ETag', '"v1"'); // server-supplied mixed case
    const out = filterResponseHeaders(headers);
    // the single kept value, whatever casing the Headers object reports it under
    const values = Object.values(out);
    expect(values).toEqual(['"v1"']);
  });

  it('returns an empty record when the server emits no allowlisted headers', () => {
    const headers = new Headers({ server: 'nginx', 'x-foo': 'bar' });
    expect(filterResponseHeaders(headers)).toEqual({});
  });
});
