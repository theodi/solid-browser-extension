// AUTHORED-BY Claude Opus 4.8
/**
 * The extension's durable auth state, backed by `chrome.storage.local`.
 *
 * What lives here, and why this store and not the page:
 *   - The active session (access + refresh token, the DPoP keypair as JWK, issuer/token
 *     endpoint, expiry). `chrome.storage.local` is reachable ONLY from the extension's own
 *     contexts (service worker / popup) — NEVER from a web page or the injected MAIN-world
 *     script. The refresh token therefore stays page-unreachable, satisfying the suite's
 *     "DPoP refresh token in extension-appropriate secure storage (not page-reachable)"
 *     invariant. The MAIN-world `window.solid` only ever sees the WebID + a proxied fetch.
 *   - The display profile (name + avatar) for the popup + the action icon.
 *   - The credential-free recent-accounts list (WebID + display, survives logout) for the
 *     returning-user affordance — the suite's recent-accounts UX.
 *   - Per-origin client-id mappings + extra pod origins (the credential boundary inputs).
 *
 * The refresh token is never logged; only the WebID/display is ever surfaced to a page.
 */

import type { StoredDpopKeyPair } from './core/dpop';

const KEYS = {
  session: 'solid:session',
  profile: 'solid:profile',
  recentAccounts: 'solid:recent-accounts',
  clientIds: 'solid:client-ids',
  podOrigins: 'solid:pod-origins',
  authParams: 'solid:auth-params',
} as const;

/** The persisted active session. The DPoP keypair is stored as JWK (see core/dpop). */
export interface StoredSession {
  readonly webId: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly dpopKeyPair: StoredDpopKeyPair;
  readonly issuer: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly expiresAt: number;
}

/** The credential-free display profile shown in the popup + the action icon. */
export interface StoredProfile {
  readonly webId: string;
  readonly name: string | null;
  readonly photoUrl: string | null;
}

/** A previously-used account, for the returning-user affordance (no credential). */
export interface RecentAccount {
  readonly webId: string;
  readonly name: string | null;
  readonly photoUrl: string | null;
}

async function get<T>(key: string): Promise<T | null> {
  const result = await chrome.storage.local.get(key);
  return (result[key] as T) ?? null;
}

async function set(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

// --- Active session -------------------------------------------------------------------

export function loadSession(): Promise<StoredSession | null> {
  return get<StoredSession>(KEYS.session);
}

export function saveSession(session: StoredSession): Promise<void> {
  return set(KEYS.session, session);
}

export async function clearSession(): Promise<void> {
  await chrome.storage.local.remove(KEYS.session);
}

// --- Display profile + recent accounts ------------------------------------------------

export function loadProfile(): Promise<StoredProfile | null> {
  return get<StoredProfile>(KEYS.profile);
}

export async function saveProfile(profile: StoredProfile): Promise<void> {
  await set(KEYS.profile, profile);
  await rememberAccount(profile);
}

export async function clearProfile(): Promise<void> {
  await chrome.storage.local.remove(KEYS.profile);
}

/** The recent-accounts list (most-recent-first, deduped by WebID). Survives logout. */
export async function loadRecentAccounts(): Promise<RecentAccount[]> {
  return (await get<RecentAccount[]>(KEYS.recentAccounts)) ?? [];
}

/** Promote/insert an account at the front of the recent list (logout-surviving memory). */
async function rememberAccount(profile: StoredProfile): Promise<void> {
  const list = await loadRecentAccounts();
  const next: RecentAccount[] = [
    { webId: profile.webId, name: profile.name, photoUrl: profile.photoUrl },
    ...list.filter((a) => a.webId !== profile.webId),
  ].slice(0, 8);
  await set(KEYS.recentAccounts, next);
}

// --- Per-origin client IDs + pod origins (credential-boundary inputs) ------------------

export async function loadClientIds(): Promise<Record<string, string>> {
  return (await get<Record<string, string>>(KEYS.clientIds)) ?? {};
}

export async function saveClientId(origin: string, clientId: string): Promise<void> {
  const map = await loadClientIds();
  map[origin] = clientId;
  await set(KEYS.clientIds, map);
}

/** User-configured pod origins (pods served from a host other than the WebID origin). */
export async function loadPodOrigins(): Promise<string[]> {
  return (await get<string[]>(KEYS.podOrigins)) ?? [];
}

export async function savePodOrigins(origins: string[]): Promise<void> {
  await set(KEYS.podOrigins, origins);
}

// --- Transient auth params (PKCE/state across the redirect) ----------------------------

export interface AuthParams {
  readonly codeVerifier: string;
  readonly state: string;
  readonly clientId: string;
  readonly issuer: string;
  readonly tokenEndpoint: string;
  readonly redirectUri: string;
}

export function loadAuthParams(): Promise<AuthParams | null> {
  return get<AuthParams>(KEYS.authParams);
}

export function saveAuthParams(params: AuthParams): Promise<void> {
  return set(KEYS.authParams, params);
}

export async function clearAuthParams(): Promise<void> {
  await chrome.storage.local.remove(KEYS.authParams);
}
