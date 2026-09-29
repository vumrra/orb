import { test, expect } from "@playwright/test";
for (const width of [375, 768, 1440])
  test(`light theme preserves the optical carrier and controls at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1024 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.getByLabel("Your message").fill("Keep this message.");
    const before = await page
      .locator("canvas.orb-canvas")
      .evaluate((c) => c.toDataURL());
    await page.getByRole("button", { name: "Light mode", exact: true }).click();
    await expect(page.locator(".app-shell")).toHaveAttribute(
      "data-theme",
      "light",
    );
    await expect(page.getByLabel("Your message")).toHaveValue(
      "Keep this message.",
    );
    expect(
      await page.locator("canvas.orb-canvas").evaluate((c) => c.toDataURL()),
    ).toBe(before);
    expect(
      await page
        .locator(".orb-stage")
        .evaluate((e) => getComputedStyle(e).backgroundColor),
    ).toBe("rgb(9, 10, 11)");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await expect(
      page.getByRole("button", { name: "Create orb" }),
    ).toBeInViewport();
    await page.screenshot({ path: `/tmp/orb-light-${width}.png` });
    await page.getByRole("button", { name: "Create orb" }).click();
    await expect(
      page.getByRole("button", { name: "Stop sending" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Dark mode", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Stop sending" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Stop sending" }).click();
  });
