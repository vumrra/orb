import { afterEach, expect, it, vi } from "vitest";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { Camera } from "../src/camera";
import {
  createColorSource,
  ColorCollector,
  drawColorGrid,
} from "../src/color-grid";
import { ColorTracker } from "../src/color-scan";
import * as ultra from "../src/ultra-qr";
const meta = {
  name: "pixels.weird",
  mime: "application/octet-stream",
  kind: "file" as const,
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup(width = 1600, height = 1000) {
  const stop = vi.fn(),
    track = { stop, addEventListener: vi.fn() },
    stream = { getTracks: () => [track] } as unknown as MediaStream;
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const captures: Canvas[] = [];
  const doc = {
    hidden: false,
    createElement: () => {
      const c = createCanvas(1, 1);
      captures.push(c);
      return c;
    },
  };
  vi.stubGlobal("document", doc);
  const screen = createCanvas(width, height),
    video = Object.assign(screen, {
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      readyState: 2,
      videoWidth: width,
      videoHeight: height,
      srcObject: null,
    }) as unknown as HTMLVideoElement;
  let tick!: (time: number) => Promise<void>;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((fn) => {
      tick = fn;
      return 7;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  return {
    screen,
    video,
    doc,
    stop,
    stream,
    getUserMedia,
    captures,
    tick: (n: number) => tick(n),
  };
}
it("receives a complete off-center rotated color binary through Camera at 30fps request, with no QR substitution", async () => {
  const { screen, video, tick, getUserMedia } = setup(),
    ctx = screen.getContext("2d");
  const bytes = Uint8Array.from({ length: 32000 }, (_, i) => i * 37),
    s = await createColorSource(bytes, meta, undefined, 64),
    r = new ColorCollector(),
    camera = new Camera();
  const errors = vi.fn(),
    candidate = vi.fn(),
    qr = vi.spyOn(ultra, "scanUltra"),
    seen: Uint8Array[] = [];
  await camera.start(video, "environment", vi.fn(), errors, candidate, "qr", {
    color: true,
    onColor: (p) => {
      r.add(p);
      seen.push(p);
    },
  });
  expect(getUserMedia.mock.calls[0][0].video.frameRate).toEqual({ ideal: 30 });
  expect(getUserMedia.mock.calls[0][0].video.width).toEqual({ ideal: 2048 });
  for (let i = 0; i < s.total * 3 && !r.ready; i++) {
    const p = s.next();
    ctx.fillStyle = "#171717";
    ctx.fillRect(0, 0, 1600, 1000);
    ctx.save();
    ctx.translate(1090, 300);
    ctx.rotate((-2 * Math.PI) / 180);
    drawColorGrid(ctx as unknown as CanvasRenderingContext2D, p, 3);
    ctx.restore();
    p.fill(0);
    await tick(i * 100);
  }
  expect(errors).not.toHaveBeenCalled();
  expect(qr).not.toHaveBeenCalled();
  expect(candidate).toHaveBeenCalledWith(true);
  expect((await r.verify()).bytes).toEqual(bytes);
  expect(seen.every((p) => p.every((v) => v === 0))).toBe(true);
  camera.stop();
  s.clear();
});
it("bounds full-FOV capture to 2048, pauses hidden, and reports no candidate for noise", async () => {
  const { video, doc, tick, captures } = setup(3000, 1800),
    camera = new Camera(),
    candidate = vi.fn(),
    scan = vi.spyOn(ColorTracker.prototype, "scanAll");
  await camera.start(video, "user", vi.fn(), vi.fn(), candidate, "qr", {
    color: true,
  });
  doc.hidden = true;
  await tick(0);
  expect(scan).not.toHaveBeenCalled();
  doc.hidden = false;
  await tick(100);
  expect(captures[0].width).toBe(2048);
  expect(captures[0].height).toBe(1229);
  expect(scan).toHaveBeenCalledOnce();
  expect(candidate).not.toHaveBeenCalled();
  const pixels = scan.mock.calls[0][0];
  expect(pixels.data.every((v) => v === 0)).toBe(true);
  camera.stop();
});
it("allows only one decode in flight, clears late pixels/packets, and never rearms after stop", async () => {
  const { video, tick, stop } = setup();
  let release!: (p: Uint8Array[]) => void;
  const scan = vi.spyOn(ColorTracker.prototype, "scanAll").mockImplementation(
    () =>
      new Promise<Uint8Array[]>((resolve) => {
        release = resolve;
      }) as unknown as Uint8Array<ArrayBuffer>[],
  );
  const camera = new Camera(),
    delivered = vi.fn();
  await camera.start(video, "user", vi.fn(), vi.fn(), vi.fn(), "qr", {
    color: true,
    onColor: delivered,
  });
  const work = tick(0);
  expect(scan).toHaveBeenCalledOnce();
  expect(requestAnimationFrame).toHaveBeenCalledOnce();
  camera.stop();
  const stale = new Uint8Array([3, 7, 9]);
  release([stale]);
  await work;
  expect(delivered).not.toHaveBeenCalled();
  expect(stale.every((v) => !v)).toBe(true);
  expect(scan.mock.calls[0][0].data.every((v) => !v)).toBe(true);
  expect(stop).toHaveBeenCalledOnce();
  expect(requestAnimationFrame).toHaveBeenCalledOnce();
});
it("releases a permission grant after stop, and propagates color callback errors while clearing packet data", async () => {
  const { video, stream, stop, getUserMedia, tick, screen } = setup();
  let grant!: (s: MediaStream) => void;
  getUserMedia.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
  );
  const camera = new Camera(),
    starting = camera.start(video, "user", vi.fn(), vi.fn(), vi.fn(), "qr", {
      color: true,
    });
  camera.stop();
  grant(stream);
  expect(await starting).toBe(false);
  expect(stop).toHaveBeenCalledOnce();
  expect(video.srcObject).toBeNull();
  const s = await createColorSource(new Uint8Array([255]), meta, undefined, 64);
  drawColorGrid(
    screen.getContext("2d") as unknown as CanvasRenderingContext2D,
    s.next(),
    3,
  );
  const errors = vi.fn();
  let captured: Uint8Array | undefined;
  await camera.start(video, "user", vi.fn(), errors, vi.fn(), "qr", {
    color: true,
    onColor: (p) => {
      captured = p;
      throw new Error("consumer failed");
    },
  });
  await tick(100);
  expect(errors).toHaveBeenCalledOnce();
  expect(captured?.every((v) => v === 0)).toBe(true);
  expect(video.srcObject).toBeNull();
  s.clear();
});
it("delivers multiple tiles, stops between callbacks and wipes even undelivered packets", async () => {
  const { video, tick } = setup(),
    camera = new Camera();
  const packets = [
    new Uint8Array([11]),
    new Uint8Array([22]),
    new Uint8Array([33]),
  ];
  vi.spyOn(ColorTracker.prototype, "scanAll").mockReturnValue(packets);
  const delivered = vi.fn(() => camera.stop());
  await camera.start(video, "user", vi.fn(), vi.fn(), vi.fn(), "qr", {
    color: true,
    onColor: delivered,
  });
  await tick(0);
  expect(delivered).toHaveBeenCalledOnce();
  expect(packets.every((p) => p.every((v) => v === 0))).toBe(true);
  expect(requestAnimationFrame).toHaveBeenCalledOnce();
});
