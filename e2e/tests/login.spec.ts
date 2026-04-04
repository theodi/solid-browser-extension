import { test, expect } from '../fixtures';
import { performLogin } from './helpers';

test('login via popup with Community Solid Server', async ({ context, extensionId }) => {
  await performLogin(context, extensionId);

  // Verify we're now logged in by reopening popup
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await expect(popupPage.locator('#logged-in-view')).toBeVisible({ timeout: 10_000 });
  await expect(popupPage.locator('#webid-display')).toContainText('test-pod');
});
