import { expect, test } from '../fixtures';
import { performLogin } from './helpers';

test('login via popup with Community Solid Server', async ({ context, extensionId }) => {
  await performLogin(context, extensionId);

  // Reopen the popup and confirm the signed-in account UI (the web component) is shown.
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await expect(popupPage.locator('#signed-in')).toBeVisible({ timeout: 10_000 });

  // The <jeswr-account-menu> carries the WebID on its reflected `web-id` attribute.
  await expect(popupPage.locator('#account-menu')).toHaveAttribute('web-id', /test-pod/, {
    timeout: 10_000,
  });
});
