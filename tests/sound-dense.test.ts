import { expect, it } from "vitest";
import * as sound from "../src/sound";
import { createFrames, Collector, crc32 } from "../src/protocol";
it.each([44100, 48000])(
  "dense protected runtime format carries 1000 bytes under 9.7 seconds at %i",
  (rate) => {
    expect(sound).toHaveProperty("encodeSoundBurst");
    let seed = 42;
    const bytes = Uint8Array.from({ length: 1000 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return 32 + ((seed >>> 24) % 95);
    });
    const source = createFrames(bytes),
      collector = new Collector();
    let result: Uint8Array | null = null,
      duration = 0;
    const decoder = new sound.SoundDecoder(rate, (f) => {
      result = collector.add(f) ?? result;
    });
    for (let start = 0; start < source.length; start += 22) {
      const frames = Array.from(
        { length: Math.min(22, source.length - start) },
        (_, i) => source.get(start + i),
      );
      const pcm = sound.encodeSoundBurst(frames, rate);
      duration += pcm.length / rate;
      for (let i = 0; i < pcm.length; i += 1024)
        decoder.push(pcm.subarray(i, i + 1024));
    }
    expect(result).toEqual(bytes);
    expect(duration).toBeLessThan(9.7);
    console.log({ rate, denseSeconds: duration });
    source.clear();
    decoder.clear();
  },
);

