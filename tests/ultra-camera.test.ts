import { afterEach, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { prepareZXingModule } from "zxing-wasm/reader";
import { Camera } from "../src/camera";
import { BinaryCollector, createBinarySource } from "../src/binary-transfer";
import * as ultra from "../src/ultra-qr";
const require = createRequire(import.meta.url);
prepareZXingModule({
  overrides: {
    wasmBinary: Uint8Array.from(
      readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm")),
    ).buffer,
  },
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup() {
  const stop = vi.fn(),
    stream = { getTracks: () => [{ stop, addEventListener: vi.fn() }] };
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => stream },
  });
  vi.stubGlobal("document", {
    hidden: false,
    createElement: () => createCanvas(1, 1),
  });
  const screen = createCanvas(1200, 1000),
    video = Object.assign(screen, {
      play: async () => {},
      pause: vi.fn(),
      readyState: 2,
      videoWidth: 1200,
      videoHeight: 1000,
      srcObject: null,
    }) as unknown as HTMLVideoElement;
  let tick!: (n: number) => unknown;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((fn) => {
      tick = fn;
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  return { screen, video, stop, tick: (n: number) => tick(n) };
}
it("Camera consumes actual full-field nine-tile rasters and collector recovers dropped data with parity", async () => {
  const { screen, video, tick } = setup(),
    ctx = screen.getContext("2d");
  const bytes = Uint8Array.from({ length: 8193 }, (_, i) => i * 73),
    source = await createBinarySource(bytes, {
      name: "file",
      mime: "",
      kind: "file",
    }),
    receiver = new BinaryCollector(),
    camera = new Camera(),
    errors = vi.fn();
  await camera.start(video, "environment", vi.fn(), errors, vi.fn(), "qr", {
    ultra: true,
    onBinary: (p) => receiver.add(p),
  });
  // Join after stream is already running; all data shard 0 of each block is visually lost.
  for (let i = 0; i < 3; i++) source.next(9);
  for (let i = 0; i < 50 && !receiver.ready; i++) {
    const packets = source.next(9);
    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, 1200, 1000);
    ctx.save();
    ctx.translate(220, 90);
    ultra.drawUltraBoard(
      ctx as unknown as CanvasRenderingContext2D,
      packets,
      9,
      693,
    );
    packets.forEach((p, tile) => {
      if (p[4] === 1 && new DataView(p.buffer).getUint32(32) % 8 === 0) {
        ctx.fillStyle = "#fff";
        ctx.fillRect((tile % 3) * 231, Math.floor(tile / 3) * 231, 231, 231);
      }
    });
    ctx.restore();
    await tick(i * 1000);
  }
  expect(errors).not.toHaveBeenCalled();
  expect(receiver.repaired).toBeGreaterThan(0);
  expect((await receiver.verify()).bytes).toEqual(bytes);
  camera.stop();
});
it("has only one decode in flight and discards/clears output after stop", async () => {
  const { video, tick, stop } = setup();
  let release!: (p: Uint8Array[]) => void;
  const read = vi.spyOn(ultra, "scanUltra").mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const camera = new Camera(),
    delivered = vi.fn();
  await camera.start(video, "environment", vi.fn(), vi.fn(), vi.fn(), "qr", {
    ultra: true,
    onBinary: delivered,
  });
  const work = tick(0);
  expect(read).toHaveBeenCalledOnce();
  expect(requestAnimationFrame).toHaveBeenCalledOnce();
  camera.stop();
  const stale = new Uint8Array([1, 2, 3]);
  release([stale]);
  await work;
  expect(delivered).not.toHaveBeenCalled();
  expect(stale).toEqual(new Uint8Array(3));
  expect(stop).toHaveBeenCalledOnce();
  expect(requestAnimationFrame).toHaveBeenCalledOnce();
});
