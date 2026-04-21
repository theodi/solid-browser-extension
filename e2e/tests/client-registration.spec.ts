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

test('app client ID: private/notes is denied when the app client identifier is used', async ({ context, extensionId }) => {
  // Sign into the extension first (extension client ID is consented at the IdP).
  await performLogin(context, extensionId);

  // Navigate to the app site so it registers its own client ID.
  const page = await context.newPage();
  await page.goto(`${APP_SITE}/with-client-id.html`);
  await page.waitForFunction(
    () => typeof (window as { solid?: unknown }).solid !== 'undefined',
    null,
    { timeout: 5_000 },
  );
  await expect(page.locator('#client-id-display')).toContainText('8081', { timeout: 5_000 });

  // The pod's ACP denies the 8081 client for /private/notes. Calling
  // solid.fetch directly (bypassing the demo UI which uses /shared/note)
  // lets us assert the security behaviour regardless of the page markup.
  // The extension may need an interactive consent for this client — do a
  // one-shot solid.login to grant it, mirroring what the app UI does on
  // first visit.
  const loginPagePromise = context.waitForEvent('page');
  await page.evaluate((webId) => {
    // Fire-and-forget: the evaluate must return immediately so the test can
    // interact with the auth popup; solid.login resolves asynchronously.
    void (window as unknown as {
      solid: { login: (w: string) => Promise<void> };
    }).solid.login(webId);
  }, TEST_WEBID);
  await completeOidcLogin(await loginPagePromise);

  // After the consent flow settles the session for the 8081 client, issue
  // the fetch and expect the ACP to deny it with 403.
  await expect.poll(async () =>
    page.evaluate(async () => {
      try {
        const res = await (window as unknown as {
          solid: { fetch: (url: string) => Promise<Response> };
        }).solid.fetch('http://localhost:3000/test-pod/private/notes');
        return res.status;
      } catch {
        return -1;
      }
    }),
  { timeout: 15_000 }).toBe(403);
});

test('reactive auth: clicking Access triggers silent re-auth and fetches the private resource', async ({
  context,
  extensionId,
}) => {
  // Pre-consent the app client ID by running one interactive login. Covers
  // OIDC consent_required; subsequent fetches from this origin go silent.
  await performLogin(context, extensionId);

  const page = await context.newPage();
  await page.goto(`${APP_SITE}/with-client-id.html`);
  await expect(page.locator('#client-id-display')).toContainText('8081', { timeout: 5_000 });
  await expect(page.locator('#webid')).toContainText('test-pod', { timeout: 10_000 });

  // First click: the extension has no session for 8081 yet and the IdP
  // requires consent, so the app's interactive fallback (solid.login) kicks
  // in. Complete the consent page that pops up.
  const loginPagePromise = context.waitForEvent('page');
  await page.click('#access-btn');
  await completeOidcLogin(await loginPagePromise);

  // After consent, the fetch should succeed and the UI should reflect it.
  await expect(page.locator('#status-text')).toContainText('Private resource fetched', { timeout: 15_000 });
  await expect(page.locator('#fetch-result')).toContainText('Shared Note', { timeout: 5_000 });
  await expect(page.locator('#status-icon')).toHaveClass(/success/);

  // Second click: truly reactive + silent. No login/consent page should open.
  const unwantedPages: string[] = [];
  const onPage = (p: { url: () => string }) => {
    const url = p.url();
    if (url.includes('/.account/') || url.includes('oidc/consent')) {
      unwantedPages.push(url);
    }
  };
  context.on('page', onPage);

  await page.click('#access-btn');
  await expect(page.locator('#status-text')).toContainText('Private resource fetched', { timeout: 10_000 });
  await expect(page.locator('#fetch-result')).toContainText('Shared Note');

  await page.waitForTimeout(500);
  expect(unwantedPages).toEqual([]);
  context.off('page', onPage);
});
