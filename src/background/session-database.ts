const STORAGE_KEY = 'solid-session';

export interface StoredSession {
  webId: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  dpopKeyPair: {
    publicKey: JsonWebKey;
    privateKey: JsonWebKey;
  };
  tokenEndpoint: string;
  issuer: string;
  clientId: string;
  expiresAt: number;
}

export interface ClientIdMapping {
  [origin: string]: string;
}

export async function loadSession(): Promise<StoredSession | null> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] ?? null;
}

export async function saveSession(session: StoredSession): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: session });
}

export async function clearSession(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

export async function loadClientIds(): Promise<ClientIdMapping> {
  const result = await chrome.storage.local.get('solid-client-ids');
  return result['solid-client-ids'] ?? {};
}

export async function saveClientId(origin: string, clientId: string): Promise<void> {
  const mapping = await loadClientIds();
  mapping[origin] = clientId;
  await chrome.storage.local.set({ 'solid-client-ids': mapping });
}

export async function loadAuthParams(): Promise<Record<string, unknown> | null> {
  const result = await chrome.storage.local.get('solid-auth-params');
  return result['solid-auth-params'] ?? null;
}

export async function saveAuthParams(params: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set({ 'solid-auth-params': params });
}

export async function clearAuthParams(): Promise<void> {
  await chrome.storage.local.remove('solid-auth-params');
}

export async function exportDpopKeyPair(
  keyPair: CryptoKeyPair
): Promise<{ publicKey: JsonWebKey; privateKey: JsonWebKey }> {
  const publicKey = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const privateKey = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  return { publicKey, privateKey };
}

export async function importDpopKeyPair(
  stored: { publicKey: JsonWebKey; privateKey: JsonWebKey }
): Promise<CryptoKeyPair> {
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    stored.publicKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  );
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    stored.privateKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign']
  );
  return { publicKey, privateKey };
}
