// AUTHORED-BY Claude Opus 4.8
/**
 * `WWW-Authenticate` parsing + the RFC 9449 §8 DPoP-nonce-challenge classifier.
 *
 * A Solid resource server that requires a server-supplied DPoP nonce answers the first
 * request with `401` + `WWW-Authenticate: DPoP …, error="use_dpop_nonce"` and a fresh
 * `DPoP-Nonce` header. The client must re-mint its proof WITH that nonce and retry ONCE.
 * This module is the conservative classifier for that case, mirroring
 * `@jeswr/solid-elements`'s `isUseDpopNonceChallenge`/`parseWwwAuthenticate` so the
 * extension behaves identically to the rest of the suite.
 *
 * Conservative on purpose: we treat a 401 as a nonce challenge ONLY when the server
 * EXPLICITLY says the token was fine and only the nonce was missing
 * (`error="use_dpop_nonce"` on a `DPoP` challenge). Any OTHER error (invalid_token,
 * expired/revoked) returns false, so the caller force-refreshes the token instead of
 * looping on a stale one even when the server ALSO rotated the nonce.
 */

interface Challenge {
  scheme: string;
  params: Map<string, string>;
}

type Atom = { kind: 'word'; value: string } | { kind: 'quoted'; value: string } | { kind: 'eq' };

/**
 * Tokenise a `WWW-Authenticate` header into atoms (a bare word, a quoted string, or a
 * standalone `=`). The grammar (RFC 9110 §11.6.1) is comma-ambiguous, so we scan
 * character-by-character; quoted strings (which may contain commas/`=`) are kept whole.
 */
function tokenize(header: string): Atom[] {
  const atoms: Atom[] = [];
  let i = 0;
  const n = header.length;
  while (i < n) {
    const c = header[i];
    if (c === ' ' || c === '\t' || c === ',') {
      i++;
      continue;
    }
    if (c === '=') {
      atoms.push({ kind: 'eq' });
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      let value = '';
      while (i < n && header[i] !== '"') {
        if (header[i] === '\\' && i + 1 < n) {
          value += header[i + 1];
          i += 2;
        } else {
          value += header[i];
          i++;
        }
      }
      i++; // closing quote
      atoms.push({ kind: 'quoted', value });
      continue;
    }
    let value = '';
    while (i < n && !' \t,="'.includes(header[i])) {
      value += header[i];
      i++;
    }
    atoms.push({ kind: 'word', value });
  }
  return atoms;
}

/**
 * Parse a `WWW-Authenticate` header into its individual challenges, each with its scheme
 * and a quote-aware map of its top-level auth-params. PURE; odd input degrades safely.
 */
export function parseWwwAuthenticate(header: string): Challenge[] {
  const atoms = tokenize(header);
  const challenges: Challenge[] = [];
  let current: Challenge | null = null;
  let i = 0;

  const isAuthScheme = (a: Atom): boolean => a.kind === 'word' && /^[A-Za-z][\w-]*$/.test(a.value);

  while (i < atoms.length) {
    const atom = atoms[i];
    // `word =` => a param; a bare `word` not followed by `=` starts a new challenge.
    if (atom.kind === 'word') {
      const next = atoms[i + 1];
      if (next && next.kind === 'eq') {
        const valueAtom = atoms[i + 2];
        if (current && valueAtom && (valueAtom.kind === 'word' || valueAtom.kind === 'quoted')) {
          current.params.set(atom.value.toLowerCase(), valueAtom.value);
          i += 3;
          continue;
        }
        // param with no current challenge / malformed — skip the `=`.
        i += 2;
        continue;
      }
      if (isAuthScheme(atom)) {
        current = { scheme: atom.value, params: new Map() };
        challenges.push(current);
        i += 1;
        continue;
      }
    }
    i += 1;
  }
  return challenges;
}

/**
 * Whether a 401 response is a PURE DPoP-nonce challenge (RFC 9449 §8): a `DPoP`
 * challenge whose `error` param is exactly `use_dpop_nonce`. Conservative — see the
 * module doc. PURE on the header value via {@link parseWwwAuthenticate}.
 */
export function isUseDpopNonceChallenge(response: Response): boolean {
  const header = response.headers.get('www-authenticate');
  if (!header) return false;
  for (const challenge of parseWwwAuthenticate(header)) {
    if (challenge.scheme.toLowerCase() === 'dpop') {
      if (challenge.params.get('error') === 'use_dpop_nonce') return true;
    }
  }
  return false;
}
