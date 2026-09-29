import { test, expect } from "@playwright/test";
const sound = async (page) => {
  await page.getByRole("button", { name: "Switch to Bar" }).click();
  await page.getByRole("button", { name: "Switch to Sound" }).click();
};
// Every native destination is rerouted to a MediaStream destination before any gesture.
// This is a real AudioBuffer -> PCM -> microphone path, with zero external output.
async function silentWire(page) {
  await page.addInitScript(() => {
    // Exercise uncompressed payload throughput, independent of browser compression.
    window.CompressionStream = undefined;
    const Native = window.AudioContext;
    window.__contexts = [];
    window.__streams = [];
    window.AudioContext = class extends Native {
      constructor(...args) {
        super(...args);
        window.__contexts.push(this);
        const destination = this.createMediaStreamDestination();
        window.__streams.push(destination.stream);
        Object.defineProperty(this, "destination", { value: destination });
      }
    };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints) => {
        if (constraints.video !== false)
          throw new Error("Sound requested a camera");
        window.__mic = window.__streams[0].clone();
        return window.__mic;
      },
    });
  });
}
for (const reduced of [false, true])
  test(`Sound actual sender PCM to microphone to DOM, reduced=${reduced}`, async ({
    page,
  }) => {
    test.setTimeout(45000);
    await silentWire(page);
    await page.emulateMedia({
      reducedMotion: reduced ? "reduce" : "no-preference",
    });
    await page.goto("/");
    await sound(page);
    expect(await page.evaluate(() => window.__contexts.length)).toBe(0);
    // A second real App is the receiver so both sender and receiver use product lifecycles.
    await page.evaluate(async () => {
      // Reuse Vite's versioned module URLs, rather than a stale optimized cache URL.
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
      const { createRoot } = ReactDOM;
      const { App } = await import("/src/App.tsx");
      const host = document.createElement("div");
      host.id = "receiver";
      document.body.append(host);
      createRoot(host).render(React.createElement(App));
    });
    const receiver = page.locator("#receiver"),
      sender = page.locator("#root");
    await receiver.getByRole("button", { name: "Switch to Bar" }).click();
    await receiver.getByRole("button", { name: "Switch to Sound" }).click();
    await receiver
      .getByRole("button", { name: "Receive", exact: true })
      .click();
    let seed = 42;
    const message = Array.from({ length: 1000 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return String.fromCharCode(32 + ((seed >>> 24) % 95));
    }).join("");
    await sender.getByLabel("Your message").fill(message);
    const began = Date.now();
    await sender.getByRole("button", { name: "Create sound" }).click();
    await receiver.getByRole("button", { name: "Start microphone" }).click();
    await page.waitForTimeout(300);
    await sender.screenshot({ path: `/tmp/orb-sound-active-${reduced}.png` });
    await expect(
      receiver.getByRole("heading", { name: "Message received" }),
      // Dense protected bursts retain the quiet low-band modulation.
    ).toBeVisible({ timeout: 10000 });
    const elapsed = Date.now() - began;
    await expect(
      receiver.getByLabel("Received message", { exact: true }),
    ).toHaveText(message);
    expect(elapsed).toBeLessThan(10000);
    await expect(receiver.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    expect(
      await page.evaluate(() =>
        window.__mic.getTracks().every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
    await sender.getByRole("button", { name: "Stop sending" }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__contexts.every((c) => c.state === "closed"),
        ),
      )
      .toBe(true);
    console.log(
      JSON.stringify({ soundBrowserMs: elapsed, originalBytes: 1000, reduced }),
    );
  });
test("Sound cancels pending microphone permissions and preserves idle drafts through brand cycle", async ({
  page,
}) => {
  await silentWire(page);
  await page.goto("/");
  await page.getByLabel("Your message").fill("draft");
  await sound(page);
  await expect(page.getByLabel("Your message")).toHaveValue("draft");
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  await page.evaluate(() =>
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: () => new Promise((r) => (window.__grant = r)),
    }),
  );
  await page.getByRole("button", { name: "Start microphone" }).click();
  await expect
    .poll(() => page.evaluate(() => typeof window.__grant))
    .toBe("function");
  await page.getByRole("button", { name: "Switch to Orb" }).click();
  await page.evaluate(() => {
    window.__late = window.__streams[0].clone();
    window.__grant(window.__late);
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__late.getTracks().every((t) => t.readyState === "ended") &&
          window.__contexts.every((c) => c.state === "closed"),
      ),
    )
    .toBe(true);
});

test("Sound uses fixed quiet output without volume controls", async ({
  page,
}) => {
  await silentWire(page);
  await page.goto("/");
  await sound(page);
  await expect(page.getByRole("slider")).toHaveCount(0);
  expect(await page.evaluate(() => window.__contexts.length)).toBe(0);
  await page.getByLabel("Your message").fill("quiet sound");
  await page.getByRole("button", { name: "Create sound" }).click();
  await expect(page.getByRole("slider")).toHaveCount(0);
  await page.getByRole("button", { name: "Stop sending" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__contexts.every((c) => c.state === "closed")),
    )
    .toBe(true);
});
