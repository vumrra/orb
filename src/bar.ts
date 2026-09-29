import { FRAME_BYTES, parseFrame } from "./protocol";

// 30 data bars plus two rails: two 180-bit symbols carry a v4 frame.
// Only the fixed magic/version are reconstructed; sender ID and frame CRC remain intact.
export const BAR_COUNT = 32;
export const BAR_SYMBOL_MS = 70;
export const BAR_TRANSITION_MS = 4;
const SYMBOL_BYTES = 23;
const BASE = 0.15,
  STEP = 0.04;
type Point = { x: number; y: number };
type Pixels = { width: number; height: number; data: Uint8ClampedArray };
// CRC-16/CCITT-FALSE protects each fragment. The original CRC32 protects reassembly.
export function crc16(bytes: Uint8Array) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++)
      crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}
// 19 frame bytes, 11-bit routing tag + fragment bit, then CRC16: 180 bits.
// CRC occupies the upper nibble of byte 20, byte 21 and lower nibble of byte 22.
function symbolCRC(s: Uint8Array) {
  const bytes = s.slice(0, 21);
  bytes[20] &= 15;
  return crc16(bytes);
}
function validSymbol(s: Uint8Array) {
  return (
    s.length === SYMBOL_BYTES &&
    s[22] < 16 &&
    ((s[20] >>> 4) | (s[21] << 4) | (s[22] << 12)) === symbolCRC(s)
  );
}
export function splitBarFrame(frame: Uint8Array): Uint8Array[] {
  const parsed = parseFrame(frame);
  if (!parsed) throw new Error("Invalid bar frame.");
  parsed.chunk.fill(0);
  const tag =
    new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(
      36,
    ) & 0x7ff;
  return [0, 1].map((index) => {
    const symbol = new Uint8Array(SYMBOL_BYTES),
      view = new DataView(symbol.buffer);
    symbol.set(frame.subarray(2 + index * 19, 2 + (index + 1) * 19));
    view.setUint16(19, tag | (index << 11), true);
    const crc = symbolCRC(symbol);
    symbol[20] |= (crc & 15) << 4;
    symbol[21] = crc >>> 4;
    symbol[22] = crc >>> 12;
    return symbol;
  });
}
export class BarCollector {
  // Tags route fragments, never authenticate them. A collision can only cause a retry:
  // both original frame CRC32 and the Collector's 64-bit sender lock still apply.
  private pending = new Map<number, (Uint8Array | undefined)[]>();
  clear() {
    for (const parts of this.pending.values())
      for (const part of parts) part?.fill(0);
    this.pending.clear();
  }
  add(s: Uint8Array): Uint8Array | null {
    if (!validSymbol(s)) return null;
    const value = new DataView(s.buffer, s.byteOffset, s.byteLength).getUint16(
      19,
      true,
    );
    const tag = value & 0x7ff,
      index = (value >>> 11) & 1;
    let parts = this.pending.get(tag);
    if (!parts) {
      if (this.pending.size >= 64) {
        const oldest = this.pending.keys().next().value!;
        for (const part of this.pending.get(oldest)!) part?.fill(0);
        this.pending.delete(oldest);
      }
      parts = [];
      this.pending.set(tag, parts);
    }
    parts[index]?.fill(0);
    parts[index] = s.slice(0, 19);
    if (!parts[0] || !parts[1]) return null;
    const frame = new Uint8Array(FRAME_BYTES);
    frame.set([0x4f, 4]);
    frame.set(parts[0], 2);
    frame.set(parts[1], 21);
    const parsed = parseFrame(frame);
    const matches =
      parsed && (new DataView(frame.buffer).getUint32(36) & 0x7ff) === tag;
    parsed?.chunk.fill(0);
    if (matches) {
      for (const part of parts) part?.fill(0);
      this.pending.delete(tag);
      return frame;
    }
    frame.fill(0);
    return null;
  }
}
function mix(symbol: Uint8Array, inverse = false) {
  const out = symbol.slice();
  if (inverse) {
    for (let i = 0; i < out.length - 1; i++) out[i] ^= out[i + 1];
    for (let i = out.length - 1; i > 0; i--) out[i] ^= out[i - 1];
    out[out.length - 1] &= 15;
  } else {
    for (let i = 1; i < out.length; i++) out[i] ^= out[i - 1];
    out[out.length - 1] &= 15;
    for (let i = out.length - 2; i >= 0; i--) out[i] ^= out[i + 1];
  }
  return out;
}
function level(symbol: Uint8Array, endpoint: number) {
  let value = 0;
  for (let j = 0; j < 3; j++) {
    const bit = ((endpoint * 3 + j) * 53) % 180;
    value |= ((symbol[bit >> 3] >> (bit & 7)) & 1) << j;
  }
  return value;
}
export function drawBar(
  ctx: CanvasRenderingContext2D,
  symbol: Uint8Array | null,
  cx: number,
  cy: number,
  width: number,
  height: number,
  previous: Uint8Array | null = null,
  blend = 1,
  time = 0,
) {
  const coded = symbol ? mix(symbol) : null,
    prior = previous ? mix(previous) : null;
  const pitch = width / 31,
    thickness = pitch * 0.68;
  ctx.fillStyle = "#ffffff";
  for (let i = 0; i < BAR_COUNT; i++) {
    let top = 0.5,
      bottom = 0.5;
    if (i > 0 && i < 31) {
      const endpoint = (i - 1) * 2;
      const a = coded
        ? level(coded, endpoint)
        : 3.5 + 3.5 * Math.sin(time * 18 + i * 1.7);
      const b = coded
        ? level(coded, endpoint + 1)
        : 3.5 + 3.5 * Math.sin(time * 18 + i * 1.7 + 1);
      top =
        BASE +
        STEP * (prior ? level(prior, endpoint) * (1 - blend) + a * blend : a);
      bottom =
        BASE +
        STEP *
          (prior ? level(prior, endpoint + 1) * (1 - blend) + b * blend : b);
    }
    ctx.fillRect(
      cx - width / 2 + i * pitch - thickness / 2,
      cy - top * height,
      thickness,
      (top + bottom) * height,
    );
  }
  // Fixed reference dots stay outside every animated endpoint and inside the canvas.
  const radius = width / 100;
  for (const x of [-0.5, 0.5])
    for (const y of [-0.56, 0.56]) {
      ctx.beginPath();
      ctx.arc(cx + x * width, cy + y * height, radius, 0, Math.PI * 2);
      ctx.fill();
    }
}

