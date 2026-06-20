// AUTHORED-BY Claude Opus 4.8
/**
 * The Solid-OIDC authorization-code + PKCE + DPoP login, adapted for the MV3 service
 * worker (no `window`): the interactive redirect is driven by
 * `chrome.identity.launchWebAuthFlow`, which opens the IdP in a managed window and
 * resolves with the `https://<extension-id>.chromiumapp.org/...` callback URL. The DPoP
 * proofs (token exchange + refresh) go through the shared core/dpop module so the proof
 * discipline matches the rest of the suite (RFC 9449).
 *
 * Login uses a PUBLISHED Solid-OIDC Client Identifier Document URL as the `client_id`
 * (so the consent screen shows a stable name and `token_endpoint_auth_method=none`
 * public-client behaviour is correct), falling back to dynamic client registration only
 * when no Client ID Document is configured (dev). A page may supply its OWN Client ID
 * Document via `window.solid.setClientId(...)` to identify itself to the pod.
 */

import * as jose from 'jose';
import { isPublishedClientIdReachable, PUBLISHED_CLIENT_ID_URL } from './client-id';
import {
  createDpopProof,
  exportDpopKeyPair,
  generateDpopKeyPair,
  importDpopKeyPair,
} from './core/dpop';
import { isLoopbackHost } from './core/origin-policy';
import { parseWebIdProfile, selectIssuer } from './core/webid';
import {
  type AuthParams,
  clearAuthParams,
  loadAuthParams,
  type StoredSession,
  saveAuthParams,
  saveSession,
} from './session-store';

/**
 * The extension's own published Client Identifier Document URL — see client-id.ts (the
 * static doc is committed at `public/clientid.jsonld`, copied into the build). This is a
 * PLACEHOLDER (`REPLACE-ME.example`) until the maintainer hosts the document and pins the
 * real URL (a needs:user step — see client-id.ts). Because the placeholder is unreachable,
 * the flow auto-falls-back to dynamic client registration (see initiateLogin), so shipping
 * the placeholder does NOT break login.
 */
const DEFAULT_CLIENT_ID = PUBLISHED_CLIENT_ID_URL;

const SCOPE = 'openid webid offline_access';

interface OidcConfig {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  issuer: string;
}

/** The `https:` everywhere / `http:` loopback-only transport guard (RFC 8252 §8.3). */
function assertIssuerTransport(issuer: string): void {
  const url = new URL(issuer);
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return;
  throw new Error(`Refusing to use insecure issuer transport: ${issuer}`);
}

async function fetchOidcConfig(issuer: string): Promise<OidcConfig> {
  assertIssuerTransport(issuer);
  const wellKnown = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const response = await fetch(wellKnown);
  if (!response.ok) {
    throw new Error(`Failed to fetch OIDC configuration (${response.status}) from ${wellKnown}`);
  }
  const config = (await response.json()) as OidcConfig;
  // OIDC Discovery §4.3: the returned issuer must equal the requested one.
  if (config.issuer.replace(/\/$/, '') !== issuer.replace(/\/$/, '')) {
    throw new Error(`Issuer mismatch: requested ${issuer}, discovery returned ${config.issuer}`);
  }
  return config;
}

/** The fixed redirect URI this extension is registered with (chrome.identity). */
function getRedirectUri(): string {
  return chrome.identity.getRedirectURL('callback');
}

async function fetchProfile(webId: string): Promise<string> {
  const response = await fetch(webId, { headers: { Accept: 'text/turtle' } });
  if (!response.ok) {
    throw new Error(`Failed to fetch WebID profile (${response.status}) from ${webId}`);
  }
  return response.text();
}

async function dynamicClientRegistration(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<string> {
  const response = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      application_type: 'web',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: SCOPE,
      client_name: 'Solid Browser Extension',
    }),
  });
  if (!response.ok) {
    throw new Error(`Dynamic client registration failed (${response.status})`);
  }
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

function randomB64Url(bytes: number): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return jose.base64url.encode(array);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return jose.base64url.encode(new Uint8Array(digest));
}

export interface InitiateLoginOptions {
  readonly webId: string;
  /** A Client Identifier Document URL to log in as (page-supplied or the extension's own). */
  readonly clientId?: string;
  /** Resolve a multi-issuer ambiguity (the user picks). Defaults to the first issuer. */
  readonly chooseIssuer?: (issuers: string[]) => Promise<string>;
}

/**
 * Run the interactive authorization-code (DPoP) login for a WebID and persist the
 * resulting session. Returns the WebID + display profile parsed from the same fetch.
 */
