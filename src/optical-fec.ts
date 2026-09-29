import { crc32, parseFrame, type Frame, type FrameSource } from "./protocol";
import { ENVELOPE_BYTES, MAX_WIRE_BYTES } from "./message";

// GF(256), primitive polynomial x^8+x^4+x^3+x^2+1. Shortened RS(60,40).
const exp = new Uint8Array(510),
  log = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  exp[i] = x;
  log[x] = i;
  x <<= 1;
  if (x & 256) x ^= 0x11d;
}
for (let i = 255; i < 510; i++) exp[i] = exp[i - 255];
const mul = (a: number, b: number) => (a && b ? exp[log[a] + log[b]] : 0);
const div = (a: number, b: number) => {
  if (!b) throw new Error("Zero GF divisor");
  return a ? exp[(log[a] - log[b] + 255) % 255] : 0;
};
function product(a: number[], b: number[]) {
  const out = Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) out[i + j] ^= mul(a[i], b[j]);
  return out;
}
let generator = [1];
for (let i = 0; i < 20; i++) generator = product(generator, [1, exp[i]]);
export function rsEncode(data: Uint8Array) {
  if (data.length !== 40) throw new Error("RS message must be 40 bytes");
  const out = new Uint8Array(60);
  out.set(data);
  for (let i = 0; i < 40; i++) {
    const c = out[i];
    for (let j = 1; j <= 20; j++) out[i + j] ^= mul(generator[j], c);
  }
  out.set(data);
  return out;
}
const evaluate = (p: ArrayLike<number>, x: number) => {
  let v = 0;
  for (let i = 0; i < p.length; i++) v = mul(v, x) ^ p[i];
  return v;
};
function locator(s: number[]) {
  let c = [1],
    b = [1],
    length = 0,
    shift = 1,
    last = 1;
  for (let n = 0; n < s.length; n++) {
    let delta = s[n];
    for (let i = 1; i <= length; i++) delta ^= mul(c[i] || 0, s[n - i]);
    if (!delta) {
      shift++;
      continue;
    }
    const before = c.slice(),
      factor = div(delta, last);
    while (c.length < b.length + shift) c.push(0);
    for (let i = 0; i < b.length; i++) c[i + shift] ^= mul(factor, b[i]);
    if (2 * length <= n) {
      length = n + 1 - length;
      b = before;
      last = delta;
      shift = 1;
    } else shift++;
  }
  return c.slice(0, length + 1);
}
export function rsDecode(
  code: Uint8Array,
  erasures: number[] = [],
): Uint8Array | null {
  if (
    code.length !== 60 ||
    erasures.length > 20 ||
    new Set(erasures).size !== erasures.length ||
    erasures.some((p) => !Number.isInteger(p) || p < 0 || p >= 60)
  )
    return null;
  const syndromes = Array.from({ length: 20 }, (_, i) =>
    evaluate(code, exp[i]),
  );
  if (syndromes.every((s) => s === 0)) return code.slice(0, 40);
  let reduced = syndromes.slice(),
    known = [1];
  for (const p of erasures) {
    const x = exp[59 - p];
    known = product(known, [1, x]);
    reduced = reduced.slice(1).map((s, i) => s ^ mul(x, reduced[i]));
  }
  const unknown = locator(reduced);
  if (2 * (unknown.length - 1) + erasures.length > 20) return null;
  const loc = product(known, unknown),
    positions: number[] = [];
  for (let p = 0; p < 60; p++)
    if (evaluate(loc.slice().reverse(), exp[(255 - (59 - p)) % 255]) === 0)
      positions.push(p);
  const n = loc.length - 1;
  if (!n || positions.length !== n) return null;
  // Solve at most a 20x20 Vandermonde system; never a message-sized matrix.
  const rows = Array.from({ length: n }, (_, i) => [
    ...positions.map((p) => exp[((59 - p) * i) % 255]),
    syndromes[i],
  ]);
  for (let c = 0; c < n; c++) {
    const pivot = rows.findIndex((r, i) => i >= c && r[c] !== 0);
    if (pivot < 0) return null;
    [rows[c], rows[pivot]] = [rows[pivot], rows[c]];
    const factor = rows[c][c];
    for (let j = c; j <= n; j++) rows[c][j] = div(rows[c][j], factor);
    for (let i = 0; i < n; i++)
      if (i !== c) {
        const f = rows[i][c];
        for (let j = c; j <= n; j++) rows[i][j] ^= mul(f, rows[c][j]);
      }
  }
  const out = code.slice();
  positions.forEach((p, i) => (out[p] ^= rows[i][n]));
  if (Array.from({ length: 20 }, (_, i) => evaluate(out, exp[i])).some(Boolean))
    return null;
  return out.slice(0, 40); // Caller MUST still validate the frame CRC and metadata.
}
const get24 = (b: Uint8Array, p: number) =>
  b[p] * 65536 + b[p + 1] * 256 + b[p + 2];
