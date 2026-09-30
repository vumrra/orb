import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
const selectQr = async (scope) => {
  for (const name of ["Bar", "Sound", "QR"])
    await scope
      .getByRole("button", { name: `Switch to ${name}`, exact: true })
      .click();
};
async function twoApps(page) {
  await page.setViewportSize({ width: 2200, height: 1300 });
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
    const { default: React } = await import(url("react")),
      { default: ReactDOM } = await import(url("react-dom_client")),
      { App } = await import("/src/App.tsx");
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
  return { sender, receiver };
}
async function cameraBridge(page, loss = false) {
  await page.evaluate((loss) => {
    const source = document.querySelector(
      "#root .ultra-canvas, #root .qr-canvas",
    );
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const scene = document.createElement("canvas");
        scene.width = 1400;
        scene.height = 1100;
        const ctx = scene.getContext("2d");
        const stream = scene.captureStream(30);
        window.__ultraStream = stream;
        const paint = () => {
          if (stream.getTracks().every((t) => t.readyState === "ended")) return;
          ctx.fillStyle = "#181a1c";
          ctx.fillRect(0, 0, 1400, 1100);
          ctx.drawImage(source, 193, 81, source.width, source.height);
          if (loss && source.dataset.cells === "9") {
            const tile = source.width / 3;
            ctx.fillStyle = "#fff";
            ctx.fillRect(193 + tile, 81, tile, tile);
          }
          requestAnimationFrame(paint);
        };
        paint();
        return stream;
      },
    });
  }, loss);
}
test("QR-only switch, compact off geometry, local files, limits, reset, and square QR camera", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 950 });
  await page.goto("/");
  await expect(page.getByRole("switch", { name: "Ultrafast" })).toHaveCount(0);
  const baseline = await page.locator(".orb-stage").boundingBox();
  await selectQr(page);
  expect((await page.locator(".orb-stage").boundingBox()).width).toBe(
    baseline.width,
  );
  await expect(page.getByRole("switch", { name: "Ultrafast" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await page.getByRole("switch", { name: "Ultrafast" }).click();
  await page.getByLabel("Choose local file").setInputFiles({
    name: "unknown",
    mimeType: "",
    buffer: Buffer.from([0, 255, 128]),
  });
  await expect(
    page.getByText("unknown · 3 bytes", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Remove file" }).click();
  await expect(
    page.getByText("unknown · 3 bytes", { exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Choose local file").setInputFiles({
    name: "over.bin",
    mimeType: "",
    buffer: Buffer.alloc(30_000_001),
  });
  await expect(page.getByRole("alert")).toContainText("30,000,000");
  await page.getByLabel("Choose local file").setInputFiles({
    name: "zero.unknown",
    mimeType: "",
    buffer: Buffer.alloc(0),
  });
  await page.getByRole("button", { name: "Create qr", exact: true }).click();
  await expect(page.locator(".ultra-canvas")).toHaveAttribute(
    "data-cells",
    "1",
  );
  await page.getByRole("button", { name: "Stop sending", exact: true }).click();
  await expect(page.locator(".ultra-canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  await expect(page.locator(".camera-shell")).toHaveCSS(
    "border-radius",
    "24px",
  );
  await page.getByRole("button", { name: "Light mode", exact: true }).click();
  await expect(page.locator(".camera-shell")).toHaveCSS(
    "border-radius",
    "24px",
  );
  await page
    .getByRole("button", { name: "Switch to Orb", exact: true })
    .click();
  await expect(page.locator(".camera-shell")).toHaveCSS("border-radius", "50%");
  await page
    .getByRole("button", { name: "Switch to Bar", exact: true })
    .click();
  await expect(page.locator(".camera-shell")).toHaveCSS("border-radius", "50%");
});
for (const kind of ["binary", "image"])
  test(`actual sender -> captureStream -> Camera -> verified ${kind} download, midstream and lane loss`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    const network = [];
    if (kind === "binary")
      await page.addInitScript(() => {
        Object.defineProperty(crypto, "subtle", { value: undefined });
      });
    page.on("request", (r) => network.push(r.url()));
    const { sender, receiver } = await twoApps(page);
    await sender.getByRole("switch", { name: "Ultrafast" }).click();
    await receiver.getByRole("switch", { name: "Ultrafast" }).click();
    const bytes =
      kind === "binary"
        ? randomBytes(65536)
        : Buffer.from(
            await page.evaluate(() => {
              const canvas = document.createElement("canvas");
              canvas.width = canvas.height = 144;
              const ctx = canvas.getContext("2d"),
                p = ctx.createImageData(144, 144);
              crypto.getRandomValues(p.data.subarray(0, 65536));
              crypto.getRandomValues(p.data.subarray(65536));
              for (let i = 3; i < p.data.length; i += 4) p.data[i] = 255;
              ctx.putImageData(p, 0, 0);
              return Array.from(
                Uint8Array.from(
                  atob(canvas.toDataURL("image/png").split(",")[1]),
                  (c) => c.charCodeAt(0),
                ),
              );
            }),
          );
    await sender.getByLabel("Choose local file").setInputFiles({
      name: kind === "image" ? "received.png" : "arbitrary.unknown",
      mimeType: "",
      buffer: bytes,
    });
    await sender
      .getByRole("button", { name: "Create qr", exact: true })
      .click();
    await expect(sender.locator(".ultra-canvas")).toHaveAttribute(
      "data-cells",
      "9",
    );
    await page.waitForTimeout(800);
    await cameraBridge(page, true);
    await receiver
      .getByRole("button", { name: "Receive", exact: true })
      .click();
    await expect(
      receiver.getByRole("link", { name: "Download file" }),
    ).toHaveCount(0);
    const began = Date.now();
    await receiver
      .getByRole("button", { name: "Start camera", exact: true })
      .click();
    await expect(
      receiver.getByRole("link", { name: "Download file" }),
    ).toBeVisible({ timeout: 70000 });
    const elapsed = Date.now() - began;
    const downloadEvent = page.waitForEvent("download");
    await receiver.getByRole("link", { name: "Download file" }).click();
    const download = await downloadEvent;
    expect((await readFile(await download.path())).equals(bytes)).toBe(true);
    if (kind === "image") {
      await expect(
        receiver.getByAltText("Verified received image"),
      ).toBeVisible();
      expect(
        await receiver
          .getByAltText("Verified received image")
          .getAttribute("src"),
      ).toMatch(/^blob:/);
      await expect(receiver.locator(".image-gen-root")).toHaveAttribute(
        "data-preset",
        "pixels-organic",
      );
    } else
      await expect(
        receiver.getByAltText("Verified received image"),
      ).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        window.__ultraStream.getTracks().every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
    expect(
      network.filter(
        (url) =>
          /^https?:/.test(url) && !url.startsWith("http://127.0.0.1:5175/"),
      ),
    ).toEqual([]);
    const blob = await receiver
      .getByRole("link", { name: "Download file" })
      .getAttribute("href");
    await receiver.getByRole("button", { name: "Reset", exact: true }).click();
    expect(
      await page.evaluate(async (url) => {
        try {
          await fetch(url);
          return false;
        } catch {
          return true;
        }
      }, blob),
    ).toBe(true);
    console.log(
      JSON.stringify({
        ultraBrowserMs: elapsed,
        bytes: bytes.length,
        bytesPerSecond: Math.round((bytes.length / elapsed) * 1000),
        kind,
        midstream: true,
        laneLoss: true,
      }),
    );
  });
test("ultrafast late permission cannot restart after mode switch", async ({
  page,
}) => {
  await page.goto("/");
  await selectQr(page);
  await page.getByRole("switch", { name: "Ultrafast" }).click();
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  await page.evaluate(() =>
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: () => new Promise((resolve) => (window.__grant = resolve)),
    }),
  );
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 10;
    window.__late = c.captureStream(30);
    window.__grant(window.__late);
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__late.getTracks().every((t) => t.readyState === "ended"),
      ),
    )
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Create qr", exact: true }),
  ).toBeVisible();
});
test("normal QR versus ultrafast same uncompressed text fixture", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    window.CompressionStream = class extends TransformStream {
      constructor() {
        super();
      }
    };
  });
  const { sender, receiver } = await twoApps(page);
  const text = Array.from(randomBytes(8192), (b) =>
      String.fromCharCode(33 + (b % 94)),
    ).join(""),
    times = {};
  for (const ultra of [false, true]) {
    if (ultra) {
      await sender.getByRole("switch", { name: "Ultrafast" }).click();
      await receiver.getByRole("switch", { name: "Ultrafast" }).click();
    }
    await sender.getByLabel("Your message").fill(text);
    await sender
      .getByRole("button", { name: "Create qr", exact: true })
      .click();
    await cameraBridge(page);
    await receiver
      .getByRole("button", { name: "Receive", exact: true })
      .click();
    const start = Date.now();
    await receiver
      .getByRole("button", { name: "Start camera", exact: true })
      .click();
    await expect(
      receiver.getByRole("heading", { name: "Message received", exact: true }),
    ).toBeVisible({ timeout: 40000 });
    expect(
      await receiver
        .getByLabel("Received message", { exact: true })
        .textContent(),
    ).toBe(text);
    times[ultra ? "ultraMs" : "normalMs"] = Date.now() - start;
    await sender
      .getByRole("button", { name: "Stop sending", exact: true })
      .click();
    await receiver.getByRole("button", { name: "Reset", exact: true }).click();
  }
  console.log(
    JSON.stringify({
      sameFixtureBytes: 8192,
      ...times,
      speedup: times.normalMs / times.ultraMs,
    }),
  );
});
