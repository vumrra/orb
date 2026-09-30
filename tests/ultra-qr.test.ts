import { beforeAll, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import { prepareZXingModule } from "zxing-wasm/reader";
import { createBinarySource } from "../src/binary-transfer";
import { drawUltraBoard, ultraLayout, scanUltra } from "../src/ultra-qr";
const require = createRequire(import.meta.url);
beforeAll(() => {
  prepareZXingModule({
    overrides: {
      wasmBinary: Uint8Array.from(
        readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm")),
      ).buffer,
    },
  });
});
it("uses measured available dimensions and keeps at least three CSS pixels per module", () => {
  expect(ultraLayout(335, 700).cells).toBe(1);
  expect(ultraLayout(600, 600).cells).toBe(4);
  expect(ultraLayout(1000, 900).cells).toBe(9);
  expect(ultraLayout(1000, 400).cells).toBe(1);
  for (const size of [240, 335, 480, 600, 720, 1000]) {
    const p = ultraLayout(size, size);
    expect(p.tile / 77).toBeGreaterThanOrEqual(3);
    expect(p.size).toBeLessThanOrEqual(size);
  }
});
for (const cells of [1, 4, 9] as const)
  for (const scale of [1, 0.85])
    it(`reads every actual tile in one ${cells}-QR shifted/scaled camera scene (${scale})`, async () => {
      const source = await createBinarySource(
        Uint8Array.from({ length: 10000 }, (_, i) => i * 71),
        { name: "binary", mime: "", kind: "file" },
      );
      // Make all packets different, including the one-cell case.
      const packets = cells === 1 ? [source.data(2)] : source.next(cells);
      const tile = 308,
        size = tile * Math.sqrt(cells),
        board = createCanvas(size, size);
      drawUltraBoard(
        board.getContext("2d") as unknown as CanvasRenderingContext2D,
        packets,
        cells,
        size,
      );
      const scene = createCanvas(1300, 1100),
        ctx = scene.getContext("2d");
      ctx.fillStyle = "#212427";
      ctx.fillRect(0, 0, 1300, 1100);
      ctx.drawImage(board, 127, 79, size * scale, size * scale);
      const start = performance.now();
      const results = await scanUltra(
        ctx.getImageData(0, 0, 1300, 1100) as unknown as ImageData,
      );
      console.log(
        JSON.stringify({ cells, scale, decodeMs: performance.now() - start }),
      );
      expect(results.length).toBe(cells);
      for (const packet of packets)
        expect(
          results.some((result) =>
            Buffer.from(result).equals(Buffer.from(packet)),
          ),
        ).toBe(true);
      source.clear();
    });
it("rejects noise and bounds decoder resolution", async () => {
  const canvas = createCanvas(320, 240);
  expect(
    await scanUltra(
      canvas
        .getContext("2d")
        .getImageData(0, 0, 320, 240) as unknown as ImageData,
    ),
  ).toEqual([]);
  await expect(
    scanUltra({
      width: 2049,
      height: 1,
      data: new Uint8ClampedArray(8196),
    } as ImageData),
  ).rejects.toThrow(/2048/);
});
