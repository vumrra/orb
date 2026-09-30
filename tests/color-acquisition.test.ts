import { expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  colorLayout,
  drawColorGrid,
  createColorSource,
  ColorCollector,
} from "../src/color-grid";
import { ColorTracker } from "../src/color-scan";
const meta = {
  name: "camera.bin",
  mime: "application/octet-stream",
  kind: "file" as const,
};

// The detector gets only these camera pixels. Tile positions are fixture inputs,
// never supplied to ColorTracker. Supersampling models subpixel downsampling.
function scene(
  packets: Uint8Array[],
  options: { roll?: Uint8Array; damage?: boolean; crop?: boolean } = {},
) {
  const l = colorLayout(64),
    scale = 2,
    cell = 3.35;
  const camera = createCanvas(800 * scale, 600 * scale),
    c = camera.getContext("2d");
  c.scale(scale, scale);
  c.fillStyle = "#ddd";
  c.fillRect(0, 0, 800, 600);
  // Bright non-finder clutter, including squares larger than real finders.
  c.fillStyle = "white";
  for (let i = 0; i < 15; i++) c.fillRect(8 + i * 51, 9 + (i % 3) * 29, 20, 18);
  const tile = (p: Uint8Array, x: number, y: number) => {
    const board = createCanvas(l.width * 8, l.height * 8),
      b = board.getContext("2d");
    drawColorGrid(b as unknown as CanvasRenderingContext2D, p, 8);
    if (options.roll) {
      const next = createCanvas(board.width, board.height);
      drawColorGrid(
        next.getContext("2d") as unknown as CanvasRenderingContext2D,
        options.roll,
        8,
      );
      b.save();
      b.beginPath();
      b.rect(0, l.top * 8 + 25 * 8, board.width, 1000);
      b.clip();
      b.drawImage(next, 0, 0);
      b.restore();
      // Rows near the exposure transition integrate both displayed frames.
      b.save();
      b.beginPath();
      b.rect(0, (l.top + 20) * 8, board.width, 5 * 8);
      b.clip();
      b.globalAlpha = 0.5;
      b.drawImage(next, 0, 0);
      b.restore();
    }
    if (options.damage) {
      b.fillStyle = "#9b647e";
      // One entire damaged data row plus a few damaged header bytes.
      b.fillRect(14 * 8, (l.top + 19) * 8, 64 * 8, 8);
      b.fillRect(14 * 8, 20 * 8, 18 * 8, 8);
    }
    c.save();
    c.translate(x, y);
    c.rotate(0.087);
    c.filter = "blur(0.55px)";
    c.drawImage(board, 0, 0, l.width * cell, l.height * cell);
    c.restore();
  };
  tile(packets[0], 161.37, 130.62);
  if (packets[1]) tile(packets[1], options.crop ? 640.7 : 480.7, 128.8);
  const down = createCanvas(800, 600),
    d = down.getContext("2d");
  d.drawImage(camera, 0, 0, 800, 600);
  const pixels = d.getImageData(0, 0, 800, 600);
  let seed = 1717;
  for (let y = 0; y < 600; y++)
    for (let x = 0; x < 800; x++) {
      const i = (y * 800 + x) * 4,
        r = pixels.data[i],
        g = pixels.data[i + 1],
        b = pixels.data[i + 2];
      const light = 0.43 + (0.39 * x) / 800 + (0.13 * y) / 600;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = ((seed >>> 24) / 255 - 0.5) * 9;
      // Cross-channel response plus gamma and spatially uneven exposure.
      const mixed = [
        0.78 * r + 0.14 * g + 0.08 * b,
        0.1 * r + 0.78 * g + 0.12 * b,
        0.12 * r + 0.16 * g + 0.72 * b,
      ];
      for (let k = 0; k < 3; k++)
        pixels.data[i + k] =
          8 + 245 * Math.pow(mixed[k] / 255, 0.87) * light + noise;
    }
  // A bright lamp outside the board must not set the finder threshold.
  for (let y = 3; y < 50; y++)
    for (let x = 720; x < 790; x++)
      pixels.data.fill(255, (y * 800 + x) * 4, (y * 800 + x) * 4 + 4);
  return pixels;
}
it("acquires a complete local tile beside a cropped tile with bright clutter, gradient, noise, color mixing and subpixel blur", async () => {
  const s = await createColorSource(
    Uint8Array.from({ length: 4000 }, (_, i) => i * 37),
    meta,
    undefined,
    64,
  );
  const p = s.data(0),
    cropped = s.data(1);
  expect(new ColorTracker().scan(scene([p, cropped], { crop: true }))).toEqual(
    p,
  );
  s.clear();
});
it("corrects local cell and protected-header damage before CRC validation", async () => {
  const s = await createColorSource(
    Uint8Array.from({ length: 4000 }, (_, i) => i * 71),
    meta,
    undefined,
    64,
  );
  const p = s.data(0);
  expect(new ColorTracker().scan(scene([p], { damage: true }))).toEqual(p);
  s.clear();
});
it("rejects rolled mixed-frame tiles without progress and completes SHA reassembly from degraded cropped pixels with packet drops", async () => {
  const bytes = Uint8Array.from(
    { length: 11000 },
    (_, i) => (i * 71 + (i >>> 8)) & 255,
  );
  const s = await createColorSource(bytes, meta, undefined, 64),
    r = new ColorCollector(),
    tracker = new ColorTracker();
  const mixed = tracker.scan(scene([s.data(0)], { roll: s.data(1) }));
  if (mixed) r.add(mixed);
  expect(r.count).toBe(0);
  expect(r.total).toBe(0);
  for (let i = 0; i < s.total * 6 && !r.ready; i++) {
    const p = s.next(),
      hidden = s.next();
    if (i % 5 !== 1) {
      const decoded = tracker.scan(scene([p, hidden], { crop: true }));
      if (decoded) {
        r.add(decoded);
        decoded.fill(0);
      }
    }
    p.fill(0);
    hidden.fill(0);
  }
  expect(r.ready).toBe(true);
  expect((await r.verify()).bytes).toEqual(bytes);
  s.clear();
}, 30000);

