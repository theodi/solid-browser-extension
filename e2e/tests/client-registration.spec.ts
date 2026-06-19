import { expect, test } from '../fixtures';
import { completeOidcLogin, TEST_WEBID } from './helpers';

const TEST_SITE = 'http://localhost:8080';
const APP_SITE = 'http://localhost:8081';

test('default popup login (dynamic registration) authenticates a private fetch', async ({
  context,
  extensionId,
}) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popupPage.fill('#webid-input', TEST_WEBID);

  const loginPagePromise = context.waitForEvent('page');
  await popupPage.click('#login-btn');
  await completeOidcLogin(await loginPagePromise);

  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popupPage.locator('#signed-in').waitFor({ state: 'visible', timeout: 15_000 });
  await popupPage.close();

  const page = await context.newPage();
  await page.goto(TEST_SITE);
  await expect(page.locator('#fetch-result')).toContainText('Private Note', { timeout: 15_000 });
});

test('a website declares its own client identifier via window.solid.setClientId', async ({
  context,
  extensionId: _extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`${APP_SITE}/with-client-id.html`);

  // Wait for the extension to inject window.solid.
  await page.waitForFunction(() => typeof (window as { solid?: unknown }).solid !== 'undefined', {
    timeout: 5_000,
  });

  // The app reads its own Client ID Document URL and calls solid.setClientId(), then logs in.
  const loginPagePromise = context.waitForEvent('page');
  await page.evaluate((webId) => {
    (window as unknown as { solid: { login(id: string): Promise<void> } }).solid.login(webId);
  }, TEST_WEBID);
  await completeOidcLogin(await loginPagePromise);

  await expect(page.locator('#fetch-result')).toContainText('Private Note', { timeout: 15_000 });
});
