import { test, expect } from '../fixtures';
import { completeOidcLogin } from './helpers';

const TEST_SITE = 'http://localhost:8080';
const APP_SITE = 'http://localhost:8081';
const TEST_WEBID = 'http://localhost:3000/test-pod/profile/card#me';

test('extension client ID: default login uses the extension client identifier', async ({ context, extensionId }) => {
  // The default popup login uses EXTENSION_CLIENT_ID (http://localhost:8080/client-id)
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

test('app client ID: website sets its own client identifier via setClientId', async ({ context, extensionId }) => {
  // Navigate to the app site (port 8081) which sets its own client ID
  const page = await context.newPage();
  await page.goto(`${APP_SITE}/with-client-id.html`);

  // Wait for the extension to inject window.solid and the app to set the client ID
  await page.waitForFunction(
    () => typeof (window as any).solid !== 'undefined',
    null,
    { timeout: 5_000 },
  );

  // The app fetches /config.json which returns its client ID (http://localhost:8081/client-id)
  // and calls solid.setClientId() automatically. Trigger login from the page.
  const loginPagePromise = context.waitForEvent('page');
  await page.evaluate((webId) => {
    (window as any).solid.login(webId);
  }, TEST_WEBID);

  await completeOidcLogin(await loginPagePromise);

  // Wait for the page to update with the authenticated data
  await expect(page.locator('#fetch-result')).toContainText('Private Note', { timeout: 15_000 });
});
