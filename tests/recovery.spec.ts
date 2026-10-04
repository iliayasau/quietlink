import { test, expect, type Page } from "@playwright/test";

test.skip(
  !!process.env.UI_ONLY,
  "Requires the Go server and local OIDC provider",
);
async function login(page: Page, name: string) {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in to continue" }).click();
  await page.getByLabel("Test identity").selectOption(name);
  await page.getByRole("button", { name: "Continue to QuietLink" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await page
    .getByRole("button", { name: "Enable camera & microphone" })
    .click();
}

for (const failure of ["server", "transport"] as const) {
  test(`preserve a saved room during a ${failure} restoration failure`, async ({
    page,
  }) => {
    await login(page, "Avery");
    await page.getByRole("button", { name: "Create a private room" }).click();
    await expect(
      page.getByRole("button", { name: "Leave", exact: true }),
    ).toBeVisible();
    const saved = await page.evaluate(() => sessionStorage.getItem("ql_room"));
    expect(saved).toBeTruthy();
    await page.route(
      "**/api/me",
      (route) =>
        failure === "server"
          ? route.fulfill({
              status: 503,
              json: { error: "Temporarily unavailable" },
            })
          : route.abort("timedout"),
      { times: 1 },
    );
    await page.reload();
    await expect(page.getByRole("alert")).toContainText(
      "saved room has been kept",
    );
    expect(await page.evaluate(() => sessionStorage.getItem("ql_room"))).toBe(
      saved,
    );
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Leave", exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("ql_room"))).toBe(
      saved,
    );
    await page.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Create a private room" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => sessionStorage.getItem("ql_room")),
    ).toBeNull();
  });
}

for (const recovery of ["retry", "refresh"] as const) {
  test(`recover committed create after a lost response and ${recovery}`, async ({
    page,
  }) => {
    await login(page, "Avery");
    // The real server commits; only its response to the browser is lost.
    await page.route(
      "**/api/rooms",
      async (route) => {
        const result = await route.fetch();
        expect(result.status()).toBe(201);
        await route.abort("failed");
      },
      { times: 1 },
    );
    // Simulate the connection remaining unavailable during immediate recovery.
    await page.route("**/api/me", (route) => route.abort("failed"), {
      times: 1,
    });
    await page.getByRole("button", { name: "Create a private room" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.unroute("**/api/me");
    if (recovery === "retry")
      await page.getByRole("button", { name: "Create a private room" }).click();
    else {
      await page.evaluate(() => sessionStorage.removeItem("ql_room"));
      await page.reload();
    }
    await expect(
      page.getByRole("heading", { name: "Save a seat for someone." }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Create new invitation" }).click();
    await expect(page.getByLabel("Private invitation link")).toHaveValue(
      /#invite=/,
    );
    await page.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Create a private room" }),
    ).toBeVisible();
  });

  test(`recover committed pending join after a lost response and ${recovery}`, async ({
    page,
    browser,
    baseURL,
  }) => {
    await login(page, "Avery");
    await page.getByRole("button", { name: "Create a private room" }).click();
    const link = await page.getByLabel("Private invitation link").inputValue();
    const context = await browser.newContext({
      baseURL,
      permissions: ["camera", "microphone"],
    });
    const guest = await context.newPage();
    try {
      await login(guest, "Jordan");
      await guest.goto(link);
      await guest.route(
        "**/api/join",
        async (route) => {
          const result = await route.fetch();
          expect(result.status()).toBe(200);
          await route.abort("failed");
        },
        { times: 1 },
      );
      await guest.route("**/api/me", (route) => route.abort("failed"), {
        times: 1,
      });
      await guest.getByRole("button", { name: "Request to join" }).click();
      await expect(guest.getByRole("alert")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Accept", exact: true }),
      ).toBeVisible();
      await guest.unroute("**/api/me");
      if (recovery === "retry")
        await guest.getByRole("button", { name: "Request to join" }).click();
      else {
        await guest.evaluate(() => sessionStorage.removeItem("ql_room"));
        await guest.reload();
      }
      await expect(
        guest.getByRole("heading", {
          name: "Your host will be right with you.",
        }),
      ).toBeVisible();
      await expect(
        guest.locator('video[aria-label="Guest video"]'),
      ).toHaveCount(0);
      await expect(guest.locator(".connection-label")).toHaveText(
        "Waiting for approval",
      );
      await guest.getByRole("button", { name: "Leave", exact: true }).click();
      await expect(
        guest.getByRole("button", { name: "Create a private room" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Accept", exact: true }),
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}
