import { test, expect } from "@playwright/test";

for (const transport of ["orb", "bar"]) {
  test(`1MB ${transport}: actual sender canvas.captureStream -> Camera -> bounded receive DOM`, async ({
    page,
  }) => {
    test.setTimeout(180000);
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
    const sender = page.frameLocator("#sender");
    const message = "a".repeat(1048576);
    if (transport === "bar")
      await sender.getByRole("button", { name: "Switch to Bar" }).click();
    await sender.getByLabel("Your message").fill(message);
    await expect(sender.locator("#byte-count")).toHaveText(
      "1,048,576 / 1,048,576 UTF-8 bytes",
    );
    await sender.getByRole("button", { name: `Create ${transport}` }).click();
    await expect(
      sender.getByRole("heading", { name: "Ready to scan" }),
    ).toBeVisible();
    await page.evaluate(() => {
      const canvas = document
        .querySelector("#sender")
        .contentDocument.querySelector("canvas.orb-canvas");
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          // A camera sees the opaque page, not the canvas's transparent backing.
          // Composite actual sender pixels so successive video frames cannot accumulate.
          const screen = document.createElement("canvas");
          screen.width = canvas.width;
          screen.height = canvas.height;
          const ctx = screen.getContext("2d");
          const background = getComputedStyle(
            canvas.ownerDocument.documentElement,
          ).backgroundColor;
          window.__megabyteStream = screen.captureStream(30);
          const paint = () => {
            if (
              window.__megabyteStream
                .getTracks()
                .every((track) => track.readyState === "ended")
            )
              return;
            ctx.fillStyle = background;
            ctx.fillRect(0, 0, screen.width, screen.height);
            ctx.drawImage(canvas, 0, 0);
            requestAnimationFrame(paint);
          };
          paint();
          return window.__megabyteStream;
        },
      });
    });
    const metrics = await page.evaluate(async () => {
      const { prepareMessage } = await import("/src/message.ts");
      const { createWireFrames } = await import("/src/protocol.ts");
      const began = performance.now(),
        wire = await prepareMessage("a".repeat(1048576));
      const source = createWireFrames(wire);
      const result = {
        originalBytes: 1048576,
        wireBytes: wire.length,
        frames: source.length,
        preparationMs: performance.now() - began,
      };
      source.clear();
      wire.fill(0);
      return result;
    });
    const began = Date.now();
    await page.getByRole("button", { name: "Receive", exact: true }).click();
    await page
      .getByRole("button", { name: "Start camera", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("frames received", {
      timeout: 15000,
    });
    // Compressed frames cannot legitimately expose a text prefix.
    await expect(
      page.getByLabel("Received message", { exact: true }),
    ).toBeEmpty();
    await expect(
      page.getByRole("heading", { name: "Message received" }),
    ).toBeVisible({ timeout: 150000 });
    const received = await page
      .getByLabel("Received message", { exact: true })
      .textContent();
    expect(received).toBe(message);
    const resultBox = await page
      .getByLabel("Received message", { exact: true })
      .evaluate((el) => ({
        height: el.clientHeight,
        contentHeight: el.scrollHeight,
        overflow: getComputedStyle(el).overflowY,
      }));
    expect(resultBox.height).toBeLessThanOrEqual(320);
    expect(resultBox.contentHeight).toBeGreaterThan(resultBox.height);
    expect(resultBox.overflow).toBe("auto");
    expect(
      await page.locator(".decoded-character").count(),
    ).toBeLessThanOrEqual(128);
    expect(await page.locator("body *").count()).toBeLessThan(400);
    expect(
      await page.evaluate(() =>
        window.__megabyteStream
          .getTracks()
          .every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
    console.log(
      JSON.stringify({ transport, ...metrics, receiveMs: Date.now() - began }),
    );
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(
      page.getByLabel("Received message", { exact: true }),
    ).toBeEmpty();
  });
}

test("cancel/toggle discard pending compression and permit a new sender", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    const Native = CompressionStream;
    window.__releaseCompression = null;
    window.CompressionStream = class {
      constructor(format) {
        const native = new Native(format);
        const gate = new TransformStream({
          async transform(chunk, controller) {
            await new Promise((resolve) => {
              window.__releaseCompression = resolve;
            });
            controller.enqueue(chunk);
          },
        });
        this.writable = native.writable;
        this.readable = native.readable.pipeThrough(gate);
      }
    };
  });
  await page.getByLabel("Your message").fill("x".repeat(1048576));
  await page.getByRole("button", { name: "Create orb" }).click();
  await expect(page.getByRole("status")).toHaveText("Preparing message…");
  await page.getByRole("button", { name: "Switch to Bar" }).click();
  await page.evaluate(() => window.__releaseCompression?.());
  await expect(page.getByLabel("Your message")).toHaveValue("");
  await expect(
    page.getByRole("heading", { name: "Ready to scan" }),
  ).toHaveCount(0);
  await page.getByLabel("Your message").fill("fresh");
  await page.getByRole("button", { name: "Create bar" }).click();
  await expect(
    page.getByRole("heading", { name: "Ready to scan" }),
  ).toBeVisible();
});

test("cancel during decompression clears progress and ignores late decoded text", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { prepareMessage } = await import("/src/message.ts");
    const { createWireFrames } = await import("/src/protocol.ts");
    const { drawOptical, SYMBOL_MS } = await import("/src/optical.ts");
    const wire = await prepareMessage("x".repeat(10000)),
      source = createWireFrames(wire);
    wire.fill(0);
    const Native = DecompressionStream;
    window.DecompressionStream = class {
      constructor(format) {
        const native = new Native(format);
        const gate = new TransformStream({
          async transform(chunk, controller) {
            await new Promise((resolve) => {
              window.__releaseDecode = resolve;
            });
            controller.enqueue(chunk);
          },
        });
        this.writable = native.writable;
        this.readable = native.readable.pipeThrough(gate);
      }
    };
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 480;
    const ctx = canvas.getContext("2d");
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        window.__decodeStream = canvas.captureStream(30);
        const began = performance.now();
        const timer = setInterval(() => {
          if (
            window.__decodeStream
              .getTracks()
              .every((t) => t.readyState === "ended")
          ) {
            clearInterval(timer);
            source.clear();
            return;
          }
          const time = performance.now() - began,
            frame = source.get(Math.floor(time / SYMBOL_MS) % source.length);
          ctx.fillStyle = "#090909";
          ctx.fillRect(0, 0, 480, 480);
          drawOptical(ctx, frame, 240, 240, 190, 0.23, 0.75 + time / 1000);
          frame.fill(0);
        }, 1000 / 30);
        return window.__decodeStream;
      },
    });
  });
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Verifying message…", {
    timeout: 15000,
  });
  await expect
    .poll(() => page.evaluate(() => typeof window.__releaseDecode))
    .toBe("function");
  await expect(
    page.getByLabel("Received message", { exact: true }),
  ).toBeEmpty();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => window.__releaseDecode());
  await expect(
    page.getByLabel("Received message", { exact: true }),
  ).toBeEmpty();
  await expect(page.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "0",
  );
  await expect(
    page.getByRole("button", { name: "Start camera", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() =>
      window.__decodeStream.getTracks().every((t) => t.readyState === "ended"),
    ),
  ).toBe(true);
});
