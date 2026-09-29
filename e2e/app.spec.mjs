import { test, expect } from "@playwright/test";

// Real canvas -> MediaStream -> video -> camera pixels -> optical decoder.
// Holding one frame lets assertions prove progress is driven by data, not time.
async function opticalCamera(page, message) {
  await page.evaluate(async (message) => {
    const { splitFrames, crc32 } = await import("/src/protocol.ts");
    const { drawOptical } = await import("/src/optical.ts");
    const frames = splitFrames(new TextEncoder().encode(message));
    const other = splitFrames(
      new TextEncoder().encode("other sender ".repeat(12)),
    );
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 640;
    const ctx = canvas.getContext("2d");
    window.__paint = (index, kind = "valid") => {
      const frame = (kind === "mixed" ? other[index] : frames[index]).slice();
      if (kind === "corrupt" || kind === "checksum") frame[20] ^= 1;
      if (kind === "checksum")
        new DataView(frame.buffer).setUint32(60, crc32(frame.subarray(0, 60)));
      ctx.fillStyle = "#090a0b";
      ctx.fillRect(0, 0, 640, 640);
      drawOptical(ctx, frame, 320, 320, 265, 0, 0.75);
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
          ctx.drawImage(canvas, 0, 0);
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
  ).toBeVisible();
  await page.getByRole("button", { name: "Create orb" }).click();
  await expect(
    page.getByRole("heading", { name: "Ready to scan" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Moving light carrying the message"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop sending" }).click();
  await expect(page.getByLabel("Your message")).toHaveValue("");
  await page.getByLabel("Your message").fill("가".repeat(129));
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
    const prefix = "a".repeat(39);
    const message = prefix + "🌒한글 " + "z".repeat(55);
    await opticalCamera(page, message);
    await start(page);
    const result = page.getByLabel("Received message", { exact: true });
    await expect(result).toHaveText(prefix, { timeout: 12000 });
    await expect(page.getByRole("status")).toContainText("1 / 3");
    await expect(page.getByLabel("Camera preview")).toBeVisible();
    await expect(
      page.getByText("Align orb here", { exact: true }),
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
    await expect(page.getByRole("status")).toContainText("2 / 3");
    for (const [index, kind] of [
      [0, "valid"],
      [0, "mixed"],
      [1, "corrupt"],
    ]) {
      await paint(page, index, kind);
      await page.waitForTimeout(400);
      await expect(result).toHaveText(prefix);
      await expect(page.getByRole("status")).toContainText("2 / 3");
    }
    await paint(page, 1);
    await expect(
      page.getByRole("heading", { name: "Message received" }),
    ).toBeVisible();
    await expect(result).toHaveText(message);
    expect(
      await page
        .locator(".decoded-character")
        .first()
        .evaluate((el) => el === window.__firstCharacter),
    ).toBe(true);
    expect(await stopped(page)).toBe(true);
    const after = await page.locator(".received-message").boundingBox();
    expect(after.y).toBeCloseTo(before.y, 0);
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
  const message = "a".repeat(80);
  await opticalCamera(page, message);
  await start(page);
  await expect(page.getByLabel("Received message", { exact: true })).toHaveText(
    "a".repeat(40),
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
    ).toHaveText("x".repeat(40));
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
  await opticalCamera(page, "short message");
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
