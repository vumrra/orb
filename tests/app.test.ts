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
