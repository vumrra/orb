import { createCanvas } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import { drawOptical, decodePixels } from "../src/optical";
import { splitFrames } from "../src/protocol";

it("carries the same data in a continuously moving chroma wave, not static dots", async () => {
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
