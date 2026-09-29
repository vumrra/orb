import { test, expect } from "@playwright/test";

// Real canvas -> MediaStream -> video -> camera pixels -> optical decoder.
// Holding one frame lets assertions prove progress is driven by data, not time.
async function opticalCamera(page, message) {
  await page.evaluate(async (message) => {
    const { splitFrames, crc32, FRAME_BYTES } =
      await import("/src/protocol.ts");
    const { drawOptical, SYMBOL_MS } = await import("/src/optical.ts");
    const frames = splitFrames(new TextEncoder().encode(message));
    const other = splitFrames(
      new TextEncoder().encode("other sender ".repeat(12)),
    );
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 540;
    const ctx = canvas.getContext("2d");
    let selected = { index: 0, kind: "valid" };
    const origin = performance.now();
    const render = () => {
      ctx.fillStyle = "#090a0b";
      ctx.fillRect(0, 0, 960, 540);
      if (!selected) return;
      const { index, kind } = window.__auto
        ? {
            index:
              Math.floor((performance.now() - origin) / SYMBOL_MS) %
              frames.length,
            kind: "valid",
          }
        : selected;
      const frame = (kind === "mixed" ? other[index] : frames[index]).slice();
      if (kind === "corrupt" || kind === "checksum") frame[20] ^= 1;
      if (kind === "checksum")
        new DataView(frame.buffer).setUint32(
          FRAME_BYTES - 4,
          crc32(frame.subarray(0, FRAME_BYTES - 4)),
        );
      ctx.fillStyle = "#090a0b";
      ctx.fillRect(0, 0, 960, 540);
      drawOptical(
        ctx,
        frame,
        690,
        270,
        190,
        0.23,
        window.__reduced ? 0.75 : 0.75 + (performance.now() - origin) / 1000,
      );
    };
    window.__reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.__paint = (index, kind = "valid") => {
      selected = { index, kind };
      render();
    };
    window.__blank = () => {
      selected = null;
      render();
    };
    window.__paint(0);
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        window.__testStream = canvas.captureStream(20);
        // Emit pixels after capture begins; a pre-painted canvas may not deliver a frame.
        const refresh = setInterval(() => {
          if (
            window.__testStream
              .getTracks()
              .every((track) => track.readyState === "ended")
          ) {
            clearInterval(refresh);
            return;
          }
          render();
        }, 50);
        return window.__testStream;
      },
    });
  }, message);
}
const paint = (page, index, kind = "valid") =>
  page.evaluate(({ index, kind }) => window.__paint(index, kind), {
    index,
    kind,
  });
const start = async (page) => {
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  await page.getByRole("button", { name: "Start camera" }).click();
};
const stopped = (page) =>
  page.evaluate(() =>
    window.__testStream.getTracks().every((t) => t.readyState === "ended"),
  );

test("message alone enables immediate sending, no PIN in either mode", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Create orb" })).toBeDisabled();
  await expect(page.locator("input, .transfer-code, .code-slots")).toHaveCount(
    0,
  );
  await page.getByLabel("Your message").fill("hello from orb 🌒");
  await expect(page.getByRole("button", { name: "Create orb" })).toBeEnabled();
  await expect(
    page.getByText("Not encrypted. Anyone who can film the orb can read it.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Create orb" }).click();
  await expect(
    page.getByRole("heading", { name: "Ready to scan" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Moving light carrying the message"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop sending" }).click();
  await expect(page.getByLabel("Your message")).toHaveValue("");
  await page.getByLabel("Your message").fill("🌒".repeat(262144) + "a");
  await expect(page.getByRole("button", { name: "Create orb" })).toBeDisabled();
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  await expect(page.locator("input, .transfer-code, .code-slots")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Start camera" }),
  ).toBeEnabled();
});

