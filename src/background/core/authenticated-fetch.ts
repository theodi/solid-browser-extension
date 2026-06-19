// AUTHORED-BY Claude Opus 4.8
/**
 * The authenticated resource fetch — DPoP-bound, origin-gated, fail-closed, with the
 * RFC 9449 §8 nonce-challenge retry. This is the one place the user's access token is
 * ever attached to an outbound request, so every guard lives here.
 *
 * Security invariants (all enforced unconditionally):
 *   1. ORIGIN GATE. The token is attached ONLY when the request URL's origin is in the
 *      session's allowed set ({@link isOriginAllowed}). A request to any other origin is
 *      sent UNAUTHENTICATED (a plain fetch) — never with the token. This stops a
 *      malicious page exfiltrating the token via `solid.fetch("https://evil/")`.
 *   2. TOKEN-ENDPOINT GUARD. The resource token is never attached to the issuer's /token
 *      endpoint ({@link isTokenEndpoint}) even if that origin is allowed.
 *   3. NONCE RETRY (RFC 9449 §8). On a pure `use_dpop_nonce` 401, the proof is re-minted
 *      with the server `DPoP-Nonce` and the request retried ONCE.
 *   4. SINGLE RETRY. Exactly one retry, so a misbehaving server cannot loop us.
 *
 * The re-entrancy guard (a fetch the SW itself issues for discovery/token/refresh must
 * never recurse into THIS path) is the caller's responsibility: discovery/token use the
 * raw `fetch`, never this function. This function only ever sends the access token to a
 * vetted resource origin.
 */

import { createDpopProof } from './dpop';
import { isOriginAllowed, isTokenEndpoint } from './origin-policy';
import { isUseDpopNonceChallenge } from './www-authenticate';

/** The minimum session shape the authenticated fetch needs. */
export interface FetchSession {
  readonly accessToken: string;
  readonly dpopKeyPair: CryptoKeyPair;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly tokenEndpoint: string | null;
}

export interface AuthenticatedFetchOptions {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: BodyInit | null;
  /** A cached server DPoP nonce to use on the first attempt, if known. */
  readonly nonce?: string;
  /** Injected fetch (test seam). Defaults to the global. */
  readonly fetchImpl?: typeof fetch;
}

export interface AuthenticatedFetchResult {
  readonly response: Response;
  /** The freshest server DPoP nonce observed (cache it for the next request). */
  readonly nonce?: string;
  /** Whether the token was actually attached (false => sent as a plain, public fetch). */
  readonly authenticated: boolean;
}

const HOP_BY_HOP = new Set(['authorization', 'dpop', 'host', 'content-length', 'connection']);

/** Strip caller-supplied auth/transport headers so a page can't inject its own DPoP/Authorization. */
function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * Perform an authenticated resource fetch under all the invariants above. If the request
 * is not to an allowed origin (or targets the token endpoint), it is performed as a plain
 * fetch with NO token — fail-open for reads to public/foreign resources, fail-CLOSED for
 * the credential (the credential is simply never attached).
 */
export async function authenticatedFetch(
  session: FetchSession,
  options: AuthenticatedFetchOptions,
): Promise<AuthenticatedFetchResult> {
  const { url, method, body } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const safeHeaders = sanitizeHeaders(options.headers);

  const mayAttach =
    isOriginAllowed(session.allowedOrigins, url) && !isTokenEndpoint(url, session.tokenEndpoint);

  if (!mayAttach) {
    // Foreign / public / token-endpoint: a plain, credential-free fetch.
    const response = await fetchImpl(url, { method, headers: safeHeaders, body });
    return { response, authenticated: false };
  }

  const send = async (nonce?: string): Promise<Response> => {
    const proof = await createDpopProof({
      keyPair: session.dpopKeyPair,
      htm: method,
      htu: url,
      accessToken: session.accessToken,
      nonce,
    });
    return fetchImpl(url, {
      method,
      headers: {
        ...safeHeaders,
        Authorization: `DPoP ${session.accessToken}`,
        DPoP: proof,
      },
      body,
    });
  };

  let response = await send(options.nonce);
  let serverNonce = response.headers.get('dpop-nonce') ?? undefined;

  // RFC 9449 §8: one retry on a pure nonce challenge, using the server's fresh nonce.
  if (response.status === 401 && isUseDpopNonceChallenge(response) && serverNonce) {
    response = await send(serverNonce);
    serverNonce = response.headers.get('dpop-nonce') ?? serverNonce;
  }

  return { response, nonce: serverNonce, authenticated: true };
}
