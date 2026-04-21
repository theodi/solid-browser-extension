const SESSIONS_KEY = 'solid-sessions';
const ACTIVE_WEBID_KEY = 'solid-active-webid';
const LEGACY_SESSION_KEY = 'solid-session';

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

export type SessionMap = Record<string, StoredSession>;

async function migrateLegacySession(): Promise<void> {
  const legacy = await chrome.storage.local.get(LEGACY_SESSION_KEY);
  const old = legacy[LEGACY_SESSION_KEY] as StoredSession | undefined;
  if (!old) return;
  const current = await chrome.storage.local.get([SESSIONS_KEY, ACTIVE_WEBID_KEY]);
  const sessions: SessionMap = current[SESSIONS_KEY] ?? {};
  if (!sessions[old.clientId]) {
    sessions[old.clientId] = old;
    await chrome.storage.local.set({ [SESSIONS_KEY]: sessions });
  }
  if (!current[ACTIVE_WEBID_KEY]) {
    await chrome.storage.local.set({ [ACTIVE_WEBID_KEY]: old.webId });
  }
  await chrome.storage.local.remove(LEGACY_SESSION_KEY);
}

export async function loadSessions(): Promise<SessionMap> {
  await migrateLegacySession();
  const result = await chrome.storage.local.get(SESSIONS_KEY);
  return (result[SESSIONS_KEY] as SessionMap | undefined) ?? {};
}

export async function loadSessionForClient(clientId: string): Promise<StoredSession | null> {
  const all = await loadSessions();
  return all[clientId] ?? null;
}

export async function saveSession(session: StoredSession): Promise<void> {
  const all = await loadSessions();
  all[session.clientId] = session;
  await chrome.storage.local.set({ [SESSIONS_KEY]: all });
}

export async function clearSessionForClient(clientId: string): Promise<void> {
  const all = await loadSessions();
  if (!(clientId in all)) return;
  delete all[clientId];
  await chrome.storage.local.set({ [SESSIONS_KEY]: all });
}

export async function clearAllSessions(): Promise<void> {
  await chrome.storage.local.remove(SESSIONS_KEY);
}

export async function loadActiveWebId(): Promise<string | null> {
  const result = await chrome.storage.local.get(ACTIVE_WEBID_KEY);
  return (result[ACTIVE_WEBID_KEY] as string | undefined) ?? null;
}

export async function saveActiveWebId(webId: string): Promise<void> {
  await chrome.storage.local.set({ [ACTIVE_WEBID_KEY]: webId });
}

export async function clearActiveWebId(): Promise<void> {
  await chrome.storage.local.remove(ACTIVE_WEBID_KEY);
}

export interface StoredProfile {
  webId: string;
  name: string | null;
  photoUrl: string | null;
  turtle: string;
}

export async function saveProfile(profile: StoredProfile): Promise<void> {
  await chrome.storage.local.set({ 'solid-profile': profile });
  // Also add to past profiles
  const past = await loadPastProfiles();
  const existing = past.findIndex((p) => p.webId === profile.webId);
  if (existing >= 0) {
    past[existing] = { webId: profile.webId, name: profile.name, photoUrl: profile.photoUrl };
  } else {
    past.unshift({ webId: profile.webId, name: profile.name, photoUrl: profile.photoUrl });
  }
  await chrome.storage.local.set({ 'solid-past-profiles': past });
}

export async function loadProfile(): Promise<StoredProfile | null> {
  const result = await chrome.storage.local.get('solid-profile');
  return result['solid-profile'] ?? null;
}

export async function clearProfile(): Promise<void> {
  await chrome.storage.local.remove('solid-profile');
}

export interface PastProfile {
  webId: string;
  name: string | null;
  photoUrl: string | null;
}

export async function loadPastProfiles(): Promise<PastProfile[]> {
  const result = await chrome.storage.local.get('solid-past-profiles');
  return result['solid-past-profiles'] ?? [];
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
