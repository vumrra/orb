import { test, expect } from "@playwright/test";
for (const degraded of [false, true])
  test(`Orb visible pixels cold capture, bloom and two dropped data/block=${degraded}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto("/");
    const message = Array.from({ length: 1000 }, (_, i) =>
      String.fromCharCode(32 + ((i * 71 + i * i) % 95)),
    ).join("");
    await page.evaluate(
      async ({ message, degraded }) => {
        const { createFrames } = await import("/src/protocol.ts");
        const { opticalFrames, parseOpticalFrame } =
          await import("/src/optical-fec.ts");
        const { drawOptical, SYMBOL_MS } = await import("/src/optical.ts");
        const original = createFrames(new TextEncoder().encode(message)),
          frames = opticalFrames(original);
        const sender = document.createElement("canvas");
        sender.width = 640;
        sender.height = 520;
        sender.style.cssText =
          "position:fixed;left:0;top:0;width:640px;z-index:100";
        document.body.append(sender);
        document.querySelector(".app-shell").style.marginLeft = "640px";
        const clean = sender.getContext("2d"),
          screen = document.createElement("canvas");
        screen.width = 640;
        screen.height = 520;
        const ctx = screen.getContext("2d"),
          glow = document.createElement("canvas");
        glow.width = 640;
        glow.height = 520;
        const g = glow.getContext("2d");
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
          configurable: true,
          value: async () => {
            window.__robustStream = screen.captureStream(30);
            window.__robustStart = performance.now();
            window.__robustDropped = 0;
            let previous = -1;
            const paint = () => {
              if (
                window.__robustStream
                  .getTracks()
                  .every((t) => t.readyState === "ended")
              ) {
                frames.clear();
                original.clear();
                return;
              }
              const index = Math.floor(
                (performance.now() - window.__robustStart) / SYMBOL_MS,
              );
              if (index !== previous) {
                previous = index;
                clean.fillStyle = "#090909";
                clean.fillRect(0, 0, 640, 520);
                // One transmission only: deliberate losses can never be filled by retransmission.
                if (index < frames.length) {
                  const frame = frames.get(index),
                    meta = parseOpticalFrame(frame);
                  drawOptical(clean, frame, 365, 255, 210, 0.23, 0.75);
                  const drop = degraded && frame[1] === 4 && meta.index % 8 < 2;
                  ctx.filter = degraded ? "blur(2px)" : "none";
                  ctx.drawImage(sender, 0, 0);
                  ctx.filter = "none";
                  if (degraded) {
                    g.filter = "blur(9px)";
                    g.drawImage(sender, 0, 0);
                    const p = ctx.getImageData(0, 0, 640, 520),
                      b = g.getImageData(0, 0, 640, 520);
                    for (let y = 0; y < 520; y++)
                      for (let x = 0; x < 640; x++) {
                        const i = (y * 640 + x) * 4,
                          glare =
                            13 +
                            55 *
                              Math.exp(
                                -((x - 420) ** 2 + (y - 170) ** 2) / 1800,
                              );
                        for (let c = 0; c < 3; c++)
                          p.data[i + c] =
                            255 *
                            Math.min(
                              1,
                              ((p.data[i + c] + b.data[i + c] * 0.35) *
                                [1.12, 1.05, 0.91][c] +
                                glare) /
                                255,
                            ) **
                              0.88;
                        if (x > 345 && x < 373 && y > 220 && y < 248)
                          p.data[i] = p.data[i + 1] = p.data[i + 2] = 20;
                      }
                    ctx.putImageData(p, 0, 0);
                  }
                  if (drop) {
                    window.__robustDropped++;
                    ctx.fillStyle = "#090909";
                    ctx.fillRect(0, 0, 640, 520);
                  }
                } else {
                  ctx.fillStyle = "#090909";
                  ctx.fillRect(0, 0, 640, 520);
                }
              }
              requestAnimationFrame(paint);
            };
            paint();
            return window.__robustStream;
          },
        });
      },
      { message, degraded },
    );
    await page.getByRole("button", { name: "Receive", exact: true }).click();
    await page
      .getByRole("button", { name: "Start camera", exact: true })
      .click();
    await expect(
      page.getByLabel("Received message", { exact: true }),
    ).toHaveText(message, { timeout: 15000 });
    const receipt = await page.evaluate(() => ({
      coldReceiveMs: performance.now() - window.__robustStart,
      dropped: window.__robustDropped,
      stopped: window.__robustStream
        .getTracks()
        .every((t) => t.readyState === "ended"),
    }));
    expect(receipt.stopped).toBe(true);
    if (degraded) expect(receipt.dropped).toBeGreaterThan(0);
    console.log(JSON.stringify({ degraded, ...receipt }));
  });
