import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { App } from "../src/App";
afterEach(() => vi.unstubAllGlobals());
it("renders the simple message-only form and honest camera-visible warning", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const html = renderToStaticMarkup(createElement(App));
  expect(html).not.toMatch(
    /Transfer code|Code character|passphrase|code-slots/,
  );
  expect(html).toContain(
    "Not encrypted. Anyone who can film the orb can read it.",
  );
  expect(html).toContain("Your message");
});
