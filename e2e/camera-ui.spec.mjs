import { test, expect } from "@playwright/test";
for (const width of [375, 768, 1440])
  test(`camera viewfinder has themed controls and a circular preview at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.getByRole("button", { name: "Receive", exact: true }).click();
    await expect(page.locator(".camera-shell")).toHaveCSS(
      "border-radius",
      "50%",
    );
    await expect(page.locator(".reticle i")).toHaveCount(0);
    const choice = page.getByRole("group", { name: "Camera", exact: true });
    await expect(
      choice.getByRole("button", { name: "Back camera", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await choice
      .getByRole("button", { name: "Front camera", exact: true })
      .click();
    await expect(
      choice.getByRole("button", { name: "Front camera", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: `/tmp/orb-camera-idle-${width}.png` });
    await page.getByRole("button", { name: "Light mode" }).click();
    await expect(page.locator(".received-message")).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
    await page.screenshot({ path: `/tmp/orb-camera-light-idle-${width}.png` });
    await page.evaluate(() => {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: (constraints) => {
          window.__cameraConstraints = constraints;
          return new Promise((resolve) => {
            window.__cameraPermit = () => {
              const canvas = document.createElement("canvas");
              canvas.width = 960;
              canvas.height = 540;
              const ctx = canvas.getContext("2d");
              const paint = () => {
                ctx.fillStyle = "#151a20";
                ctx.fillRect(0, 0, 960, 540);
                ctx.strokeStyle = "#69717a";
                ctx.lineWidth = 2;
                ctx.strokeRect(60, 60, 840, 420);
              };
              paint();
              window.__cameraStream = canvas.captureStream(30);
              const timer = setInterval(() => {
                if (
                  window.__cameraStream
                    .getTracks()
                    .every((t) => t.readyState === "ended")
                )
                  clearInterval(timer);
                else paint();
              }, 33);
              resolve(window.__cameraStream);
            };
          });
        },
      });
    });
    await page.getByRole("button", { name: "Start camera" }).click();
    await expect(page.getByText("Camera on", { exact: true })).toHaveCount(0);
    expect(
      await page.evaluate(
        () => window.__cameraConstraints.video.facingMode.ideal,
      ),
    ).toBe("user");
    await page.evaluate(() => window.__cameraPermit());
    await expect(page.getByText("Camera on", { exact: true })).toBeVisible();
    expect(
      await page
        .locator("video")
        .evaluate((el) => getComputedStyle(el).objectFit),
    ).toBe("cover");
    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).hover();
    await expect(
      page.getByRole("button", { name: "Cancel", exact: true }),
    ).toHaveCSS("color", "rgb(23, 27, 32)");
    await expect(page.locator(".received-message")).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
    await page.screenshot({
      path: `/tmp/orb-camera-light-active-${width}.png`,
    });
    await page.getByRole("button", { name: "Dark mode" }).click();
    await page.screenshot({ path: `/tmp/orb-camera-active-${width}.png` });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(
      await page.evaluate(() =>
        window.__cameraStream
          .getTracks()
          .every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
  });
