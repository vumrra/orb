import { expect, it } from "vitest";
import {
  rsEncode,
  rsDecode,
  opticalFrames,
  OpticalRecovery,
  parseOpticalFrame,
} from "../src/optical-fec";
import { createFrames, Collector, crc32 } from "../src/protocol";
it("RS(60,40) corrects 0..10 arbitrary byte errors and mixed errors/erasures", () => {
  let seed = 123;
  const rand = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 24;
  for (let trial = 0; trial < 300; trial++) {
    const message = Uint8Array.from({ length: 40 }, rand),
      code = rsEncode(message);
    const count = trial % 11,
      positions = new Set<number>();
    while (positions.size < count) positions.add(rand() % 60);
    for (const p of positions) code[p] ^= rand() || 1;
    expect(rsDecode(code)).toEqual(message);
    const erased = rsEncode(message),
      erasures = Array.from({ length: 20 }, (_, i) => i * 3);
    for (const p of erasures) erased[p] ^= rand() || 1;
    expect(rsDecode(erased, erasures)).toEqual(message);
  }
});
it("recovers any two data losses per 8-frame block, reordered duplicates, exact 1k", () => {
  const bytes = new TextEncoder().encode("abcdefghij".repeat(100)),
    original = createFrames(bytes),
    source = opticalFrames(original),
    recovery = new OpticalRecovery(),
    collector = new Collector();
  let result: Uint8Array | null = null;
  const all = Array.from({ length: source.length }, (_, i) =>
    source.get(i),
  ).reverse();
  for (const frame of all) {
    const parsed = parseOpticalFrame(frame)!;
    if (frame[1] === 4 && parsed.index % 8 < 2) continue;
    for (let duplicate = 0; duplicate < 2; duplicate++)
      for (const data of recovery.add(frame))
        result = collector.add(data) || result;
  }
  expect(result).toEqual(bytes);
  expect(collector.count).toBe(original.length);
  recovery.clear();
  source.clear();
  expect(() => source.get(0)).toThrow();
  expect(original.get(0).length).toBe(40);
});
it("parity validates CRC, sender, length, index and never counts as data", () => {
  const original = createFrames(new TextEncoder().encode("x".repeat(1000))),
    source = opticalFrames(original),
    recovery = new OpticalRecovery();
  const parity = Array.from({ length: source.length }, (_, i) =>
    source.get(i),
  ).find((f) => f[1] === 5)!;
  expect(recovery.add(parity)).toEqual([]);
  const corrupt = parity.slice();
  corrupt[20] ^= 1;
  expect(parseOpticalFrame(corrupt)).toBeNull();
  const bounds = parity.slice();
  bounds.fill(255, 10, 13);
  new DataView(bounds.buffer).setUint32(36, crc32(bounds.subarray(0, 36)));
  expect(parseOpticalFrame(bounds)).toBeNull();
  const alien = createFrames(new TextEncoder().encode("z".repeat(1000)));
  expect(recovery.add(alien.get(0))).toEqual([]);
});
it("covers every pair of erased data/parity symbols including truncated groups", () => {
  for (const size of [1, 7, 20, 139, 140, 141, 1000]) {
    const bytes = new TextEncoder().encode("a".repeat(size)),
      original = createFrames(bytes),
      source = opticalFrames(original);
    for (let a = 0; a < 10; a++)
      for (let b = a + 1; b < 10; b++) {
        const recovery = new OpticalRecovery(),
          collector = new Collector();
        let result: Uint8Array | null = null;
        for (let i = source.length - 1; i >= 0; i--) {
          if (i % 10 === a || i % 10 === b) continue;
          for (const f of recovery.add(source.get(i)))
            result = collector.add(f) || result;
        }
        expect(result, `size=${size}, losses=${a},${b}`).toEqual(bytes);
      }
  }
});
it("rejects over-capacity corruption through original CRC and checks mixed erasures", () => {
  const original = createFrames(new TextEncoder().encode("z".repeat(100))),
    frame = original.get(0);
  for (let trial = 0; trial < 100; trial++) {
    const code = rsEncode(frame);
    for (let i = 0; i < 11; i++)
      code[(i * 5 + trial) % 60] ^= ((i + trial) % 255) + 1;
    const result = rsDecode(code);
    expect(result && parseOpticalFrame(result)).toBeNull();
    const mixed = rsEncode(frame);
    for (let i = 0; i < 15; i++) mixed[i] ^= i + 1;
    expect(
      rsDecode(
        mixed,
        Array.from({ length: 10 }, (_, i) => i),
      ),
    ).toEqual(frame);
  }
});
it("lazily handles 1MB with two syndrome bytes per ten message bytes and wipes state", () => {
  const original = createFrames(new Uint8Array(1_000_000).fill(97)),
    source = opticalFrames(original),
    recovery = new OpticalRecovery();
  expect(source.length).toBe(
    original.length + Math.ceil(original.length / 8) * 2,
  );
  for (const index of [0, 4, 9, source.length - 1])
    expect(source.get(index).length).toBe(40);
  const frame = source.get(0);
  recovery.add(frame);
  recovery.clear();
  expect(
    recovery.add(createFrames(new TextEncoder().encode("new sender")).get(0)),
  ).toHaveLength(1);
  source.clear();
  expect(original.get(0)[1]).toBe(4);
  original.clear();
});
it("refuses conflicting lengths, truncated parity and forged reconstructions at final body CRC", () => {
  const original = createFrames(
      new TextEncoder().encode("abcdefghij".repeat(100)),
    ),
    source = opticalFrames(original),
    recovery = new OpticalRecovery(),
    collector = new Collector();
  const parity = source.get(4),
    wrong = parity.slice();
  wrong[15]++;
  new DataView(wrong.buffer).setUint32(36, crc32(wrong.subarray(0, 36)));
  recovery.add(parity);
  expect(recovery.add(wrong)).toEqual([]);
  expect(parseOpticalFrame(parity.subarray(0, 39))).toBeNull();
  recovery.clear();
  let rejected = false;
  for (let i = 0; i < source.length; i++) {
    const frame = source.get(i),
      meta = parseOpticalFrame(frame)!;
    if (frame[1] === 4 && meta.index % 8 < 2) continue;
    if (frame[1] === 5 && meta.index === 0) {
      frame[30] ^= 33;
      new DataView(frame.buffer).setUint32(36, crc32(frame.subarray(0, 36)));
    }
    try {
      for (const data of recovery.add(frame)) collector.add(data);
    } catch {
      rejected = true;
      break;
    }
  }
  expect(rejected).toBe(true);
});
it("restores 1MB in bounded per-block work and clears all receiver state", () => {
  const bytes = new Uint8Array(1_000_000).fill(97),
    original = createFrames(bytes),
    source = opticalFrames(original),
    recovery = new OpticalRecovery(),
    collector = new Collector();
  let result: Uint8Array | null = null;
  for (let i = source.length - 1; i >= 0; i--) {
    const frame = source.get(i),
      meta = parseOpticalFrame(frame)!;
    if (frame[1] === 4 && meta.index % 8 < 2) continue;
    for (const data of recovery.add(frame))
      result = collector.add(data) || result;
  }
  expect(result).toEqual(bytes);
  const state = recovery as unknown as {
    blocks: Map<number, unknown>;
    seen: Uint8Array;
    header: Uint8Array;
  };
  expect(state.blocks.size).toBe(0);
  const seen = state.seen,
    header = state.header;
  recovery.clear();
  expect(seen.every((v) => v === 0)).toBe(true);
  expect(header.every((v) => v === 0)).toBe(true);
  expect(state.seen.length).toBe(0);
  source.clear();
  original.clear();
  collector.clear();
});
