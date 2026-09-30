import { expect, it } from "vitest";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { randomFillSync } from "node:crypto";
import {
  createColorSource,
  colorCapacity,
  colorLayout,
  drawColorGrid,
  ColorCollector,
} from "../src/color-grid";
import { ColorTracker } from "../src/color-scan";
const meta = {
  name: "raster.bin",
  mime: "application/octet-stream",
  kind: "file" as const,
};
for (const grid of [64, 128, 256] as const)
  for (const angle of [-2, 2, 19]) {
    it(`acquires ${grid} from real off-center ${angle} degree pixels`, async () => {
      const s = await createColorSource(
          randomFillSync(new Uint8Array(colorCapacity(grid) + 123)),
          meta,
          undefined,
          grid,
        ),
        packet = s.next();
      const l = colorLayout(grid),
        cell = 3,
        canvas = createCanvas(1600, 1400),
        ctx = canvas.getContext("2d");
      ctx.fillStyle = "#161616";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(860, 660);
      ctx.rotate((angle * Math.PI) / 180);
      ctx.translate((-l.width * cell) / 2, (-l.height * cell) / 2);
      drawColorGrid(ctx as unknown as CanvasRenderingContext2D, packet, cell);
      ctx.restore();
      const tracker = new ColorTracker();
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(
        Buffer.from(tracker.scan(pixels) ?? []).equals(Buffer.from(packet)),
      ).toBe(true);
      expect(
        Buffer.from(tracker.scan(pixels) ?? []).equals(Buffer.from(packet)),
      ).toBe(true); // cached geometry
      tracker.clear();
      s.clear();
    });
  }
it("decodes a blurred, rotated board with calibrated channel brightness", async () => {
  const s = await createColorSource(
      randomFillSync(new Uint8Array(9000)),
      meta,
      undefined,
      128,
    ),
    packet = s.next(),
    l = colorLayout(128);
  const board = createCanvas(l.width * 4, l.height * 4),
    b = board.getContext("2d");
  drawColorGrid(b as unknown as CanvasRenderingContext2D, packet, 4);
  const screen = createCanvas(1100, 1000),
    ctx = screen.getContext("2d");
  ctx.fillStyle = "#171717";
  ctx.fillRect(0, 0, 1100, 1000);
  ctx.translate(230, 110);
  ctx.rotate((-2 * Math.PI) / 180);
  ctx.filter = "blur(0.6px)";
  ctx.drawImage(board, 0, 0);
  const pixels = ctx.getImageData(0, 0, 1100, 1000);
  for (let i = 0; i < pixels.data.length; i += 4) {
    pixels.data[i] *= 0.86;
    pixels.data[i + 1] *= 0.91;
    pixels.data[i + 2] *= 0.88;
  }
  expect(new ColorTracker().scan(pixels)).toEqual(packet);
  s.clear();
});
// Independent inverse projective rasterizer; scanner receives only resulting RGBA pixels.
function projectRaster(board: Canvas, width: number, height: number) {
  const input = board
    .getContext("2d")
    .getImageData(0, 0, board.width, board.height);
  const canvas = createCanvas(width, height),
    ctx = canvas.getContext("2d"),
    out = ctx.createImageData(width, height);
  // forward x=(1.02*u + .04*v + 140)/(1 + .000065*u + .00003*v), y=(-.025*u + .98*v + 120)/denom
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const a = 1.02 - x * 0.000065,
        b = 0.04 - x * 0.00003,
        c = -0.025 - y * 0.000065,
        d = 0.98 - y * 0.00003;
      const det = a * d - b * c,
        u = ((x - 140) * d - b * (y - 120)) / det,
        v = (a * (y - 120) - c * (x - 140)) / det;
      const i = (y * width + x) * 4;
      if (u >= 0 && v >= 0 && u < board.width && v < board.height) {
        const j = (Math.floor(v) * board.width + Math.floor(u)) * 4;
        out.data.set(input.data.subarray(j, j + 4), i);
      } else out.data.set([16, 16, 16, 255], i);
    }
  ctx.putImageData(out, 0, 0);
  return ctx.getImageData(0, 0, width, height);
}
for (const grid of [64, 128, 256] as const)
  it(`acquires actual ${grid} projective pixels, no supplied corners`, async () => {
    const s = await createColorSource(
        randomFillSync(new Uint8Array(colorCapacity(grid) + 123)),
        meta,
        undefined,
        grid,
      ),
      packet = s.next(),
      l = colorLayout(grid);
    const board = createCanvas(l.width * 4, l.height * 4);
    drawColorGrid(
      board.getContext("2d") as unknown as CanvasRenderingContext2D,
      packet,
      4,
    );
    expect(
      Buffer.from(
        new ColorTracker().scan(projectRaster(board, 1500, 1450)) ?? [],
      ).equals(Buffer.from(packet)),
    ).toBe(true);
    s.clear();
  });
