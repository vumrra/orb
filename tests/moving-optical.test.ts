import { createCanvas } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import { drawOptical, decodePixels } from "../src/optical";
import { splitFrames } from "../src/protocol";

it("carries the same data in fast moving individual silver particles", async () => {
  const [frame] = splitFrames(new TextEncoder().encode("moving light"));
  const images = [0, 0.37, 1.25].map((time) => {
    const canvas = createCanvas(480, 480);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#090a0b";
    ctx.fillRect(0, 0, 480, 480);
    drawOptical(
      ctx as unknown as CanvasRenderingContext2D,
      frame,
      240,
      240,
      170,
      0.27,
      time,
    );
    return ctx.getImageData(0, 0, 480, 480);
  });
  for (const image of images) expect(decodePixels(image)).toEqual(frame);
  let changed = 0;
  for (let i = 0; i < images[0].data.length; i += 4) {
    if (Math.abs(images[0].data[i] - images[1].data[i]) > 10) changed++;
  }
  expect(changed).toBeGreaterThan(480 * 480 * 0.03);
});

it("payload changes only particle chroma, never cloud brightness or point positions", () => {
  const images = ["a", "z"].map((text) => {
    const [frame] = splitFrames(new TextEncoder().encode(text));
    const c = createCanvas(400, 400),
      ctx = c.getContext("2d");
    drawOptical(
      ctx as unknown as CanvasRenderingContext2D,
      frame,
      200,
      200,
      170,
      0,
      0.75,
    );
    return ctx.getImageData(0, 0, 400, 400).data;
  });
  let luminanceDifference = 0,
    chromaDifference = 0;
  for (let i = 0; i < images[0].length; i += 4) {
    const a = images[0],
      b = images[1];
    luminanceDifference += Math.abs(
      (a[i] + 2 * a[i + 1] + a[i + 2] - b[i] - 2 * b[i + 1] - b[i + 2]) / 4,
    );
    chromaDifference += Math.abs(a[i] - b[i]);
    expect(a[i + 3]).toBe(b[i + 3]);
  }
  expect(luminanceDifference / (400 * 400)).toBeLessThan(0.5);
  expect(chromaDifference).toBeGreaterThan(1000);
});
