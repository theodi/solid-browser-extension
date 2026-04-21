import type { BrowserContext, Page } from '@playwright/test';

const TEST_WEBID = 'http://localhost:3000/test-pod/profile/card#me';

/**
 * Complete the CSS OIDC login + consent flow on an already-opened login page.
 * The page should be the CSS login page opened by chrome.identity.launchWebAuthFlow.
 */
export async function completeOidcLogin(loginPage: Page) {
  await loginPage.waitForLoadState('networkidle');

  // If the IdP already has a valid SSO cookie (e.g. from a previous login
  // in this context) CSS skips the password step and drops straight onto
  // the consent page. Detect both cases.
  const onConsent = loginPage.url().includes('/.account/oidc/consent');
  if (!onConsent) {
    await loginPage.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 10_000 });
    await loginPage.fill('#email', 'test@example.com');
    await loginPage.fill('#password', 'test-password-123');
    await loginPage.click('button[type="submit"]');
    await loginPage.waitForURL('**/.account/oidc/consent/**', { timeout: 10_000 });
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
