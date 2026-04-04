import { test, expect } from '../fixtures';
import { performLogin } from './helpers';

const TEST_SITE = 'http://localhost:8080';

test('session persists after navigation', async ({ context, extensionId }) => {
  await performLogin(context, extensionId);

  // Navigate to test site and verify
  const page = await context.newPage();
  await page.goto(TEST_SITE);
  await expect(page.locator('#webid')).toContainText('test-pod', { timeout: 15_000 });

  // Navigate away
  await page.goto('about:blank');

  // Navigate back to test site
  await page.goto(TEST_SITE);

  // WebID should still be displayed (session persisted)
  await expect(page.locator('#webid')).toContainText('test-pod', { timeout: 15_000 });
});
