import { expect, test } from '../fixtures';
import { performLogin } from './helpers';

const TEST_SITE = 'http://localhost:8080';

test('authenticated fetch retrieves a private resource via window.solid', async ({
  context,
  extensionId,
}) => {
  await performLogin(context, extensionId);

  const page = await context.newPage();
  await page.goto(TEST_SITE);

  // The test site reads window.solid.webId + window.solid.fetch(private resource).
  await expect(page.locator('#webid')).toContainText('test-pod', { timeout: 15_000 });
  await expect(page.locator('#fetch-result')).toContainText('Private Note', { timeout: 15_000 });
  await expect(page.locator('#status')).toContainText('Private resource fetched successfully');
});