it("returns every fully visible tile, skips an occluded tile, and never mixes sessions in the collector", async () => {
  const a = await createColorSource(
    Uint8Array.from({ length: 22000 }, (_, i) => i * 91),
    meta,
  );
  const b = await createColorSource(new Uint8Array(3000).fill(199), meta);
  const l = colorLayout(64),
    canvas = createCanvas(l.width * 9 + 60, l.height * 9 + 60);
  const c = canvas.getContext("2d"),
    expected = [];
  for (let i = 0; i < 9; i++) {
    const p = i === 8 ? b.data(0) : a.data(i);
    expected.push(p);
    c.save();
    c.translate(
      29 + (i % 3) * l.width * 3,
      31 + Math.floor(i / 3) * l.height * 3,
    );
    drawColorGrid(c as unknown as CanvasRenderingContext2D, p, 3);
    c.restore();
  }
  const tracker = new ColorTracker(),
    pixels = () => c.getImageData(0, 0, canvas.width, canvas.height);
  const all = tracker.scanAll(pixels());
  expect(all).toHaveLength(9);
  for (const p of expected)
    expect(all.some((q) => Buffer.from(q).equals(Buffer.from(p)))).toBe(true);
  // Block one full finder of the middle tile; the others remain usable.
  c.fillStyle = "#aaa";
  c.fillRect(29 + l.width * 3, 31 + l.height * 3, 35, 35);
  const visible = tracker.scanAll(pixels());
  // A previously validated tile may still decode with its cached geometry:
  // retain only an occlusion that actually erases payload as well.
  c.fillRect(29 + l.width * 3, 31 + l.height * 3, l.width * 3, l.height * 3);
  const after = tracker.scanAll(pixels());
  expect(after).toHaveLength(8);
  const collector = new ColorCollector();
  collector.add(a.data(0));
  for (const p of after) collector.add(p);
  expect(collector.total).toBe(a.total);
  expect(collector.count).toBe(7);
  expect(collector.ready).toBe(false);
  [...all, ...visible, ...after, ...expected].forEach((p) => p.fill(0));
  tracker.clear();
  collector.clear();
  a.clear();
  b.clear();
});
it("keeps progress at zero for corrupt headers, saturated frames, noise and invalid capture bounds", async () => {
  const s = await createColorSource(new Uint8Array(12000).fill(173), meta),
    r = new ColorCollector();
  const l = colorLayout(64),
    canvas = createCanvas(l.width * 3 + 50, l.height * 3 + 50),
    c = canvas.getContext("2d");
  c.translate(21, 19);
  drawColorGrid(c as unknown as CanvasRenderingContext2D, s.data(0), 3);
  c.fillStyle = "#777";
  c.fillRect(14 * 3, 17 * 3, 64 * 3, 12 * 3);
  const tracker = new ColorTracker();
  for (const p of tracker.scanAll(
    c.getImageData(0, 0, canvas.width, canvas.height),
  ))
    r.add(p);
  const white = new Uint8ClampedArray(480 * 360 * 4).fill(255);
  const noise = new Uint8ClampedArray(white.length);
  let state = 772;
  for (let i = 0; i < noise.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    noise[i] = state >>> 24;
  }
  for (let i = 0; i < 4; i++) {
    expect(tracker.scanAll({ width: 480, height: 360, data: white })).toEqual(
      [],
    );
    expect(tracker.scanAll({ width: 480, height: 360, data: noise })).toEqual(
      [],
    );
  }
  for (const pixels of [
    { width: 2049, height: 360, data: white },
    { width: 480, height: 360, data: white.subarray(4) },
    { width: NaN, height: 360, data: white },
    { width: 480, height: -1, data: white },
  ])
    expect(tracker.scanAll(pixels)).toEqual([]);
  expect(r.count).toBe(0);
  expect(r.total).toBe(0);
  expect(r.ready).toBe(false);
  s.clear();
});
it("acquires degraded small off-center tiles from a native 2048px field of view", async () => {
  const s = await createColorSource(
    Uint8Array.from({ length: 4000 }, (_, i) => (i * 97) ^ (i >>> 4)),
    meta,
  );
  const p = s.data(0),
    small = scene([p, s.data(1)], { crop: true });
  const native = {
    width: 2048,
    height: 1152,
    data: new Uint8ClampedArray(2048 * 1152 * 4).fill(240),
  };
  for (let y = 0; y < small.height; y++)
    native.data.set(
      small.data.subarray(y * 800 * 4, (y + 1) * 800 * 4),
      ((y + 281) * 2048 + 1161) * 4,
    );
  expect(new ColorTracker().scan(native)).toEqual(p);
  s.clear();
});
