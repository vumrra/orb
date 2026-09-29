import { createCanvas } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import { drawOptical, OpticalTracker, scanPixels } from "../src/optical";
import { splitFrames } from "../src/protocol";
it("tracks verified geometry, re-acquires moved/rotated/blurred small targets and clears after misses", () => {
  const [frame] = splitFrames(new TextEncoder().encode("tracked geometry"));
  const tracker = new OpticalTracker(),
    times: number[] = [],
    baseline: number[] = [];
  for (const [x, y, r, angle, blur] of [
    [700, 300, 115, 0.2, 0.3],
    [700, 300, 115, 0.2, 0.3],
    [230, 420, 140, 1.2, 0.5],
    [230, 420, 140, 1.2, 0.5],
  ]) {
    const c = createCanvas(1024, 700),
      ctx = c.getContext("2d");
    ctx.fillStyle = "#090909";
    ctx.fillRect(0, 0, 1024, 700);
    drawOptical(
      ctx as unknown as CanvasRenderingContext2D,
      frame,
      x,
      y,
      r,
      angle,
      0.75,
    );
    const out = createCanvas(1024, 700),
      o = out.getContext("2d");
    o.filter = `blur(${blur}px)`;
    o.drawImage(c, 0, 0);
    const pixels = o.getImageData(0, 0, 1024, 700);
    let start = performance.now();
    expect(scanPixels(pixels).frame).toEqual(frame);
    baseline.push(performance.now() - start);
    start = performance.now();
    expect(tracker.scan(pixels).frame).toEqual(frame);
    times.push(performance.now() - start);
  }
  const c = createCanvas(1024, 700),
    pixels = c.getContext("2d").getImageData(0, 0, 1024, 700);
  for (let i = 0; i < 4; i++) expect(tracker.scan(pixels).frame).toBeNull();
  tracker.clear();
  console.log(
    JSON.stringify({ acquisitionBaselineMs: baseline, trackedMs: times }),
  );
});
it("a tracked carrier with corrupt CRC remains only a candidate and contributes no data", () => {
  const [frame] = splitFrames(new TextEncoder().encode("verified only"));
  const tracker = new OpticalTracker(),
    c = createCanvas(480, 480),
    ctx = c.getContext("2d");
  const scan = (bytes: Uint8Array) => {
    ctx.fillStyle = "#090909";
    ctx.fillRect(0, 0, 480, 480);
    drawOptical(
      ctx as unknown as CanvasRenderingContext2D,
      bytes,
      240,
      240,
      170,
      0,
      0.75,
    );
    return tracker.scan(ctx.getImageData(0, 0, 480, 480));
  };
  expect(scan(frame).frame).toEqual(frame);
  const corrupt = frame.slice();
  corrupt[20] ^= 1;
  const result = scan(corrupt);
  expect(result.frame).toBeNull();
  expect(result.candidate).toBe(true);
});
