import { expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  Collector,
  createFrames,
  crc32,
  MAX_TEXT_BYTES,
} from "../src/protocol";
import * as qr from "../src/qr";
const bytes = (n: number) =>
  Uint8Array.from({ length: n }, (_, i) => 32 + ((i * 31) % 95));
it("packs hundreds of bytes with density growing by payload and bounded by CSS pixels", () => {
  expect(qr.qrProfile(3, 600).version).toBe(8);
  expect(qr.qrProfile(15, 600).version).toBe(14);
  expect(qr.qrProfile(30, 600).version).toBe(20);
  expect(qr.qrProfile(1000, 600).version).toBe(26);
  const mobile = qr.qrProfile(1000, 335);
  expect(mobile.version).toBe(20);
  expect(mobile.modulePixels).toBeGreaterThanOrEqual(3);
  expect((mobile.modules + 8) * mobile.modulePixels).toBeLessThanOrEqual(335);
  expect(mobile.framesPerPacket * 20).toBeGreaterThan(500);
});
it("reconstructs exact frames, tolerating packet gaps/repeats/reordering and isolating senders", () => {
  const raw = bytes(10000),
    source = createFrames(raw),
    other = createFrames(bytes(9999));
  const packets = qr.createQrPackets(source, 335),
    foreign = qr.createQrPackets(other, 335);
  const collector = new Collector();
  let result: Uint8Array | null = null;
  const accept = (packet: Uint8Array) =>
    qr.unpackQr(packet)?.forEach((f) => {
      result = collector.add(f) || result;
    });
  accept(packets.get(2));
  accept(foreign.get(0));
  accept(packets.get(2));
  expect(collector.prefix).toBe("");
  for (let i = packets.length - 1; i >= 1; i--) accept(packets.get(i));
  expect(result).toBeNull();
  accept(packets.get(0));
  expect(result).toEqual(raw);
  for (let i = 0; i < packets.length; i++) {
    const frames = qr.unpackQr(packets.get(i))!;
    frames.forEach((frame, j) =>
      expect(frame).toEqual(
        source.get(i * packets.profile.framesPerPacket + j),
      ),
    );
  }
  packets.clear();
  foreign.clear();
});
it("rejects corruption, invalid count, bounds and nonzero final padding even with fresh CRC", () => {
  const source = qr.createQrPackets(createFrames(bytes(21)), 335);
  const valid = source.get(0);
  for (const position of [0, 1, 2, 10, 13, 16, 18, valid.length - 1]) {
    const bad = valid.slice();
    bad[position] ^= 1;
    expect(qr.unpackQr(bad)).toBeNull();
  }
  for (const mutate of [
    (b: Uint8Array) => {
      b[16] = 255;
    },
    (b: Uint8Array) => {
      b[10] = 255;
    },
    (b: Uint8Array) => {
      b[13] = 255;
    },
    (b: Uint8Array) => {
      b[b.length - 5] = 1;
    },
  ]) {
    const bad = valid.slice();
    mutate(bad);
    new DataView(bad.buffer).setUint32(
      bad.length - 4,
      crc32(bad.subarray(0, -4)),
    );
    expect(qr.unpackQr(bad)).toBeNull();
  }
  source.clear();
});
it("reads lazily, clears owned source, and roundtrips the full original byte cap", () => {
  const raw = bytes(MAX_TEXT_BYTES),
    frames = createFrames(raw),
    get = vi.spyOn(frames, "get");
  const packets = qr.createQrPackets(frames, 600);
  expect(get).not.toHaveBeenCalled();
  const collector = new Collector();
  let result: Uint8Array | null = null;
  for (let i = 0; i < packets.length; i++)
    for (const f of qr.unpackQr(packets.get(i))!)
      result = collector.add(f) || result;
  expect(get).toHaveBeenCalledTimes(Math.ceil((raw.length + 13) / 20));
  expect(result).toEqual(raw);
  const sample = qr.qrMatrix(packets.get(0), packets.profile.version);
  expect(sample.size).toBe(121);
  packets.clear();
  expect(frames.length).toBe(0);
  expect(packets.length).toBe(0);
  expect(() => packets.get(0)).toThrow();
  expect(() => createFrames(bytes(MAX_TEXT_BYTES + 1))).toThrow();
});
for (const [length, css] of [
  [80, 335],
  [250, 335],
  [600, 335],
  [1000, 600],
]) {
  it(`decodes actual binary QR raster at ${length} bytes / ${css}px`, () => {
    const packets = qr.createQrPackets(createFrames(bytes(length)), css);
    const packet = packets.get(0),
      matrix = qr.qrMatrix(packet, packets.profile.version);
    const size = (matrix.size + 8) * packets.profile.modulePixels;
    const canvas = createCanvas(size, size),
      ctx = canvas.getContext("2d");
    qr.drawQr(ctx as unknown as CanvasRenderingContext2D, matrix, size);
    const pixels = ctx.getImageData(0, 0, size, size);
    expect(Array.from(pixels.data.slice(0, size * 4))).toEqual(
      Array(size * 4).fill(255),
    );
    expect(qr.scanQr(pixels)).toEqual(qr.unpackQr(packet));
    packets.clear();
  });
}