const set24 = (b: Uint8Array, p: number, v: number) => {
  b[p] = v >>> 16;
  b[p + 1] = v >>> 8;
  b[p + 2] = v;
};
function seal(b: Uint8Array) {
  new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(
    36,
    crc32(b.subarray(0, 36)),
  );
  return b;
}
export function parseOpticalFrame(b: Uint8Array): Frame | null {
  if (b[1] !== 5) return parseFrame(b);
  if (
    b.length !== 40 ||
    b[0] !== 0x4f ||
    crc32(b.subarray(0, 36)) !==
      new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(36)
  )
    return null;
  const length = get24(b, 13),
    total = Math.ceil(length / 20),
    index = get24(b, 10);
  if (
    length <= ENVELOPE_BYTES ||
    length > MAX_WIRE_BYTES ||
    index >= Math.ceil(total / 8) * 2
  )
    return null;
  return {
    id: Array.from(b.subarray(2, 10), (v) =>
      v.toString(16).padStart(2, "0"),
    ).join(""),
    index,
    length,
    total,
    chunk: b.slice(16, 36),
  };
}
// Borrow the original source. Clearing this adapter never clears its owner's buffer.
export function opticalFrames(source: FrameSource): FrameSource {
  const total = source.length,
    length = total + Math.ceil(total / 8) * 2;
  let closed = false,
    cacheBlock = -1,
    parity: Uint8Array[] = [];
  return {
    length,
    get(index) {
      if (
        closed ||
        !source.length ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= length
      )
        throw new Error("Optical index out of bounds");
      const block = Math.floor(index / 10),
        count = Math.min(8, total - block * 8),
        slot = index % 10;
      // Four data, parity 0, remaining data, parity 1 (also for truncated groups).
      const first = Math.min(4, count);
      if (slot < first) return source.get(block * 8 + slot);
      if (slot > first && slot <= count)
        return source.get(block * 8 + slot - 1);
      if (cacheBlock !== block) {
        parity.forEach((p) => p.fill(0));
        parity = [];
        const header = source.get(block * 8);
        for (let p = 0; p < 2; p++) {
          const b = header.slice();
          b[1] = 5;
          set24(b, 10, block * 2 + p);
          b.fill(0, 16, 40);
          parity.push(b);
        }
        header.fill(0);
        for (let i = 0; i < count; i++) {
          const b = source.get(block * 8 + i);
          for (let j = 0; j < 20; j++) {
            parity[0][16 + j] ^= b[16 + j];
            parity[1][16 + j] ^= mul(exp[i], b[16 + j]);
          }
          b.fill(0);
        }
        parity.forEach(seal);
        cacheBlock = block;
      }
      return parity[slot === first ? 0 : 1].slice();
    },
    clear() {
      closed = true;
      this.length = 0;
      parity.forEach((p) => p.fill(0));
      parity = [];
    },
  };
}
type Block = { mask: number; parity: number; s: Uint8Array };
export class OpticalRecovery {
  private meta: Frame | null = null;
  private header = new Uint8Array();
  private seen = new Uint8Array();
  // Two 20-byte syndromes per incomplete block, no retained data payloads.
  private blocks = new Map<number, Block>();
  add(bytes: Uint8Array): Uint8Array[] {
    const f = parseOpticalFrame(bytes);
    if (!f) return [];
    f.chunk.fill(0);
    if (this.meta && (f.id !== this.meta.id || f.length !== this.meta.length))
      return [];
    if (!this.meta) {
      this.meta = f;
      this.header = bytes.slice(0, 16);
      this.seen = new Uint8Array(f.total);
    }
    const isParity = bytes[1] === 5,
      blockIndex = isParity ? Math.floor(f.index / 2) : Math.floor(f.index / 8),
      base = blockIndex * 8,
      count = Math.min(8, f.total - base);
    if (Array.from(this.seen.subarray(base, base + count)).every(Boolean))
      return [];
    let b = this.blocks.get(blockIndex);
    if (!b) {
      b = { mask: 0, parity: 0, s: new Uint8Array(40) };
      this.blocks.set(blockIndex, b);
    }
    const out: Uint8Array[] = [];
    if (isParity) {
      const p = f.index % 2;
      if (b.parity & (1 << p)) return [];
      b.parity |= 1 << p;
      for (let j = 0; j < 20; j++) b.s[p * 20 + j] ^= bytes[16 + j];
    } else {
      if (this.seen[f.index]) return [];
      this.seen[f.index] = 1;
      b.mask |= 1 << (f.index % 8);
      out.push(bytes.slice());
      for (let j = 0; j < 20; j++) {
        b.s[j] ^= bytes[16 + j];
        b.s[20 + j] ^= mul(exp[f.index % 8], bytes[16 + j]);
      }
    }
    const missing = Array.from({ length: count }, (_, i) => i).filter(
      (i) => !(b!.mask & (1 << i)),
    );
    if (
      (missing.length === 1 && b.parity) ||
      (missing.length === 2 && b.parity === 3)
    ) {
      const chunks = missing.map(() => new Uint8Array(20));
      for (let j = 0; j < 20; j++) {
        if (missing.length === 1)
          chunks[0][j] =
            b.parity & 1 ? b.s[j] : div(b.s[20 + j], exp[missing[0]]);
        else {
          chunks[0][j] = div(
            b.s[20 + j] ^ mul(exp[missing[1]], b.s[j]),
            exp[missing[0]] ^ exp[missing[1]],
          );
          chunks[1][j] = b.s[j] ^ chunks[0][j];
        }
      }
      const recovered = chunks.map((chunk, i) => {
        const frame = new Uint8Array(40);
        frame.set(this.header);
        frame[1] = 4;
        set24(frame, 10, base + missing[i]);
        frame.set(chunk, 16);
        chunk.fill(0);
        return seal(frame);
      });
      // Reject nonzero padding in a reconstructed final fragment. Final body CRC remains mandatory.
      if (
        recovered.every((frame) => {
          const parsed = parseFrame(frame);
          parsed?.chunk.fill(0);
          return !!parsed;
        })
      ) {
        for (let i = 0; i < missing.length; i++) {
          this.seen[base + missing[i]] = 1;
          b.mask |= 1 << missing[i];
        }
        out.push(...recovered);
      } else recovered.forEach((f) => f.fill(0));
    }
    if (b.mask === (1 << count) - 1) {
      b.s.fill(0);
      this.blocks.delete(blockIndex);
    }
    return out;
  }
  clear() {
    this.header.fill(0);
    this.header = new Uint8Array();
    this.seen.fill(0);
    this.seen = new Uint8Array();
    for (const b of this.blocks.values()) b.s.fill(0);
    this.blocks.clear();
    this.meta = null;
  }
}
