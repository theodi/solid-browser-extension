// AUTHORED-BY Claude Opus 4.8
import { describe, expect, it } from 'vitest';
import { NoIssuerError, parseWebIdProfile, selectIssuer } from '../src/background/core/webid';

const WEBID = 'https://alice.pod.example/profile/card#me';

const PROFILE = `
@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
<#me> a foaf:Person ;
  foaf:name "Alice Example" ;
  foaf:img <https://alice.pod.example/profile/photo.jpg> ;
  solid:oidcIssuer <https://idp.example/> .
`;

describe('parseWebIdProfile', () => {
  it('extracts the solid:oidcIssuer, name and photo from a prefixed profile', () => {
    const p = parseWebIdProfile(WEBID, PROFILE);
    expect(p.issuers).toEqual(['https://idp.example/']);
    expect(p.name).toBe('Alice Example');
    expect(p.photoUrl).toBe('https://alice.pod.example/profile/photo.jpg');
  });

  it('parses a full-IRI (non-prefixed) issuer triple', () => {
    const turtle = `<${WEBID}> <http://www.w3.org/ns/solid/terms#oidcIssuer> <https://idp2.example/> .`;
    expect(parseWebIdProfile(WEBID, turtle).issuers).toEqual(['https://idp2.example/']);
  });

  it('returns ALL advertised issuers, deduped', () => {
    const turtle = `
      @prefix solid: <http://www.w3.org/ns/solid/terms#>.
      <#me> solid:oidcIssuer <https://a.example/>, <https://b.example/>, <https://a.example/> .`;
    expect(parseWebIdProfile(WEBID, turtle).issuers).toEqual([
      'https://a.example/',
      'https://b.example/',
    ]);
  });

  it('falls back to vcard:fn / vcard:hasPhoto when foaf is absent', () => {
    const turtle = `
      @prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
      @prefix solid: <http://www.w3.org/ns/solid/terms#>.
      <#me> vcard:fn "VC Alice" ; vcard:hasPhoto <https://x/p.png> ; solid:oidcIssuer <https://i/> .`;
    const p = parseWebIdProfile(WEBID, turtle);
    expect(p.name).toBe('VC Alice');
    expect(p.photoUrl).toBe('https://x/p.png');
  });

  it('returns no issuers / null name when the profile lacks them', () => {
    const p = parseWebIdProfile(WEBID, '<#me> a <http://xmlns.com/foaf/0.1/Person> .');
    expect(p.issuers).toEqual([]);
    expect(p.name).toBeNull();
    expect(p.photoUrl).toBeNull();
  });

  it('IGNORES a literal-valued solid:oidcIssuer (issuers must be NamedNode IRIs)', () => {
    const turtle = `
      @prefix solid: <http://www.w3.org/ns/solid/terms#>.
      <#me> solid:oidcIssuer "https://not-a-real-iri/" ; solid:oidcIssuer <https://real.example/> .`;
    expect(parseWebIdProfile(WEBID, turtle).issuers).toEqual(['https://real.example/']);
  });

  it('IGNORES a non-http(s) issuer IRI', () => {
    const turtle = `
      @prefix solid: <http://www.w3.org/ns/solid/terms#>.
      <#me> solid:oidcIssuer <urn:bad:issuer> ; solid:oidcIssuer <https://ok.example/> .`;
    expect(parseWebIdProfile(WEBID, turtle).issuers).toEqual(['https://ok.example/']);
  });
});

describe('selectIssuer', () => {
  const choose = async (issuers: string[]) => issuers[1];

  it('uses the single issuer directly without calling choose', async () => {
    const chooser = async () => {
      throw new Error('should not be called');
    };
    const issuer = await selectIssuer(
      { issuers: ['https://i/'], name: null, photoUrl: null },
      WEBID,
      chooser,
    );
    expect(issuer).toBe('https://i/');
  });

  it('asks the chooser when several issuers are advertised', async () => {
    const issuer = await selectIssuer(
      { issuers: ['https://a/', 'https://b/'], name: null, photoUrl: null },
      WEBID,
      choose,
    );
    expect(issuer).toBe('https://b/');
  });

  it('throws NoIssuerError when none are advertised', async () => {
    await expect(
      selectIssuer({ issuers: [], name: null, photoUrl: null }, WEBID, choose),
    ).rejects.toBeInstanceOf(NoIssuerError);
  });

  it('REJECTS a chooser result that is not an advertised issuer', async () => {
    const rogue = async () => 'https://attacker.example/';
    await expect(
      selectIssuer(
        { issuers: ['https://a/', 'https://b/'], name: null, photoUrl: null },
        WEBID,
        rogue,
      ),
    ).rejects.toThrow(/not advertised/);
  });
});
