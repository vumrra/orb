// Read dimensions before asking an image decoder to allocate a bitmap. Only
// three inert raster formats are previewed; all other bytes stay download-only.
export function rasterInfo(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number, n: number) =>
    String.fromCharCode(...bytes.subarray(at, at + n));
  let width = 0,
    height = 0,
    mime = "";
  if (
    bytes.length >= 33 &&
    bytes[0] === 137 &&
    tag(1, 7) === "PNG\r\n\x1a\n" &&
    tag(12, 4) === "IHDR" &&
    v.getUint32(8) === 13
  ) {
    width = v.getUint32(16);
    height = v.getUint32(20);
    mime = "image/png";
  } else if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216) {
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at++] !== 255) return null;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 0xda || marker === 0xd9 || at + 2 > bytes.length) break;
      const length = v.getUint16(at);
      if (length < 2 || at + length > bytes.length) return null;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        height = v.getUint16(at + 3);
        width = v.getUint16(at + 5);
        mime = "image/jpeg";
        break;
      }
      at += length;
    }
  } else if (
    bytes.length >= 30 &&
    tag(0, 4) === "RIFF" &&
    tag(8, 4) === "WEBP"
  ) {
    const type = tag(12, 4);
    if (type === "VP8X") {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (
      type === "VP8 " &&
      bytes[23] === 0x9d &&
      bytes[24] === 1 &&
      bytes[25] === 0x2a
    ) {
      width = v.getUint16(26, true) & 0x3fff;
      height = v.getUint16(28, true) & 0x3fff;
    } else if (type === "VP8L" && bytes[20] === 0x2f) {
      const bits = v.getUint32(21, true);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
    mime = "image/webp";
  }
  return width > 0 &&
    height > 0 &&
    width <= 4096 &&
    height <= 4096 &&
    width * height <= 8_000_000
    ? { width, height, mime }
    : null;
}
