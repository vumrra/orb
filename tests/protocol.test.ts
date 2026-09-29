import { describe, it, expect } from "vitest";
import {
  splitFrames,
  parseFrame,
  Collector,
  crc32,
  FRAME_BYTES,
  CHUNK_BYTES,
} from "../src/protocol";

const bytes = (text: string) => new TextEncoder().encode(text);
function reseal(frame: Uint8Array) {
  new DataView(frame.buffer).setUint32(
    FRAME_BYTES - 4,
    crc32(frame.subarray(0, FRAME_BYTES - 4)),
  );
  return frame;
}
describe("plaintext particle optical v3", () => {
  it("carries plain UTF-8 in an incompatible version with fresh transfer IDs", () => {
    const [frame] = splitFrames(bytes("hello"));
    expect(frame[2]).toBe(3);
    expect(parseFrame(frame)?.chunk).toEqual(bytes("hello"));
    expect(splitFrames(bytes("hello"))[0].slice(6, 14)).not.toEqual(
      frame.slice(6, 14),
    );
    const old = frame.slice();
    old[2] = 1;
    expect(parseFrame(reseal(old))).toBeNull();
  });
  it("exposes only contiguous UTF-8 with split emoji, Korean and a literal BOM", () => {
    const text = "\uFEFF" + "a".repeat(12) + "🌒한글" + "z".repeat(30);
    const frames = splitFrames(bytes(text));
    const collector = new Collector();
    expect(collector.add(frames[2])).toBeNull();
    expect(collector.prefix).toBe("");
    collector.add(frames[0]);
    expect(collector.prefix).toBe("\uFEFF" + "a".repeat(12));
    collector.add(frames[0]);
    expect(collector.count).toBe(2);
    collector.add(frames[1]);
    expect(collector.prefix).toBe(
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        bytes(text).slice(0, 48),
      ),
    );
    const packet = collector.add(frames[3]);
    expect(packet).toEqual(bytes(text));
    expect(collector.prefix).toBe(text);
    expect(collector.add(frames[3])).toBeNull();
    expect(collector.prefix).toBe(text);
    collector.clear();
    expect(collector.prefix).toBe("");
    expect(collector.count).toBe(0);
    expect(collector.total).toBe(0);
  });
  it("holds incomplete Korean bytes without replacement characters", () => {
    const frames = splitFrames(bytes("가".repeat(40)));
    const collector = new Collector();
    collector.add(frames[0]);
    expect(collector.prefix).toBe("가".repeat(5));
    collector.add(frames[1]);
    expect(collector.prefix).toBe("가".repeat(10));
    for (const frame of frames.slice(2)) collector.add(frame);
    expect(collector.prefix).toBe("가".repeat(40));
  });
  it("rejects empty/oversized payloads and accepts the byte cap", () => {
    expect(() => splitFrames(bytes(""))).toThrow();
    expect(() => splitFrames(bytes("가".repeat(129)))).toThrow();
    expect(splitFrames(bytes("가".repeat(128)))).toHaveLength(24);
  });
  it("rejects malformed, truncated, oversized, padded and corrupted frames", () => {
    const [frame] = splitFrames(bytes("hello"));
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
      [3, 1],
      [4, 2],
      [5, 0],
      [25, 1],
      [14, 255],
    ]) {
      const broken = frame.slice();
      broken[index] = value;
      expect(parseFrame(reseal(broken))).toBeNull();
    }
  });
  it("ignores mixed transfers, conflicting metadata, duplicates and corrupt frames; waits for gaps", () => {
    const a = splitFrames(bytes("A".repeat(180)));
    const b = splitFrames(bytes("B".repeat(180)));
    const collector = new Collector();
    collector.add(a[0]);
    for (const frame of b) expect(collector.add(frame)).toBeNull();
    const conflict = a[1].slice();
    conflict[16] ^= 1;
    expect(collector.add(reseal(conflict))).toBeNull();
    const corrupt = a[1].slice();
    corrupt[20] ^= 1;
    expect(collector.add(corrupt)).toBeNull();
    for (const frame of a.slice(2).reverse())
      expect(collector.add(frame)).toBeNull();
    collector.add(a[0]);
    expect(collector.count).toBe(a.length - 1);
    expect(collector.prefix).toBe("A".repeat(CHUNK_BYTES));
    expect(collector.add(a[1])).toEqual(bytes("A".repeat(180)));
    expect(collector.prefix).toBe("A".repeat(180));
    collector.clear();
    for (const frame of b) collector.add(frame);
    expect(collector.prefix).toBe("B".repeat(180));
  });
  it("clears provisional text on total checksum failure", () => {
    const frames = splitFrames(bytes("a".repeat(CHUNK_BYTES * 2)));
    const collector = new Collector();
    collector.add(frames[0]);
    frames[1][20] ^= 1;
    expect(() => collector.add(reseal(frames[1]))).toThrow(/checksum/i);
    expect(collector.prefix).toBe("");
    expect(collector.count).toBe(0);
  });
  it.each([[0xff], [0xe2, 0x82]])(
    "rejects invalid or truncated UTF-8 %j and clears partial text",
    (...tail) => {
      const frames = splitFrames(
        new Uint8Array([...bytes("a".repeat(CHUNK_BYTES)), ...tail]),
      );
      const collector = new Collector();
      collector.add(frames[0]);
      expect(() => collector.add(frames[1])).toThrow(/UTF-8/);
      expect(collector.prefix).toBe("");
      expect(collector.total).toBe(0);
    },
  );
});

it("uses a compact particle frame with sixteen payload bytes for broader camera neighborhoods", () => {
  const frames = splitFrames(bytes("x".repeat(17)));
  expect(frames).toHaveLength(2);
  expect(frames[0]).toHaveLength(40);
  expect(parseFrame(frames[0])?.chunk).toHaveLength(16);
});
