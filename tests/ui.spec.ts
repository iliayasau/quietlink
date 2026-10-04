import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
for (const width of [1440, 768, 390]) {
  test(`landing layout and accessibility at ${width}px`, async ({ page }) => {
    await page.route("**/api/me", (route) =>
      route.fulfill({ status: 401, json: { error: "Sign in required" } }),
    );
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "A room for two." }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Sign in to continue" }),
    ).toHaveAttribute("href", "/auth/login");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
    await page.screenshot({
      path: `docs/screenshots/landing-${width}.png`,
      fullPage: true,
    });
  });
}
test("camera permission error is actionable", async ({ page, context }) => {
  await page.route("**/api/me", (route) =>
    route.fulfill({
      json: { name: "Avery", csrf: "test", iceServers: [], development: true },
    }),
  );
  await context.clearPermissions();
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException("Denied", "NotAllowedError"));
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Enable camera & microphone" })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Allow access in your browser",
  );
  await expect(
    page.getByRole("button", { name: "Create a private room" }),
  ).toBeDisabled();
});
