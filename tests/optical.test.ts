import { createCanvas } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import { drawOptical, decodePixels } from "../src/optical";
import { splitFrames, Collector } from "../src/protocol";

it.each([
  [240, 230, 145, 0, 0],
  [211, 192, 112, 0.39, 0],
  [265, 243, 175, 2.2, 0.65],
  [218, 260, 125, 4.87, 0.5],
])(
  "decodes real image pixels at center %s,%s scale %s rotation %s blur %s",
  async (x, y, radius, rotation, blur) => {
    const secret = "다시 만나요 🌒 — secret / 秘密";
    const frames = splitFrames(new TextEncoder().encode(secret));
    const collector = new Collector();
    let complete: Uint8Array | null = null;
    for (const frame of frames.reverse()) {
      const source = createCanvas(480, 480);
      const ctx = source.getContext("2d");
      ctx.fillStyle = "#090a0b";
      ctx.fillRect(0, 0, 480, 480);
      drawOptical(
        ctx as unknown as CanvasRenderingContext2D,
        frame,
        x,
        y,
        radius,
        rotation,
      );
      const canvas = createCanvas(480, 480);
      const out = canvas.getContext("2d");
      out.filter = `blur(${blur}px)`;
      out.drawImage(source, 0, 0);
      const decoded = decodePixels(out.getImageData(0, 0, 480, 480));
      expect(decoded).not.toBeNull();
      expect(decoded).toEqual(frame);
      complete = collector.add(decoded!);
    }
    expect(new TextDecoder().decode(complete!)).toBe(secret);
  },
);
it("rejects blank and noisy image captures", () => {
  const canvas = createCanvas(320, 320);
  const ctx = canvas.getContext("2d");
  expect(decodePixels(ctx.getImageData(0, 0, 320, 320))).toBeNull();
  const pixels = ctx.getImageData(0, 0, 320, 320);
  for (let i = 0; i < pixels.data.length; i++)
    pixels.data[i] = (i * 73 + 19) % 256;
  expect(decodePixels(pixels)).toBeNull();
});
