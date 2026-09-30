import { test, expect } from "@playwright/test";

for (const width of [375, 768, 1440]) {
  test(`QR preserves Orb geometry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const geometry = () =>
      page.evaluate(() =>
        [".main", ".mode-switch", ".orb-stage", ".intro", ".controls"].map(
          (selector) => {
            const r = document.querySelector(selector).getBoundingClientRect();
            return {
              selector,
              x: r.x,
              y: r.y,
              width: r.width,
              // Fast 파일 선택 영역은 아래에 추가되지만 기존 상단 배치는 유지합니다.
              height: selector === ".main" ? undefined : r.height,
            };
          },
        ),
      );
    const baseline = await geometry();
    for (const name of ["Bar", "Sound", "QR"])
      await page
        .getByRole("button", { name: `Switch to ${name}`, exact: true })
        .click();
    expect(await geometry()).toEqual(baseline);
    await expect
      .poll(() =>
        page
          .locator(".qr-canvas")
          .evaluate(
            (canvas) =>
              canvas.getContext("2d").getImageData(0, 0, 1, 1).data[3],
          ),
      )
      .toBe(0);
    await page.screenshot({ path: `/tmp/orb-qr-refined-idle-${width}.png` });
    await page
      .getByLabel("Your message")
      .fill("QR layout and readable quiet zone");
    await page.getByRole("button", { name: "Create qr", exact: true }).click();
    await expect(page.locator(".ultra-canvas")).toBeVisible();
    await expect(page.locator(".orb-stage")).toHaveCSS("border-radius", "20px");
    expect(
      (await page.locator(".orb-stage").boundingBox()).width,
    ).toBeLessThanOrEqual(width - 40);
    await page.screenshot({ path: `/tmp/orb-qr-refined-dark-${width}.png` });
    await page.getByRole("button", { name: "Light mode", exact: true }).click();
    await expect(page.locator(".wordmark")).toHaveCSS(
      "color",
      "rgb(23, 27, 32)",
    );
    await page.screenshot({ path: `/tmp/orb-qr-refined-light-${width}.png` });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("button", { name: "Stop sending", exact: true }),
    ).toBeInViewport();
    await page
      .getByRole("button", { name: "Stop sending", exact: true })
      .click();
  });
}
