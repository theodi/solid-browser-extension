import type { BrowserContext, Page } from '@playwright/test';

const TEST_WEBID = 'http://localhost:3000/test-pod/profile/card#me';

/**
 * Complete the CSS OIDC login + consent flow on an already-opened login page.
 * The page should be the CSS login page opened by chrome.identity.launchWebAuthFlow.
 */
export async function completeOidcLogin(loginPage: Page) {
  await loginPage.waitForLoadState('networkidle');

  // Three possible landing URLs:
  //   1. Login form (new session, no SSO cookie)
  //   2. Consent page (SSO cookie valid but client not yet consented)
  //   3. Callback/closed (CSS configured without a consent prompt, e.g. via
  //      the e2e consent-skip patch — the auth flow ends silently)
  const onConsent = loginPage.url().includes('/.account/oidc/consent');
  if (!onConsent) {
    try {
      await loginPage.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 5_000 });
    } catch {
      // No login form appeared — the flow already finished (consent-less IdP).
      return;
    }
    await loginPage.fill('#email', 'test@example.com');
    await loginPage.fill('#password', 'test-password-123');
    await Promise.all([
      loginPage.click('button[type="submit"]'),
      Promise.race([
        loginPage.waitForURL('**/.account/oidc/consent/**', { timeout: 10_000 }),
        loginPage.waitForEvent('close', { timeout: 10_000 }),
      ]),
    ]);
    if (loginPage.isClosed()) return;
    await loginPage.waitForLoadState('networkidle');
  }

  await loginPage.waitForSelector('#authorize:not([disabled])', { timeout: 10_000 });
  await loginPage.click('#authorize');
}

/**
 * Perform a full login flow via the extension popup using dynamic registration.
 */
export async function performLogin(context: BrowserContext, extensionId: string) {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popupPage.fill('#webid-input', TEST_WEBID);

  const loginPagePromise = context.waitForEvent('page');
  await popupPage.click('#login-btn');

  await completeOidcLogin(await loginPagePromise);

  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popupPage.locator('#logged-in-view').waitFor({ state: 'visible', timeout: 15_000 });

  await popupPage.close();
}
