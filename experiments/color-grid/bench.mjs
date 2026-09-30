import { chromium } from "../../node_modules/playwright-core/index.mjs";
import { appendFile, writeFile } from "node:fs/promises";
const bytes = Number(process.argv[2] || 10000000),
  smoke = process.argv.includes("--smoke");
const cases = smoke
  ? [{ fps: 60 }]
  : [
      { fps: 60 },
      { fps: 60 },
      { fps: 30 },
      { fps: 60, dropEvery: 13 },
      { fps: 60, blur: 0.5 },
      { fps: 60, move: true },
      { fps: 60, angle: 2, timeoutMs: 8000 },
    ];
const path = "/tmp/orb-color-grid-results.jsonl";
await writeFile(path, "");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const scenario of cases) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 1100 },
    });
    page.on("pageerror", (e) => console.error(e.message));
    await page.goto(
      process.env.COLOR_GRID_URL ||
        "http://127.0.0.1:5175/experiments/color-grid/",
    );
    await page.waitForFunction(() => !!window.runTrial);
    const result = await page.evaluate((args) => window.runTrial(args), {
      bytes,
      bits: 3,
      timeoutMs: 35000,
      ...scenario,
    });
    console.log(JSON.stringify(result));
    await appendFile(path, JSON.stringify(result) + "\n");
    await page.screenshot({ path: "/tmp/orb-color-grid-last.png" });
    await page.close();
  }
} finally {
  await browser.close();
}
