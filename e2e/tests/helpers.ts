import type { BrowserContext, Page } from '@playwright/test';

/** The seeded CSS test WebID (see e2e/setup/seed.json). */
export const TEST_WEBID = 'http://localhost:3000/test-pod/profile/card#me';

/**
 * Complete the CSS OIDC login + consent flow on the window
 * `chrome.identity.launchWebAuthFlow` opened. CSS auto-redirects to the password page,
 * then to consent; both have JS-enabled submit buttons we wait on.
 */
export async function completeOidcLogin(loginPage: Page): Promise<void> {
  await loginPage.waitForLoadState('networkidle');
  await loginPage.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 10_000 });
  await loginPage.fill('#email', 'test@example.com');
  await loginPage.fill('#password', 'test-password-123');
  await loginPage.click('button[type="submit"]');

  await loginPage.waitForURL('**/.account/oidc/consent/**', { timeout: 10_000 });
  await loginPage.waitForLoadState('networkidle');
  await loginPage.waitForSelector('#authorize:not([disabled])', { timeout: 10_000 });
  await loginPage.click('#authorize');
}

/**
 * Drive a full login through the extension popup. Opens the popup, enters the WebID,
 * completes the CSS OIDC flow in the launched window, then reopens the popup and waits
 * for the signed-in state (the <jeswr-account-menu> appears in #signed-in).
 */
export async function performLogin(
  context: BrowserContext,
  extensionId: string,
  webId: string = TEST_WEBID,
): Promise<void> {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  // The signed-out surface is now <jeswr-login-panel>; drive its shadow parts.
  // Playwright's CSS engine pierces the (open) shadow root, so `part=` selectors work.
  await popupPage.fill('#login-panel >>> [part="webid-input"]', webId);

  const loginPagePromise = context.waitForEvent('page');
  await popupPage.click('#login-panel >>> [part="login-button"]');
  await completeOidcLogin(await loginPagePromise);

  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popupPage.locator('#signed-in').waitFor({ state: 'visible', timeout: 15_000 });
  await popupPage.close();
}
