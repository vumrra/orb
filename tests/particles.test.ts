import { createCanvas } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import { drawOptical, decodePixels, scanPixels } from "../src/optical";
import { splitFrames } from "../src/protocol";

// Real raster, then camera-like geometric/photometric transforms (not sampled ideal bits).
export function capture(
  frame: Uint8Array | null,
  {
    radius = 110,
    x = 145,
    y = 180,
    rotation = 0.43,
    time = 0.37,
    brightness = 1,
    blur = 0,
    noise = 0,
    tilt = 1,
    perspective = 0,
  } = {},
) {
  const source = createCanvas(400, 400),
    ctx = source.getContext("2d");
  ctx.fillStyle = "#090a0b";
  ctx.fillRect(0, 0, 400, 400);
  drawOptical(
    ctx as unknown as CanvasRenderingContext2D,
    frame,
    200,
    200,
    170,
    rotation,
    time,
  );
  const canvas = createCanvas(640, 360),
    out = canvas.getContext("2d");
  out.fillStyle = "#090a0b";
  out.fillRect(0, 0, 640, 360);
  const src = ctx.getImageData(0, 0, 400, 400),
    warped = out.getImageData(0, 0, 640, 360);
  for (let py = 0; py < 360; py++)
    for (let px = 0; px < 640; px++) {
      const v = (py - y) / radius,
        u = (px - x) / radius;
      const sy = v / (tilt - perspective * v),
        sx = u * (1 + perspective * sy);
      const ix = Math.round(200 + sx * 170),
        iy = Math.round(200 + sy * 170);
      if (ix < 0 || iy < 0 || ix >= 400 || iy >= 400) continue;
      const p = (py * 640 + px) * 4,
        q = (iy * 400 + ix) * 4;
      for (let c = 0; c < 3; c++) warped.data[p + c] = src.data[q + c];
    }
  out.putImageData(warped, 0, 0);
  if (blur) {
    out.filter = `blur(${blur}px)`;
    out.drawImage(canvas, 0, 0);
  }
  const pixels = out.getImageData(0, 0, 640, 360);
  let seed = 42;
  for (let p = 0; p < pixels.data.length; p += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const n = (seed / 0xffffffff - 0.5) * noise;
    for (let c = 0; c < 3; c++)
      pixels.data[p + c] = pixels.data[p + c] * brightness + n;
  }
  return pixels;
}
it.each([
  ["off center", { x: 490, radius: 110 }],
  ["small", { radius: 78 }],
  ["rotation", { rotation: 2.19 }],
  ["dim", { brightness: 0.55 }],
  ["blur and noise", { blur: 0.6, noise: 10 }],
  ["modest perspective", { tilt: 0.85, perspective: 0.08, rotation: 0.23 }],
])("decodes transformed real raster: %s", (_, options) => {
  const [frame] = splitFrames(new TextEncoder().encode("tiny waves 🌒"));
  expect(decodePixels(capture(frame, options))).toEqual(frame);
});

it("reports only a candidate for an optically intact but invalid frame", () => {
  const [frame] = splitFrames(new TextEncoder().encode("unverified"));
  frame[20] ^= 1;
  const reaction: string[] = [];
  const result = scanPixels(capture(frame), () => reaction.push("candidate"));
  expect(reaction).toEqual(["candidate"]);
  expect(result).toEqual({ candidate: true, frame: null });
});
it("keeps the observed 144px limit honest: acquisition is possible, decoded bytes require CRC", () => {
  const [frame] = splitFrames(new TextEncoder().encode("small limit"));
  const result = scanPixels(capture(frame, { radius: 72 }));
  expect(result.candidate).toBe(true);
  if (result.frame) expect(result.frame).toEqual(frame);
});
it.each(["blank", "text", "noise", "colored patches"])(
  "never invents content from %s backgrounds",
  (kind) => {
    const c = createCanvas(640, 360),
      ctx = c.getContext("2d");
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, 640, 360);
    if (kind === "text") {
      ctx.fillStyle = "#eee";
      ctx.font = "30px sans-serif";
      ctx.fillText("Nothing is being transmitted", 25, 180);
    }
    if (kind === "colored patches")
      for (const [x, y] of [
        [120, 80],
        [300, 80],
        [120, 260],
        [300, 260],
      ]) {
        ctx.fillStyle = "#6c9";
        ctx.fillRect(x, y, 20, 20);
      }
    const pixels = ctx.getImageData(0, 0, 640, 360);
    if (kind === "noise") {
      let seed = 3;
      for (let i = 0; i < pixels.data.length; i += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pixels.data[i] = seed & 255;
        pixels.data[i + 1] = (seed >>> 8) & 255;
        pixels.data[i + 2] = (seed >>> 16) & 255;
      }
    }
    expect(scanPixels(pixels).frame).toBeNull();
  },
);

it("recovers changing payloads across independent fast cloud phases", () => {
  const frames = splitFrames(
    new TextEncoder().encode("Wave currents 🌒 한글 ".repeat(3)),
  );
  for (const time of [0, 0.17, 0.37, 0.75, 1.2, 2.1])
    for (const frame of frames) {
      expect(
        decodePixels(
          capture(frame, { time, rotation: 1.1, blur: 0.35, noise: 6 }),
        ),
        `phase ${time}`,
      ).toEqual(frame);
    }
});
