// Experimental axis-aligned optical transport, not the production QR protocol.
export const GRID = 256,
  W = 260,
  H = 270,
  TOP = 12;
export const capacity = (bits) => (GRID * GRID * bits) / 8;
const exp = new Uint8Array(512),
  log = new Uint8Array(256);
let field = 1;
for (let i = 0; i < 255; i++) {
  exp[i] = field;
  log[field] = i;
  field <<= 1;
  if (field & 256) field ^= 0x11d;
}
for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
const mul = (a, b) => (a && b ? exp[log[a] + log[b]] : 0);
const div = (a, b) => (a ? exp[(log[a] - log[b] + 255) % 255] : 0);
const weights = Array.from({ length: 8 }, (_, i) =>
  Uint8Array.from({ length: 256 }, (_, b) => mul(i + 1, b)),
);
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function palette(bits, n) {
  return bits === 1
    ? [32 + 192 * (n & 1), 32 + 192 * (n & 1), 32 + 192 * (n & 1)]
    : [
        32 + 192 * (n & 1),
        32 + 192 * ((n >> 1) & 1),
        bits === 3 ? 32 + 192 * ((n >> 2) & 1) : 128,
      ];
}
export async function source(bytes, bits) {
  if (![1, 2, 3].includes(bits) || !bytes.length || bytes.length > 30_000_000)
    throw Error("Unsupported input");
  if (!globalThis.crypto?.subtle)
    throw Error("Color-grid experiment requires HTTPS or localhost.");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const size = capacity(bits),
    total = Math.ceil(bytes.length / size),
    id = crypto.getRandomValues(new Uint32Array(1))[0];
  let cursor = 0;
  return {
    total,
    hash,
    frame() {
      const block = Math.floor(cursor / 10),
        slot = cursor % 10,
        index = block * 8 + slot;
      cursor = (cursor + 1) % (Math.ceil(total / 8) * 10);
      const parity = slot >= 8,
        payload = new Uint8Array(size);
      if (parity) {
        for (let s = 0; s < 8; s++) {
          const start = (block * 8 + s) * size;
          for (let j = 0; j < size && start + j < bytes.length; j++)
            payload[j] ^=
              slot === 9 ? weights[s][bytes[start + j]] : bytes[start + j];
        }
      } else
        payload.set(
          bytes.subarray(
            Math.min(index * size, bytes.length),
            Math.min((index + 1) * size, bytes.length),
          ),
        );
      const header = new Uint8Array(64),
        v = new DataView(header.buffer);
      header.set([67, 76, 71, 49]);
      v.setUint32(4, id);
      v.setUint32(8, bytes.length);
      v.setUint32(
        12,
        parity ? ((slot === 9 ? 0xc0000000 : 0x80000000) | block) >>> 0 : index,
      );
      v.setUint16(
        16,
        parity
          ? size
          : Math.max(0, Math.min(size, bytes.length - index * size)),
      );
      header[18] = bits;
      header.set(hash, 20);
      v.setUint32(52, crc(payload));
      v.setUint32(56, crc(header.subarray(0, 56)));
      return { header, payload, bits };
    },
  };
}
export function raster(frame) {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  const put = (x, y, c) => {
    const i = (y * W + x) * 4;
    pixels[i] = c[0];
    pixels[i + 1] = c[1];
    pixels[i + 2] = c[2];
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (x < 2 || x >= W - 2 || y < 2 || y >= H - 2)
        put(x, y, [255, 255, 255]);
  for (let y = 2; y < 10; y++)
    for (let x = 2; x < 258; x++)
      put(
        x,
        y,
        palette(frame.bits, Math.floor((x - 2) / 32) % (1 << frame.bits)),
      );
  for (let k = 0; k < 512; k++)
    put(
      2 + (k % 256),
      10 + Math.floor(k / 256),
      frame.header[k >> 3] & (1 << (k & 7)) ? [224, 224, 224] : [32, 32, 32],
    );
  const mask = (1 << frame.bits) - 1;
  for (let k = 0; k < GRID * GRID; k++) {
    const bit = k * frame.bits,
      i = bit >> 3,
      shift = bit & 7;
    const value =
      ((frame.payload[i] >> shift) |
        ((frame.payload[i + 1] ?? 0) << (8 - shift))) &
      mask;
    put(2 + (k % GRID), TOP + Math.floor(k / GRID), palette(frame.bits, value));
  }
  return { data: pixels, width: W, height: H };
}
export function decode(image) {
  if (image.width !== W || image.height !== H) return null;
  const p = image.data,
    at = (x, y, c) => (y * W + x) * 4 + c;
  const low = [255, 255, 255],
    high = [0, 0, 0];
  for (let n = 0; n < 8; n++)
    for (let c = 0; c < 3; c++) {
      const v = p[at(18 + n * 32, 5, c)];
      low[c] = Math.min(low[c], v);
      high[c] = Math.max(high[c], v);
    }
  if (high[0] - low[0] < 30) return null;
  const mid = low.map((v, i) => (v + high[i]) / 2),
    header = new Uint8Array(64);
  for (let k = 0; k < 512; k++)
    if (p[at(2 + (k % 256), 10 + Math.floor(k / 256), 0)] > mid[0])
      header[k >> 3] |= 1 << (k & 7);
  if (
    header[0] !== 67 ||
    header[1] !== 76 ||
    header[2] !== 71 ||
    header[3] !== 49
  )
    return null;
  const v = new DataView(header.buffer),
    bits = header[18];
  if (
    ![1, 2, 3].includes(bits) ||
    crc(header.subarray(0, 56)) !== v.getUint32(56) ||
    v.getUint32(8) > 30_000_000
  )
    return null;
  const payload = new Uint8Array(capacity(bits));
  for (let k = 0; k < GRID * GRID; k++) {
    const x = 2 + (k % GRID),
      y = TOP + Math.floor(k / GRID);
    let val = 0;
    for (let c = 0; c < bits; c++) if (p[at(x, y, c)] > mid[c]) val |= 1 << c;
    const bit = k * bits,
      i = bit >> 3,
      shift = bit & 7;
    payload[i] |= val << shift;
    if (shift + bits > 8) payload[i + 1] |= val >> (8 - shift);
  }
  if (crc(payload) !== v.getUint32(52)) return null;
  const rawIndex = v.getUint32(12),
    kind = rawIndex >>> 30,
    parity = kind >= 2,
    index = rawIndex & 0x3fffffff,
    length = v.getUint32(8),
    total = Math.ceil(length / payload.length),
    valid = v.getUint16(16);
  if (kind === 1) return null;
  if (
    index >= (parity ? Math.ceil(total / 8) : total) ||
    valid !==
      (parity
        ? payload.length
        : Math.min(payload.length, length - index * payload.length))
  )
    return null;
  return {
    id: v.getUint32(4),
    length,
    index,
    parity,
    kind,
    bits,
    payload,
    hash: header.slice(20, 52),
  };
}
export class Collector {
  constructor() {
    this.count = 0;
    this.repaired = 0;
    this.parities = new Map();
  }
  add(p) {
    if (!p) return false;
    if (!this.bytes) {
      this.id = p.id;
      this.hash = p.hash;
      this.size = p.payload.length;
      this.bytes = new Uint8Array(p.length);
      this.seen = new Uint8Array(Math.ceil(p.length / this.size));
    }
    if (
      p.id !== this.id ||
      p.length !== this.bytes.length ||
      p.payload.length !== this.size ||
      p.hash.some((v, i) => v !== this.hash[i])
    )
      return false;
    const store = (i, data) => {
      if (!this.seen[i]) {
        this.bytes.set(
          data.subarray(
            0,
            Math.min(this.size, this.bytes.length - i * this.size),
          ),
          i * this.size,
        );
        this.seen[i] = 1;
        this.count++;
      }
    };
    const block = p.parity ? p.index : Math.floor(p.index / 8);
    if (p.parity) {
      if (this.parities.size >= 128 && !this.parities.has(block))
        this.parities.delete(this.parities.keys().next().value);
      const pair = this.parities.get(block) || [];
      pair[p.kind - 2] = p.payload;
      this.parities.set(block, pair);
    } else store(p.index, p.payload);
    const pair = this.parities.get(block);
    if (pair) {
      const start = block * 8,
        end = Math.min(this.seen.length, start + 8),
        missing = [];
      for (let i = start; i < end; i++) if (!this.seen[i]) missing.push(i);
      if (
        missing.length > 0 &&
        missing.length <= 2 &&
        (missing.length === 1 || (pair[0] && pair[1]))
      ) {
        const residual = pair.map((parity, kind) => {
          const out = parity.slice();
          for (let i = start; i < end; i++)
            if (this.seen[i])
              for (
                let j = 0;
                j < this.size && i * this.size + j < this.bytes.length;
                j++
              )
                out[j] ^= kind
                  ? weights[i - start][this.bytes[i * this.size + j]]
                  : this.bytes[i * this.size + j];
          return out;
        });
        const a = missing[0] - start + 1,
          data = new Uint8Array(this.size);
        if (missing.length === 1) {
          for (let j = 0; j < this.size; j++)
            data[j] = residual[0] ? residual[0][j] : div(residual[1][j], a);
          store(missing[0], data);
        } else {
          const b = missing[1] - start + 1,
            second = new Uint8Array(this.size);
          for (let j = 0; j < this.size; j++) {
            data[j] = div(residual[1][j] ^ mul(b, residual[0][j]), a ^ b);
            second[j] = residual[0][j] ^ data[j];
          }
          store(missing[0], data);
          store(missing[1], second);
        }
        this.repaired += missing.length;
        this.parities.delete(block);
      } else if (!missing.length) this.parities.delete(block);
    }
    return this.count === this.seen.length;
  }
  async verify() {
    if (!this.bytes || this.count !== this.seen.length)
      throw Error("Incomplete");
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", this.bytes),
    );
    if (hash.some((v, i) => v !== this.hash[i])) throw Error("SHA mismatch");
    return hash;
  }
}
// Initial acquisition deliberately limited to a near-axis-aligned white border.
export function locate(image) {
  const { width: w, height: h, data: p } = image;
  let best = null;
  for (let y = 0; y < h; y += 2) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const i = (y * w + x) * 4,
        white = x < w && p[i] > 200 && p[i + 1] > 200 && p[i + 2] > 200;
      if (white && start < 0) start = x;
      if (!white && start >= 0) {
        const len = x - start;
        if (len > 100 && (!best || len > best.w))
          best = { x: start, y, w: len };
        start = -1;
      }
    }
  }
  if (!best) return null;
  // First longest white run is the upper outer edge; infer fixed board aspect.
  return { x: best.x, y: best.y, w: best.w, h: (best.w * H) / W };
}
