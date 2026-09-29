import { FRAME_BYTES, parseFrame } from "./protocol";
import {
  packSoundBurst,
  unpackSoundBurst,
  burstSize,
  SOUND_BURST_FRAMES,
} from "./sound-burst";

// Eight independent 4-FSK lanes: 16 bits per 16ms symbol, audible 875–4750Hz.
// Four clock/preamble symbols, 20 frame symbols, two silent guard symbols.
export const SOUND_SYMBOL_SECONDS = 0.016;
const PREAMBLE = [0x1b1b, 0xe4e4, 0x4e4e, 0xb1b1];
const frequency = (lane: number, value: number) =>
  875 + (lane * 4 + value) * 125;
export function encodeSound(frame: Uint8Array, rate: number): Float32Array {
  const parsed = parseFrame(frame);
  if (!parsed) throw new Error("Invalid sound frame.");
  parsed.chunk.fill(0);
  const words = [...PREAMBLE];
  for (let i = 0; i < FRAME_BYTES; i += 2)
    words.push(frame[i] | (frame[i + 1] << 8));
  return encodeWords(words, rate);
}
export function encodeSoundBurst(
  frames: Uint8Array[],
  rate: number,
): Float32Array {
  const code = packSoundBurst(frames);
  const words = [
    ...PREAMBLE.slice(0, 3),
    0x7272,
    frames.length | ((frames.length ^ 255) << 8),
  ];
  for (let i = 0; i < code.length; i += 2)
    words.push(code[i] | ((code[i + 1] ?? 0) << 8));
  code.fill(0);
  return encodeWords(words, rate);
}
function encodeWords(words: number[], rate: number) {
  const pcm = new Float32Array(
    Math.round((words.length + 2) * SOUND_SYMBOL_SECONDS * rate),
  );
  for (let s = 0; s < words.length; s++) {
    const begin = Math.round(s * SOUND_SYMBOL_SECONDS * rate);
    const end = Math.round((s + 1) * SOUND_SYMBOL_SECONDS * rate);
    for (let i = begin; i < end; i++) {
      const t = (i - begin) / rate;
      const edge = Math.min(1, t / 0.002, (end - i - 1) / (rate * 0.002));
      const ramp = (1 - Math.cos(Math.PI * edge)) / 2;
      let sample = 0;
      for (let lane = 0; lane < 8; lane++)
        sample += Math.sin(
          2 * Math.PI * frequency(lane, (words[s] >>> (lane * 2)) & 3) * t +
            lane * 1.7,
        );
      pcm[i] = sample * 0.025 * ramp;
    }
  }
  return pcm;
}

