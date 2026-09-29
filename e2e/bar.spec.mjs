import { test, expect } from "@playwright/test";

const toggle = (page) =>
  page.getByRole("button", { name: /Switch to (Bar|Sound|QR|Orb)/ });
const start = async (page) => {
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
};
const stopped = (page) =>
  page.evaluate(() =>
    window.__stream.getTracks().every((t) => t.readyState === "ended"),
  );
async function barCamera(
  page,
  message,
  { mirror = false, angle = 0, blur = 0 } = {},
) {
  await page.evaluate(
    async ({ message, mirror, angle, blur }) => {
      const { splitFrames } = await import("/src/protocol.ts");
      const { splitBarFrame, drawBar, BAR_SYMBOL_MS, BAR_TRANSITION_MS } =
        await import("/src/bar.ts");
      const frames = splitFrames(new TextEncoder().encode(message));
      const symbols = frames.flatMap(splitBarFrame);
      const other = splitFrames(new TextEncoder().encode(message)).flatMap(
        splitBarFrame,
      );
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext("2d");
      let began = performance.now();
      window.__hold = null;
      window.__kind = "valid";
      const render = () => {
        const time = performance.now() - began,
          n = Math.floor(time / BAR_SYMBOL_MS) % symbols.length;
        const index = window.__hold ?? n;
        const phase = time % BAR_SYMBOL_MS;
        const t = Math.min(1, phase / BAR_TRANSITION_MS);
        const blend =
          window.__hold !== null ||
          matchMedia("(prefers-reduced-motion: reduce)").matches
            ? 1
            : 1 - Math.exp(-6 * t) * Math.cos(8 * t);
        ctx.fillStyle = "#090909";
        ctx.fillRect(0, 0, 1280, 720);
        ctx.save();
        ctx.translate(970, 350);
        ctx.rotate(angle);
        ctx.scale(mirror ? -1 : 1, 1);
        ctx.filter = `blur(${blur}px)`;
        const selected = (window.__kind === "mixed" ? other : symbols)[
          index
        ].slice();
        if (window.__kind === "corrupt") selected[10] ^= 1;
        drawBar(
          ctx,
          selected,
          0,
          0,
          330,
          290,
          symbols[(index + symbols.length - 1) % symbols.length],
          window.__hold !== null || phase >= BAR_TRANSITION_MS ? 1 : blend,
        );
        ctx.restore();
      };
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          began = performance.now();
          window.__stream = canvas.captureStream(30);
          const timer = setInterval(() => {
            if (
              window.__stream.getTracks().every((t) => t.readyState === "ended")
            ) {
              clearInterval(timer);
              return;
            }
            render();
          }, 1000 / 30);
          render();
          return window.__stream;
        },
      });
    },
    { message, mirror, angle, blur },
  );
}
for (const reduced of [false, true])
  test(`Bar pixels -> real Camera -> Collector, reduced=${reduced}`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.emulateMedia({
      reducedMotion: reduced ? "reduce" : "no-preference",
    });
    await page.goto("/");
    await barCamera(page, "a".repeat(15) + "🌒 한글 geometric white bars", {
      mirror: true,
      angle: 0.23,
      blur: 0.5,
    });
    // Default Orb receiver must auto-detect Bar.
    await start(page);
    const began = Date.now();
    await expect(
      page.getByLabel("Received message", { exact: true }),
    ).toHaveText("a".repeat(15) + "🌒 한글 geometric white bars", {
      timeout: 15000,
    });
    expect(await stopped(page)).toBe(true);
    console.log(
      JSON.stringify({ barCaptureStreamMs: Date.now() - began, reduced }),
    );
    await page.getByRole("button", { name: "Copy message" }).click();
    await expect(
      page.getByRole("button", { name: "Copied", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Send again" }).click();
    await toggle(page).click();
    await expect(page.getByLabel("Your message")).toHaveValue(
      "a".repeat(15) + "🌒 한글 geometric white bars",
    );
    await page.getByRole("button", { name: "Create bar" }).click();
    await expect(
      page.getByLabel("White bars carrying the message"),
    ).toBeVisible();
    await toggle(page).click();
    await expect(
      page.getByRole("button", { name: "Create sound" }),
    ).toBeDisabled();
  });
test("keyboard logo toggle keeps idle composition and resets active transfer", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Your message").fill("keep my draft");
  await toggle(page).focus();
  await page.keyboard.press("Enter");
  await expect(toggle(page)).toHaveText("Bar");
  await expect(page.getByLabel("Your message")).toHaveValue("keep my draft");
  await page.getByRole("button", { name: "Create bar" }).click();
  await toggle(page).focus();
  await page.keyboard.press("Space");
  await expect(toggle(page)).toHaveText("Sound");
  await toggle(page).click();
  await expect(toggle(page)).toHaveText("QR");
  await toggle(page).click();
  await expect(toggle(page)).toHaveText("Orb");
  await expect(page.getByLabel("Your message")).toHaveValue("");
});
for (const pending of [true, false])
  test(`logo cancels camera, permission pending=${pending}`, async ({
    page,
  }) => {
    await page.goto("/");
    if (pending)
      await page.evaluate(() =>
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
          value: () => new Promise((resolve) => (window.__grant = resolve)),
        }),
      );
    else {
      await barCamera(page, "partial ".repeat(10));
      await page.evaluate(() => (window.__hold = 0));
    }
    await start(page);
    if (!pending) await expect(page.getByLabel("Camera preview")).toBeVisible();
    await toggle(page).click();
    if (pending)
      await page.evaluate(() => {
        window.__stream = document.createElement("canvas").captureStream();
        window.__grant(window.__stream);
      });
    await expect.poll(() => stopped(page)).toBe(true);
    await expect(
      page.getByLabel("Received message", { exact: true }),
    ).toBeEmpty();
    await expect(
      page.getByRole("button", { name: "Start camera" }),
    ).toBeEnabled();
  });
