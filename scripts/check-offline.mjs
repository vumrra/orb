import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
try {
  const page = await context.newPage();
  const errors = [];
  const external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (!request.url().startsWith("http://127.0.0.1:4173/"))
      external.push(request.url());
  });
  await page.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (!entry.hadRecentInput) window.__cls += entry.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto("http://127.0.0.1:4173/");
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page
    .getByRole("button", { name: "Create orb" })
    .waitFor({ state: "visible" });
  const cls = await page.evaluate(() => window.__cls);
  await context.setOffline(true);
  await page.reload();
  await page.getByLabel("Your message").fill("offline test — 비밀");
  await page.getByRole("button", { name: "Create orb" }).click();
  await page.getByRole("heading", { name: "Ready to scan" }).waitFor();
  await page.screenshot({
    path: "evidence/offline-broadcast-1440.png",
    fullPage: true,
  });
  const storage = await page.evaluate(async () => {
    const keys = await caches.keys();
    const urls = [];
    for (const key of keys)
      for (const request of await (await caches.open(key)).keys())
        urls.push(request.url);
    return { local: localStorage.length, session: sessionStorage.length, urls };
  });
  assert.equal(errors.length, 0, errors.join("\n"));
  assert.deepEqual(external, []);
  assert.equal(storage.local, 0);
  assert.equal(storage.session, 0);
  assert.ok(storage.urls.every((url) => !url.includes("offline test")));
  assert.ok(cls < 0.1, `CLS ${cls} exceeds budget`);
  const result = {
    offlineReloadAndOpticalSend: "passed",
    browserErrors: errors,
    externalRequests: external,
    storage,
    cls,
    profile:
      "Chromium desktop 1440x1000, cold local production load, unthrottled, reduced motion; synthetic lab sample, not field p75",
  };
  await writeFile(
    "evidence/offline-check.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
