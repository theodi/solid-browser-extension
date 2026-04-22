// --require preload that auto-grants OIDC consent on CSS. This lets the
// extension's per-client silent re-auth (prompt=none) succeed without the
// IdP pausing for a consent screen on every new client ID.
//
// Instead of removing the consent prompt from the policy (which breaks
// CSS's scope/grant bookkeeping because no Grant ever gets created),
// we install a `loadExistingGrant` hook that auto-creates a Grant with all
// requested scopes whenever one doesn't already exist for the (account,
// client) pair. oidc-provider's consent checks (`op_scopes_missing`,
// `op_claims_missing`, etc.) then see those scopes as already-granted and
// don't trigger the consent prompt.
'use strict';

const path = require('path');

const cssDistDir = path.resolve(
  __dirname,
  '..',
  '..',
  'node_modules',
  '@solid',
  'community-server',
  'dist',
);

const { IdentityProviderFactory } = require(
  path.join(cssDistDir, 'identity', 'configuration', 'IdentityProviderFactory'),
);
const { importOidcProvider } = require(
  path.join(cssDistDir, 'identity', 'IdentityUtil'),
);

IdentityProviderFactory.prototype.createProvider = async function createProvider() {
  const key = await this.jwkGenerator.getPrivateKey();
  const config = await this.initConfig(key);
  this.configureClaims(config, key.alg);
  this.configureRoutes(config);
  this.configureErrors(config);
  const oidcImport = await importOidcProvider();
  const policy = oidcImport.interactionPolicy.base();
  await this.promptFactory.handleSafe(policy);
  config.interactions.policy = policy;

  config.loadExistingGrant = async function loadExistingGrant(ctx) {
    const grantId = (ctx.oidc.result && ctx.oidc.result.consent && ctx.oidc.result.consent.grantId)
      || ctx.oidc.session.grantIdFor(ctx.oidc.client.clientId);
    if (grantId) {
      return ctx.oidc.provider.Grant.find(grantId);
    }
    if (!ctx.oidc.session.accountId) {
      return undefined;
    }
    const grant = new ctx.oidc.provider.Grant({
      clientId: ctx.oidc.client.clientId,
      accountId: ctx.oidc.session.accountId,
    });
    const requestedScopes = ctx.oidc.requestParamOIDCScopes
      ? [...ctx.oidc.requestParamOIDCScopes].join(' ')
      : 'openid webid offline_access';
    grant.addOIDCScope(requestedScopes);
    const newGrantId = await grant.save();
    // grantIdFor(clientId, value) is both getter (1-arg) and setter (2-arg)
    // in this version of oidc-provider. Persist the new grant on the session
    // so subsequent requests skip the consent prompt.
    ctx.oidc.session.grantIdFor(ctx.oidc.client.clientId, newGrantId);
    return grant;
  };

  const provider = new oidcImport.default(this.baseUrl, config);
  provider.proxy = true;
  this.captureErrorResponses(provider);
  return provider;
};
