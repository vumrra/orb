import { crc32, parseFrame } from "./protocol";
import { rsEncode, rsDecode } from "./sound-fec";
export const SOUND_BURST_FRAMES = 22;
// Original 16-byte v4 header, count, consecutive padded chunks, CRC32.
// One/two shortened RS words with 16 parity bytes each (8 errors or 16 erasures).
// Interleaving distributes adjacent symbols across both words in large bursts.
export function burstSize(count: number) {
  return 21 + count * 20 + (count <= 10 ? 16 : 32);
}
export function packSoundBurst(frames: Uint8Array[]) {
  if (!frames.length || frames.length > SOUND_BURST_FRAMES)
    throw new Error("Invalid sound burst size");
  const data = new Uint8Array(21 + frames.length * 20);
  let first: ReturnType<typeof parseFrame> = null;
  try {
    frames.forEach((frame, i) => {
      const parsed = parseFrame(frame);
      if (!parsed) throw new Error("Invalid sound frame");
      parsed.chunk.fill(0);
      if (!i) {
        first = parsed;
        data.set(frame.subarray(0, 16));
      }
      if (
        parsed.id !== first!.id ||
        parsed.length !== first!.length ||
        parsed.index !== first!.index + i
      )
        throw new Error("Nonconsecutive sound frames");
      data.set(frame.subarray(16, 36), 17 + i * 20);
    });
    data[16] = frames.length;
    new DataView(data.buffer).setUint32(
      data.length - 4,
      crc32(data.subarray(0, -4)),
    );
    const width = frames.length <= 10 ? 1 : 2;
    const codes = Array.from({ length: width }, (_, lane) => {
      const part = data.filter((_, i) => i % width === lane);
      try {
        return rsEncode(part);
      } finally {
        part.fill(0);
      }
    });
    const out = new Uint8Array(burstSize(frames.length));
    for (let i = 0; i < out.length; i++)
      out[i] = codes[i % width][Math.floor(i / width)];
    codes.forEach((c) => c.fill(0));
    return out;
  } finally {
    data.fill(0);
  }
}
export function unpackSoundBurst(
  code: Uint8Array,
  count: number,
  erasures: number[] = [],
): Uint8Array[] {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > SOUND_BURST_FRAMES ||
    code.length !== burstSize(count)
  )
    return [];
  const width = count <= 10 ? 1 : 2;
  const lanes = Array.from({ length: width }, (_, lane) => {
    const part = code.filter((_, i) => i % width === lane);
    try {
      return rsDecode(
        part,
        erasures
          .filter((i) => i % width === lane)
          .map((i) => Math.floor(i / width)),
      );
    } finally {
      part.fill(0);
    }
  });
  const data = new Uint8Array(code.length - width * 16),
    frames: Uint8Array[] = [];
  try {
    if (lanes.some((x) => !x)) return [];
    for (let i = 0; i < data.length; i++)
      data[i] = lanes[i % width]![Math.floor(i / width)];
    if (
      data[16] !== count ||
      crc32(data.subarray(0, -4)) !==
        new DataView(data.buffer).getUint32(data.length - 4)
    )
      return [];
    const start = data[10] * 65536 + data[11] * 256 + data[12];
    for (let i = 0; i < count; i++) {
      const f = new Uint8Array(40);
      f.set(data.subarray(0, 16));
      const index = start + i;
      f[10] = index >>> 16;
      f[11] = index >>> 8;
      f[12] = index;
      f.set(data.subarray(17 + i * 20, 37 + i * 20), 16);
      new DataView(f.buffer).setUint32(36, crc32(f.subarray(0, 36)));
      const parsed = parseFrame(f);
      if (!parsed) {
        f.fill(0);
        frames.forEach((x) => x.fill(0));
        return [];
      }
      parsed.chunk.fill(0);
      frames.push(f);
    }
    return frames;
  } finally {
    data.fill(0);
    lanes.forEach((x) => x?.fill(0));
  }
}
