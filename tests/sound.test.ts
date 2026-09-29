import { expect, it } from "vitest";
import { encodeSound, SoundDecoder, SOUND_SYMBOL_SECONDS } from "../src/sound";
import { Collector, splitFrames } from "../src/protocol";

function feed(decoder: SoundDecoder, pcm: Float32Array) {
  for (let i = 0; i < pcm.length;) {
    const n = 137 + (i % 997);
    decoder.push(pcm.subarray(i, i + n));
    i += n;
  }
}
it.each([44100, 48000])(
  "PCM at %i Hz carries 1000 original bytes in <22 seconds (narrow-band tradeoff) with offset/noise and arbitrary chunks",
  (rate) => {
    let seed = 42;
    const bytes = Uint8Array.from({ length: 1000 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return 32 + ((seed >>> 24) % 95);
    });
    const frames = splitFrames(bytes),
      collector = new Collector();
    let packet: Uint8Array | null = null;
    const decoder = new SoundDecoder(rate, (f) => {
      packet = collector.add(f) ?? packet;
    });
    let duration = 0.037;
    feed(decoder, new Float32Array(Math.round(rate * duration)));
    for (const frame of frames) {
      const pcm = encodeSound(frame, rate);
      duration += pcm.length / rate;
      for (let i = 0; i < pcm.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pcm[i] = pcm[i] * 0.7 + ((seed >>> 24) / 255 - 0.5) * 0.008;
      }
      feed(decoder, pcm);
    }
    expect(packet).toEqual(bytes);
    expect(1 / SOUND_SYMBOL_SECONDS).toBeGreaterThan(10);
    // 125Hz spacing and a 12ms tapered detector replace the harsh 250Hz-wide
    // spacing. 16ms symbols cost 2.67x airtime versus the former 6ms mode.
    expect(duration).toBeLessThan(22);
    console.log(
      JSON.stringify({
        soundRate: rate,
        originalBytes: bytes.length,
        pcmSeconds: duration,
      }),
    );
  },
);
it("rejects corrupt PCM, recovers after a dropped frame, ignores repeats and other senders", () => {
  const frames = splitFrames(
    new TextEncoder().encode("authentic sound with gaps and retries"),
  );
  const other = splitFrames(new TextEncoder().encode("another sender"));
  const collector = new Collector();
  let packet: Uint8Array | null = null;
  const decoder = new SoundDecoder(48000, (f) => {
    packet = collector.add(f) ?? packet;
  });
  feed(decoder, encodeSound(frames[0], 48000));
  feed(decoder, encodeSound(frames[0], 48000));
  feed(decoder, encodeSound(other[0], 48000));
  const bad = encodeSound(frames[1], 48000);
  bad.fill(0, 2000, 4000);
  feed(decoder, bad);
  expect(packet).toBeNull();
  for (const frame of frames.slice(1)) feed(decoder, encodeSound(frame, 48000));
  expect(new TextDecoder().decode(packet!)).toBe(
    "authentic sound with gaps and retries",
  );
  decoder.clear();
});
it.each([0.9985, 1.0015])(
  "reacquires preambles with sample clock ratio %s, noise and random phase",
  (ratio) => {
    const frames = splitFrames(
      new TextEncoder().encode("clock alignment 한글 🌒"),
    );
    const collector = new Collector();
    let packet: Uint8Array | null = null;
    const decoder = new SoundDecoder(48000, (f) => {
      packet = collector.add(f) ?? packet;
    });
    feed(decoder, new Float32Array(157));
    for (const frame of frames) {
      const pcm = encodeSound(frame, 48000),
        resampled = new Float32Array(Math.floor(pcm.length * ratio));
      for (let i = 0; i < resampled.length; i++) {
        const position = i / ratio,
          at = Math.floor(position),
          f = position - at;
        resampled[i] = (pcm[at] ?? 0) * (1 - f) + (pcm[at + 1] ?? 0) * f;
      }
      feed(decoder, resampled);
    }
    expect(new TextDecoder().decode(packet!)).toBe("clock alignment 한글 🌒");
  },
);
it("carries arbitrary v4 wide indices and final padding from a lazy 1MB source", async () => {
  const { createFrames } = await import("../src/protocol");
  const source = createFrames(new TextEncoder().encode("z".repeat(1048576)));
  for (const index of [0, 255, 256, 32768, source.length - 1]) {
    const frame = source.get(index);
    let received: Uint8Array | undefined;
    const decoder = new SoundDecoder(44100, (f) => {
      received = f.slice();
    });
    feed(decoder, encodeSound(frame, 44100));
    expect(received).toEqual(frame);
    decoder.clear();
  }
  source.clear();
});

