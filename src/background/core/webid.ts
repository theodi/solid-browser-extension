// AUTHORED-BY Claude Opus 4.8
/**
 * WebID profile parsing — issuer resolution + display profile, via proper RDF (N3.js),
 * never regex over Turtle. The house rule (suite-wide) is to parse RDF with N3/@solid
 * libraries, not hand-rolled string matching; a profile can be in any Turtle shape
 * (prefixed, full-IRI, multi-subject) that a regex would miss or mis-parse.
 *
 * `solid:oidcIssuer` (http://www.w3.org/ns/solid/terms#oidcIssuer) on the WebID subject
 * is the OIDC issuer to log in against. A profile MAY advertise several; we return all so
 * the caller can choose (single → use directly; many → the user picks; none → error).
 */

import { DataFactory, Parser, Store } from 'n3';

const SOLID_OIDC_ISSUER = 'http://www.w3.org/ns/solid/terms#oidcIssuer';
const FOAF_NAME = 'http://xmlns.com/foaf/0.1/name';
const FOAF_IMG = 'http://xmlns.com/foaf/0.1/img';
const VCARD_FN = 'http://www.w3.org/2006/vcard/ns#fn';
const VCARD_PHOTO = 'http://www.w3.org/2006/vcard/ns#hasPhoto';

export interface WebIdProfile {
  /** Every `solid:oidcIssuer` advertised on the WebID subject (deduped, in document order). */
  readonly issuers: string[];
  /** A human display name (foaf:name / vcard:fn), if any. */
  readonly name: string | null;
  /** An avatar URL (foaf:img / vcard:hasPhoto), if any. */
  readonly photoUrl: string | null;
}

/** Parse a WebID Turtle document into a {@link Store}, baselined to the document URL. */
function parse(webId: string, turtle: string): Store {
  const baseIRI = webId.split('#')[0];
  const parser = new Parser({ baseIRI });
  const store = new Store();
  store.addQuads(parser.parse(turtle));
  return store;
}

function objectsFor(store: Store, subject: string, predicate: string): string[] {
  const out: string[] = [];
  for (const quad of store.getQuads(
    DataFactory.namedNode(subject),
    DataFactory.namedNode(predicate),
    null,
    null,
  )) {
    out.push(quad.object.value);
  }
  return out;
}

/** Whether `value` is a parseable http(s) absolute URL (a usable issuer). */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * The `solid:oidcIssuer` objects on the WebID subject, restricted to **NamedNode** terms
 * whose value is an absolute URL. A literal or blank-node issuer object — or a relative /
 * non-URL value — is not a usable issuer and is dropped, so malformed profiles can't feed
 * an invalid issuer string into the login flow.
 */
function issuersFor(store: Store, subject: string): string[] {
  const out: string[] = [];
  for (const quad of store.getQuads(
    DataFactory.namedNode(subject),
    DataFactory.namedNode(SOLID_OIDC_ISSUER),
    null,
    null,
  )) {
    if (quad.object.termType === 'NamedNode' && isHttpUrl(quad.object.value)) {
      out.push(quad.object.value);
    }
  }
  return out;
}

/**
 * Extract the issuer list + display profile for `webId` from its Turtle profile. PURE
 * (no fetch). The issuer list is the deduped, NamedNode-only, absolute-URL
 * `solid:oidcIssuer` objects on the WebID subject; name/photo fall back foaf → vcard.
 */
export function parseWebIdProfile(webId: string, turtle: string): WebIdProfile {
  const store = parse(webId, turtle);

  const issuers = [...new Set(issuersFor(store, webId))];

  const name =
    objectsFor(store, webId, FOAF_NAME)[0] ?? objectsFor(store, webId, VCARD_FN)[0] ?? null;
  const photoUrl =
    objectsFor(store, webId, FOAF_IMG)[0] ?? objectsFor(store, webId, VCARD_PHOTO)[0] ?? null;

  return { issuers, name, photoUrl };
}

export class NoIssuerError extends Error {
  constructor(public readonly webId: string) {
    super(
      `No solid:oidcIssuer found in the WebID profile at ${webId}. The profile must declare a ` +
        'solid:oidcIssuer triple to be used for Solid login.',
    );
    this.name = 'NoIssuerError';
  }
}

/**
 * Choose the single issuer to log in against. One issuer → it; several → the caller's
 * `choose` callback (the user picks); none → {@link NoIssuerError}. PURE except the
 * injected chooser.
 */
export async function selectIssuer(
  profile: WebIdProfile,
  webId: string,
  choose: (issuers: string[]) => Promise<string>,
): Promise<string> {
  if (profile.issuers.length === 0) throw new NoIssuerError(webId);
  if (profile.issuers.length === 1) return profile.issuers[0];
  const chosen = await choose(profile.issuers);
  // The chooser MUST return one of the profile's advertised issuers — never log in against
  // an issuer the WebID doesn't actually advertise.
  if (!profile.issuers.includes(chosen)) {
    throw new Error(`Chosen issuer ${chosen} is not advertised by the WebID profile at ${webId}.`);
  }
  return chosen;
}
