import { expect, it } from "vitest";
import { randomFillSync } from "node:crypto";
import {
  BinaryCollector,
  createBinarySource,
  parseBinaryPacket,
  MAX_FILE_BYTES,
  SHARD_BYTES,
  sanitizeName,
} from "../src/binary-transfer";
import { crc32 } from "../src/protocol";
const meta = {
  name: "../weird\\file\u0000.unknown",
  mime: "",
  kind: "file" as const,
};
const seal = (b: Uint8Array) => {
  new DataView(b.buffer).setUint32(b.length - 4, crc32(b.subarray(0, -4)));
  return b;
};
it("roundtrips NUL/non-UTF8 bytes out of order, ignores duplicates, isolates sender IDs and verifies SHA256", async () => {
  const bytes = randomFillSync(new Uint8Array(65539));
  const source = await createBinarySource(bytes, meta);
  const other = await createBinarySource(bytes, meta);
  const receiver = new BinaryCollector();
  receiver.add(source.data(0)); // no metadata: no allocation/progress
  expect(receiver.total).toBe(0);
  receiver.add(source.manifest());
  receiver.add(other.data(0));
  expect(receiver.count).toBe(0);
  for (let i = source.total - 1; i >= 0; i--) {
    receiver.add(source.data(i));
    receiver.add(source.data(i));
  }
  expect(receiver.count).toBe(source.total);
  const result = await receiver.verify();
  expect(result.bytes).toEqual(bytes);
  expect(result.meta.mime).toBe("application/octet-stream");
  expect(result.meta.name).not.toMatch(/[\\/\u0000]/);
  source.clear();
  other.clear();
  receiver.clear();
});
it("joins midstream after manifest loss and repairs exactly one missing shard per block, including padded tail", async () => {
  const bytes = randomFillSync(new Uint8Array(8193));
  const source = await createBinarySource(bytes, meta),
    receiver = new BinaryCollector();
  for (let i = 0; i < 8; i++) source.next(9); // receiver starts late
  for (let i = 0; i < source.total * 4 && !receiver.ready; i++) {
    for (const packet of source.next(4)) {
      const p = parseBinaryPacket(packet)!;
      if (p.role === 1 && p.index % 8 === 0) continue;
      receiver.add(packet);
    }
  }
  expect(receiver.ready).toBe(true);
  expect(receiver.repaired).toBeGreaterThan(0);
  expect((await receiver.verify()).bytes).toEqual(bytes);
});
it("does not claim repair of two missing shards until repeats arrive", async () => {
  const source = await createBinarySource(new Uint8Array(2048).fill(17), meta),
    r = new BinaryCollector();
  r.add(source.manifest());
  r.add(source.parity(0));
  for (let i = 2; i < 8; i++) r.add(source.data(i));
  expect(r.ready).toBe(false);
  r.add(source.data(1));
  expect(r.ready).toBe(true);
  expect((await r.verify()).bytes).toEqual(new Uint8Array(2048).fill(17));
});
it("rejects corruption, unsafe indices, oversized metadata, padding, malformed lengths and random noise", async () => {
  const source = await createBinarySource(new Uint8Array([0, 255, 128]), meta);
  const packet = source.data(0);
  packet[44] ^= 1;
  expect(parseBinaryPacket(packet)).toBeNull();
  const index = source.data(0);
  new DataView(index.buffer).setUint32(32, 0xffffffff);
  expect(parseBinaryPacket(seal(index))).toBeNull();
  const cap = source.manifest();
  new DataView(cap.buffer).setUint32(24, MAX_FILE_BYTES + 1);
  expect(parseBinaryPacket(seal(cap))).toBeNull();
  const padding = source.data(0);
  padding[43] = 1;
  expect(parseBinaryPacket(seal(padding))).toBeNull();
  const reserved = source.data(0);
  reserved[5] = 1;
  expect(parseBinaryPacket(seal(reserved))).toBeNull();
  for (let i = 0; i < 100; i++)
    expect(parseBinaryPacket(randomFillSync(new Uint8Array(300)))).toBeNull();
  expect(parseBinaryPacket(source.data(0).subarray(1))).toBeNull();
  expect(() => source.data(-1)).toThrow();
  expect(() => source.parity(1)).toThrow();
  const m = source.manifest();
  m[73] = 255;
  expect(parseBinaryPacket(seal(m))).toBeNull();
});
it("refuses corrupted content even with a recomputed packet CRC", async () => {
  const source = await createBinarySource(new Uint8Array(512), meta),
    r = new BinaryCollector();
  r.add(source.manifest());
  const bad = source.data(0);
  bad[40] = 123;
  r.add(seal(bad));
  r.add(source.data(1));
  await expect(r.verify()).rejects.toThrow(/SHA-256/);
  expect(r.count).toBe(0);
});
it("accepts zero bytes, bounds metadata, and cancellation clears lazy sources and pending verification", async () => {
  expect(sanitizeName("../../\u0000")).not.toMatch(/[\\/\u0000]/);
  const source = await createBinarySource(new Uint8Array(), {
      ...meta,
      name: "🎈".repeat(1000),
      mime: "x".repeat(1000),
    }),
    r = new BinaryCollector();
  r.add(source.manifest());
  expect((await r.verify()).bytes.length).toBe(0);
  expect(source.next(9).length).toBeLessThanOrEqual(9);
  source.clear();
  expect(() => source.next(1)).toThrow();
  expect(() => source.manifest()).toThrow();
  const controller = new AbortController();
  controller.abort();
  await expect(
    createBinarySource(new Uint8Array(2), meta, controller.signal),
  ).rejects.toThrow();
  const s = await createBinarySource(new Uint8Array(), meta);
  r.add(s.manifest());
  const pending = r.verify();
  r.clear();
  await expect(pending).rejects.toThrow(/cancel/i);
});
it("exactly 30,000,000 random file bytes survive lazy packets and SHA; cap + 1 is rejected", async () => {
  const original = randomFillSync(new Uint8Array(MAX_FILE_BYTES));
  const s = await createBinarySource(original, meta),
    r = new BinaryCollector();
  expect(s.total).toBe(Math.ceil(MAX_FILE_BYTES / SHARD_BYTES));
  r.add(s.manifest());
  for (let i = 0; i < s.total; i++) r.add(s.data(i));
  expect(
    Buffer.from((await r.verify()).bytes).equals(Buffer.from(original)),
  ).toBe(true);
  s.clear();
  r.clear();
  await expect(
    createBinarySource(new Uint8Array(MAX_FILE_BYTES + 1), meta),
  ).rejects.toThrow(/30,000,000/);
}, 30000);
it("keeps indices stable while switching 1/4/9 layouts, with bounded lazy packet batches", async () => {
  const bytes = randomFillSync(new Uint8Array(7001)),
    s = await createBinarySource(bytes, meta),
    r = new BinaryCollector();
  const getData = s.data,
    getManifest = s.manifest;
  let generated = 0;
  s.data = (index) => {
    generated++;
    return getData(index);
  };
  s.manifest = () => {
    generated++;
    return getManifest();
  };
  expect(generated).toBe(0);
  for (let i = 0; i < 300 && !r.ready; i++) {
    const cells = ([1, 4, 9] as const)[i % 3],
      batch = s.next(cells);
    expect(batch.length).toBeLessThanOrEqual(cells);
    for (const p of batch) r.add(p);
  }
  expect((await r.verify()).bytes).toEqual(bytes);
  s.clear();
});
it("retains the full 1 MiB UTF8 text capacity in ultrafast mode and aborts preparation", async () => {
  const bytes = new TextEncoder().encode("x".repeat(1_048_576));
  const s = await createBinarySource(bytes, {
      name: "text",
      mime: "text/plain",
      kind: "text",
    }),
    r = new BinaryCollector();
  r.add(s.manifest());
  for (let i = 0; i < s.total; i++) r.add(s.data(i));
  expect(Buffer.from((await r.verify()).bytes).equals(Buffer.from(bytes))).toBe(
    true,
  );
  s.clear();
  await expect(
    createBinarySource(new Uint8Array(1_048_577), { ...meta, kind: "text" }),
  ).rejects.toThrow(/1 MiB/);
  const controller = new AbortController();
  const pending = createBinarySource(bytes, meta, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(bytes[0]).toBe(120);
});