test("sender payload resumes after hidden and reduced motion still advances symbols", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await toggle(page).click();
  await page.getByLabel("Your message").fill("visibility recovery");
  await page.getByRole("button", { name: "Create bar" }).click();
  const snapshot = () =>
    page.locator(".orb-canvas").evaluate((el) => el.toDataURL());
  const first = await snapshot();
  await page.waitForTimeout(180);
  expect(await snapshot()).not.toBe(first);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hidden = await snapshot();
  await page.waitForTimeout(200);
  expect(await snapshot()).toBe(hidden);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(snapshot).not.toBe(hidden);
});
for (const width of [375, 768, 1440])
  test(`Bar layout fits ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1024 });
    await page.goto("/");
    await toggle(page).click();
    await expect(
      page.getByRole("button", { name: "Create bar" }),
    ).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await page.getByRole("button", { name: "Receive", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Start camera" }),
    ).toBeInViewport();
  });

test("Bar camera fragments tolerate gaps, repeats and interleaved senders with genuine partial progress", async ({
  page,
}) => {
  await page.goto("/");
  await toggle(page).click();
  const message = "a".repeat(6) + "🌒 한글 " + "z".repeat(20);
  await barCamera(page, message);
  const paint = async (index, kind = "valid") => {
    await page.evaluate(
      ({ index, kind }) => {
        window.__hold = index;
        window.__kind = kind;
      },
      { index, kind },
    );
    await page.waitForTimeout(180);
  };
  await paint(0);
  await start(page);
  const result = page.getByLabel("Received message", { exact: true });
  for (const index of [0, 0]) await paint(index);
  await expect(result).toBeEmpty();
  await paint(1);
  await expect(result).toHaveText("a".repeat(6));
  await expect(page.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "33",
  );
  for (const index of [5, 4]) await paint(index);
  await expect(page.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "67",
  );
  for (const index of [2, 3]) await paint(index, "mixed");
  await paint(2, "corrupt");
  await expect(result).toHaveText("a".repeat(6));
  // Real broadcasts repeat missed fragments; a busy browser may skip a held sample.
  await expect(async () => {
    for (const index of [3, 2]) await paint(index);
    await expect(result).toHaveText(message, { timeout: 250 });
  }).toPass({ timeout: 6000 });
  expect(await stopped(page)).toBe(true);
  await toggle(page).click();
  await expect(result).toBeEmpty();
});
for (const angle of [Math.PI / 2, 2.7])
  test(`Bar camera rotated ${angle}`, async ({ page }) => {
    await page.goto("/");
    await toggle(page).click();
    await barCamera(page, "rotated bars", { angle, mirror: true, blur: 0.5 });
    await start(page);
    await expect(
      page.getByLabel("Received message", { exact: true }),
    ).toHaveText("rotated bars", { timeout: 12000 });
  });
