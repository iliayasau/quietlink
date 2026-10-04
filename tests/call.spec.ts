import { test, expect, type Page, type Browser } from '@playwright/test';
test.skip(!!process.env.UI_ONLY, 'Requires the real Go server and local OIDC provider');
async function login(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in to continue' }).click();
  await expect(page.getByRole('heading', { name: 'Local test identities' })).toBeVisible();
  await page.getByLabel('Test identity').selectOption(name);
  await page.getByRole('button', { name: 'Continue to QuietLink' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function newGuest(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ baseURL, permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  await login(page, 'Jordan');
  return { page, context };
}
test('two identities complete OIDC, approval, media, controls and hangup', async ({ page, browser, baseURL }) => {
  await login(page, 'Avery');
  await page.getByRole('button', { name: 'Enable camera & microphone' }).click();
  await page.getByRole('button', { name: 'Create a private room' }).click();
  const link = await page.getByLabel('Private invitation link').inputValue();
  const guest = await newGuest(browser, baseURL!);
  try {
    await guest.page.goto(link);
    await guest.page.getByRole('button', { name: 'Enable camera & microphone' }).click();
    await guest.page.getByRole('button', { name: 'Request to join' }).click();
    await expect(guest.page.getByRole('heading', { name: 'Your host will be right with you.' })).toBeVisible();
    await expect(guest.page.locator('video[aria-label="Guest video"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(page.locator('.connection-label')).toHaveText('Connected', { timeout: 30000 });
    await expect(guest.page.locator('.connection-label')).toHaveText('Connected', { timeout: 30000 });
    await expect.poll(() => page.locator('video[aria-label="Guest video"]').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Unmute microphone', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Turn camera off', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Turn camera on', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Turn camera on', exact: true }).click();
    await page.getByRole('button', { name: 'Reconnect call' }).click();
    await expect(page.locator('.connection-label')).toHaveText('Connected', { timeout: 30000 });
    await page.screenshot({ path: 'docs/screenshots/call-desktop.png', fullPage: true });
    await guest.page.getByRole('button', { name: 'Leave', exact: true }).click();
    await expect(guest.page.getByRole('status').filter({ hasText: 'You left the room' })).toBeVisible();
    await expect(guest.page.getByRole('button', { name: 'Mute microphone', exact: true })).toBeDisabled();
    await expect(page.getByRole('heading', { name: 'Save a seat for someone.' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('link', { name: 'Sign in to continue' })).toBeVisible();
  } finally { await guest.context.close(); }
});
test('declined guest loses room access and used invitation cannot be replayed', async ({ page, browser, baseURL }) => {
  await login(page, 'Avery');
  await page.getByRole('button', { name: 'Enable camera & microphone' }).click();
  await page.getByRole('button', { name: 'Create a private room' }).click();
  const link = await page.getByLabel('Private invitation link').inputValue();
  const guest = await newGuest(browser, baseURL!);
  try {
    await guest.page.goto(link);
    await guest.page.getByRole('button', { name: 'Enable camera & microphone' }).click();
    await guest.page.getByRole('button', { name: 'Request to join' }).click();
    await page.getByRole('button', { name: 'Decline' }).click();
    await expect(guest.page.getByRole('alert')).toContainText('declined');
    await guest.page.goto(link);
    await guest.page.getByRole('button', { name: 'Enable camera & microphone' }).click();
    await guest.page.getByRole('button', { name: 'Request to join' }).click();
    await expect(guest.page.getByRole('alert')).toContainText('already used');
  } finally { await guest.context.close(); }
});
