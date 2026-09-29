import { test, expect } from "@playwright/test";

test("dim moving reference anchors: real canvas stream through Camera to 1000B UI", async ({
  page,
}, testInfo) => {
  test.setTimeout(45000);
  await page.goto("/");
  const message = "0123456789".repeat(100);
  await page.evaluate(async (message) => {
    const { splitFrames } = await import("/src/protocol.ts");
    const { drawBar, splitBarFrame, BAR_SYMBOL_MS } =
      await import("/src/bar.ts");
    const symbols = splitFrames(new TextEncoder().encode(message)).flatMap(
      splitBarFrame,
    );
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext("2d");
    window.__barHold = true;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const began = performance.now();
        const render = () => {
          const time = performance.now() - began;
          ctx.fillStyle = "#181818";
          ctx.fillRect(0, 0, 800, 600);
          ctx.fillStyle = "white";
          ctx.fillRect(20, 20, 70, 50);
          // Include one blank interval and a jump; the repeating broadcast recovers.
          if (time > 1700 && time < 1900) return;
          ctx.save();
          ctx.translate(
            530.35 + (time > 1900 ? -90 : 0) + Math.sin(time / 1800) * 4,
            305.65,
          );
          ctx.rotate(0.23 + Math.sin(time / 2000) * 0.008);
          ctx.scale(-1, 1);
          ctx.globalAlpha = 0.4;
          ctx.filter = "blur(0.65px)";
          const index = window.__barHold
            ? 0
            : Math.floor(time / BAR_SYMBOL_MS) % symbols.length;
          drawBar(ctx, symbols[index], 0, 0, 300.3, 265.7);
          ctx.restore();
        };
        render();
        window.__barStream = canvas.captureStream(30);
        const timer = setInterval(() => {
          if (
            window.__barStream
              .getTracks()
              .every((t) => t.readyState === "ended")
          )
            clearInterval(timer);
          else render();
        }, 1000 / 30);
        return window.__barStream;
      },
    });
  }, message);
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  const result = page.getByLabel("Received message", { exact: true });
  await page.waitForTimeout(700);
  await expect(result).toBeEmpty(); // A candidate or one fragment is not progress.
  const began = Date.now();
  await page.evaluate(() => {
    window.__barHold = false;
  });
  await expect(result).toHaveText(message, { timeout: 35000 });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__barStream.getTracks().every((t) => t.readyState === "ended"),
      ),
    )
    .toBe(true);
  await testInfo.attach("bar-anchors-throughput.json", {
    body: JSON.stringify({
      bytes: 1000,
      captureStreamMs: Date.now() - began,
      physicalDevice: false,
    }),
    contentType: "application/json",
  });
});
