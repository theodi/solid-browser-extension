import { test, expect } from '../fixtures';
import { completeOidcLogin, performLogin } from './helpers';

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

test('identity isolation: app client ID gets a silently brokered per-client session and is denied by the pod ACP', async ({
  context,
  extensionId,
}) => {
  // Sign into the extension first. After this, the extension holds a master
  // session for EXTENSION_CLIENT_ID (localhost:8080/client-id) consented at
  // the IdP. The app's own clientId (localhost:8081/client-id) has no session.
  await performLogin(context, extensionId);

  // Navigate to the app site. It calls solid.setClientId(localhost:8081/client-id)
  // on load, so any subsequent solid.fetch() from this origin must be served
  // by a session scoped to that app clientId — never the extension's master
  // session.
  const page = await context.newPage();
  await page.goto(`${APP_SITE}/with-client-id.html`);
  await expect(page.locator('#client-id-display')).toContainText('8081', { timeout: 5_000 });
  await expect(page.locator('#webid')).toContainText('test-pod', { timeout: 10_000 });

  // No login/consent pages should open — the extension must broker the
  // per-client session silently (prompt=none) while the user clicks the
  // button in the app page.
  const unwantedPages: string[] = [];
  const onPage = (p: { url: () => string }) => {
    const url = p.url();
    if (url.includes('/.account/') || url.includes('oidc/consent')) {
      unwantedPages.push(url);
    }
  };
  context.on('page', onPage);

  // Click "Access private resource". The demo button calls solid.fetch on
  // /private/notes. The pod's ACR denies the 8081 client explicitly, so the
  // request MUST surface as 403 — a 200 would mean the extension leaked its
  // master session into the app.
  await page.click('#access-btn');
  await expect(page.locator('#status-text')).toContainText('HTTP 403', { timeout: 15_000 });
  await expect(page.locator('#status-icon')).toHaveClass(/error/);

  await page.waitForTimeout(500);
  expect(unwantedPages).toEqual([]);
  context.off('page', onPage);
});
