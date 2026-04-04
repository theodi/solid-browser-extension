import { test, expect } from '../fixtures';
import { completeOidcLogin } from './helpers';

const TEST_SITE = 'http://localhost:8080';
const TEST_WEBID = 'http://localhost:3000/test-pod/profile/card#me';

function buildClientIdUrl(redirectUri: string, clientName: string): string {
  return `http://localhost:8080/client-id?redirect_uri=${encodeURIComponent(redirectUri)}&client_name=${encodeURIComponent(clientName)}`;
}

test('dynamic registration: login without a static client ID', async ({ context, extensionId }) => {
  // This is the default flow — no client ID set, uses dynamic registration
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popupPage.fill('#webid-input', TEST_WEBID);

  const loginPagePromise = context.waitForEvent('page');
  await popupPage.click('#login-btn');
  await completeOidcLogin(await loginPagePromise);

  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popupPage.locator('#logged-in-view').waitFor({ state: 'visible', timeout: 15_000 });
  await popupPage.close();

  // Verify authenticated fetch works
  const page = await context.newPage();
  await page.goto(TEST_SITE);
  await expect(page.locator('#fetch-result')).toContainText('Private Note', { timeout: 15_000 });
});

test('static registration: extension-owned client ID', async ({ context, extensionId }) => {
  // Build the static Client ID Document URL using the extension's redirect URI
  const redirectUri = `https://${extensionId}.chromiumapp.org/callback`;
  const clientIdUrl = buildClientIdUrl(redirectUri, 'Solid Browser Extension');

  // Set the client ID for the extension via the popup before logging in
  // We do this by evaluating in the popup context which sends the message directly
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);

  // Send SOLID_SET_CLIENT_ID directly from the popup context
  await popupPage.evaluate((cid) => {
    chrome.runtime.sendMessage({
      type: 'SOLID_SET_CLIENT_ID',
      origin: 'chrome-extension://' + chrome.runtime.id,
      clientId: cid,
    });
  }, clientIdUrl);

  // Now log in — the service worker will use the stored client ID
  await popupPage.fill('#webid-input', TEST_WEBID);

  // Need to also pass clientId in the login message from the popup
  // Since the popup sends SOLID_LOGIN directly, we override the submit handler
  await popupPage.evaluate((params) => {
    chrome.runtime.sendMessage({
      type: 'SOLID_LOGIN',
      webId: params.webId,
      clientId: params.clientId,
    }, () => {});
  }, { webId: TEST_WEBID, clientId: clientIdUrl });

  // Wait for the login page to open
  const loginPage = await context.waitForEvent('page', { timeout: 15_000 });
  await completeOidcLogin(loginPage);

  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popupPage.locator('#logged-in-view').waitFor({ state: 'visible', timeout: 15_000 });
  await popupPage.close();

  // Verify authenticated fetch works
  const page = await context.newPage();
  await page.goto(TEST_SITE);
  await expect(page.locator('#fetch-result')).toContainText('Private Note', { timeout: 15_000 });
});

test('static registration: application-owned client ID via setClientId', async ({ context, extensionId }) => {
  // Build the static Client ID Document URL using the extension's redirect URI
  const redirectUri = `https://${extensionId}.chromiumapp.org/callback`;
  const clientIdUrl = buildClientIdUrl(redirectUri, 'Test Application');

  // Navigate to the test site and call solid.setClientId() before login
  const page = await context.newPage();
  await page.goto(TEST_SITE);

  // Wait for the extension to inject window.solid
  await page.waitForFunction(() => typeof (window as any).solid !== 'undefined', null, { timeout: 5_000 });

  // Set the client ID for this origin
  await page.evaluate((cid) => {
    (window as any).solid.setClientId(cid);
  }, clientIdUrl);

  // Now trigger login from the page — solid.login() will include the clientId
  const loginPagePromise = context.waitForEvent('page');
  await page.evaluate((webId) => {
    (window as any).solid.login(webId);
  }, TEST_WEBID);

  await completeOidcLogin(await loginPagePromise);

  // Wait for the page to update with the authenticated data
  await expect(page.locator('#fetch-result')).toContainText('Private Note', { timeout: 15_000 });
});
