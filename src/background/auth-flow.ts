import * as jose from 'jose';
import {
  saveAuthParams,
  loadAuthParams,
  clearAuthParams,
  exportDpopKeyPair,
  saveSession,
  type StoredSession,
} from './session-database';

interface OidcConfig {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  issuer: string;
}

async function fetchOidcConfig(idpUrl: string): Promise<OidcConfig> {
  const wellKnown = idpUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
  const response = await fetch(wellKnown);
  if (!response.ok) {
    throw new Error(`Failed to fetch OIDC configuration from ${wellKnown}: ${response.status}`);
  }
  return response.json();
}

// The extension's dereferenceable Client ID Document URL.
// This URL must resolve to a JSON-LD document with the extension's redirect_uri.
// In production, this would be hosted by the extension developer.
const EXTENSION_CLIENT_ID = 'http://localhost:8080/client-id';

function getRedirectUri(): string {
  return chrome.identity.getRedirectURL('callback');
}

async function resolveIssuerFromWebId(webId: string): Promise<string> {
  // Fetch the WebID profile document as Turtle
  const response = await fetch(webId, {
    headers: { Accept: 'text/turtle' },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch WebID profile from ${webId}: ${response.status}`);
  }
  const turtle = await response.text();

  // Parse solid:oidcIssuer from the Turtle document
  // Matches both full URI and prefixed forms
  const issuerPatterns = [
    /solid:oidcIssuer\s+<([^>]+)>/,
    /http:\/\/www\.w3\.org\/ns\/solid\/terms#oidcIssuer>\s+<([^>]+)>/,
  ];

  for (const pattern of issuerPatterns) {
    const match = turtle.match(pattern);
    if (match) {
      return match[1];
    }
  }

  throw new Error(
    `No solid:oidcIssuer found in WebID profile at ${webId}. ` +
    'Make sure your WebID profile contains a solid:oidcIssuer triple.'
  );
}

async function dynamicClientRegistration(
  registrationEndpoint: string,
  redirectUri: string
): Promise<{ client_id: string; client_secret?: string }> {
  const response = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      application_type: 'web',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      id_token_signed_response_alg: 'ES256',
      grant_types: ['authorization_code', 'refresh_token'],
      scope: 'openid webid offline_access',
      client_name: 'Solid Browser Extension',
    }),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Dynamic client registration failed: ${response.status} ${errorBody}`);
  }
  return response.json();
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return jose.base64url.encode(array);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return jose.base64url.encode(new Uint8Array(hash));
}

function generateState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return jose.base64url.encode(array);
}

export async function initiateLogin(webId: string, staticClientId?: string): Promise<StoredSession> {
  const idpUrl = await resolveIssuerFromWebId(webId);
  const oidcConfig = await fetchOidcConfig(idpUrl);
  const redirectUri = getRedirectUri();

  // Use the provided client ID, or the extension's own dereferenceable client identifier
  const clientId = staticClientId || EXTENSION_CLIENT_ID;

  // Generate PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Store auth params for token exchange
  await saveAuthParams({
    codeVerifier,
    state,
    clientId,
    tokenEndpoint: oidcConfig.token_endpoint,
    issuer: oidcConfig.issuer,
    redirectUri,
  });

  // Build authorization URL
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid webid offline_access',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
  });

  const authUrl = `${oidcConfig.authorization_endpoint}?${params.toString()}`;

  // Launch the auth flow using chrome.identity
  const callbackUrl = await new Promise<string>((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      (responseUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!responseUrl) {
          reject(new Error('No response URL from auth flow'));
        } else {
          resolve(responseUrl);
        }
      }
    );
  });

  // Extract code, state, iss from callback URL
  const callbackParams = new URL(callbackUrl).searchParams;
  const code = callbackParams.get('code');
  const returnedState = callbackParams.get('state');
  const iss = callbackParams.get('iss');

  if (!code || !returnedState) {
    const error = callbackParams.get('error');
    const errorDesc = callbackParams.get('error_description');
    throw new Error(`Auth failed: ${error} - ${errorDesc}`);
  }

  // Handle the redirect (exchange code for tokens)
  return handleRedirect(code, returnedState, iss || oidcConfig.issuer);
}

async function createDpopProof(
  keyPair: CryptoKeyPair,
  method: string,
  url: string,
  nonce?: string
): Promise<string> {
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const header: Record<string, unknown> = {
    alg: 'ES256',
    typ: 'dpop+jwt',
    jwk: {
      kty: publicJwk.kty,
      crv: publicJwk.crv,
      x: publicJwk.x,
      y: publicJwk.y,
    },
  };

  const payload: Record<string, unknown> = {
    jti: crypto.randomUUID(),
    htm: method,
    htu: url,
    iat: Math.floor(Date.now() / 1000),
  };
  if (nonce) {
    payload.nonce = nonce;
  }

  const privateKey = await crypto.subtle.importKey(
    'jwk',
    await crypto.subtle.exportKey('jwk', keyPair.privateKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  return new jose.SignJWT(payload as jose.JWTPayload)
    .setProtectedHeader(header as jose.JWTHeaderParameters)
    .sign(privateKey);
}

export async function handleRedirect(
  code: string,
  state: string,
  iss: string
): Promise<StoredSession> {
  const authParams = await loadAuthParams();
  if (!authParams) {
    throw new Error('No auth params found — login flow not initiated');
  }

  // Validate state
  if (state !== authParams.state) {
    throw new Error('State mismatch — possible CSRF attack');
  }

  // Validate issuer
  if (iss !== authParams.issuer) {
    throw new Error('Issuer mismatch');
  }

  // Generate DPoP key pair (extractable for persistence)
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  const tokenEndpoint = authParams.tokenEndpoint as string;
  const dpopProof = await createDpopProof(keyPair, 'POST', tokenEndpoint);

  // Exchange code for tokens
  const tokenResponse = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      DPoP: dpopProof,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: authParams.redirectUri as string,
      client_id: authParams.clientId as string,
      code_verifier: authParams.codeVerifier as string,
    }),
  });

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${tokenResponse.status} ${errorBody}`);
  }

  const tokens = await tokenResponse.json();

  // Decode the ID token to extract WebID
  const idTokenPayload = jose.decodeJwt(tokens.id_token);
  const webId = (idTokenPayload.webid as string) || (idTokenPayload.sub as string);
  if (!webId) {
    throw new Error('No WebID found in ID token');
  }

  const storedKeyPair = await exportDpopKeyPair(keyPair);

  const session: StoredSession = {
    webId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    dpopKeyPair: storedKeyPair,
    tokenEndpoint,
    issuer: authParams.issuer as string,
    clientId: authParams.clientId as string,
    expiresAt: Date.now() + (tokens.expires_in ?? 600) * 1000,
  };

  await saveSession(session);
  await clearAuthParams();

  return session;
}

export async function refreshAccessToken(
  session: StoredSession,
  keyPair: CryptoKeyPair
): Promise<StoredSession> {
  const dpopProof = await createDpopProof(keyPair, 'POST', session.tokenEndpoint);

  const response = await fetch(session.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      DPoP: dpopProof,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
      client_id: session.clientId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const tokens = await response.json();

  const updatedSession: StoredSession = {
    ...session,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? session.refreshToken,
    expiresAt: Date.now() + (tokens.expires_in ?? 600) * 1000,
  };

  await saveSession(updatedSession);
  return updatedSession;
}

export { createDpopProof };