for (const reduced of [false, true]) {
  test(`real optical stream shows partial UTF-8, new-only motion, copy/resend/reset; reduced=${reduced}`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.emulateMedia({
      reducedMotion: reduced ? "reduce" : "no-preference",
    });
    await page.goto("/");
    const prefix = "a".repeat(6);
    const message = prefix + "🌒한글 " + "z".repeat(20);
    await opticalCamera(page, message);
    await start(page);
    const result = page.getByLabel("Received message", { exact: true });
    await expect(result).toHaveText(prefix, { timeout: 12000 });
    await expect(
      page.getByRole("progressbar", { name: "Receive progress" }),
    ).toHaveAttribute("aria-valuenow", "33");
    await expect(page.getByLabel("Camera preview")).toBeVisible();
    await expect(
      page.getByText("Signal acquired", { exact: true }),
    ).toBeVisible();
    const before = await page.locator(".received-message").boundingBox();
    const stage = await page.locator(".orb-stage").boundingBox();
    expect(before.y).toBeGreaterThanOrEqual(stage.y + stage.height);
    expect(before.y - stage.y - stage.height).toBeLessThan(50);
    await page
      .locator(".decoded-character")
      .first()
      .evaluate((el) => {
        window.__firstCharacter = el;
      });
    const animation = await page
      .locator(".decoded-character")
      .first()
      .evaluate((el) => getComputedStyle(el).animationName);
    expect(animation).toBe(reduced ? "none" : "text-resolve");
    if (reduced) {
      expect(
        await page
          .locator(".decoded-character")
          .first()
          .evaluate((el) => ({
            filter: getComputedStyle(el).filter,
            opacity: getComputedStyle(el).opacity,
          })),
      ).toEqual({ filter: "none", opacity: "1" });
    }
    const trail = await page
      .locator(".light-trails")
      .evaluate((el) => getComputedStyle(el).display);
    expect(trail).toBe(reduced ? "none" : "block");
    // Reordered final frame, then duplicates/mixed/corrupt: no text across a gap.
    await paint(page, 2);
    await expect(
      page.getByRole("progressbar", { name: "Receive progress" }),
    ).toHaveAttribute("aria-valuenow", "67");
    for (const [index, kind] of [
      [0, "valid"],
      [0, "mixed"],
      [1, "corrupt"],
    ]) {
      await paint(page, index, kind);
      await page.waitForTimeout(400);
      await expect(result).toHaveText(prefix);
      await expect(
        page.getByRole("progressbar", { name: "Receive progress" }),
      ).toHaveAttribute("aria-valuenow", "67");
    }
    await paint(page, 1);
    await expect(
      page.getByRole("heading", { name: "Message received" }),
    ).toBeVisible();
    await expect(result).toHaveText(message);
    await expect(
      page.getByRole("progressbar", { name: "Receive progress" }),
    ).toHaveAttribute("aria-valuenow", "100");
    expect(
      await page
        .locator(".decoded-character")
        .first()
        .evaluate((el) => el === window.__firstCharacter),
    ).toBe(true);
    expect(await stopped(page)).toBe(true);
    const after = await page.locator(".received-message").boundingBox();
    const finalStage = await page.locator(".orb-stage").boundingBox();
    expect(after.y - finalStage.y).toBeCloseTo(before.y - stage.y, 0);
    expect(after.width).toBe(before.width);
    await expect(
      page.getByRole("button", { name: /Reveal|Hide message/ }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Copy message" }).click();
    await expect(
      page.getByRole("button", { name: "Copied", exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      message,
    );
    await page.getByRole("button", { name: "Send again" }).click();
    await expect(page.getByLabel("Your message")).toHaveValue(message);
    await page.getByRole("button", { name: "Create orb" }).click();
    await expect(
      page.getByRole("heading", { name: "Ready to scan" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Receive", exact: true }).click();
    await expect(result).toBeEmpty();
    expect(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
    ).toBe(0);
  });
}

test("checksum failure clears provisional text and stops camera; retry and reset", async ({
  page,
}) => {
  await page.goto("/");
  const message = "a".repeat(27);
  await opticalCamera(page, message);
  await start(page);
  await expect(page.getByLabel("Received message", { exact: true })).toHaveText(
    "a".repeat(7),
  );
  await paint(page, 1, "checksum");
  await expect(page.getByRole("alert")).toContainText("checksum");
  await expect(
    page.getByLabel("Received message", { exact: true }),
  ).toBeEmpty();
  expect(await stopped(page)).toBe(true);
  await paint(page, 0);
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.getByRole("status")).toContainText("1 / 2");
  await paint(page, 1);
  await expect(
    page.getByRole("heading", { name: "Message received" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(
    page.getByLabel("Received message", { exact: true }),
  ).toBeEmpty();
});

for (const action of ["Cancel", "Send"]) {
  test(`${action} clears partial text and stops capture`, async ({ page }) => {
    await page.goto("/");
    await opticalCamera(page, "x".repeat(90));
    await start(page);
    await expect(
      page.getByLabel("Received message", { exact: true }),
    ).toHaveText("x".repeat(7));
    await page.getByRole("button", { name: action, exact: true }).click();
    expect(await stopped(page)).toBe(true);
    if (action === "Send")
      await page.getByRole("button", { name: "Receive", exact: true }).click();
    await paint(page, 1);
    await expect(
      page.getByLabel("Received message", { exact: true }),
    ).toBeEmpty();
    await expect(
      page.getByRole("button", { name: "Start camera" }),
    ).toBeEnabled();
  });
}

test("camera permission denial is recoverable", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() =>
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => {
        throw new DOMException("denied", "NotAllowedError");
      },
    }),
  );
  await start(page);
  await expect(page.getByRole("alert")).toContainText(
    "Camera access was denied",
  );
  await expect(
    page.getByRole("button", { name: "Start camera" }),
  ).toBeEnabled();
});

for (const action of ["Cancel", "Send"]) {
  test(`${action} during permission stops late streams`, async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() =>
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        value: () =>
          new Promise((resolve) => {
            window.__grant = resolve;
          }),
      }),
    );
    await start(page);
    await page.getByRole("button", { name: action, exact: true }).click();
    await page.evaluate(() => {
      window.__testStream = document.createElement("canvas").captureStream();
      window.__grant(window.__testStream);
    });
    await expect.poll(() => stopped(page)).toBe(true);
    if (action === "Send")
      await page.getByRole("button", { name: "Receive", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Start camera" }),
    ).toBeEnabled();
    await expect(
      page.getByLabel("Received message", { exact: true }),
    ).toBeEmpty();
  });
}

test("stale clipboard completion cannot change a reset view", async ({
  page,
}) => {
  await page.goto("/");
  await opticalCamera(page, "short");
  await start(page);
  await expect(
    page.getByRole("heading", { name: "Message received" }),
  ).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: () =>
        new Promise((resolve) => {
          window.__copied = resolve;
        }),
    }),
  );
  await page.getByRole("button", { name: "Copy message" }).click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.evaluate(() => window.__copied());
  await expect(
    page.getByRole("button", { name: "Copied", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Received message", { exact: true }),
  ).toBeEmpty();
});

