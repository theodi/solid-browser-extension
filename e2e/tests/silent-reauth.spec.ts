import { test, expect } from '../fixtures';
import { performLogin } from './helpers';

const TEST_SITE = 'http://localhost:8080';

// After the popup login the extension has a session and consent granted for
// its own client ID. This test verifies the service worker can silently
// re-issue tokens for that client ID via prompt=none when the in-storage
// session is gone (e.g. dropped from chrome.storage) but the active WebID and
// the IdP SSO cookie are still valid.
test('silent re-auth: dropping the stored session still lets solid.fetch succeed without UI', async ({
  context,
  extensionId,
}) => {
  await performLogin(context, extensionId);

  // Wipe just the stored sessions map, keeping solid-active-webid. This
  // simulates the scenario where the extension is warm (knows the user) but
  // has no token for this client — i.e. exactly the case silent re-auth
  // must handle.
  const swPage = await context.newPage();
  await swPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await swPage.evaluate(() =>
    new Promise<void>((resolve) => {
      chrome.storage.local.remove('solid-sessions', () => resolve());
    }),
  );
  await swPage.close();

  // Track any page that looks like a login/consent UI popping up.
  const unwantedPages: string[] = [];
  context.on('page', (p) => {
    const url = p.url();
    if (url.includes('/.account/') || url.includes('oidc/consent')) {
      unwantedPages.push(url);
    }
  });

  // Visit the test site which uses the extension's default client ID.
  const page = await context.newPage();
  await page.goto(TEST_SITE);

  // The test site auto-fetches /private/notes. A 200 with "Private Note"
  // means solid.fetch triggered silent re-auth and fetched under the
  // extension client identity.
  await expect(page.locator('#fetch-result')).toContainText('Private Note', { timeout: 15_000 });
  await expect(page.locator('#status')).toContainText('Private resource fetched successfully');

  // No login/consent pages should have appeared during silent re-auth.
  await page.waitForTimeout(500);
  expect(unwantedPages).toEqual([]);
});
