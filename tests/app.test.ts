import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { App } from "../src/App";
afterEach(() => vi.unstubAllGlobals());
it("renders the simple form without instructional or warning copy", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const html = renderToStaticMarkup(createElement(App));
  expect(html).not.toMatch(
    /Transfer code|Code character|passphrase|code-slots/,
  );
  expect(html).not.toMatch(
    /Not encrypted|카메라를 켜고|카메라에는 HTTPS|Only light travels/,
  );
  expect(html).toContain("Your message");
});
it("renders the brand as an accessible transport toggle", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const html = renderToStaticMarkup(createElement(App));
  expect(html).toMatch(
    /<button[^>]*class="wordmark"[^>]*aria-label="Switch to Bar"/,
  );
  expect(html).not.toContain("Orb home");
});
it("renders megabyte receive content as plain text plus at most 128 animated code points", async () => {
  const { ReceivedText } = await import("../src/App");
  expect(typeof ReceivedText).toBe("function");
  const text = "🌒".repeat(262144);
  const html = renderToStaticMarkup(createElement(ReceivedText, { text }));
  expect((html.match(/decoded-character/g) ?? []).length).toBeLessThanOrEqual(
    128,
  );
  expect(html.replace(/<[^>]+>/g, "")).toBe(text);
});