it("decodes a dimmed, tilted camera view with mild optical blur", () => {
  const packets = qr.createQrPackets(createFrames(bytes(1000)), 335);
  const packet = packets.get(0);
  const signal = createCanvas(335, 335);
  qr.drawQr(
    signal.getContext("2d") as unknown as CanvasRenderingContext2D,
    qr.qrMatrix(packet, packets.profile.version),
    335,
  );
  const scene = createCanvas(700, 700);
  const ctx = scene.getContext("2d");
  ctx.fillStyle = "#242424";
  ctx.fillRect(0, 0, 700, 700);
  ctx.translate(170, 145);
  ctx.rotate(0.07);
  ctx.globalAlpha = 0.7;
  ctx.filter = "blur(0.4px)";
  ctx.drawImage(signal, 0, 0);
  expect(qr.scanQr(ctx.getImageData(0, 0, 700, 700))).toEqual(
    qr.unpackQr(packet),
  );
  packets.clear();
});

it("rejects mixed senders, scattered indices and invalid source CRC before packing", () => {
  const a = createFrames(bytes(1000)),
    b = createFrames(bytes(1000));
  for (const get of [
    (i: number) => (i === 1 ? b.get(i) : a.get(i)),
    (i: number) => a.get(i === 1 ? 2 : i),
    (i: number) => {
      const f = a.get(i);
      if (i === 1) f[25] ^= 1;
      return f;
    },
  ]) {
    const packets = qr.createQrPackets(
      { length: a.length, get, clear() {} },
      600,
    );
    expect(() => packets.get(0)).toThrow();
  }
  a.clear();
  b.clear();
});
it("retains the existing compressed envelope for a repetitive original 1 MiB", async () => {
  const { prepareMessage, decodeMessage } = await import("../src/message");
  const { createWireFrames } = await import("../src/protocol");
  const message = "x".repeat(MAX_TEXT_BYTES),
    wire = await prepareMessage(message);
  expect(wire[0]).toBe(1);
  const packets = qr.createQrPackets(createWireFrames(wire), 600),
    collector = new Collector(true);
  let result: Uint8Array | null = null;
  for (let i = 0; i < packets.length; i++)
    for (const frame of qr.unpackQr(packets.get(i))!)
      result = collector.add(frame) || result;
  expect(await decodeMessage(result!)).toBe(message);
  packets.clear();
  wire.fill(0);
  result!.fill(0);
});
it("does not turn ordinary or CRC-invalid QR codes into protocol progress", () => {
  const packets = qr.createQrPackets(createFrames(bytes(80)), 335);
  const corrupt = packets.get(0);
  corrupt[23] ^= 1;
  for (const packet of [
    new TextEncoder().encode("ordinary QR text"),
    corrupt,
  ]) {
    const canvas = createCanvas(335, 335),
      ctx = canvas.getContext("2d");
    qr.drawQr(
      ctx as unknown as CanvasRenderingContext2D,
      qr.qrMatrix(packet, 8),
      335,
    );
    expect(qr.scanQr(ctx.getImageData(0, 0, 335, 335))).toBeNull();
  }
  packets.clear();
});
