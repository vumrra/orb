import { expect, it } from "vitest";
import { ColorCollector, createColorSource } from "../src/color-grid";

it.each([2, 3, 4, 5])(
  "recovers a repeating 1/%i camera cadence without dozens of broadcast laps",
  async (divisor) => {
    const bytes = new Uint8Array(262144);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const source = await createColorSource(
      bytes,
      { kind: "file", name: "cadence.bin", mime: "" },
      undefined,
      128,
    );
    const receiver = new ColorCollector();
    const frames = source.total + Math.ceil(source.total / 8) * 2;
    let ready = false;
    for (let tick = 0; tick < frames * (divisor + 2) && !ready; tick++) {
      const packet = source.next();
      if (tick % divisor === 0) ready = receiver.add(packet);
      packet.fill(0);
    }
    try {
      expect(ready).toBe(true);
      const result = await receiver.verify();
      expect(result.bytes).toEqual(bytes);
      result.bytes.fill(0);
    } finally {
      source.clear();
      receiver.clear();
    }
  },
);