export class SoundDecoder {
  private samples = new Float32Array(0);
  private cursor = 0;
  private readonly step: number;
  private readonly window: number;
  private readonly coefficients: number[];
  private readonly taper: Float32Array;
  constructor(
    private rate: number,
    private onFrame: (frame: Uint8Array) => void,
    private onLevel: (level: number) => void = () => {},
  ) {
    this.step = Math.max(1, Math.round(rate * 0.001));
    this.window = Math.round(rate * 0.012);
    this.taper = Float32Array.from(
      { length: this.window },
      (_, i) => (1 - Math.cos((2 * Math.PI * i) / (this.window - 1))) / 2,
    );
    this.coefficients = Array.from(
      { length: 32 },
      (_, i) => 2 * Math.cos((2 * Math.PI * (875 + i * 125)) / rate),
    );
  }
  clear() {
    this.samples.fill(0);
    this.samples = new Float32Array(0);
    this.cursor = 0;
  }
  private word(at: number) {
    let word = 0,
      energy = 0;
    for (let i = 0; i < this.window; i++) energy += this.samples[at + i] ** 2;
    // Only exact silence is amplitude-gated. Confidence below is dimensionless.
    if (!(energy > 0)) return -1;
    for (let lane = 0; lane < 8; lane++) {
      let best = -1,
        second = -1,
        value = 0,
        total = 0;
      for (let v = 0; v < 4; v++) {
        const c = this.coefficients[lane * 4 + v];
        let a = 0,
          b = 0;
        for (let i = 0; i < this.window; i++) {
          const next = this.samples[at + i] * this.taper[i] + c * a - b;
          b = a;
          a = next;
        }
        const power = a * a + b * b - c * a * b;
        total += power;
        if (power > best) {
          second = best;
          best = power;
          value = v;
        } else second = Math.max(second, power);
      }
      // Unselected matched bins estimate local interference/noise each symbol.
      // Normalize by observed energy so microphone gain cannot alter confidence.
      const normalization = this.window * energy;
      const signal = best / normalization;
      const noise = (total - best) / (3 * normalization);
      if (signal < 0.0001 || signal < noise * 4 || best < second * 2) return -1;
      word |= value << (lane * 2);
    }
    return word;
  }
  push(chunk: Float32Array) {
    // Bound allocation even when a caller supplies an entire recording.
    if (chunk.length > 4096) {
      for (let i = 0; i < chunk.length; i += 4096)
        this.push(chunk.subarray(i, i + 4096));
      return;
    }
    // Retain at most one incomplete burst (about 4s), independent of callbacks.
    const joined = new Float32Array(
      this.samples.length - this.cursor + chunk.length,
    );
    joined.set(this.samples.subarray(this.cursor));
    joined.set(chunk, this.samples.length - this.cursor);
    this.samples.fill(0);
    this.samples = joined;
    this.cursor = 0;
    let energy = 0;
    for (const value of chunk) energy += value * value;
    this.onLevel(
      Math.min(1, Math.sqrt(energy / Math.max(1, chunk.length)) * 12),
    );
    const span = Math.ceil(24 * SOUND_SYMBOL_SECONDS * this.rate);
    while (this.cursor + span <= this.samples.length) {
      const at = this.cursor;
      let valid = true;
      for (let s = 0; s < 3; s++)
        if (
          this.word(at + Math.round(s * SOUND_SYMBOL_SECONDS * this.rate)) !==
          PREAMBLE[s]
        ) {
          valid = false;
          break;
        }
      if (
        valid &&
        this.word(at + Math.round(3 * SOUND_SYMBOL_SECONDS * this.rate)) ===
          0x7272
      ) {
        const marker = this.word(
          at + Math.round(4 * SOUND_SYMBOL_SECONDS * this.rate),
        );
        const count = marker & 255;
        if (
          count >= 1 &&
          count <= SOUND_BURST_FRAMES &&
          marker >>> 8 === (count ^ 255)
        ) {
          const size = burstSize(count),
            symbols = 5 + Math.ceil(size / 2);
          const needed = Math.ceil(
            symbols * SOUND_SYMBOL_SECONDS * this.rate * 1.0015,
          );
          if (at + needed > this.samples.length) break;
          let recovered: Uint8Array[] = [];
          for (const ratio of [1, 0.9985, 1.0015]) {
            const code = new Uint8Array(size),
              erasures: number[] = [];
            for (let s = 0; s < Math.ceil(size / 2); s++) {
              const word = this.word(
                at +
                  Math.round(
                    (s + 5) * SOUND_SYMBOL_SECONDS * this.rate * ratio,
                  ),
              );
              if (word < 0) {
                erasures.push(s * 2);
                if (s * 2 + 1 < size) erasures.push(s * 2 + 1);
              } else {
                code[s * 2] = word;
                if (s * 2 + 1 < size) code[s * 2 + 1] = word >>> 8;
              }
            }
            recovered = unpackSoundBurst(code, count, erasures);
            code.fill(0);
            if (recovered.length) break;
          }
          if (recovered.length) {
            this.cursor += Math.floor(
              symbols * SOUND_SYMBOL_SECONDS * this.rate * 0.9985,
            );
            try {
              for (const frame of recovered) this.onFrame(frame);
            } finally {
              recovered.forEach((f) => f.fill(0));
            }
            continue;
          }
        }
      }
      valid =
        valid &&
        this.word(at + Math.round(3 * SOUND_SYMBOL_SECONDS * this.rate)) ===
          PREAMBLE[3];
      if (valid) {
        const frame = new Uint8Array(FRAME_BYTES);
        for (let s = 0; s < 20; s++) {
          const word = this.word(
            at + Math.round((s + 4) * SOUND_SYMBOL_SECONDS * this.rate),
          );
          if (word < 0) {
            valid = false;
            break;
          }
          frame[s * 2] = word;
          frame[s * 2 + 1] = word >>> 8;
        }
        const parsed = valid ? parseFrame(frame) : null;
        if (parsed) {
          parsed.chunk.fill(0);
          this.cursor += span;
          try {
            this.onFrame(frame);
          } finally {
            frame.fill(0);
          }
          continue;
        }
        frame.fill(0);
      }
      this.cursor += this.step;
    }
  }
}
