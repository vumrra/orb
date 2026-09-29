import { createCanvas } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import {
  BarTracker,
  BarCollector,
  BAR_SYMBOL_MS,
  drawBar,
  scanBarPixels,
  splitBarFrame,
} from "../src/bar";
import { Collector, splitFrames } from "../src/protocol";
const symbol = splitBarFrame(
  splitFrames(new TextEncoder().encode("dim reference anchors"))[0],
)[0];
function raster(
  gain = 0.36,
  angle = 0.23,
  mirror = false,
  dx = 0,
  blur = 0.65,
  payload = symbol,
) {
  const canvas = createCanvas(800, 600),
    c = canvas.getContext("2d");
  c.fillStyle = "#090909";
  c.fillRect(0, 0, 800, 600);
  c.save();
  c.translate(530.35 + dx, 305.65);
  c.rotate(angle);
  c.scale(mirror ? -1 : 1, 1);
  drawBar(
    c as unknown as CanvasRenderingContext2D,
    payload,
    0,
    0,
    300.3,
    265.7,
  );
  c.restore();
  const out = createCanvas(800, 600),
    o = out.getContext("2d");
  o.filter = `blur(${blur}px)`;
  o.drawImage(canvas, 0, 0);
  const pixels = o.getImageData(0, 0, 800, 600);
  for (let i = 0; i < pixels.data.length; i += 4)
    for (let k = 0; k < 3; k++)
      pixels.data[i + k] = 18 + pixels.data[i + k] * gain;
  // Bright clutter must not set the exposure threshold of the dim sender.
  for (let y = 20; y < 70; y++)
    for (let x = 20; x < 90; x++)
      for (let k = 0; k < 3; k++) pixels.data[(y * 800 + x) * 4 + k] = 255;
  return pixels;
}
it("acquires dim fractional off-center bars despite a brighter background object", () => {
  expect(scanBarPixels(raster()).symbol).toEqual(symbol);
});

it.each([
  [0.26, 0, false],
  [0.55, 1.57, true],
  [0.8, 2.7, true],
  [1, -0.4, false],
])("acquires gain=%s rotation=%s mirrored=%s", (gain, angle, mirror) => {
  expect(
    scanBarPixels(raster(gain as number, angle as number, mirror as boolean))
      .symbol,
  ).toEqual(symbol);
});

it("finds the reference rectangle among compact bright distractors", () => {
  const pixels = raster();
  for (const [cx, cy] of [
    [40, 150],
    [100, 240],
    [180, 470],
    [80, 520],
  ])
    for (let y = cy - 3; y <= cy + 3; y++)
      for (let x = cx - 3; x <= cx + 3; x++)
        for (let k = 0; k < 3; k++)
          pixels.data[(y * pixels.width + x) * 4 + k] = 255;
  expect(scanBarPixels(pixels).symbol).toEqual(symbol);
});

it("tracks motion, reacquires jumps and blanks, and bounds scans during loss", () => {
  const tracker = new BarTracker();
  expect(tracker.scan(raster()).symbol).toEqual(symbol);
  for (let x = 1; x <= 8; x++)
    expect(
      tracker.scan(raster(0.36, 0.23 + x * 0.001, false, x)).symbol,
    ).toEqual(symbol);
  expect(tracker.stats.fullScans).toBe(1);
  expect(tracker.stats.trackedScans).toBe(8);
  expect(tracker.scan(raster(0.36, 0.23, false, -120)).symbol).toEqual(symbol);
  expect(tracker.stats.fullScans).toBe(2);
  const blank = {
    width: 800,
    height: 600,
    data: new Uint8ClampedArray(800 * 600 * 4),
  };
  for (let i = 0; i < 12; i++) expect(tracker.scan(blank).symbol).toBeNull();
  expect(tracker.stats.fullScans).toBe(5);
  let found = false;
  for (let i = 0; i < 4; i++) found ||= !!tracker.scan(raster()).symbol;
  expect(found).toBe(true);
  tracker.clear();
  expect(tracker.stats).toEqual({ fullScans: 0, trackedScans: 0 });
  expect(tracker.scan(raster()).symbol).toEqual(symbol);
  expect(tracker.stats.fullScans).toBe(1);
});

it("samples dim blurred perspective geometry with bilinear fractional raster", () => {
  const src = raster(0.4, 0.18, true),
    out = {
      width: src.width,
      height: src.height,
      data: new Uint8ClampedArray(src.data.length),
    };
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const factor = 1 - 0.00035 * (y - 300),
        sx = 530 + (x - 530) / factor,
        sy = 300 + (y - 300) / factor;
      const ix = Math.floor(sx),
        iy = Math.floor(sy),
        fx = sx - ix,
        fy = sy - iy;
      if (ix < 0 || iy < 0 || ix + 1 >= src.width || iy + 1 >= src.height)
        continue;
      for (let k = 0; k < 4; k++)
        out.data[(y * src.width + x) * 4 + k] =
          src.data[(iy * src.width + ix) * 4 + k] * (1 - fx) * (1 - fy) +
          src.data[(iy * src.width + ix + 1) * 4 + k] * fx * (1 - fy) +
          src.data[((iy + 1) * src.width + ix) * 4 + k] * (1 - fx) * fy +
          src.data[((iy + 1) * src.width + ix + 1) * 4 + k] * fx * fy;
    }
  expect(scanBarPixels(out).symbol).toEqual(symbol);
});

it("measures acquisition versus tracking and receives all 1000 bytes at unchanged cadence", () => {
  const p = raster(),
    tracker = new BarTracker(),
    fresh: number[] = [],
    tracked: number[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    expect(scanBarPixels(p).symbol).toEqual(symbol);
    fresh.push(performance.now() - start);
  }
  tracker.scan(p);
  for (let i = 0; i < 40; i++) {
    const start = performance.now();
    expect(tracker.scan(p).symbol).toEqual(symbol);
    tracked.push(performance.now() - start);
  }
  const bytes = new TextEncoder().encode("0123456789".repeat(100)),
    symbols = splitFrames(bytes).flatMap(splitBarFrame),
    fragments = new BarCollector(),
    collector = new Collector();
  const frames = symbols.map((s, i) =>
    raster(
      0.4,
      0.23 + Math.sin(i / 10) * 0.008,
      false,
      Math.sin(i / 10) * 3,
      0.65,
      s,
    ),
  );
  let packet: Uint8Array | null = null,
    elapsed = 0,
    accepted = 0;
  tracker.clear();
  const start = performance.now();
  for (
    ;
    elapsed < symbols.length * BAR_SYMBOL_MS * 3 && !packet;
    elapsed += 50
  ) {
    const capture = Math.floor(elapsed / (1000 / 30)) * (1000 / 30),
      index = Math.floor(capture / BAR_SYMBOL_MS) % symbols.length;
    const scan = tracker.scan(frames[index]);
    if (scan.symbol) {
      accepted++;
      const frame = fragments.add(scan.symbol);
      if (frame) packet = collector.add(frame) || packet;
    }
  }
  expect(packet).toEqual(bytes);
  expect(collector.count).toBe(collector.total);
  expect(tracker.stats.fullScans).toBe(1);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  console.info(
    JSON.stringify({
      freshMeanMs: mean(fresh),
      trackedMeanMs: mean(tracked),
      scanCpuMs: performance.now() - start,
      simulatedTransferMs: elapsed,
      bytes: bytes.length,
      symbols: symbols.length,
      accepted,
      stats: tracker.stats,
    }),
  );
});
