import { test, expect } from '../fixtures';
import { performLogin } from './helpers';

const TEST_SITE = 'http://localhost:8080';

test('authenticated fetch retrieves private resource', async ({ context, extensionId }) => {
  await performLogin(context, extensionId);

  // Navigate to the test site
  const page = await context.newPage();
  await page.goto(TEST_SITE);

  // Wait for the WebID to be displayed
  await expect(page.locator('#webid')).toContainText('test-pod', { timeout: 15_000 });

  // Wait for the private resource content to appear
  await expect(page.locator('#fetch-result')).toContainText('Private Note', { timeout: 15_000 });

  // The status should indicate success
  await expect(page.locator('#status')).toContainText('Private resource fetched successfully');
});