export async function initiateLogin(
  options: InitiateLoginOptions,
): Promise<{ session: StoredSession; name: string | null; photoUrl: string | null }> {
  const { webId } = options;
  const turtle = await fetchProfile(webId);
  const profile = parseWebIdProfile(webId, turtle);
  const issuer = await selectIssuer(
    profile,
    webId,
    options.chooseIssuer ?? (async (issuers) => issuers[0]),
  );

  const config = await fetchOidcConfig(issuer);
  const redirectUri = getRedirectUri();

  // Client-id resolution order:
  //   1. a page-supplied Client ID Document URL (the page identifying itself), used as-is;
  //   2. otherwise the extension's OWN published Client ID Document — but ONLY if it is
  //      actually reachable + self-consistent (the IdP will need to dereference it). The
  //      shipped value is a placeholder until hosted (needs:user), so this probe fails and
  //      we fall through to (3) — keeping login working with no published client-id;
  //   3. dynamic client registration (the fallback), when there is no usable client-id.
  let clientId = options.clientId || '';
  if (!clientId && DEFAULT_CLIENT_ID && (await isPublishedClientIdReachable(DEFAULT_CLIENT_ID))) {
    clientId = DEFAULT_CLIENT_ID;
  }
  if (!clientId) {
    if (!config.registration_endpoint) {
      throw new Error(
        'No client identifier configured and the issuer offers no dynamic registration endpoint.',
      );
    }
    clientId = await dynamicClientRegistration(config.registration_endpoint, redirectUri);
  }

  const codeVerifier = randomB64Url(32);
  const codeChallenge = await pkceChallenge(codeVerifier);
  const state = randomB64Url(16);

  const params: AuthParams = {
    codeVerifier,
    state,
    clientId,
    issuer: config.issuer,
    tokenEndpoint: config.token_endpoint,
    redirectUri,
  };
  await saveAuthParams(params);

  const authUrl = new URL(config.authorization_endpoint);
  authUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
  }).toString();

  const callbackUrl = await new Promise<string>((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true }, (url) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!url) reject(new Error('Authorization was cancelled.'));
      else resolve(url);
    });
  });

  const session = await completeLogin(callbackUrl);
  return { session, name: profile.name, photoUrl: profile.photoUrl };
}

/** Exchange the authorization code (from the callback URL) for a DPoP-bound token set. */
async function completeLogin(callbackUrl: string): Promise<StoredSession> {
  const callback = new URL(callbackUrl).searchParams;
  const code = callback.get('code');
  const returnedState = callback.get('state');
  const returnedIss = callback.get('iss');

  const params = await loadAuthParams();
  if (!params) throw new Error('Login flow not initiated (no auth params).');

  if (!code) {
    const error = callback.get('error') ?? 'unknown';
    throw new Error(`Authorization failed: ${error} - ${callback.get('error_description') ?? ''}`);
  }
  if (returnedState !== params.state) {
    throw new Error('State mismatch — possible CSRF; aborting login.');
  }
  // RFC 9207 authorization-server issuer identification — defends against IdP mix-up: if the
  // AS returned an `iss`, it MUST equal the issuer we started the flow with.
  if (returnedIss !== null && returnedIss.replace(/\/$/, '') !== params.issuer.replace(/\/$/, '')) {
    throw new Error('Issuer mismatch in the authorization response — aborting login.');
  }

  const keyPair = await generateDpopKeyPair();
  const dpopProof = await createDpopProof({
    keyPair,
    htm: 'POST',
    htu: params.tokenEndpoint,
  });

  const response = await fetch(params.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: dpopProof },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.codeVerifier,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}).`);
  }
  const tokens = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token: string;
    expires_in?: number;
  };

  const idToken = jose.decodeJwt(tokens.id_token);
  const webId = (idToken.webid as string) || (idToken.sub as string);
  if (!webId) throw new Error('No WebID in the ID token.');

  const session: StoredSession = {
    webId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    dpopKeyPair: await exportDpopKeyPair(keyPair),
    issuer: params.issuer,
    tokenEndpoint: params.tokenEndpoint,
    clientId: params.clientId,
    expiresAt: Date.now() + (tokens.expires_in ?? 600) * 1000,
  };

  await saveSession(session);
  await clearAuthParams();
  return session;
}

/**
 * Refresh an expiring session via the DPoP-bound refresh-token grant, reusing the SAME
 * keypair (CSS binds the refresh token to the original `jkt`, so a regenerated key fails).
 * One retry on a server DPoP-nonce challenge.
 */
export async function refreshSession(session: StoredSession): Promise<StoredSession> {
  if (!session.refreshToken) throw new Error('No refresh token; re-login required.');
  const keyPair = await importDpopKeyPair(session.dpopKeyPair);

  const grant = async (nonce?: string): Promise<Response> => {
    const proof = await createDpopProof({
      keyPair,
      htm: 'POST',
      htu: session.tokenEndpoint,
      nonce,
    });
    return fetch(session.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: proof },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken as string,
        client_id: session.clientId,
        scope: SCOPE,
      }),
    });
  };

  let response = await grant();
  if (response.status === 400 || response.status === 401) {
    const nonce = response.headers.get('dpop-nonce');
    if (nonce) response = await grant(nonce);
  }
  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status}).`);
  }

  const tokens = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const updated: StoredSession = {
    ...session,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? session.refreshToken,
    expiresAt: Date.now() + (tokens.expires_in ?? 600) * 1000,
  };
  await saveSession(updated);
  return updated;
}