it.each([44100, 48000])(
  "quiet PCM at %i Hz remains decodable without raising transmit volume",
  (rate) => {
    const bytes = new TextEncoder().encode("quiet transmission 한글");
    const collector = new Collector();
    let packet: Uint8Array | null = null;
    const decoder = new SoundDecoder(rate, (f) => {
      packet = collector.add(f) ?? packet;
    });
    let seed = 19;
    for (const frame of splitFrames(bytes)) {
      const pcm = encodeSound(frame, rate);
      for (let i = 0; i < pcm.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pcm[i] = pcm[i] * 0.025 + ((seed >>> 24) / 255 - 0.5) * 0.0002;
      }
      feed(decoder, pcm);
    }
    expect(packet).toEqual(bytes);
  },
);

// Synthetic channel fixtures; these do not measure a physical room.
function ambient(i: number, rate: number, random: number) {
  const t = i / rate;
  return (
    0.006 * Math.sin(2 * Math.PI * 90 * t) +
    0.0015 * Math.sin(2 * Math.PI * 180 * t) +
    0.0008 * Math.sin(2 * Math.PI * 540 * t) +
    0.00012 * Math.sin(2 * Math.PI * 2123 * t) +
    0.0007 * random
  );
}
it.each([44100, 48000])(
  "weak PCM survives rumble, voiced harmonics, interference, noise and 2ms echo at %i Hz",
  (rate) => {
    const frames = splitFrames(
      new TextEncoder().encode("weak sound with ambient noise"),
    );
    for (const gain of [0.1, 1, 10])
      for (const noiseScale of [0.5, 1, 1.5]) {
        const received: Uint8Array[] = [];
        const decoder = new SoundDecoder(rate, (f) => received.push(f.slice()));
        let seed = 91;
        feed(decoder, new Float32Array(173));
        for (const frame of frames) {
          const clean = encodeSound(frame, rate);
          const mixed = Float32Array.from(clean, (v, i) => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return (
              gain *
              (0.025 * (v + 0.25 * (clean[i - Math.round(rate * 0.002)] ?? 0)) +
                noiseScale * ambient(i, rate, seed / 4294967296 - 0.5))
            );
          });
          feed(decoder, mixed);
        }
        expect(received).toEqual(frames);
      }
  },
);
it("accepts no frames from silence or standalone ambient noise at varied gain", () => {
  let count = 0,
    seed = 7;
  const decoder = new SoundDecoder(48000, () => count++);
  feed(decoder, new Float32Array(48000));
  for (const gain of [0.01, 1, 10]) {
    const noise = Float32Array.from({ length: 48000 }, (_, i) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return gain * ambient(i, 48000, seed / 4294967296 - 0.5);
    });
    feed(decoder, noise);
  }
  expect(count).toBe(0);
});

it("keeps high-frequency PCM energy low and smoothly enters each symbol", () => {
  const rate = 48000;
  const pcm = encodeSound(
    splitFrames(new TextEncoder().encode("tone"))[0],
    rate,
  );
  const n = Math.round(rate * SOUND_SYMBOL_SECONDS);
  let high = 0,
    total = 0;
  // DFT of an actual preamble symbol, including its attack/release envelope.
  for (let bin = 1; bin <= n / 2; bin++) {
    let re = 0,
      im = 0;
    for (let i = 0; i < n; i++) {
      re += pcm[i] * Math.cos((2 * Math.PI * bin * i) / n);
      im += pcm[i] * Math.sin((2 * Math.PI * bin * i) / n);
    }
    const power = re * re + im * im;
    total += power;
    if ((bin * rate) / n > 6000) high += power;
  }
  expect(high / total).toBeLessThan(0.001);
  expect(Math.abs(pcm[0])).toBe(0);
  expect(Math.abs(pcm[1])).toBeLessThan(0.00003);
  expect(Math.abs(pcm[n - 1])).toBe(0);
});