test("primary control remains visible without WebGL and with reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      return kind.includes("webgl")
        ? null
        : getContext.call(this, kind, ...args);
    };
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Create orb" })).toBeVisible();
});

for (const [width, height] of [
  [1440, 1000],
  [768, 1024],
  [375, 812],
]) {
  test(`layout ${width}px has no overflow and exposes primary action`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    for (const mode of ["Send", "Receive"]) {
      await page.getByRole("button", { name: mode, exact: true }).click();
      await expect(
        page.getByRole("button", {
          name: mode === "Send" ? "Create orb" : "Start camera",
        }),
      ).toBeInViewport();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await page.screenshot({
        path: testInfo.outputPath(`${mode}-${width}.png`),
        fullPage: true,
      });
    }
  });
}

test("candidate reacts before valid data, expires, then receives from an off-center landscape stream", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Switch to Bar" }).click();
  await opticalCamera(page, "acquire");
  await paint(page, 0, "corrupt");
  await start(page);
  await expect(page.getByRole("status")).toContainText("Signal candidate");
  await expect(page.locator(".orb-stage")).toHaveClass(/is-candidate/);
  await expect(
    page.getByLabel("Received message", { exact: true }),
  ).toBeEmpty();
  await expect(
    page.getByRole("progressbar", { name: "Receive progress" }),
  ).toHaveAttribute("aria-valuenow", "0");
  await page.evaluate(() => window.__blank());
  await expect(page.getByRole("status")).toContainText("Searching");
  await expect(page.locator(".orb-stage")).not.toHaveClass(/is-candidate/);
  await paint(page, 0);
  await expect(
    page.getByRole("heading", { name: "Message received" }),
  ).toBeVisible();
  await expect(page.getByLabel("Received message", { exact: true })).toHaveText(
    "acquire",
  );
});

test("automatically collects a moving, advancing capture stream at the configured symbol cadence", async ({
  page,
}) => {
  await page.goto("/");
  const message = "Fast wave particles 🌒 한글 ".repeat(3);
  await opticalCamera(page, message);
  await page.evaluate(() => (window.__auto = true));
  const began = Date.now();
  await start(page);
  await expect(
    page.getByRole("heading", { name: "Message received" }),
  ).toBeVisible({ timeout: 12000 });
  await expect(page.getByLabel("Received message", { exact: true })).toHaveText(
    message,
  );
  console.log(
    JSON.stringify({
      captureStreamReceiveMs: Date.now() - began,
      bytes: new TextEncoder().encode(message).length,
    }),
  );
  expect(await stopped(page)).toBe(true);
});
