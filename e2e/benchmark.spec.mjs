import { test, expect } from "@playwright/test";

// Identical payload, viewport, motion preference and start/end boundary for all modes.
// Optical: 600px Orb/Bar; Fast QR keeps native pixels (at least 3px/module).
// All optical modes use a 1024x720 captureStream camera.
// Sound: actual sender AudioBuffers looped into the microphone, no speaker output.
for (const transport of ["orb", "bar", "sound", "qr"]) {
  test(`benchmark ${transport}: 1000 uncompressed bytes`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.addInitScript(() => {
      window.CompressionStream = class extends TransformStream {};
      const Native = window.AudioContext;
      window.__benchmarkStreams = [];
      window.AudioContext = class extends Native {
        constructor(...args) {
          super(...args);
          const destination = this.createMediaStreamDestination();
          window.__benchmarkStreams.push(destination.stream);
          Object.defineProperty(this, "destination", { value: destination });
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
    const cycle = ["orb", "bar", "sound", "qr"];
    for (let i = 1; i <= cycle.indexOf(transport); i++)
      await sender.locator(".wordmark").click();
    if (transport === "qr") {
      for (let i = 0; i < 3; i++) await receiver.locator(".wordmark").click();
    }
    if (transport === "sound") {
      await receiver.locator(".wordmark").click();
      await receiver.locator(".wordmark").click();
    }
    await receiver
      .getByRole("button", { name: "Receive", exact: true })
      .click();
    await page.evaluate((mode) => {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          if (mode === "sound") {
            window.__benchmarkStream = window.__benchmarkStreams[0].clone();
            return window.__benchmarkStream;
          }
          const source = document.querySelector(
            "#root .ultra-canvas, #root .orb-canvas",
          );
          const output = document.createElement("canvas");
          output.width = 1024;
          output.height = 720;
          const ctx = output.getContext("2d");
          window.__benchmarkStream = output.captureStream(30);
          const paint = () => {
            if (
              window.__benchmarkStream
                .getTracks()
                .every((t) => t.readyState === "ended")
            )
              return;
            ctx.fillStyle = "#090909";
            ctx.fillRect(0, 0, 1024, 720);
            if (mode === "qr") {
              ctx.drawImage(
                source,
                (1024 - source.width) / 2,
                (720 - source.height) / 2,
              );
            } else ctx.drawImage(source, 390, 110, 600, 600);
            requestAnimationFrame(paint);
          };
          paint();
          return window.__benchmarkStream;
        },
      });
    }, transport);
    let seed = 42;
    const message = Array.from({ length: 1000 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return String.fromCharCode(32 + ((seed >>> 24) % 95));
    }).join("");
    await sender.getByLabel("Your message").fill(message);
    const start = Date.now();
    await sender
      .getByRole("button", { name: `Create ${transport}`, exact: true })
      .click();
    if (transport === "qr")
      await expect(sender.locator(".ultra-canvas")).toBeVisible();
    await receiver
      .getByRole("button", {
        name: transport === "sound" ? "Start microphone" : "Start camera",
        exact: true,
      })
      .click();
    await expect(
      receiver.getByRole("heading", { name: "Message received", exact: true }),
    ).toBeVisible({ timeout: 45000 });
    expect(
      await receiver
        .getByLabel("Received message", { exact: true })
        .textContent(),
    ).toBe(message);
    const elapsedMs = Date.now() - start;
    expect(
      await page.evaluate(() =>
        window.__benchmarkStream
          .getTracks()
          .every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
    console.log(
      "BENCHMARK " +
        JSON.stringify({
          transport,
          originalBytes: 1000,
          compressed: false,
          elapsedMs,
          verified: true,
          boundary: "create-click-to-verified-DOM",
          environment: "desktop-Chrome-synthetic-loopback",
        }),
    );
    await sender
      .getByRole("button", { name: "Stop sending", exact: true })
      .click();
  });
}
