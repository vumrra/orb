import { afterEach, expect, it, vi } from "vitest";
import { randomFillSync, webcrypto } from "node:crypto";
import * as color from "../src/color-grid";
import { crc32, MAX_TEXT_BYTES } from "../src/protocol";
import { MAX_FILE_BYTES, sanitizeName } from "../src/binary-transfer";
const meta = {
  name: "../binary\\file\0.arbitrary",
  mime: "application/x-test",
  kind: "file" as const,
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function seal(p: Uint8Array) {
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  v.setUint32(64, crc32(p.subarray(80)));
  v.setUint32(68, crc32(p.subarray(0, 68)));
  return p;
}
for (const grid of [64, 128, 256] as const) {
  it(`roundtrips ${grid} binary bytes, typed metadata, duplicate/reordered/mixed sessions`, async () => {
    const bytes = randomFillSync(new Uint8Array(90001));
    const s = await color.createColorSource(bytes, meta, undefined, grid);
    const other = await color.createColorSource(bytes, meta, undefined, grid);
    const r = new color.ColorCollector();
    expect(s.grid).toBe(grid);
    r.add(s.data(s.total - 1));
    r.add(other.data(0));
    expect(r.count).toBe(1);
    for (let i = s.total - 1; i >= 0; i--) {
      r.add(s.data(i));
      r.add(s.data(i));
    }
    expect(r.ready).toBe(true);
    const result = await r.verify();
    expect(result.bytes).toEqual(bytes);
    expect(result.meta).toEqual({ ...meta, name: sanitizeName(meta.name) });
    s.clear();
    other.clear();
  });
  for (const missing of [1, 2])
    it(`repairs ${missing} erasures per block at ${grid}, including padded tail`, async () => {
      const bytes = randomFillSync(
        new Uint8Array(color.colorCapacity(grid) * 18 - 150),
      );
      const s = await color.createColorSource(bytes, meta, undefined, grid),
        r = new color.ColorCollector();
      for (let b = 0; b < Math.ceil(s.total / 8); b++) {
        r.add(s.parity(b, 1));
        for (let i = b * 8; i < Math.min(s.total, (b + 1) * 8); i++)
          if (i % 8 >= missing) r.add(s.data(i));
        r.add(s.parity(b, 0));
      }
      expect(r.repaired).toBeGreaterThan(0);
      expect((await r.verify()).bytes).toEqual(bytes);
      s.clear();
    });
}
it("accepts empty files and 1 MiB text without SubtleCrypto; preserves long filename extensions", async () => {
  vi.stubGlobal("crypto", {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  });
  for (const bytes of [
    new Uint8Array(),
    new Uint8Array(MAX_TEXT_BYTES).fill(120),
  ]) {
    const s = await color.createColorSource(bytes, {
      name: "한".repeat(1000) + ".custom",
      mime: "text/plain",
      kind: "text",
    });
    const r = new color.ColorCollector();
    for (let i = 0; i < s.total; i++) r.add(s.data(i));
    const result = await r.verify();
    expect(result.bytes).toEqual(bytes);
    expect(result.meta.kind).toBe("text");
    expect(result.meta.name.endsWith(".custom")).toBe(true);
    s.clear();
  }
  await expect(
    color.createColorSource(new Uint8Array(MAX_TEXT_BYTES + 1), {
      ...meta,
      kind: "text",
    }),
  ).rejects.toThrow(/1 MiB/);
});
it("rejects corrupt packets and invalid bounds before allocating a session", async () => {
  const s = await color.createColorSource(new Uint8Array(1), meta),
    r = new color.ColorCollector();
  const corrupt = s.data(0);
  corrupt[80] ^= 1;
  const index = s.data(0);
  new DataView(index.buffer).setUint32(28, 0xffffffff);
  seal(index);
  const length = s.data(0);
  new DataView(length.buffer).setUint32(
    24,
    MAX_FILE_BYTES + color.COLOR_ENVELOPE_ALLOWANCE + 1,
  );
  seal(length);
  const reserved = s.data(0);
  reserved[72] = 1;
  const padding = s.data(0);
  padding[padding.length - 1] = 7;
  seal(padding);
  for (const p of [
    corrupt,
    index,
    length,
    reserved,
    padding,
    new Uint8Array(25000),
  ]) {
    expect(color.parseColorPacket(p)).toBeNull();
    expect(r.add(p)).toBe(false);
    expect(r.total).toBe(0);
  }
  await expect(r.verify()).rejects.toThrow(/incomplete/i);
  expect(() => s.data(-1)).toThrow();
  expect(() => s.parity(99999, 0)).toThrow();
  s.clear();
});
it("enforces final SHA even with valid packet CRC", async () => {
  const s = await color.createColorSource(new Uint8Array(7), meta),
    r = new color.ColorCollector();
  const bad = s.data(0);
  bad[90] ^= 1;
  r.add(seal(bad));
  await expect(r.verify()).rejects.toThrow(/SHA-256/);
  expect(r.count).toBe(0);
  s.clear();
});
it("cancels preparation, clears borrowed source state, and prevents stale verification consuming a new session", async () => {
  const controller = new AbortController(),
    input = new Uint8Array(100).fill(17);
  const pending = color.createColorSource(input, meta, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(input[0]).toBe(17);
  await expect(
    color.createColorSource(input, meta, controller.signal),
  ).rejects.toThrow();
  const c = new AbortController(),
    s = await color.createColorSource(input, meta, c.signal);
  const r = new color.ColorCollector();
  r.add(s.data(0));
  const verify = expect(r.verify()).rejects.toThrow(/cancel/i);
  r.clear();
  const next = await color.createColorSource(new Uint8Array([23]), meta);
  r.add(next.data(0));
  await verify;
  expect((await r.verify()).bytes).toEqual(new Uint8Array([23]));
  c.abort();
  expect(() => s.next()).toThrow();
  next.clear();
  expect(() => next.data(0)).toThrow();
});
it("reassembles exactly 30,000,000 raw bytes lazily with bounded parity cache and rejects +1", async () => {
  const bytes = randomFillSync(new Uint8Array(MAX_FILE_BYTES)),
    s = await color.createColorSource(bytes, meta, undefined, 256),
    r = new color.ColorCollector();
  expect(s.total).toBe(
    Math.ceil(
      (MAX_FILE_BYTES +
        8 +
        new TextEncoder().encode(sanitizeName(meta.name)).length +
        meta.mime.length) /
        color.colorCapacity(256),
    ),
  );
  for (let i = 0; i < s.total; i++) {
    const p = s.data(i);
    expect(p.length).toBe(80 + color.colorCapacity(256));
    r.add(p);
    p.fill(0);
  }
  expect(Buffer.from((await r.verify()).bytes).equals(Buffer.from(bytes))).toBe(
    true,
  );
  for (let b = 0; b < Math.ceil(s.total / 8); b++) r.add(s.parity(b, 0));
  expect(
    (r as unknown as { parities: Map<number, unknown> }).parities.size,
  ).toBeLessThanOrEqual(16);
  r.clear();
  s.clear();
  await expect(
    color.createColorSource(new Uint8Array(MAX_FILE_BYTES + 1), meta),
  ).rejects.toThrow(/30,000,000/);
}, 30000);
it("changes lap phase so a receiver sampling every second frame eventually receives everything", async () => {
  const bytes = randomFillSync(new Uint8Array(60000)),
    s = await color.createColorSource(bytes, meta, undefined, 64),
    r = new color.ColorCollector();
  for (let i = 0; i < s.total * 8 && !r.ready; i++) {
    const p = s.next();
    if (i % 2) r.add(p);
    p.fill(0);
  }
  expect((await r.verify()).bytes).toEqual(bytes);
  s.clear();
});
it("selects camera-safe 64-cell tiles at every viewport and enforces readable minimum", () => {
  for (const grid of [64, 128, 256] as const) {
    const l = color.colorLayout(grid);
    expect(color.colorGridForViewport(l.width * 3, l.height * 3)).toBe(64);
  }
  expect(color.colorGridForViewport(350, 450)).toBe(64);
  expect(() => color.colorGridForViewport(200, 200)).toThrow(/space/i);
});
it("verifies an empty file and normalizes an invalid MIME type without changing its kind or extension", async () => {
  const s = await color.createColorSource(new Uint8Array(), {
    name: "empty.unknown",
    mime: "",
    kind: "file",
  });
  const r = new color.ColorCollector(),
    packet = s.data(0),
    padded = new Uint8Array(packet.length + 6);
  padded.set(packet, 3);
  expect(r.add(padded.subarray(3, -3))).toBe(true);
  expect(await r.verify()).toEqual({
    bytes: new Uint8Array(),
    meta: {
      name: "empty.unknown",
      mime: "application/octet-stream",
      kind: "file",
    },
  });
  s.clear();
});
it("keeps three erasures incomplete until a retransmission arrives, rejects simultaneous verification", async () => {
  const bytes = randomFillSync(
    new Uint8Array(color.colorCapacity(64) * 8 - 100),
  );
  const s = await color.createColorSource(bytes, meta, undefined, 64),
    r = new color.ColorCollector();
  r.add(s.parity(0, 0));
  r.add(s.parity(0, 1));
  for (let i = 3; i < s.total; i++) r.add(s.data(i));
  expect(r.ready).toBe(false);
  await expect(r.verify()).rejects.toThrow(/incomplete/i);
  expect(r.add(s.data(2))).toBe(true);
  const verifying = r.verify();
  await expect(r.verify()).rejects.toThrow(/progress/i);
  expect((await verifying).bytes).toEqual(bytes);
  s.clear();
});
it("wipes assembly and bounded parity storage on clear", async () => {
  const s = await color.createColorSource(
      new Uint8Array(300000).fill(37),
      meta,
      undefined,
      64,
    ),
    r = new color.ColorCollector();
  r.add(s.data(1));
  r.add(s.parity(0, 0));
  r.add(s.parity(0, 1));
  const internal = r as unknown as {
    bytes: Uint8Array;
    hash: Uint8Array;
    id: Uint8Array;
    parities: Map<number, Uint8Array[]>;
  };
  const retained = [
    internal.bytes,
    internal.hash,
    internal.id,
    ...Array.from(internal.parities.values()).flat(),
  ];
  r.clear();
  expect(retained.every((p) => p.every((v) => v === 0))).toBe(true);
  expect(r.total).toBe(0);
  s.clear();
});
