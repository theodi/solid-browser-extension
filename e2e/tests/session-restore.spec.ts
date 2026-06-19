import { expect, test } from '../fixtures';
import { performLogin } from './helpers';

const TEST_SITE = 'http://localhost:8080';

test('session persists across navigation (the worker holds the session)', async ({
  context,
  extensionId,
}) => {
  await performLogin(context, extensionId);

  const page = await context.newPage();
  await page.goto(TEST_SITE);
  await expect(page.locator('#webid')).toContainText('test-pod', { timeout: 15_000 });

  await page.goto('about:blank');
  await page.goto(TEST_SITE);

  // window.solid.webId is repopulated from the worker's persisted session.
  await expect(page.locator('#webid')).toContainText('test-pod', { timeout: 15_000 });
});
