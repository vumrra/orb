import { expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { rasterInfo } from "../src/file-preview";
it("recognizes actual PNG/JPEG/WebP dimensions rather than file extension or MIME", () => {
  const canvas = createCanvas(32, 24);
  canvas.getContext("2d").fillRect(1, 2, 10, 12);
  for (const format of ["png", "jpeg", "webp"] as const) {
    const info = rasterInfo(
      new Uint8Array(
        format === "png"
          ? canvas.toBuffer("image/png")
          : canvas.toBuffer(`image/${format}`),
      ),
    );
    expect(info).toEqual({ width: 32, height: 24, mime: `image/${format}` });
  }
});
it("rejects active content, truncated headers, oversized dimensions and pixel counts before decode", () => {
  for (const text of [
    '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    "<html><script>alert(1)</script>",
    "GIF89a",
    "RIFFxxxxxxxxWEBP",
  ])
    expect(rasterInfo(new TextEncoder().encode(text))).toBeNull();
  const png = new Uint8Array(createCanvas(1, 1).toBuffer("image/png"));
  expect(rasterInfo(png.subarray(0, 20))).toBeNull();
  const v = new DataView(png.buffer);
  v.setUint32(16, 100000);
  expect(rasterInfo(png)).toBeNull();
  v.setUint32(16, 4000);
  v.setUint32(20, 4000);
  expect(rasterInfo(png)).toBeNull();
  v.setUint32(16, 0);
  expect(rasterInfo(png)).toBeNull();
});
