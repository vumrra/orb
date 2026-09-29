import { createCanvas } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import {
  BarCollector,
  crc16,
  BAR_SYMBOL_MS,
  BAR_TRANSITION_MS,
  splitBarFrame,
  drawBar,
  scanBarPixels,
} from "../src/bar";
import { Collector, splitFrames } from "../src/protocol";

function reseal(s: Uint8Array) {
  s[20] &= 15;
  const crc = crc16(s.subarray(0, 21));
  s[20] |= (crc & 15) << 4;
  s[21] = crc >>> 4;
  s[22] = crc >>> 12;
}
const message = "White geometric bars 한글 🌒";
it("reassembles repeated, missed and reordered fragments without mixing senders or frames", () => {
  const frames = splitFrames(new TextEncoder().encode(message));
  const other = splitFrames(new TextEncoder().encode(message));
  const receiver = new BarCollector();
  const a = splitBarFrame(frames[0]),
    b = splitBarFrame(other[0]);
  expect(a).toHaveLength(2);
  for (const symbol of [a[0], a[0], b[1]])
    expect(receiver.add(symbol)).toBeNull();
  expect(receiver.add(a[1])).toEqual(frames[0]);
  receiver.clear();
  for (const symbol of a.slice(1)) expect(receiver.add(symbol)).toBeNull();
  expect(receiver.add(a[0])).toEqual(frames[0]);
});
it("requires fragment CRC, original frame CRC and matching original metadata", () => {
  const [frame] = splitFrames(new TextEncoder().encode("check"));
  const a = splitBarFrame(frame),
    receiver = new BarCollector();
  const corrupt = a[0].slice();
  corrupt[10] ^= 1;
  expect(receiver.add(corrupt)).toBeNull();
  for (const s of a.slice(1)) expect(receiver.add(s)).toBeNull();
  expect(receiver.add(a[0])).toEqual(frame);
  receiver.clear();
  const forged = a.map((s) => s.slice());
  forged[1][10] ^= 1;
  reseal(forged[1]);
  for (const s of forged) expect(receiver.add(s)).toBeNull();
  receiver.clear();
  const wrongID = a.map((s) => s.slice());
  for (const s of wrongID) {
    s[0] ^= 1;
    reseal(s);
    expect(receiver.add(s)).toBeNull();
  }
});

