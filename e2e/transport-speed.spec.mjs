import { test, expect } from "@playwright/test";
const fixture = () => {
  let seed = 42;
  return Array.from({ length: 1000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return String.fromCharCode(32 + ((seed >>> 24) % 95));
  }).join("");
};
for (const transport of ["orb", "bar"])
  for (const reduced of [false, true])
    test(`${transport}: 1000 original bytes cold camera acquisition to verified DOM, reduced=${reduced}`, async ({
      page,
    }) => {
      await page.emulateMedia({
        reducedMotion: reduced ? "reduce" : "no-preference",
      });
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.goto("/");
      await page.evaluate(() => {
        const iframe = document.createElement("iframe");
        iframe.id = "sender";
        iframe.src = "/";
        iframe.style.cssText =
          "position:fixed;left:0;top:0;width:720px;height:950px;z-index:100;border:0";
        document.body.append(iframe);
        document.querySelector(".app-shell").style.marginLeft = "720px";
      });
      const sender = page.frameLocator("#sender"),
        message = fixture();
      if (transport === "bar")
        await sender.getByRole("button", { name: "Switch to Bar" }).click();
      await sender.getByLabel("Your message").fill(message);
      await sender.getByRole("button", { name: `Create ${transport}` }).click();
      await page.evaluate(() => {
        const canvas = document
          .querySelector("#sender")
          .contentDocument.querySelector(".orb-canvas");
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
          configurable: true,
          value: async () => {
            const screen = document.createElement("canvas");
            screen.width = 1024;
            screen.height = 720;
            const ctx = screen.getContext("2d");
            window.__speedStream = screen.captureStream(30);
            window.__began = performance.now();
            window.__firstFrame = null;
            const background = getComputedStyle(
              canvas.ownerDocument.documentElement,
            ).backgroundColor;
            const paint = () => {
              if (
                window.__speedStream
                  .getTracks()
                  .every((t) => t.readyState === "ended")
              )
                return;
              ctx.fillStyle = background;
              ctx.fillRect(0, 0, 1024, 720);
              // Same real sender, full camera field; target is deliberately off-center.
              ctx.drawImage(canvas, 390, 110, 480, 480);
              requestAnimationFrame(paint);
            };
            paint();
            return window.__speedStream;
          },
        });
      });
      await page.getByRole("button", { name: "Receive", exact: true }).click();
      const started = Date.now();
      await page
        .getByRole("button", { name: "Start camera", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Message received" }),
      ).toBeVisible({ timeout: 10000 });
      const elapsed = Date.now() - started;
      await expect(
        page.getByLabel("Received message", { exact: true }),
      ).toHaveText(message);
      expect(elapsed).toBeLessThan(10000);
      expect(
        await page.evaluate(() =>
          window.__speedStream
            .getTracks()
            .every((t) => t.readyState === "ended"),
        ),
      ).toBe(true);
      console.log(
        JSON.stringify({
          transport,
          reduced,
          originalBytes: 1000,
          uncompressed: true,
          coldReceiveMs: elapsed,
        }),
      );
      await sender.getByRole("button", { name: "Stop sending" }).click();
    });
for (const width of [375, 768, 1440])
  for (const reduced of [false, true])
    test(`carrier visual QA ${width}px reduced=${reduced}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 1024 });
      await page.emulateMedia({
        reducedMotion: reduced ? "reduce" : "no-preference",
      });
      await page.goto("/");
      for (const mode of ["orb", "bar", "sound"]) {
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width);
        await expect(
          page.getByRole("button", { name: `Create ${mode}` }),
        ).toBeInViewport();
        if (mode === "bar") {
          await page.getByLabel("Your message").fill(fixture());
          await page.getByRole("button", { name: "Create bar" }).click();
        }
        await page.screenshot({
          path: `/tmp/orb-sound-${mode}-${width}-${reduced}.png`,
        });
        await page.locator(".wordmark").click();
      }
    });
