import type { BrowserContext, Page } from '@playwright/test';

const TEST_WEBID = 'http://localhost:3000/test-pod/profile/card#me';

/**
 * Complete the CSS OIDC login + consent flow on an already-opened login page.
 * The page should be the CSS login page opened by chrome.identity.launchWebAuthFlow.
 */
export async function completeOidcLogin(loginPage: Page) {
  await loginPage.waitForLoadState('networkidle');

  // CSS auto-redirects to password login page
  // Wait for the submit button to be enabled (CSS uses JS to enable it)
  await loginPage.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 10_000 });

  // Fill in credentials
  await loginPage.fill('#email', 'test@example.com');
  await loginPage.fill('#password', 'test-password-123');
  await loginPage.click('button[type="submit"]');

  // Wait for consent page to load
  await loginPage.waitForURL('**/.account/oidc/consent/**', { timeout: 10_000 });
  await loginPage.waitForLoadState('networkidle');

  // Wait for the Authorize button to be enabled (JS populates WebIDs then enables it)
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
