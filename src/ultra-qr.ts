import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { drawQr, qrMatrix } from "./qr";
export const ULTRA_SLOT_MS = 100;
export const ULTRA_VERSION = 13;
const MODULES_WITH_MARGIN = 77;
let preload: Promise<unknown> | undefined;
export function preloadUltraReader() {
  // Node raster tests explicitly supply wasmBinary; browser always uses a local asset.
  if (typeof window === "undefined") return Promise.resolve();
  return (preload ??= prepareZXingModule({
    overrides: { locateFile: () => wasmUrl },
    fireImmediately: true,
  }).catch((error) => {
    preload = undefined;
    throw error;
  }));
}
export function ultraLayout(width: number, height: number) {
  const available = Math.max(0, Math.min(width, height));
  const side =
    available >= MODULES_WITH_MARGIN * 9
      ? 3
      : available >= MODULES_WITH_MARGIN * 6
        ? 2
        : 1;
  const tile =
    Math.floor(Math.min(available / side, 308) / MODULES_WITH_MARGIN) *
    MODULES_WITH_MARGIN;
  return { cells: (side * side) as 1 | 4 | 9, tile, size: tile * side };
}
export function drawUltraBoard(
  ctx: CanvasRenderingContext2D,
  packets: Uint8Array[],
  cells: 1 | 4 | 9,
  size: number,
) {
  if (packets.length > cells) throw new Error("Too many QR tiles.");
  const side = Math.sqrt(cells),
    tile = Math.floor(size / side);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < packets.length; i++) {
    const matrix = qrMatrix(packets[i], ULTRA_VERSION);
    try {
      ctx.save();
      ctx.translate((i % side) * tile, Math.floor(i / side) * tile);
      drawQr(ctx, matrix, tile);
      ctx.restore();
    } finally {
      matrix.data.fill(0);
    }
  }
}
export async function scanUltra(pixels: ImageData): Promise<Uint8Array[]> {
  if (
    pixels.width > 2048 ||
    pixels.height > 2048 ||
    pixels.width < 1 ||
    pixels.height < 1 ||
    pixels.data.length !== pixels.width * pixels.height * 4
  )
    throw new Error("Ultrafast capture must fit 2048 pixels.");
  await preloadUltraReader();
  const results = await readBarcodes(pixels, {
    formats: ["QRCode"],
    maxNumberOfSymbols: 9,
    tryHarder: true,
  });
  const packets = results.map((result) => result.bytes.slice());
  for (const result of results) {
    result.bytes.fill(0);
    result.bytesECI.fill(0);
    result.text = "";
  }
  return packets;
}
