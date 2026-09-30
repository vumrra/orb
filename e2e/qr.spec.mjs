import { test, expect } from "@playwright/test";
const selectQr = async (scope) => {
  for (const name of ["Bar", "Sound", "QR"])
    await scope
      .getByRole("button", { name: `Switch to ${name}`, exact: true })
      .click();
};
for (const [length, reduced] of [
  [1000, false],
  [1000, true],
  [10240, false],
]) {
  test(`QR actual sender canvas -> video -> Camera -> verified DOM: ${length} uncompressed bytes, reduced=${reduced}`, async ({
    page,
  }) => {
    test.setTimeout(45000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({
      reducedMotion: reduced ? "reduce" : "no-preference",
    });
    await page.addInitScript(() => {
      // Keep the production preparation path but force its uncompressed branch.
      window.CompressionStream = class extends TransformStream {
        constructor() {
          super();
        }
      };
    });
    await page.goto("/");
    await page.evaluate(async () => {
      const main = await (await fetch("/src/main.tsx")).text();
      const url = (name) => {
        const match = main.match(
          new RegExp('"([^" ]*/' + name + '[.]js[?][^" ]+)"'),
        );
        if (!match) throw new Error("Missing browser module: " + name);
        return match[1];
      };
      const { default: React } = await import(url("react"));
      const { default: ReactDOM } = await import(url("react-dom_client"));
      const { App } = await import("/src/App.tsx");
      document.body.style.display = "grid";
      document.body.style.gridTemplateColumns = "1fr 1fr";
      const host = document.createElement("div");
      host.id = "receiver";
      document.body.append(host);
      ReactDOM.createRoot(host).render(React.createElement(App));
    });
    const sender = page.locator("#root"),
      receiver = page.locator("#receiver");
    await selectQr(sender);
    await selectQr(receiver);
    let seed = 42;
    const message = Array.from({ length }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return String.fromCharCode(33 + ((seed >>> 24) % 94));
    }).join("");
    await sender.getByLabel("Your message").fill(message);
    await sender
      .getByRole("button", { name: "Create qr", exact: true })
      .click();
    await expect(sender.getByLabel("Fast QR transfer board")).toBeVisible();
    await expect(receiver.locator(".app-shell")).toHaveAttribute(
      "data-transport",
      "qr",
    );
    await page.evaluate(() => {
      const canvas = document.querySelector("#root .ultra-canvas");
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          const screen = document.createElement("canvas");
          screen.width = 1024;
          screen.height = 768;
          const ctx = screen.getContext("2d");
          window.__qrStream = screen.captureStream(30);
          const paint = () => {
            if (
              window.__qrStream
                .getTracks()
                .every((t) => t.readyState === "ended")
            )
              return;
            ctx.fillStyle = "#101214";
            ctx.fillRect(0, 0, 1024, 768);
            // Opaque composition of ACTUAL product pixels, deliberately off center.
            ctx.drawImage(canvas, 350, 84, canvas.width, canvas.height);
            requestAnimationFrame(paint);
          };
          paint();
          return window.__qrStream;
        },
      });
    });
    await receiver
      .getByRole("button", { name: "Receive", exact: true })
      .click();
    const began = Date.now();
    await receiver
      .getByRole("button", { name: "Start camera", exact: true })
      .click();
    await expect(
      receiver.getByRole("heading", { name: "Message received", exact: true }),
    ).toBeVisible({ timeout: length === 1000 ? 8000 : 15000 });
    expect(
      await receiver
        .getByLabel("Received message", { exact: true })
        .textContent(),
    ).toBe(message);
    const elapsed = Date.now() - began;
    expect(elapsed).toBeLessThan(length === 1000 ? 8000 : 15000);
    expect(
      await page.evaluate(() =>
        window.__qrStream.getTracks().every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
    expect(
      await receiver.locator(".decoded-character").count(),
    ).toBeLessThanOrEqual(128);
    await sender
      .getByRole("button", { name: "Stop sending", exact: true })
      .click();
    await expect(sender.getByLabel("QR finder outlines")).toBeVisible();
    console.log(
      JSON.stringify({
        qrBrowserMs: elapsed,
        uncompressedBytes: length,
        reduced,
      }),
    );
  });
}
for (const width of [375, 768, 1440]) {
  test(`QR themes, density and permission cancellation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1100 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.getByLabel("Your message").fill("draft");
    await selectQr(page);
    await expect(page.getByLabel("Your message")).toHaveValue("draft");
    await page
      .getByRole("button", { name: "Switch to Orb", exact: true })
      .click();
    await expect(page.getByLabel("Your message")).toHaveValue("draft");
    await selectQr(page);
    await page.screenshot({ path: `/tmp/orb-qr-idle-${width}.png` });
    await page.getByRole("button", { name: "Create qr", exact: true }).click();
    for (const theme of ["dark", "light"]) {
      if (theme === "light")
        await page
          .getByRole("button", { name: "Light mode", exact: true })
          .click();
      await page.screenshot({ path: `/tmp/orb-qr-${theme}-${width}.png` });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page
      .getByRole("button", { name: "Stop sending", exact: true })
      .click();
    await page.getByRole("button", { name: "Receive", exact: true }).click();
    await page.evaluate(() =>
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: () => new Promise((r) => (window.__qrGrant = r)),
      }),
    );
    await page
      .getByRole("button", { name: "Start camera", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("permission");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 10;
      window.__qrLate = canvas.captureStream(30);
      window.__qrGrant(window.__qrLate);
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__qrLate.getTracks().every((t) => t.readyState === "ended"),
        ),
      )
      .toBe(true);
    await expect(page.locator(".camera-shell")).toHaveCSS(
      "border-radius",
      "24px",
    );
    await page
      .getByRole("button", { name: "Switch to Orb", exact: true })
      .click();
    await expect(page.locator(".app-shell")).toHaveAttribute(
      "data-transport",
      "orb",
    );
  });
}
