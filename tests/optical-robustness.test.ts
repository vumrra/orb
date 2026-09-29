import { createCanvas } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import { drawOptical, decodePixels } from "../src/optical";
import { splitFrames } from "../src/protocol";

// Fixed camera model: defocus, convolution bloom, veiling glare, AWB and gamma.
// No seed from crypto affects the degradation or target geometry.
export function degraded(frame: Uint8Array, occlude = false) {
  const src = createCanvas(640, 520),
    ctx = src.getContext("2d");
  ctx.fillStyle = "#090909";
  ctx.fillRect(0, 0, 640, 520);
  drawOptical(
    ctx as unknown as CanvasRenderingContext2D,
    frame,
    365,
    255,
    210,
    0.23,
    0.75,
  );
  const out = createCanvas(640, 520),
    o = out.getContext("2d");
  o.filter = "blur(2px)";
  o.drawImage(src, 0, 0);
  const glow = createCanvas(640, 520),
    g = glow.getContext("2d");
  g.filter = "blur(9px)";
  g.drawImage(src, 0, 0);
  const pixels = o.getImageData(0, 0, 640, 520),
    bloom = g.getImageData(0, 0, 640, 520);
  for (let y = 0; y < 520; y++)
    for (let x = 0; x < 640; x++) {
      const i = (y * 640 + x) * 4;
      const glare =
        13 + 55 * Math.exp(-((x - 420) ** 2 + (y - 170) ** 2) / 1800);
      for (let c = 0; c < 3; c++)
        pixels.data[i + c] =
          255 *
          Math.min(
            1,
            ((pixels.data[i + c] + bloom.data[i + c] * 0.35) *
              [1.12, 1.05, 0.91][c] +
              glare) /
              255,
          ) **
            0.88;
      if (occlude && x > 345 && x < 373 && y > 220 && y < 248)
        pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 20;
    }
  return pixels;
}
it.each([false, true])(
  "decodes defocus+bloom+glare+AWB, occlusion=%s",
  (occlude) => {
    const frame = splitFrames(
      new TextEncoder().encode("Deterministic physical model"),
    )[0];
    // Fix the sender id and refresh CRC for repeatable pixel values.
    frame.set([1, 2, 3, 4, 5, 6, 7, 8], 2);
    return import("../src/protocol").then(({ crc32 }) => {
      new DataView(frame.buffer).setUint32(36, crc32(frame.subarray(0, 36)));
      expect(decodePixels(degraded(frame, occlude))).toEqual(frame);
    });
  },
);
it("recovers a cropped data rim with glare while registration remains visible", () => {
  const frame = splitFrames(new TextEncoder().encode("cropped data rim"))[0];
  const pixels = degraded(frame);
  for (let y = 0; y < pixels.height; y++)
    for (let x = 550; x < pixels.width; x++) {
      const i = (y * pixels.width + x) * 4;
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 20;
    }
  expect(decodePixels(pixels)).toEqual(frame);
});
