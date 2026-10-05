// Context-only sample; this file is not part of the starter's executable tests.
import { test, expect } from '@playwright/test';
test('product listing', async ({ page }) => {
  await page.goto('/products');
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
});
