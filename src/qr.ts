import QRCode from "qrcode";
import jsQR from "jsqr";
import { crc32, parseFrame, type FrameSource } from "./protocol";
import { ENVELOPE_BYTES, MAX_WIRE_BYTES } from "./message";

export const QR_SLOT_MS = 150;
// Byte-mode capacity at ECC M. The packet uses 22 bytes plus 20 per v4 frame.
const densities = [
  [8, 152],
  [14, 362],
  [20, 666],
  [26, 1059],
] as const;
export function qrProfile(frameCount: number, cssSize: number) {
  const allowed = densities.filter(([v]) => (17 + 4 * v + 8) * 3 <= cssSize);
  const selected =
    allowed.find(([, capacity]) => 22 + frameCount * 20 <= capacity) ??
    allowed.at(-1) ??
    densities[0];
  const [version, capacity] = selected,
    modules = 17 + 4 * version;
  return {
    version,
    modules,
    framesPerPacket: Math.floor((capacity - 22) / 20),
    modulePixels: Math.max(1, Math.floor(cssSize / (modules + 8))),
  };
}
const get24 = (b: Uint8Array, at: number) =>
  b[at] * 65536 + b[at + 1] * 256 + b[at + 2];
function set24(b: Uint8Array, at: number, n: number) {
  b[at] = n >>> 16;
  b[at + 1] = n >>> 8;
  b[at + 2] = n;
}
export function createQrPackets(source: FrameSource, cssSize: number) {
  const profile = qrProfile(source.length, cssSize);
  let cleared = false;
  return {
    profile,
    length: Math.ceil(source.length / profile.framesPerPacket),
    get(index: number) {
      if (
        cleared ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= this.length
      )
        throw new Error("QR packet index out of bounds.");
      const start = index * profile.framesPerPacket;
      const count = Math.min(profile.framesPerPacket, source.length - start);
      const packet = new Uint8Array(22 + count * 20);
      try {
        for (let i = 0; i < count; i++) {
          const frame = source.get(start + i);
          try {
            const meta = parseFrame(frame);
            if (
              !meta ||
              meta.index !== start + i ||
              meta.total !== source.length
            )
              throw new Error("Invalid QR source frame.");
            meta.chunk.fill(0);
            if (!i) {
              packet.set(frame.subarray(0, 16));
              packet.set([0x51, 1]);
            } else if (
              frame.subarray(2, 10).some((v, j) => v !== packet[2 + j]) ||
              frame.subarray(13, 16).some((v, j) => v !== packet[13 + j])
            )
              throw new Error("Mixed QR source frames.");
            packet.set(frame.subarray(16, 36), 18 + i * 20);
          } finally {
            frame.fill(0);
          }
        }
        const view = new DataView(packet.buffer);
        view.setUint16(16, count);
        view.setUint32(packet.length - 4, crc32(packet.subarray(0, -4)));
        return packet;
      } catch (error) {
        packet.fill(0);
        throw error;
      }
    },
    clear() {
      cleared = true;
      this.length = 0;
      source.clear();
    },
  };
}
export function unpackQr(packet: Uint8Array): Uint8Array[] | null {
  if (
    packet.length < 42 ||
    packet.length > 1059 ||
    packet[0] !== 0x51 ||
    packet[1] !== 1
  )
    return null;
  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );
  const count = view.getUint16(16),
    start = get24(packet, 10),
    length = get24(packet, 13);
  if (
    !count ||
    packet.length !== 22 + count * 20 ||
    length <= ENVELOPE_BYTES ||
    length > MAX_WIRE_BYTES ||
    start + count > Math.ceil(length / 20) ||
    crc32(packet.subarray(0, -4)) !== view.getUint32(packet.length - 4)
  )
    return null;
  const padding = (start + count) * 20 - length;
  if (
    padding > 0 &&
    packet.subarray(packet.length - 4 - padding, -4).some((v) => v !== 0)
  )
    return null;
  return Array.from({ length: count }, (_, i) => {
    const frame = new Uint8Array(40);
    frame.set(packet.subarray(0, 16));
    frame.set([0x4f, 4]);
    set24(frame, 10, start + i);
    frame.set(packet.subarray(18 + i * 20, 38 + i * 20), 16);
    new DataView(frame.buffer).setUint32(36, crc32(frame.subarray(0, 36)));
    return frame;
  });
}
export function qrMatrix(packet: Uint8Array, version: number) {
  return QRCode.create([{ data: packet, mode: "byte" }], {
    version,
    errorCorrectionLevel: "M",
  }).modules;
}
export type QrMatrix = ReturnType<typeof qrMatrix>;
export function drawQr(
  ctx: CanvasRenderingContext2D,
  matrix: QrMatrix | null,
  size: number,
) {
  ctx.clearRect(0, 0, size, size);
  if (!matrix) {
    // 대기 화면은 기존 배경 위에 작은 은색 선만 표시합니다.
    const unit = size / 34;
    const offset = (size - unit * 10) / 2;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#90969e";
    for (const [x, y] of [
      [0, 0],
      [6, 0],
      [0, 6],
    ])
      ctx.strokeRect(offset + x * unit, offset + y * unit, 4 * unit, 4 * unit);
    return;
  }
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000";
  const unit = Math.floor(size / (matrix.size + 8)),
    offset = Math.floor((size - matrix.size * unit) / 2);
  for (let y = 0; y < matrix.size; y++)
    for (let x = 0; x < matrix.size; x++)
      if (matrix.data[y * matrix.size + x])
        ctx.fillRect(offset + x * unit, offset + y * unit, unit, unit);
}
export function scanQr(pixels: {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}) {
  const decoded = jsQR(pixels.data, pixels.width, pixels.height, {
    inversionAttempts: "dontInvert",
  });
  if (!decoded) return null;
  const packet = Uint8Array.from(decoded.binaryData);
  try {
    return unpackQr(packet);
  } finally {
    packet.fill(0);
    decoded.binaryData.fill(0);
    decoded.data = "";
  }
}
