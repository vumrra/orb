import { expect, it } from "vitest";
import {
  Collector,
  createFrames,
  parseFrame,
  MAX_TEXT_BYTES,
  CHUNK_BYTES,
  crc32,
} from "../src/protocol";
import {
  prepareMessage,
  decodeMessage,
  envelope,
  ENVELOPE_BYTES,
} from "../src/message";
import { BarCollector, splitBarFrame } from "../src/bar";
const encode = (s: string) => new TextEncoder().encode(s);
it("accepts exactly 1,048,576 UTF8 bytes, rejects one extra including emoji", async () => {
  expect(MAX_TEXT_BYTES).toBe(1048576);
  const text = "🌒".repeat(262144);
  const wire = await prepareMessage(text);
  expect(await decodeMessage(wire)).toBe(text);
  await expect(prepareMessage(text + "a")).rejects.toThrow(/bytes/);
});
it("lazily reconstructs every full 1MB frame and Bar symbol, including wide indices and last frame", () => {
  const bytes = new Uint8Array(1048576);
  let seed = 42;
  for (let i = 0; i < bytes.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    bytes[i] = 32 + ((seed >>> 24) % 95);
  }
  const source = createFrames(bytes),
    receiver = new Collector(),
    bar = new BarCollector();
  expect(Array.isArray(source)).toBe(false);
  expect(source.length).toBe(
    Math.ceil((bytes.length + ENVELOPE_BYTES) / CHUNK_BYTES),
  );
  for (const index of [255, 256, source.length - 1])
    expect(parseFrame(source.get(index))?.index).toBe(index);
  let packet: Uint8Array | null = null;
  for (let i = source.length - 1; i >= 0; i--) {
    const frame = source.get(i),
      symbols = splitBarFrame(frame);
    expect(symbols.length).toBe(2);
    expect(bar.add(symbols[1])).toBeNull();
    const restored = bar.add(symbols[0]);
    expect(restored).toEqual(frame);
    const value = receiver.add(restored!);
    if (value) packet = value;
  }
  expect(packet).toEqual(bytes);
  expect(receiver.count).toBe(source.length);
  source.clear();
  receiver.clear();
}, 20000);
it("compresses only when smaller and preserves original metadata and integrity", async () => {
  const text = "a".repeat(1048576),
    packet = await prepareMessage(text);
  expect(packet[0]).toBe(1);
  expect(packet.length).toBeLessThan(2000);
  expect(await decodeMessage(packet)).toBe(text);
  const broken = packet.slice();
  broken[5] ^= 1;
  await expect(decodeMessage(broken)).rejects.toThrow(/checksum/);
  expect((await prepareMessage("tiny 🌒"))[0]).toBe(0);
});
it("bounds malformed envelopes, decompression bombs, invalid UTF8 and cancellation", async () => {
  await expect(decodeMessage(new Uint8Array(12))).rejects.toThrow();
  const bomb = await new Response(
    new Blob([encode("x".repeat(1048577))])
      .stream()
      .pipeThrough(new CompressionStream("deflate")),
  ).arrayBuffer();
  const packet = envelope(new Uint8Array(bomb), 1, 1048576, 0);
  await expect(decodeMessage(packet)).rejects.toThrow(/limit|length|bytes/);
  await expect(
    decodeMessage(
      envelope(new Uint8Array([255]), 0, 1, crc32(new Uint8Array([255]))),
    ),
  ).rejects.toThrow(/UTF-8/);
  const abort = new AbortController();
  abort.abort();
  await expect(
    prepareMessage("x".repeat(10000), abort.signal),
  ).rejects.toThrow();
  await expect(decodeMessage(packet, abort.signal)).rejects.toThrow();
});
it("collects compressed frames without inventing a text prefix and verifies the original after collection", async () => {
  const { createWireFrames } = await import("../src/protocol");
  const message = "🌒".repeat(262144),
    wire = await prepareMessage(message),
    source = createWireFrames(wire),
    collector = new Collector(true);
  let packet: Uint8Array | null = null;
  for (let index = 0; index < source.length; index++) {
    const result = collector.add(source.get(index));
    expect(collector.prefix).toBe("");
    if (result) packet = result;
  }
  expect(await decodeMessage(packet!)).toBe(message);
  collector.clear();
  source.clear();
  packet!.fill(0);
  wire.fill(0);
});
it("rejects invalid deflate, dishonest original lengths and unknown flags", async () => {
  const bad = envelope(new Uint8Array([1, 2, 3]), 1, 1000, 0);
  await expect(decodeMessage(bad)).rejects.toThrow();
  const wire = await prepareMessage("x".repeat(10000));
  const short = wire.slice();
  new DataView(short.buffer).setUint32(1, 9999);
  await expect(decodeMessage(short)).rejects.toThrow(/limit|length/);
  const long = wire.slice();
  new DataView(long.buffer).setUint32(1, 10001);
  await expect(decodeMessage(long)).rejects.toThrow(/length/);
  const oversized = wire.slice();
  new DataView(oversized.buffer).setUint32(1, 1048577);
  await expect(decodeMessage(oversized)).rejects.toThrow(/length/);
  wire[0] = 2;
  await expect(decodeMessage(wire)).rejects.toThrow(/flag/);
});
it("reports unavailable compression explicitly rather than silently changing the transfer", async () => {
  const native = globalThis.CompressionStream;
  try {
    Object.defineProperty(globalThis, "CompressionStream", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    await expect(prepareMessage("x".repeat(1024))).rejects.toThrow(
      /cannot compress/,
    );
    expect((await prepareMessage("tiny"))[0]).toBe(0);
  } finally {
    globalThis.CompressionStream = native;
  }
});
it("can abort running compression and decompression, without a stale result", async () => {
  const a = new AbortController(),
    pending = prepareMessage("a".repeat(1048576), a.signal);
  a.abort();
  await expect(pending).rejects.toThrow();
  const wire = await prepareMessage("a".repeat(1048576));
  const b = new AbortController(),
    decoding = decodeMessage(wire, b.signal);
  b.abort();
  await expect(decoding).rejects.toThrow();
});
it("uses raw UTF8 when a native compression result would not reduce bytes", async () => {
  const native = globalThis.CompressionStream;
  try {
    Object.defineProperty(globalThis, "CompressionStream", {
      configurable: true,
      writable: true,
      value: class {
        readable: ReadableStream;
        writable: WritableStream;
        constructor() {
          const stream = new TransformStream({
            transform(chunk, controller) {
              controller.enqueue(chunk);
            },
            flush(controller) {
              controller.enqueue(new Uint8Array([0]));
            },
          });
          this.readable = stream.readable;
          this.writable = stream.writable;
        }
      },
    });
    const text = "x".repeat(1024),
      wire = await prepareMessage(text);
    expect(wire[0]).toBe(0);
    expect(wire.length).toBe(1024 + ENVELOPE_BYTES);
    expect(await decodeMessage(wire)).toBe(text);
  } finally {
    globalThis.CompressionStream = native;
  }
});
it("feeds decompression in small chunks so a bomb cannot inflate one huge input chunk before the output cap", async () => {
  const raw = new TextEncoder().encode("x".repeat(8 * 1048576));
  const compressed = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
  const wire = envelope(compressed, 1, 1048576, 0),
    native = globalThis.DecompressionStream,
    sizes: number[] = [];
  try {
    Object.defineProperty(globalThis, "DecompressionStream", {
      configurable: true,
      writable: true,
      value: class {
        readable: ReadableStream;
        writable: WritableStream;
        constructor(format: CompressionFormat) {
          const tap = new TransformStream({
            transform(chunk, controller) {
              sizes.push(chunk.length);
              controller.enqueue(chunk);
            },
          });
          this.writable = tap.writable;
          this.readable = tap.readable.pipeThrough(new native(format));
        }
      },
    });
    await expect(decodeMessage(wire)).rejects.toThrow(/limit|length/);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(256);
  } finally {
    globalThis.DecompressionStream = native;
    raw.fill(0);
    compressed.fill(0);
  }
});
