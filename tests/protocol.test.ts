import { describe, it, expect } from "vitest";
import {
  splitFrames,
  createFrames,
  parseFrame,
  Collector,
  crc32,
  FRAME_BYTES,
  CHUNK_BYTES,
  MAX_TEXT_BYTES,
} from "../src/protocol";
import { ENVELOPE_BYTES, MAX_WIRE_BYTES } from "../src/message";
const bytes = (text: string) => new TextEncoder().encode(text);
function reseal(frame: Uint8Array) {
  new DataView(frame.buffer).setUint32(
    FRAME_BYTES - 4,
    crc32(frame.subarray(0, FRAME_BYTES - 4)),
  );
  return frame;
}
describe("plaintext optical v4", () => {
  it("carries UTF8 in incompatible 40-byte frames with fresh 64-bit transfer IDs", () => {
    const [frame] = splitFrames(bytes("hello"));
    expect(frame[1]).toBe(4);
    expect(frame.length).toBe(40);
    expect(parseFrame(frame)?.chunk.subarray(ENVELOPE_BYTES)).toEqual(
      bytes("hello"),
    );
    expect(splitFrames(bytes("hello"))[0].slice(2, 10)).not.toEqual(
      frame.slice(2, 10),
    );
    const old = frame.slice();
    old[1] = 3;
    expect(parseFrame(reseal(old))).toBeNull();
  });
  it("exposes only contiguous UTF8 with split emoji, Korean and a literal BOM", () => {
    const text = "\uFEFF" + "a".repeat(3) + "🌒한글" + "z".repeat(40),
      frames = splitFrames(bytes(text)),
      collector = new Collector();
    collector.add(frames[2]);
    expect(collector.prefix).toBe("");
    collector.add(frames[0]);
    expect(collector.prefix).toBe("\uFEFFaaa");
    collector.add(frames[0]);
    expect(collector.count).toBe(2);
    collector.add(frames[1]);
    expect(collector.prefix).toBe(
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        bytes(text).slice(0, CHUNK_BYTES * 3 - ENVELOPE_BYTES),
      ),
    );
    expect(collector.add(frames[3])).toEqual(bytes(text));
    expect(collector.prefix).toBe(text);
    expect(collector.add(frames[3])).toBeNull();
    collector.clear();
    expect(collector.prefix).toBe("");
    expect(collector.count).toBe(0);
    expect(collector.total).toBe(0);
  });
  it("holds incomplete Korean bytes without replacement characters", () => {
    const frames = splitFrames(bytes("가".repeat(40))),
      collector = new Collector();
    collector.add(frames[0]);
    expect(collector.prefix).toBe("가".repeat(2));
    collector.add(frames[1]);
    expect(collector.prefix).toBe("가".repeat(9));
    for (const frame of frames.slice(2)) collector.add(frame);
    expect(collector.prefix).toBe("가".repeat(40));
  });
  it("rejects empty and oversized payloads and accepts exact UTF8 byte cap lazily", () => {
    expect(MAX_TEXT_BYTES).toBe(1048576);
    expect(() => createFrames(bytes(""))).toThrow();
    expect(() => createFrames(bytes("🌒".repeat(262144) + "a"))).toThrow();
    const source = createFrames(bytes("🌒".repeat(262144)));
    expect(source.length).toBe(52430);
    expect(parseFrame(source.get(source.length - 1))?.chunk.length).toBe(9);
    expect(() => source.get(source.length)).toThrow();
    source.clear();
    expect(() => source.get(0)).toThrow();
  });
  it("rejects malformed, truncated, oversized, padded and corrupted frames before allocation", () => {
    const [frame] = splitFrames(bytes("hi"));
    for (const input of [
      new Uint8Array(),
      frame.slice(1),
      new Uint8Array(1000),
    ])
      expect(parseFrame(input)).toBeNull();
    for (let i = 0; i < frame.length; i++) {
      const broken = frame.slice();
      broken[i] ^= 128;
      expect(parseFrame(broken)).toBeNull();
    }
    for (const [index, value] of [
      [10, 255],
      [11, 255],
      [12, 1],
      [13, 255],
      [15, 0],
      [35, 1],
    ]) {
      const broken = frame.slice();
      broken[index] = value;
      expect(parseFrame(reseal(broken))).toBeNull();
    }
    const oversized = frame.slice(),
      length = MAX_WIRE_BYTES + 1;
    oversized[13] = length >>> 16;
    oversized[14] = length >>> 8;
    oversized[15] = length;
    const receiver = new Collector();
    expect(receiver.add(reseal(oversized))).toBeNull();
    expect(receiver.total).toBe(0);
  });
  it("ignores mixed transfers, conflicting lengths, duplicates and corruption; waits for gaps", () => {
    const a = splitFrames(bytes("A".repeat(180))),
      b = splitFrames(bytes("B".repeat(180))),
      collector = new Collector();
    collector.add(a[0]);
    for (const frame of b) expect(collector.add(frame)).toBeNull();
    const conflict = a[1].slice();
    conflict[15]--;
    expect(collector.add(reseal(conflict))).toBeNull();
    const corrupt = a[1].slice();
    corrupt[20] ^= 1;
    expect(collector.add(corrupt)).toBeNull();
    for (const frame of a.slice(2).reverse())
      expect(collector.add(frame)).toBeNull();
    collector.add(a[0]);
    expect(collector.count).toBe(a.length - 1);
    expect(collector.prefix).toBe("A".repeat(CHUNK_BYTES - ENVELOPE_BYTES));
    expect(collector.add(a[1])).toEqual(bytes("A".repeat(180)));
    expect(collector.prefix).toBe("A".repeat(180));
    collector.clear();
    for (const frame of b) collector.add(frame);
    expect(collector.prefix).toBe("B".repeat(180));
  });
  it("clears provisional text on final CRC failure despite valid frame CRC", () => {
    const frames = splitFrames(bytes("a".repeat(27))),
      collector = new Collector();
    collector.add(frames[0]);
    frames[1][20] ^= 1;
    expect(() => collector.add(reseal(frames[1]))).toThrow(/checksum/i);
    expect(collector.prefix).toBe("");
    expect(collector.count).toBe(0);
  });
  it.each([[0xff], [0xe2, 0x82]])(
    "rejects invalid or truncated UTF8 %j",
    (...tail) => {
      const frames = splitFrames(
          new Uint8Array([
            ...bytes("a".repeat(CHUNK_BYTES - ENVELOPE_BYTES)),
            ...tail,
          ]),
        ),
        collector = new Collector();
      collector.add(frames[0]);
      expect(() => collector.add(frames[1])).toThrow(/UTF-8/);
      expect(collector.prefix).toBe("");
      expect(collector.total).toBe(0);
    },
  );
});
it("rejects 65535/65536 indices since the 1MB cap derives only 52430 frames", () => {
  const source = createFrames(bytes("a".repeat(MAX_TEXT_BYTES)));
  for (const index of [65535, 65536]) {
    const frame = source.get(0);
    frame[10] = index >>> 16;
    frame[11] = index >>> 8;
    frame[12] = index;
    expect(parseFrame(reseal(frame))).toBeNull();
  }
  source.clear();
});
it("clearing the lazy source invalidates its count as well as future frame access", () => {
  const source = createFrames(bytes("pending render"));
  source.clear();
  expect(source.length).toBe(0);
  expect(() => source.get(0)).toThrow();
});