import { packSoundBurst, unpackSoundBurst } from "../src/sound-burst";
import { rsEncode, rsDecode } from "../src/sound-fec";
it("shortened RS corrects errors plus erasures within its bound", () => {
  for (const size of [1, 40, 91, 231, 239]) {
    const data = Uint8Array.from({ length: size }, (_, i) => i * 71),
      code = rsEncode(data);
    for (let i = 0; i < 12; i++) code[i] ^= 31 + i;
    expect(
      rsDecode(
        code,
        Array.from({ length: 8 }, (_, i) => i),
      ),
    ).toEqual(data);
    expect(
      rsDecode(
        code,
        Array.from({ length: 17 }, (_, i) => i),
      ),
    ).toBeNull();
  }
});
it("protects all metadata and payload before emitting exact original frames", () => {
  const source = createFrames(new TextEncoder().encode("x".repeat(1048576)));
  for (const start of [0, 255, 256, 32768, source.length - 22]) {
    const frames = Array.from({ length: 22 }, (_, i) => source.get(start + i));
    const code = packSoundBurst(frames);
    for (let i = 20; i < 36; i++) code[i] ^= 91; // 8 unknown errors in each interleaved word
    expect(unpackSoundBurst(code, 22)).toEqual(frames);
    for (let i = 70; i < 110; i++) code[i] ^= 37;
    expect(unpackSoundBurst(code, 22)).toEqual([]);
  }
  source.clear();
});
it.each([44100, 48000])(
  "dense low gain .02 with ambient noise, echo and 96ms dropout at %i",
  (rate) => {
    const source = createFrames(
      new TextEncoder().encode("quiet dense acoustic transport ".repeat(13)),
    );
    const frames = Array.from({ length: source.length }, (_, i) =>
      source.get(i),
    );
    const clean = sound.encodeSoundBurst(frames, rate);
    let seed = 19;
    const pcm = Float32Array.from(clean, (v, i) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const t = i / rate;
      const signal =
        i > rate * 0.8 && i < rate * 0.896
          ? 0
          : v + 0.25 * (clean[i - Math.round(rate * 0.002)] ?? 0);
      return (
        0.02 * signal +
        0.006 * Math.sin(2 * Math.PI * 90 * t) +
        0.0015 * Math.sin(2 * Math.PI * 180 * t) +
        0.00012 * Math.sin(2 * Math.PI * 2123 * t) +
        0.0005 * (seed / 4294967296 - 0.5)
      );
    });
    const got: Uint8Array[] = [];
    const decoder = new sound.SoundDecoder(rate, (f) => got.push(f.slice()));
    decoder.push(new Float32Array(173));
    for (let i = 0; i < pcm.length;) {
      const n = 137 + (i % 997);
      decoder.push(pcm.subarray(i, i + n));
      i += n;
    }
    expect(got).toEqual(frames);
    source.clear();
    decoder.clear();
  },
);
it.each([0.9985, 1.0015])("dense clock drift %s", (ratio) => {
  const source = createFrames(new TextEncoder().encode("drift ".repeat(70)));
  const frames = Array.from({ length: source.length }, (_, i) => source.get(i));
  const pcm = sound.encodeSoundBurst(frames, 48000);
  const resampled = Float32Array.from(
    { length: Math.floor(pcm.length * ratio) },
    (_, i) => {
      const at = i / ratio,
        p = Math.floor(at),
        f = at - p;
      return (pcm[p] ?? 0) * (1 - f) + (pcm[p + 1] ?? 0) * f;
    },
  );
  const got: Uint8Array[] = [];
  const decoder = new sound.SoundDecoder(48000, (f) => got.push(f.slice()));
  decoder.push(new Float32Array(157));
  for (let i = 0; i < resampled.length; i += 1024)
    decoder.push(resampled.subarray(i, i + 1024));
  expect(got).toEqual(frames);
  source.clear();
  decoder.clear();
});
it("rejects CRC damage even with valid Reed Solomon parity; rejects mixed senders", () => {
  const a = createFrames(new TextEncoder().encode("a".repeat(400))),
    b = createFrames(new TextEncoder().encode("b".repeat(400)));
  const frames = Array.from({ length: 20 }, (_, i) => a.get(i));
  expect(() => packSoundBurst([a.get(0), b.get(1)])).toThrow("Nonconsecutive");
  const encoded = packSoundBurst(frames),
    lanes = [0, 1].map((l) => rsDecode(encoded.filter((_, i) => i % 2 === l))!);
  lanes[0][40] ^= 64; // Re-encode tampered payload without updating its protected burst CRC.
  const codes = lanes.map(rsEncode),
    bad = Uint8Array.from(encoded, (_, i) => codes[i % 2][Math.floor(i / 2)]);
  expect(unpackSoundBurst(bad, 20)).toEqual([]);
  a.clear();
  b.clear();
});
it("dense repeats and interleaved senders cannot mix Collector messages", () => {
  const bytes = new TextEncoder().encode("sender one ".repeat(70)),
    a = createFrames(bytes),
    b = createFrames(new TextEncoder().encode("other ".repeat(120)));
  const collector = new Collector();
  let result: Uint8Array | null = null;
  const decoder = new sound.SoundDecoder(48000, (f) => {
    result = collector.add(f) ?? result;
  });
  for (const [source, start] of [
    [a, 0],
    [b, 0],
    [a, 0],
    [a, 22],
  ] as const) {
    const pcm = sound.encodeSoundBurst(
      Array.from({ length: Math.min(22, source.length - start) }, (_, i) =>
        source.get(start + i),
      ),
      48000,
    );
    for (let i = 0; i < pcm.length; i += 1024)
      decoder.push(pcm.subarray(i, i + 1024));
  }
  expect(result).toEqual(bytes);
  a.clear();
  b.clear();
  decoder.clear();
});
it("does not emit before the complete protected burst; clear zeroes retained samples", () => {
  const source = createFrames(new TextEncoder().encode("q".repeat(400)));
  const frames = Array.from({ length: source.length }, (_, i) => source.get(i));
  const pcm = sound.encodeSoundBurst(frames, 48000);
  let count = 0;
  const decoder = new sound.SoundDecoder(48000, () => count++);
  decoder.push(pcm.subarray(0, pcm.length - 4000));
  expect(count).toBe(0);
  const retained = (decoder as unknown as { samples: Float32Array }).samples;
  expect(retained.length).toBeLessThan(200000);
  decoder.clear();
  expect(retained.every((v) => v === 0)).toBe(true);
  decoder.push(pcm.subarray(pcm.length - 4000));
  expect(count).toBe(0);
  source.clear();
});
it("bounds retained working PCM even for one huge callback", () => {
  let largest = 0;
  const decoder = new sound.SoundDecoder(
    48000,
    () => {
      throw new Error("noise frame");
    },
    () => {
      largest = Math.max(
        largest,
        (decoder as unknown as { samples: Float32Array }).samples.length,
      );
    },
  );
  decoder.push(new Float32Array(1000000));
  expect(largest).toBeLessThan(210000);
  decoder.clear();
});
it("still requires the final message checksum after valid burst/frame checksums", () => {
  const source = createFrames(
    new TextEncoder().encode("final message integrity ".repeat(10)),
  );
  const frames = Array.from({ length: source.length }, (_, i) => source.get(i));
  frames[2][20] ^= 1;
  new DataView(frames[2].buffer).setUint32(
    36,
    crc32(frames[2].subarray(0, 36)),
  );
  const recovered = unpackSoundBurst(packSoundBurst(frames), frames.length);
  expect(recovered).toEqual(frames);
  const collector = new Collector();
  expect(() => recovered.forEach((f) => collector.add(f))).toThrow(/checksum/i);
  expect(collector.count).toBe(0);
  source.clear();
});
