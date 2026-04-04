import type { BrowserContext } from '@playwright/test';

const CSS_BASE = 'http://localhost:3000';

export async function performLogin(context: BrowserContext, extensionId: string) {
  // Open popup and initiate login
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popupPage.fill('#idp-url', CSS_BASE);

  // Listen for the CSS login page to open before clicking
  const loginPagePromise = context.waitForEvent('page');
  await popupPage.click('#login-btn');

  // Get the CSS login page (opened by chrome.identity.launchWebAuthFlow)
  const loginPage = await loginPagePromise;
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

  // Wait for the auth flow to complete by polling the popup for logged-in state
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popupPage.locator('#logged-in-view').waitFor({ state: 'visible', timeout: 15_000 });

  await popupPage.close();
}
