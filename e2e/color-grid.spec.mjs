import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
const qr = async (scope) => {
  for (const mode of ["Bar", "Sound", "QR"])
    await scope
      .getByRole("button", { name: `Switch to ${mode}`, exact: true })
      .click();
};
async function apps(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await page.evaluate(async () => {
    const main = await (await fetch("/src/main.tsx")).text();
    const url = (name) => {
      const match = main.match(
        new RegExp('"([^" ]*/' + name + '[.]js[?][^" ]+)"'),
      );
      if (!match) throw Error(name);
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
  for (const scope of [sender, receiver]) {
    await qr(scope);
    await scope.getByRole("button", { name: "Ultrafast", exact: true }).click();
  }
  return { sender, receiver };
}
for (const width of [375, 768, 1440]) {
  test(`two speeds and receive-only motion, beam, themes, reduced motion at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.goto("/");
    await qr(page);
    await expect(
      page.getByRole("group", { name: "QR speed" }).getByRole("button"),
    ).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "Fast", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Ultrafast", exact: true }).click();
    await expect(page.locator(".ultra-particles")).toHaveCount(0);
    await page.getByRole("button", { name: "Receive", exact: true }).click();
    const particles = page.locator(".ultra-particles");
    await expect(particles).toBeVisible();
    await expect(particles).toHaveAttribute("aria-hidden", "true");
    await expect(particles).toHaveCSS("pointer-events", "none");
    const pixels = () =>
      particles.evaluate((c) =>
        Array.from(
          c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        ).reduce((sum, v, i) => (sum + v * ((i % 19) + 1)) >>> 0, 0),
      );
    const before = await pixels();
    await expect.poll(pixels).not.toBe(before);
    const beam = () =>
      page
        .locator(".camera-shell")
        .evaluate((el) => getComputedStyle(el, "::after").animationName);
    expect(await beam()).toBe("camera-border-beam");
    await expect(page.locator(".camera-shell")).toHaveCSS(
      "border-radius",
      "24px",
    );
    for (const theme of ["dark", "light"]) {
      if (theme === "light")
        await page
          .getByRole("button", { name: "Light mode", exact: true })
          .click();
      await page.waitForTimeout(250);
      await page.screenshot({
        path: `/tmp/orb-color-receive-${width}-${theme}.png`,
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(beam).toBe("none");
    await page.waitForTimeout(100);
    const still = await pixels();
    await page.waitForTimeout(100);
    expect(await pixels()).toBe(still);
    await page.getByRole("button", { name: "Fast", exact: true }).click();
    await expect(particles).toHaveCount(0);
    await expect(page.locator(".ultra-receive")).toHaveCount(0);
    await page.getByRole("button", { name: "Ultrafast", exact: true }).click();
    await page
      .getByRole("button", { name: "Switch to Orb", exact: true })
      .click();
    await expect(particles).toHaveCount(0);
  });
}
for (const scenario of [
  { grid: 64, width: 750, height: 950, bytes: 65536, angle: 0, fps: 60 },
  { grid: 128, width: 1440, height: 1100, bytes: 262144, angle: 2, fps: 30 },
  { grid: 256, width: 2200, height: 1300, bytes: 1048576, angle: -2, fps: 60 },
  { grid: 256, width: 2200, height: 1300, bytes: 10000000, angle: 0, fps: 60 },
  {
    grid: 64,
    width: 750,
    height: 950,
    bytes: 0,
    angle: 0,
    fps: 30,
    image: true,
  },
]) {
  test(`Ultrafast actual colored pixels to verified file grid=${scenario.grid}, angle=${scenario.angle}, fps=${scenario.fps}`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.addInitScript(() =>
      Object.defineProperty(crypto, "subtle", { value: undefined }),
    );
    const { sender, receiver } = await apps(
      page,
      scenario.width,
      scenario.height,
    );
    if (scenario.grid === 64)
      await page.emulateMedia({ reducedMotion: "reduce" });
    const data = scenario.image
      ? Buffer.from(
          await page.evaluate(() => {
            const c = document.createElement("canvas");
            c.width = c.height = 128;
            const ctx = c.getContext("2d"),
              p = ctx.createImageData(128, 128);
            crypto.getRandomValues(p.data);
            for (let i = 3; i < p.data.length; i += 4) p.data[i] = 255;
            ctx.putImageData(p, 0, 0);
            return Array.from(
              atob(c.toDataURL("image/png").split(",")[1]),
              (x) => x.charCodeAt(0),
            );
          }),
        )
      : randomBytes(scenario.bytes);
    const filename = scenario.image ? "received.png" : "original.anything";
    await sender
      .getByLabel("Choose local file")
      .setInputFiles({ name: filename, mimeType: "", buffer: data });
    await sender
      .getByRole("button", { name: "Create qr", exact: true })
      .click();
    await expect(sender.locator(".color-canvas")).toBeVisible();
    await expect(sender.locator(".color-canvas")).toHaveAttribute(
      "data-grid",
      String(scenario.grid),
    );
    await expect(sender.locator(".ultra-canvas")).toHaveCount(0);
    await page.evaluate(({ angle, fps }) => {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          const source = document.querySelector("#root .color-canvas");
          const scene = document.createElement("canvas");
          scene.width = source.width + 180;
          scene.height = source.height + 140;
          const ctx = scene.getContext("2d"),
            stream = scene.captureStream(fps);
          window.__colorStream = stream;
          const paint = () => {
            if (stream.getTracks().every((t) => t.readyState === "ended"))
              return;
            ctx.fillStyle = "#171a1e";
            ctx.fillRect(0, 0, scene.width, scene.height);
            ctx.save();
            ctx.translate(scene.width / 2 + 15, scene.height / 2 - 10);
            ctx.rotate((angle * Math.PI) / 180);
            ctx.drawImage(source, -source.width / 2, -source.height / 2);
            ctx.restore();
            requestAnimationFrame(paint);
          };
          paint();
          return stream;
        },
      });
    }, scenario);
    await page.waitForTimeout(150);
    await receiver
      .getByRole("button", { name: "Receive", exact: true })
      .click();
    await expect(
      receiver.getByRole("link", { name: "Download file" }),
    ).toHaveCount(0);
    const begin = Date.now();
    await receiver
      .getByRole("button", { name: "Start camera", exact: true })
      .click();
    await expect(
      receiver.getByRole("link", { name: "Download file" }),
    ).toBeVisible({ timeout: 65000 });
    const elapsed = Date.now() - begin;
    const downloadEvent = page.waitForEvent("download");
    await receiver.getByRole("link", { name: "Download file" }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(filename);
    if (scenario.image)
      await expect(
        receiver.getByAltText("Verified received image"),
      ).toBeVisible();
    expect((await readFile(await download.path())).equals(data)).toBe(true);
    await expect(receiver.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    await expect(receiver.locator(".ultra-particles")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        window.__colorStream.getTracks().every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
    await sender
      .getByRole("button", { name: "Stop sending", exact: true })
      .click();
    await expect(sender.locator(".color-canvas")).toHaveCount(0);
    console.log(
      JSON.stringify({
        colorBrowserMs: elapsed,
        ...scenario,
        bytes: data.length,
      }),
    );
  });
}
test("Ultrafast preserves selected file across speed changes and cancels late camera permission", async ({
  page,
}) => {
  await page.goto("/");
  await qr(page);
  await page.getByLabel("Choose local file").setInputFiles({
    name: "keep.bin",
    mimeType: "",
    buffer: Buffer.from([1, 2, 3]),
  });
  await page.getByRole("button", { name: "Ultrafast", exact: true }).click();
  await expect(
    page.getByText("keep.bin · 3 bytes", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  await page.evaluate(() =>
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: () => new Promise((r) => (window.__grantColor = r)),
    }),
  );
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("permission");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Fast", exact: true }).click();
  await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 10;
    window.__lateColor = c.captureStream(30);
    window.__grantColor(window.__lateColor);
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__lateColor.getTracks().every((t) => t.readyState === "ended"),
      ),
    )
    .toBe(true);
  await expect(page.locator(".camera-active")).toHaveCount(0);
  await expect(page.locator(".ultra-particles")).toHaveCount(0);
});