it("reacquires a moving board after CRC misses, changes grid only through a valid header, rejects noise", async () => {
  const tracker = new ColorTracker(),
    screen = createCanvas(1200, 1200),
    ctx = screen.getContext("2d");
  for (const [grid, x, y] of [
    [64, 40, 40],
    [256, 200, 120],
    [128, 430, 100],
  ] as const) {
    const s = await createColorSource(
        new Uint8Array([2, 7, 255]),
        meta,
        undefined,
        grid,
      ),
      packet = s.next();
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, 1200, 1200);
    ctx.save();
    ctx.translate(x, y);
    drawColorGrid(ctx as unknown as CanvasRenderingContext2D, packet, 3);
    ctx.restore();
    let got: Uint8Array | null = null;
    for (let i = 0; i < 4 && !got; i++)
      got = tracker.scan(ctx.getImageData(0, 0, 1200, 1200));
    expect(got).toEqual(packet);
    s.clear();
  }
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1200, 1200);
  for (let i = 0; i < 5; i++)
    expect(tracker.scan(ctx.getImageData(0, 0, 1200, 1200))).toBeNull();
});
it("transfers an entire binary through rotated rasters and final SHA", async () => {
  const bytes = randomFillSync(new Uint8Array(20000)),
    s = await createColorSource(bytes, meta, undefined, 64),
    r = new ColorCollector(),
    tracker = new ColorTracker();
  const screen = createCanvas(620, 550),
    ctx = screen.getContext("2d");
  for (let i = 0; i < s.total * 3 && !r.ready; i++) {
    const packet = s.next();
    ctx.fillStyle = "#171717";
    ctx.fillRect(0, 0, 620, 550);
    ctx.save();
    ctx.translate(200, 100);
    ctx.rotate(0.035);
    drawColorGrid(ctx as unknown as CanvasRenderingContext2D, packet, 3);
    ctx.restore();
    const decoded = tracker.scan(ctx.getImageData(0, 0, 620, 550));
    if (decoded) {
      r.add(decoded);
      decoded.fill(0);
    }
    packet.fill(0);
  }
  expect((await r.verify()).bytes).toEqual(bytes);
  s.clear();
});
for (const angle of [44, 91, 173, 271])
  it(`locates a tile rotated ${angle} degrees without an alignment guide`, async () => {
    const s = await createColorSource(
      randomFillSync(new Uint8Array(3500)),
      meta,
    );
    const packet = s.data(0),
      l = colorLayout(s.grid);
    const canvas = createCanvas(800, 800),
      ctx = canvas.getContext("2d");
    ctx.fillStyle = "#bbb";
    ctx.fillRect(0, 0, 800, 800);
    ctx.translate(425.35, 390.65);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.translate(-l.width * 1.5, -l.height * 1.5);
    drawColorGrid(ctx as unknown as CanvasRenderingContext2D, packet, 3);
    expect(new ColorTracker().scan(ctx.getImageData(0, 0, 800, 800))).toEqual(
      packet,
    );
    s.clear();
  });
