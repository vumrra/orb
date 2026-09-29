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
  "PCM at %i Hz carries 1000 original bytes in <10 seconds with offset/noise and arbitrary chunks",
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
    expect(duration).toBeLessThan(10);
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
