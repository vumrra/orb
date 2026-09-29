import { createCanvas } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import {
  BAR_COUNT,
  BAR_SYMBOL_MS,
  BAR_TRANSITION_MS,
  BarCollector,
  drawBar,
  BarTracker,
  splitBarFrame,
} from "../src/bar";
import { Collector, splitFrames } from "../src/protocol";
it.each([0, 17, 32])(
  "fewer thicker bars deliver 1000 uncompressed bytes from 30fps pixels within ten seconds (phase %sms)",
  (phase) => {
    let seed = 42;
    const bytes = Uint8Array.from({ length: 1000 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return 32 + ((seed >>> 24) % 95);
    });
    const symbols = splitFrames(bytes).flatMap(splitBarFrame),
      fragments = new BarCollector(),
      tracker = new BarTracker(),
      collector = new Collector();
    const c = createCanvas(480, 400),
      ctx = c.getContext("2d");
    let packet: Uint8Array | null = null,
      completed = 0;
    for (let time = 200 + phase; time < 10000 && !packet; time += 1000 / 30) {
      // Camera sees the most recent 60Hz render, after 200ms cold acquisition.
      const rendered = Math.floor(time / (1000 / 60)) * (1000 / 60);
      const index = Math.floor(rendered / BAR_SYMBOL_MS) % symbols.length,
        elapsed = rendered % BAR_SYMBOL_MS;
      const t = Math.min(1, elapsed / BAR_TRANSITION_MS),
        blend = t === 1 ? 1 : 1 - Math.exp(-6 * t) * Math.cos(8 * t);
      ctx.fillStyle = "#090909";
      ctx.fillRect(0, 0, 480, 400);
      drawBar(
        ctx as unknown as CanvasRenderingContext2D,
        symbols[index],
        240,
        200,
        330,
        280,
        symbols[(index + symbols.length - 1) % symbols.length],
        blend,
      );
      const scan = tracker.scan(ctx.getImageData(0, 0, 480, 400));
      if (scan.symbol) {
        const frame = fragments.add(scan.symbol);
        if (frame) packet = collector.add(frame);
      }
      completed = time;
    }
    expect(symbols).toHaveLength(102);
    expect(BAR_COUNT).toBeLessThan(34);
    expect(packet).toEqual(bytes);
    expect(completed).toBeLessThan(10000);
    expect(tracker.stats.trackedScans).toBeGreaterThan(20);
    expect(tracker.stats.fullScans).toBeLessThan(10);
    console.log(
      JSON.stringify({
        bar30fpsMs: completed,
        bars: BAR_COUNT,
        symbolMs: BAR_SYMBOL_MS,
      }),
    );
  },
);

it("Orb delivers 1000 original bytes at 30fps, tracking and re-acquiring after target movement", async () => {
  const { drawOptical, OpticalTracker, SYMBOL_MS } =
    await import("../src/optical");
  let seed = 42;
  const bytes = Uint8Array.from({ length: 1000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return 32 + ((seed >>> 24) % 95);
  });
  const frames = splitFrames(bytes),
    tracker = new OpticalTracker(),
    collector = new Collector();
  const c = createCanvas(640, 480),
    ctx = c.getContext("2d");
  let packet: Uint8Array | null = null,
    completed = 0;
  const began = performance.now();
  for (let time = 17; time < 10000 && !packet; time += 1000 / 30) {
    const index = Math.floor(time / SYMBOL_MS) % frames.length;
    ctx.fillStyle = "#090909";
    ctx.fillRect(0, 0, 640, 480);
    drawOptical(
      ctx as unknown as CanvasRenderingContext2D,
      frames[index],
      time < 3500 ? 420 : 200,
      240,
      165,
      time < 3500 ? 0.23 : 1.1,
      0.75 + time / 1000,
    );
    const scan = tracker.scan(ctx.getImageData(0, 0, 640, 480));
    if (scan.frame) packet = collector.add(scan.frame);
    completed = time;
  }
  expect(packet).toEqual(bytes);
  expect(completed).toBeLessThan(10000);
  console.log(
    JSON.stringify({
      orb30fpsMs: completed,
      simulationCpuMs: performance.now() - began,
    }),
  );
}, 20000);
