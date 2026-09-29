import { FRAME_BYTES, parseFrame } from "./protocol";

// The same 32 data bars / two 3-bit endpoints; two symbols carry all 40 frame bytes.
export const BAR_COUNT = 34;
export const BAR_SYMBOL_MS = 160;
export const BAR_TRANSITION_MS = 32;
const SYMBOL_BYTES = 24;
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
function validSymbol(s: Uint8Array) {
  return (
    s.length === SYMBOL_BYTES &&
    new DataView(s.buffer, s.byteOffset, s.byteLength).getUint16(22) ===
      crc16(s.subarray(0, 22))
  );
}
export function splitBarFrame(frame: Uint8Array): Uint8Array[] {
  const parsed = parseFrame(frame);
  if (!parsed) throw new Error("Invalid bar frame.");
  parsed.chunk.fill(0);
  const tag =
    new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(
      36,
    ) & 0x7fff;
  return [0, 1].map((index) => {
    const symbol = new Uint8Array(SYMBOL_BYTES),
      view = new DataView(symbol.buffer);
    symbol.set(frame.subarray(index * 20, (index + 1) * 20));
    view.setUint16(20, tag | (index << 15));
    view.setUint16(22, crc16(symbol.subarray(0, 22)));
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
      20,
    );
    const tag = value & 0x7fff,
      index = value >>> 15;
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
    parts[index] = s.slice(0, 20);
    if (!parts[0] || !parts[1]) return null;
    const frame = new Uint8Array(FRAME_BYTES);
    frame.set(parts[0]);
    frame.set(parts[1], 20);
    const parsed = parseFrame(frame);
    const matches =
      parsed && (new DataView(frame.buffer).getUint32(36) & 0x7fff) === tag;
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
function level(symbol: Uint8Array, endpoint: number) {
  const bit = endpoint * 3,
    byte = bit >> 3,
    shift = bit & 7;
  return ((symbol[byte] | ((symbol[byte + 1] ?? 0) << 8)) >> shift) & 7;
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
  const pitch = width / 33,
    thickness = pitch * 0.56;
  ctx.fillStyle = "#ffffff";
  for (let i = 0; i < BAR_COUNT; i++) {
    let top = 0.5,
      bottom = 0.5;
    if (i > 0 && i < 33) {
      const endpoint = (i - 1) * 2;
      const a = symbol
        ? level(symbol, endpoint)
        : 3.5 + 3.5 * Math.sin(time * 18 + i * 1.7);
      const b = symbol
        ? level(symbol, endpoint + 1)
        : 3.5 + 3.5 * Math.sin(time * 18 + i * 1.7 + 1);
      top =
        BASE +
        STEP *
          (previous ? level(previous, endpoint) * (1 - blend) + a * blend : a);
      bottom =
        BASE +
        STEP *
          (previous
            ? level(previous, endpoint + 1) * (1 - blend) + b * blend
            : b);
    }
    ctx.fillRect(
      cx - width / 2 + i * pitch - thickness / 2,
      cy - top * height,
      thickness,
      (top + bottom) * height,
    );
  }
}

export function scanBarPixels({ width, height, data }: Pixels): {
  candidate: boolean;
  symbol: Uint8Array | null;
} {
  const empty = { candidate: false, symbol: null };
  if (
    width < 80 ||
    height < 80 ||
    width > 1024 ||
    height > 1024 ||
    data.length !== width * height * 4
  )
    return empty;
  const mask = new Uint8Array(width * height),
    queue = new Int32Array(mask.length);
  for (let i = 0; i < mask.length; i++)
    mask[i] = data[i * 4] + 2 * data[i * 4 + 1] + data[i * 4 + 2] > 512 ? 1 : 0;
  const rails: (Point & { dx: number; dy: number; length: number })[] = [];
  // Connected luminance runs give orientation without a center crop or color markers.
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    let head = 0,
      tail = 1,
      sx = 0,
      sy = 0,
      sxx = 0,
      syy = 0,
      sxy = 0;
    queue[0] = i;
    mask[i] = 0;
    while (head < tail) {
      const n = queue[head++],
        x = (n % width) + 0.5,
        y = Math.floor(n / width) + 0.5;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
      // Avoid allocating a neighbor array for every bright pixel.
      for (let j = 0; j < 4; j++) {
        const q =
          j === 0 ? n - 1 : j === 1 ? n + 1 : j === 2 ? n - width : n + width;
        if (
          q < 0 ||
          q >= mask.length ||
          (j < 2 && Math.floor(q / width) !== Math.floor(n / width)) ||
          !mask[q]
        )
          continue;
        mask[q] = 0;
        queue[tail++] = q;
      }
    }
    if (tail < 80 || tail > 40000) continue;
    const x = sx / tail,
      y = sy / tail,
      xx = sxx / tail - x * x,
      yy = syy / tail - y * y,
      xy = sxy / tail - x * y;
    const angle = 0.5 * Math.atan2(2 * xy, xx - yy),
      dx = Math.cos(angle),
      dy = Math.sin(angle);
    const major = xx * dx * dx + 2 * xy * dx * dy + yy * dy * dy,
      minor = xx + yy - major;
    const length = Math.sqrt(12 * major),
      thick = Math.sqrt(Math.max(0, 12 * minor));
    if (length >= 70 && thick >= 1.5 && length > thick * 9)
      rails.push({ x, y, dx, dy, length });
    if (rails.length > 256) return empty;
  }
  rails.sort((a, b) => b.length - a.length);
  // Largest 16 possible rails, at most 24 plausible pairs; noisy scenes stay bounded.
  const top = rails.slice(0, 16);
  let candidate = false,
    attempts = 0;
  function light(x: number, y: number) {
    x -= 0.5;
    y -= 0.5;
    const ix = Math.floor(x),
      iy = Math.floor(y),
      fx = x - ix,
      fy = y - iy;
    if (ix < 0 || iy < 0 || ix + 1 >= width || iy + 1 >= height) return 0;
    const at = (px: number, py: number) => {
      const i = (py * width + px) * 4;
      return (data[i] + 2 * data[i + 1] + data[i + 2]) / 4;
    };
    return (
      at(ix, iy) * (1 - fx) * (1 - fy) +
      at(ix + 1, iy) * fx * (1 - fy) +
      at(ix, iy + 1) * (1 - fx) * fy +
      at(ix + 1, iy + 1) * fx * fy
    );
  }
  function ends(r: (typeof top)[number], flip = false) {
    const dx = r.dx * (flip ? -1 : 1),
      dy = r.dy * (flip ? -1 : 1);
    return [-1, 1].map((sign) => {
      let lo = 0,
        hi = r.length * 0.65;
      for (let k = 0; k < 12; k++) {
        const m = (lo + hi) / 2;
        if (light(r.x + dx * m * sign, r.y + dy * m * sign) > 128) lo = m;
        else hi = m;
      }
      const distance = ((lo + hi) / 2) * sign;
      return { x: r.x + dx * distance, y: r.y + dy * distance };
    });
  }
  for (let a = 0; a < top.length; a++)
    for (let b = a + 1; b < top.length; b++) {
      const l = top[a],
        r = top[b],
        dot = l.dx * r.dx + l.dy * r.dy;
      const separation = Math.abs((r.x - l.x) * l.dy - (r.y - l.y) * l.dx);
      if (
        Math.abs(dot) < 0.97 ||
        l.length / r.length > 1.35 ||
        separation < 180 ||
        separation < l.length * 0.6 ||
        separation > l.length * 2
      )
        continue;
      if (++attempts > 24) return { candidate, symbol: null };
      const [p0, p3] = ends(l),
        [p1, p2] = ends(r, dot < 0);
      const dx = p0.x - p1.x + p2.x - p3.x,
        dy = p0.y - p1.y + p2.y - p3.y;
      const ax = p1.x - p2.x,
        bx = p3.x - p2.x,
        ay = p1.y - p2.y,
        by = p3.y - p2.y,
        det = ax * by - bx * ay;
      if (Math.abs(det) < 1) continue;
      const g = (dx * by - bx * dy) / det,
        h = (ax * dy - dx * ay) / det;
      const project = (u: number, v: number) => {
        const d = 1 + g * u + h * v;
        return {
          x:
            (p0.x +
              (p1.x - p0.x + g * p1.x) * u +
              (p3.x - p0.x + h * p3.x) * v) /
            d,
          y:
            (p0.y +
              (p1.y - p0.y + g * p1.y) * u +
              (p3.y - p0.y + h * p3.y) * v) /
            d,
        };
      };
      const sample = (u: number, v: number) => {
        const p = project(u, v);
        return light(p.x, p.y);
      };
      let aligned = true;
      for (let i = 1; i <= 32; i++) {
        if (sample(i / 33, 0.5) < 160 || sample((i - 0.5) / 33, 0.5) > 100) {
          aligned = false;
          break;
        }
      }
      if (!aligned) continue;
      candidate = true;
      const levels: number[] = [];
      for (let i = 1; i <= 32 && aligned; i++)
        for (const sign of [-1, 1]) {
          let lo = 0,
            hi = 0.49;
          for (let k = 0; k < 10; k++) {
            const m = (lo + hi) / 2;
            if (sample(i / 33, 0.5 + sign * m) > 128) lo = m;
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
      if (!aligned) continue;
      for (const reverse of [false, true])
        for (const flip of [false, true]) {
          const symbol = new Uint8Array(SYMBOL_BYTES);
          for (let i = 0; i < 64; i++) {
            const bar = reverse ? 31 - (i >> 1) : i >> 1,
              side = (i & 1) ^ (flip ? 1 : 0);
            const value = levels[bar * 2 + side],
              bit = i * 3,
              byte = bit >> 3,
              shift = bit & 7;
            symbol[byte] |= value << shift;
            if (shift > 5) symbol[byte + 1] |= value >> (8 - shift);
          }
          if (validSymbol(symbol)) return { candidate: true, symbol };
        }
    }
  return { candidate, symbol: null };
}