type Scan = {
  candidate: boolean;
  symbol: Uint8Array | null;
  corners?: Point[];
};
function usable({ width, height, data }: Pixels) {
  return (
    width >= 80 &&
    height >= 80 &&
    width <= 1024 &&
    height <= 1024 &&
    data.length === width * height * 4
  );
}
function luminance(p: Pixels, x: number, y: number) {
  const i = (y * p.width + x) * 4;
  return (p.data[i] + 2 * p.data[i + 1] + p.data[i + 2]) / 4;
}
function decode(pixels: Pixels, corners: Point[]): Scan {
  const { width, height } = pixels;
  let candidate = false;
  const light = (x: number, y: number) => {
    x -= 0.5;
    y -= 0.5;
    const ix = Math.floor(x),
      iy = Math.floor(y),
      fx = x - ix,
      fy = y - iy;
    if (ix < 0 || iy < 0 || ix + 1 >= width || iy + 1 >= height) return 0;
    return (
      luminance(pixels, ix, iy) * (1 - fx) * (1 - fy) +
      luminance(pixels, ix + 1, iy) * fx * (1 - fy) +
      luminance(pixels, ix, iy + 1) * (1 - fx) * fy +
      luminance(pixels, ix + 1, iy + 1) * fx * fy
    );
  };
  const [p0, p1, p2, p3] = corners;
  const dx = p0.x - p1.x + p2.x - p3.x,
    dy = p0.y - p1.y + p2.y - p3.y;
  const ax = p1.x - p2.x,
    bx = p3.x - p2.x,
    ay = p1.y - p2.y,
    by = p3.y - p2.y,
    det = ax * by - bx * ay;
  if (Math.abs(det) < 1) return { candidate: false, symbol: null };
  const g = (dx * by - bx * dy) / det,
    h = (ax * dy - dx * ay) / det;
  const project = (u: number, v: number) => {
    const d = 1 + g * u + h * v;
    return {
      x:
        (p0.x + (p1.x - p0.x + g * p1.x) * u + (p3.x - p0.x + h * p3.x) * v) /
        d,
      y:
        (p0.y + (p1.y - p0.y + g * p1.y) * u + (p3.y - p0.y + h * p3.y) * v) /
        d,
    };
  };
  const sample = (u: number, v: number) => {
    const p = project(u, v);
    return light(p.x, p.y);
  };

  // Exposure is local to the carrier, so bright background objects cannot set it.
  let white = 0,
    black = 0;
  for (let i = 1; i <= 30; i++) {
    white += sample(i / 31, 0.5);
    black += sample((i - 0.5) / 31, 0.5);
  }
  white /= 30;
  black /= 30;
  if (white - black < 25) return { candidate: false, symbol: null };
  const threshold = (white + black) / 2;
  let aligned = true;
  for (let i = 1; i <= 30; i++) {
    if (
      sample(i / 31, 0.5) < threshold ||
      sample((i - 0.5) / 31, 0.5) > threshold
    ) {
      aligned = false;
      break;
    }
  }
  if (!aligned) return { candidate, symbol: null };
  candidate = true;
  const levels: number[] = [];
  for (let i = 1; i <= 30 && aligned; i++)
    for (const sign of [-1, 1]) {
      let lo = 0,
        hi = 0.49;
      for (let k = 0; k < 10; k++) {
        const m = (lo + hi) / 2;
        if (sample(i / 31, 0.5 + (sign * m) / 1.12) > threshold) lo = m;
        else hi = m;
      }
      const value = ((lo + hi) / 2 - BASE) / STEP,
        nearest = Math.round(value);
      if (nearest < 0 || nearest > 7 || Math.abs(value - nearest) > 0.3) {
        aligned = false;
        break;
      }
      levels.push(nearest);
    }
  if (!aligned) return { candidate, symbol: null };
  for (const reverse of [false, true])
    for (const flip of [false, true]) {
      const symbol = new Uint8Array(SYMBOL_BYTES);
      for (let i = 0; i < 60; i++) {
        const bar = reverse ? 29 - (i >> 1) : i >> 1,
          side = (i & 1) ^ (flip ? 1 : 0);
        const value = levels[bar * 2 + side];
        for (let j = 0; j < 3; j++) {
          const bit = ((i * 3 + j) * 53) % 180;
          symbol[bit >> 3] |= ((value >> j) & 1) << (bit & 7);
        }
      }
      const original = mix(symbol, true);
      if (validSymbol(original))
        return { candidate: true, symbol: original, corners };
    }
  return { candidate, symbol: null };
}
function acquire(p: Pixels): Scan {
  const { width, height } = p,
    size = width * height;
  // The modal background plus a small contrast floor also finds dim white dots.
  const histogram = new Uint32Array(256);
  for (let i = 0; i < size; i += 4)
    histogram[Math.round(luminance(p, i % width, Math.floor(i / width)))]++;
  let bg = 0;
  for (let i = 1; i < 256; i++) if (histogram[i] > histogram[bg]) bg = i;
  const threshold = bg + 25,
    mask = new Uint8Array(size),
    queue = new Int32Array(size);
  for (let i = 0; i < size; i++)
    mask[i] =
      luminance(p, i % width, Math.floor(i / width)) > threshold ? 1 : 0;
  const dots: Point[] = [];
  for (let i = 0; i < size; i++) {
    if (!mask[i]) continue;
    let head = 0,
      tail = 1,
      sx = 0,
      sy = 0,
      minX = width,
      maxX = 0,
      minY = height,
      maxY = 0;
    queue[0] = i;
    mask[i] = 0;
    while (head < tail) {
      const n = queue[head++],
        x = n % width,
        y = Math.floor(n / width);
      sx += x + 0.5;
      sy += y + 0.5;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let j = 0; j < 4; j++) {
        const q =
          j === 0 ? n - 1 : j === 1 ? n + 1 : j === 2 ? n - width : n + width;
        if (
          q < 0 ||
          q >= size ||
          (j < 2 && Math.floor(q / width) !== y) ||
          !mask[q]
        )
          continue;
        mask[q] = 0;
        queue[tail++] = q;
      }
    }
    const w = maxX - minX + 1,
      h = maxY - minY + 1;
    if (
      tail >= 7 &&
      tail <= 600 &&
      w / h > 0.5 &&
      w / h < 2 &&
      tail / (w * h) > 0.45
    )
      dots.push({ x: sx / tail, y: sy / tail });
    if (dots.length > 32) return { candidate: false, symbol: null };
  }
  let attempts = 0,
    candidate = false;
  for (let a = 0; a < dots.length; a++)
    for (let b = a + 1; b < dots.length; b++)
      for (let c = b + 1; c < dots.length; c++)
        for (let d = c + 1; d < dots.length; d++) {
          const corners = [dots[a], dots[b], dots[c], dots[d]],
            cx = corners.reduce((s, p) => s + p.x, 0) / 4,
            cy = corners.reduce((s, p) => s + p.y, 0) / 4;
          corners.sort(
            (a, b) =>
              Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
          );
          const lengths = corners.map((p, i) =>
            Math.hypot(
              p.x - corners[(i + 1) % 4].x,
              p.y - corners[(i + 1) % 4].y,
            ),
          );
          if (
            Math.min(...lengths) < 100 ||
            Math.max(...lengths) / Math.min(...lengths) > 2.4 ||
            Math.abs(lengths[0] / lengths[2] - 1) > 0.35 ||
            Math.abs(lengths[1] / lengths[3] - 1) > 0.35
          )
            continue;
          if (++attempts > 24) return { candidate, symbol: null };
          for (let turn = 0; turn < 2; turn++) {
            const result = decode(p, corners);
            candidate ||= result.candidate;
            if (result.symbol) return result;
            corners.push(corners.shift()!);
          }
        }
  return { candidate, symbol: null };
}
export function scanBarPixels(pixels: Pixels): Scan {
  return usable(pixels) ? acquire(pixels) : { candidate: false, symbol: null };
}
export class BarTracker {
  private corners: Point[] | null = null;
  private width = 0;
  private height = 0;
  private missed = 0;
  readonly stats = { fullScans: 0, trackedScans: 0 };
  clear() {
    this.corners = null;
    this.width = 0;
    this.height = 0;
    this.missed = 0;
    this.stats.fullScans = 0;
    this.stats.trackedScans = 0;
  }
  scan(p: Pixels): Scan {
    if (!usable(p)) {
      this.clear();
      return { candidate: false, symbol: null };
    }
    if (p.width !== this.width || p.height !== this.height) this.clear();
    this.width = p.width;
    this.height = p.height;
    if (this.corners) {
      this.stats.trackedScans++;
      // Four bounded windows follow modest motion; a failed CRC triggers reacquisition.
      const moved = this.corners.map((point) => {
        const radius = 10;
        let low = 255,
          high = 0;
        for (let y = Math.floor(point.y) - radius; y <= point.y + radius; y++)
          for (
            let x = Math.floor(point.x) - radius;
            x <= point.x + radius;
            x++
          ) {
            if (x < 0 || y < 0 || x >= p.width || y >= p.height) continue;
            const v = luminance(p, x, y);
            low = Math.min(low, v);
            high = Math.max(high, v);
          }
        let sx = 0,
          sy = 0,
          total = 0;
        for (let y = Math.floor(point.y) - radius; y <= point.y + radius; y++)
          for (
            let x = Math.floor(point.x) - radius;
            x <= point.x + radius;
            x++
          ) {
            if (x < 0 || y < 0 || x >= p.width || y >= p.height) continue;
            const v = Math.max(0, luminance(p, x, y) - (low + high) / 2);
            sx += (x + 0.5) * v;
            sy += (y + 0.5) * v;
            total += v;
          }
        return total ? { x: sx / total, y: sy / total } : point;
      });
      const result = decode(p, moved);
      if (result.symbol) {
        this.corners = moved;
        this.missed = 0;
        return result;
      }
      if (result.candidate && this.missed++ < 2) {
        this.corners = moved;
        return result;
      }
      this.corners = null;
      this.missed = 0;
    }
    // During loss, scan the whole FOV once every four calls, never a center crop.
    if (this.missed++ % 4 !== 0) return { candidate: false, symbol: null };
    this.stats.fullScans++;
    const result = acquire(p);
    if (result.corners) {
      this.corners = result.corners;
      this.missed = 0;
    }
    return result;
  }
}
