import { afterEach, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { colorLayout, createColorSource } from "../src/color-grid";
import { ColorTracker } from "../src/color-scan";
const hooks = vi.hoisted(() => ({
  element: null as unknown,
  effect: null as null | (() => void | (() => void)),
}));
vi.mock("react", () => ({
  useRef: (value: unknown) => ({
    current: value === null ? hooks.element : value,
  }),
  useEffect: (fn: () => void) => {
    hooks.effect = fn;
  },
}));
import { ColorBoard } from "../src/ColorBoard";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function setup() {
  const screen = createCanvas(1, 1),
    style = { width: "91px", height: "92px", aspectRatio: "1 / 1" },
    stage = { style };
  const shell = { clientWidth: 1100 };
  Object.assign(screen, {
    parentElement: stage,
    closest: () => shell,
    style: {},
    dataset: {},
  });
  hooks.element = screen;
  const doc = {
    hidden: false,
    createElement: () => createCanvas(1, 1),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("innerWidth", 1100);
  vi.stubGlobal("innerHeight", 1250);
  vi.stubGlobal("devicePixelRatio", 1);
  let resize!: () => void, tick!: (time: number) => void;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(fn: () => void) {
        resize = fn;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((fn) => {
      tick = fn;
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  return {
    screen,
    stage,
    doc,
    disconnect,
    resize: () => resize(),
    tick: (time: number) => tick(time),
  };
}
it("draws readable real cells, pauses hidden tabs, restores stage styles, never clears a borrowed source", async () => {
  const { screen, stage, doc, tick, disconnect } = setup();
  const s = await createColorSource(new Uint8Array(40000), {
    name: "file.bin",
    mime: "application/octet-stream",
    kind: "file",
  });
  const clear = vi.spyOn(s, "clear"),
    next = vi.spyOn(s, "next"),
    errors = vi.fn();
  ColorBoard({ source: s, onError: errors });
  const cleanup = hooks.effect!();
  tick(0);
  const pixels = screen
    .getContext("2d")
    .getImageData(0, 0, screen.width, screen.height);
  expect(new ColorTracker().scan(pixels)).not.toBeNull();
  expect(stage.style.width).toBe(`${colorLayout(256).width * 3}px`);
  expect(next).toHaveBeenCalledOnce();
  doc.hidden = true;
  tick(17);
  expect(next).toHaveBeenCalledOnce();
  doc.hidden = false;
  tick(34);
  expect(next).toHaveBeenCalledTimes(2);
  tick(51);
  expect(next).toHaveBeenCalledTimes(3);
  if (cleanup) cleanup();
  expect(clear).not.toHaveBeenCalled();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(stage.style).toEqual({
    width: "91px",
    height: "92px",
    aspectRatio: "1 / 1",
  });
  expect(
    screen
      .getContext("2d")
      .getImageData(0, 0, screen.width, screen.height)
      .data.every((v) => v === 0),
  ).toBe(true);
  expect(errors).not.toHaveBeenCalled();
  s.clear();
});
it("fails visibly on a too-small resize instead of changing the grid or scaling unreadable cells", async () => {
  const { resize, tick, screen } = setup(),
    errors = vi.fn();
  const s = await createColorSource(new Uint8Array([1]), {
    name: "f",
    mime: "x/y",
    kind: "file",
  });
  const next = vi.spyOn(s, "next");
  ColorBoard({ source: s, onError: errors });
  const cleanup = hooks.effect!();
  tick(0);
  vi.stubGlobal("innerWidth", 390);
  resize();
  tick(100);
  expect(errors).toHaveBeenCalledOnce();
  expect(String(errors.mock.calls[0][0])).toMatch(/space|small/i);
  expect(s.grid).toBe(256);
  expect(next).toHaveBeenCalledOnce();
  expect(
    screen
      .getContext("2d")
      .getImageData(0, 0, screen.width, screen.height)
      .data.every((v) => v === 0),
  ).toBe(true);
  if (cleanup) cleanup();
  s.clear();
});