it.each([
  [330, 260, 0, false, 0, 0],
  [200, 200, 0.23, false, 0.4, 0],
  [240, 220, 0.23, false, 0.5, 0],
  [240, 220, 1.57, true, 0.5, 0],
  [260, 240, 2.7, true, 0.6, 0.12],
])(
  "white pixels roundtrip at %sx%s rotation=%s mirror=%s blur=%s shear=%s",
  (w, h, angle, mirror, blur, shear) => {
    const collector = new Collector(),
      fragments = new BarCollector();
    let packet: Uint8Array | null = null;
    for (const frame of splitFrames(new TextEncoder().encode(message))) {
      for (const symbol of splitBarFrame(frame).reverse()) {
        const c = createCanvas(960, 640),
          ctx = c.getContext("2d");
        ctx.fillStyle = "#090909";
        ctx.fillRect(0, 0, 960, 640);
        ctx.translate(710, 330);
        ctx.rotate(angle);
        ctx.transform(mirror ? -1 : 1, 0, shear, 1, 0, 0);
        drawBar(ctx as unknown as CanvasRenderingContext2D, symbol, 0, 0, w, h);
        const out = createCanvas(960, 640),
          o = out.getContext("2d");
        o.filter = `blur(${blur}px)`;
        o.drawImage(c, 0, 0);
        const pixels = o.getImageData(0, 0, 960, 640);
        // Geometry carries the data even when all chroma is removed.
        for (let i = 0; i < pixels.data.length; i += 4)
          pixels.data[i + 1] = pixels.data[i + 2] = pixels.data[i];
        const scan = scanBarPixels(pixels);
        expect(scan.symbol).toEqual(symbol);
        const original = fragments.add(scan.symbol!);
        if (original) packet = collector.add(original);
      }
    }
    expect(new TextDecoder().decode(packet!)).toBe(message);
  },
);
it("rejects blank, noise and undersized raster input", () => {
  const c = createCanvas(320, 320),
    ctx = c.getContext("2d");
  const pixels = ctx.getImageData(0, 0, 320, 320);
  expect(scanBarPixels(pixels).symbol).toBeNull();
  let seed = 17;
  for (let i = 0; i < pixels.data.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    pixels.data[i] = seed >>> 24;
  }
  expect(scanBarPixels(pixels).symbol).toBeNull();
  expect(
    scanBarPixels({ width: 2048, height: 2048, data: new Uint8ClampedArray() })
      .symbol,
  ).toBeNull();
});
it("does not combine fragments from different frame indices in the same transfer", () => {
  const frames = splitFrames(new TextEncoder().encode("x".repeat(48))),
    receiver = new BarCollector();
  const [a, b, c] = frames.map(splitBarFrame);
  for (const s of [a[0], b[1], c[1]]) expect(receiver.add(s)).toBeNull();
  expect(receiver.add(c[0])).toEqual(frames[2]);
  expect(receiver.add(a[1])).toEqual(frames[0]);
});
it("white geometry changes with payload and rejects damaged heights", () => {
  const [frame] = splitFrames(new TextEncoder().encode("geometric"));
  const symbols = splitBarFrame(frame),
    c = createCanvas(480, 480),
    ctx = c.getContext("2d");
  const draw = (s: Uint8Array) => {
    ctx.fillStyle = "#090909";
    ctx.fillRect(0, 0, 480, 480);
    drawBar(ctx as unknown as CanvasRenderingContext2D, s, 240, 240, 330, 280);
    return ctx.getImageData(0, 0, 480, 480);
  };
  const a = draw(symbols[0]),
    b = draw(symbols[1]);
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    expect(a.data[i]).toBe(a.data[i + 1]);
    expect(a.data[i]).toBe(a.data[i + 2]);
    if (a.data[i] !== b.data[i]) changed++;
  }
  expect(changed).toBeGreaterThan(1000);
  ctx.fillStyle = "#090909";
  ctx.fillRect(122, 80, 8, 145);
  expect(scanBarPixels(ctx.getImageData(0, 0, 480, 480)).symbol).toBeNull();
});
it("decodes a modest projective tilt using the two calibration rails", () => {
  const [frame] = splitFrames(new TextEncoder().encode("tilt"));
  const symbol = splitBarFrame(frame)[1];
  const c = createCanvas(500, 500),
    ctx = c.getContext("2d");
  ctx.fillStyle = "#090909";
  ctx.fillRect(0, 0, 500, 500);
  drawBar(
    ctx as unknown as CanvasRenderingContext2D,
    symbol,
    250,
    250,
    330,
    280,
  );
  const source = ctx.getImageData(0, 0, 500, 500),
    result = ctx.createImageData(500, 500);
  for (let y = 0; y < 500; y++)
    for (let x = 0; x < 500; x++) {
      const dy = y - 250,
        factor = 1 - 0.0004 * dy;
      const sx = Math.round(250 + (x - 250) / factor),
        sy = Math.round(250 + dy / factor);
      const q = (y * 500 + x) * 4;
      if (sx >= 0 && sx < 500 && sy >= 0 && sy < 500)
        result.data.set(
          source.data.subarray((sy * 500 + sx) * 4, (sy * 500 + sx) * 4 + 4),
          q,
        );
    }
  expect(scanBarPixels(result).symbol).toEqual(symbol);
});
it("animates idle geometry without inventing a payload; active endpoints remain symbol data", () => {
  const c = createCanvas(480, 480),
    ctx = c.getContext("2d");
  const draw = (symbol: Uint8Array | null, time: number) => {
    ctx.fillStyle = "#090909";
    ctx.fillRect(0, 0, 480, 480);
    drawBar(
      ctx as unknown as CanvasRenderingContext2D,
      symbol,
      240,
      240,
      330,
      280,
      null,
      1,
      time,
    );
    return ctx.getImageData(0, 0, 480, 480);
  };
  const idle = draw(null, 0),
    moving = draw(null, 0.17);
  expect(moving.data).not.toEqual(idle.data);
  expect(scanBarPixels(moving).symbol).toBeNull();
  const symbol = splitBarFrame(
    splitFrames(new TextEncoder().encode("stable"))[0],
  )[0];
  expect(draw(symbol, 0).data).toEqual(draw(symbol, 0.17).data);
});
it.each(
  [0, 17, 32].flatMap((offset) => [40, 50].map((scanMs) => [offset, scanMs])),
)(
  "receives at 30fps capture with %sms phase offset / %sms scan and real spring pixels",
  (offset, scanMs) => {
    function reseal(s: Uint8Array) {
      s[20] &= 15;
      const crc = crc16(s.subarray(0, 21));
      s[20] |= (crc & 15) << 4;
      s[21] = crc >>> 4;
      s[22] = crc >>> 12;
    }
    const message = "cadence 한글 🌒";
    const symbols = splitFrames(new TextEncoder().encode(message)).flatMap(
      splitBarFrame,
    );
    const c = createCanvas(400, 400),
      ctx = c.getContext("2d"),
      fragments = new BarCollector(),
      collector = new Collector();
    let packet: Uint8Array | null = null;
    for (
      let scanTime = 0;
      scanTime < symbols.length * BAR_SYMBOL_MS * 2 && !packet;
      scanTime += scanMs
    ) {
      const time = Math.floor(scanTime / (1000 / 30)) * (1000 / 30) + offset;
      const index = Math.floor(time / BAR_SYMBOL_MS) % symbols.length,
        t = Math.min(1, (time % BAR_SYMBOL_MS) / BAR_TRANSITION_MS);
      const blend = t === 1 ? 1 : 1 - Math.exp(-6 * t) * Math.cos(8 * t);
      ctx.fillStyle = "#090909";
      ctx.fillRect(0, 0, 400, 400);
      drawBar(
        ctx as unknown as CanvasRenderingContext2D,
        symbols[index],
        200,
        200,
        330,
        280,
        symbols[(index + symbols.length - 1) % symbols.length],
        blend,
      );
      const result = scanBarPixels(ctx.getImageData(0, 0, 400, 400));
      if (result.symbol) {
        const frame = fragments.add(result.symbol);
        if (frame) packet = collector.add(frame);
      }
    }
    expect(new TextDecoder().decode(packet!)).toBe(message);
  },
);
it("CRC tag collisions cannot emit a mixed frame and valid repeats recover", async () => {
  const { createFrames } = await import("../src/protocol");
  const source = createFrames(new TextEncoder().encode("a".repeat(1048576)));
  const tags = new Map<number, Uint8Array>();
  let pair: Uint8Array[] | undefined;
  for (let index = 0; index < source.length; index++) {
    const frame = source.get(index),
      tag = new DataView(frame.buffer).getUint32(36) & 0x7ff;
    if (tags.has(tag)) {
      pair = [tags.get(tag)!, frame];
      break;
    }
    tags.set(tag, frame);
  }
  expect(pair).toBeDefined();
  const [a, b] = pair!.map(splitBarFrame),
    receiver = new BarCollector();
  expect(receiver.add(a[0])).toBeNull();
  expect(receiver.add(b[1])).toBeNull();
  expect(receiver.add(a[1])).toEqual(pair![0]);
  expect(receiver.add(b[1])).toBeNull();
  expect(receiver.add(b[0])).toEqual(pair![1]);
  source.clear();
  receiver.clear();
});
it("spreads changing frame data across both halves, including the fixed-header end", () => {
  const frames = splitFrames(
    new TextEncoder().encode(
      Array.from({ length: 200 }, (_, i) =>
        String.fromCharCode(32 + ((i * 71) % 95)),
      ).join(""),
    ),
  );
  const c = createCanvas(480, 400),
    ctx = c.getContext("2d");
  const images = frames.slice(0, 5).map((frame) => {
    ctx.fillStyle = "#090909";
    ctx.fillRect(0, 0, 480, 400);
    drawBar(
      ctx as unknown as CanvasRenderingContext2D,
      splitBarFrame(frame)[0],
      240,
      200,
      330,
      280,
    );
    return ctx.getImageData(0, 0, 480, 400).data;
  });
  for (const side of [0, 1]) {
    let changed = 0;
    for (let y = 0; y < 400; y++)
      for (let x = side * 240; x < (side + 1) * 240; x++) {
        const i = (y * 480 + x) * 4;
        if (images.some((image) => image[i] !== images[0][i])) changed++;
      }
    expect(changed).toBeGreaterThan(2500);
  }
});

it("rejects every single transported bit error, including packed metadata and CRC", () => {
  const [frame] = splitFrames(new TextEncoder().encode("all 180 bits"));
  for (const symbol of splitBarFrame(frame)) {
    for (let bit = 0; bit < 180; bit++) {
      const damaged = symbol.slice();
      damaged[bit >> 3] ^= 1 << (bit & 7);
      const receiver = new BarCollector();
      expect(receiver.add(damaged)).toBeNull();
      for (const other of splitBarFrame(frame).filter(
        (s) => !s.every((v, i) => v === symbol[i]),
      ))
        expect(receiver.add(other)).toBeNull();
      expect(receiver.add(symbol)).toEqual(frame);
    }
  }
});
