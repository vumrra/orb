import { createCanvas } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import { createFrames, createWireFrames, Collector } from "../src/protocol";
import { prepareMessage, decodeMessage } from "../src/message";
import { drawOptical, decodePixels } from "../src/optical";
import {
  drawBar,
  scanBarPixels,
  splitBarFrame,
  BarCollector,
} from "../src/bar";

function roundtrip(frame: Uint8Array, transport: string) {
  const canvas = createCanvas(480, 480),
    ctx = canvas.getContext("2d"),
    bar = new BarCollector();
  let result: Uint8Array | null = null;
  for (const symbol of transport === "bar" ? splitBarFrame(frame) : [frame]) {
    ctx.fillStyle = "#090909";
    ctx.fillRect(0, 0, 480, 480);
    if (transport === "bar")
      drawBar(
        ctx as unknown as CanvasRenderingContext2D,
        symbol,
        240,
        240,
        330,
        280,
      );
    else
      drawOptical(
        ctx as unknown as CanvasRenderingContext2D,
        symbol,
        240,
        240,
        190,
        0.23,
        0.75,
      );
    const pixels = ctx.getImageData(0, 0, 480, 480);
    if (transport === "bar") {
      const scanned = scanBarPixels(pixels).symbol;
      expect(scanned).toEqual(symbol);
      result = bar.add(scanned!);
    } else result = decodePixels(pixels);
  }
  expect(result).toEqual(frame);
  return result!;
}
it.each(["orb", "bar"])(
  "samples 1MB uncompressed %s geometry across index boundaries and final padding",
  (transport) => {
    const data = new Uint8Array(1048576);
    let seed = 73;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = 32 + ((seed >>> 24) % 95);
    }
    const source = createFrames(data);
    for (const index of [0, 255, 256, 32767, 32768, source.length - 1])
      roundtrip(source.get(index), transport);
    source.clear();
  },
);
it.each(["orb", "bar"])(
  "full compressed 1MB %s raster -> Collector -> original UTF8",
  async (transport) => {
    const text = "a".repeat(1048576),
      wire = await prepareMessage(text),
      source = createWireFrames(wire),
      collector = new Collector(true);
    let packet: Uint8Array | null = null;
    for (let index = 0; index < source.length; index++)
      packet = collector.add(roundtrip(source.get(index), transport));
    expect(collector.prefix).toBe("");
    expect(await decodeMessage(packet!)).toBe(text);
    source.clear();
    collector.clear();
    wire.fill(0);
    packet!.fill(0);
  },
  15000,
);
