import {
  colorCapacity,
  colorLayout,
  parseColorPacket,
  readColorHeader,
} from "./color-grid";
import type { ColorGrid } from "./color-grid";
type Pixels = { width: number; height: number; data: Uint8ClampedArray };
type Point = { x: number; y: number };
type Finder = Point & { area: number };
type Geometry = {
  points: Point[];
  grid: ColorGrid;
  width: number;
  height: number;
  offsets: Int32Array;
};
// Same square-to-quadrilateral homography as optical.ts, expressed in normalized
// finder coordinates. No screen placement or fixture corners are assumed.
function projection(p: Point[], grid: ColorGrid) {
  const dx = p[0].x - p[1].x + p[2].x - p[3].x,
    dy = p[0].y - p[1].y + p[2].y - p[3].y;
  const ax = p[1].x - p[2].x,
    bx = p[3].x - p[2].x,
    ay = p[1].y - p[2].y,
    by = p[3].y - p[2].y,
    det = ax * by - bx * ay;
  if (Math.abs(det) < 1) return null;
  const g = (dx * by - bx * dy) / det,
    h = (ax * dy - dx * ay) / det,
    l = colorLayout(grid);
  return (x: number, y: number) => {
    const u = (x - 6) / (l.width - 12),
      v = (y - 6) / (l.height - 12),
      d = 1 + g * u + h * v;
    return {
      x:
        (p[0].x +
          (p[1].x - p[0].x + g * p[1].x) * u +
          (p[3].x - p[0].x + h * p[3].x) * v) /
        d,
      y:
        (p[0].y +
          (p[1].y - p[0].y + g * p[1].y) * u +
          (p[3].y - p[0].y + h * p[3].y) * v) /
        d,
    };
  };
}
function valid(image: Pixels) {
  return (
    Number.isInteger(image.width) &&
    Number.isInteger(image.height) &&
    image.width >= 80 &&
    image.height >= 80 &&
    image.width <= 2048 &&
    image.height <= 2048 &&
    image.data.length === image.width * image.height * 4
  );
}
function finders({ width, height, data }: Pixels): Finder[] {
  // <= 1,048,576 coarse samples even at full 2048²; never flood full RGBA.
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 700)),
    w = Math.ceil(width / step),
    h = Math.ceil(height / step);
  const mask = new Uint8Array(w * h),
    queue = new Int32Array(w * h);
  let peak = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * step * width + x * step) * 4,
        lo = Math.min(data[i], data[i + 1], data[i + 2]),
        hi = Math.max(data[i], data[i + 1], data[i + 2]);
      if (hi - lo < 35) peak = Math.max(peak, lo);
    }
  if (peak < 100) return [];
  const threshold = peak - Math.max(10, peak * 0.045),
    found: Finder[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * step * width + x * step) * 4;
      mask[y * w + x] =
        Math.min(data[i], data[i + 1], data[i + 2]) >= threshold ? 1 : 0;
    }
  for (let n = 0; n < mask.length; n++) {
    if (!mask[n]) continue;
    let head = 0,
      tail = 1,
      x0 = w,
      y0 = h,
      x1 = 0,
      y1 = 0;
    queue[0] = n;
    mask[n] = 0;
    while (head < tail) {
      const at = queue[head++],
        x = at % w,
        y = Math.floor(at / w);
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      if (x > 0 && mask[at - 1]) {
        mask[at - 1] = 0;
        queue[tail++] = at - 1;
      }
      if (x + 1 < w && mask[at + 1]) {
        mask[at + 1] = 0;
        queue[tail++] = at + 1;
      }
      if (y > 0 && mask[at - w]) {
        mask[at - w] = 0;
        queue[tail++] = at - w;
      }
      if (y + 1 < h && mask[at + w]) {
        mask[at + w] = 0;
        queue[tail++] = at + w;
      }
    }
    const bw = x1 - x0 + 1,
      bh = y1 - y0 + 1;
    if (
      tail < 4 ||
      tail > 5000 ||
      bw / bh < 0.45 ||
      bw / bh > 2.2 ||
      tail / (bw * bh) < 0.45 ||
      bw * step > width / 6 ||
      bh * step > height / 6
    )
      continue;
    // Refine centroid at native resolution, retaining antialiased edge weights.
    let sx = 0,
      sy = 0,
      weight = 0;
    for (
      let y = Math.max(0, y0 * step - step);
      y <= Math.min(height - 1, y1 * step + step);
      y++
    )
      for (
        let x = Math.max(0, x0 * step - step);
        x <= Math.min(width - 1, x1 * step + step);
        x++
      ) {
        const i = (y * width + x) * 4,
          value = Math.min(data[i], data[i + 1], data[i + 2]);
        const q = Math.max(0, (value - peak * 0.15) / (peak * 0.85));
        sx += (x + 0.5) * q;
        sy += (y + 0.5) * q;
        weight += q;
      }
    if (weight) found.push({ x: sx / weight, y: sy / weight, area: weight });
  }
  mask.fill(0);
  queue.fill(0);
  return found.sort((a, b) => b.area - a.area).slice(0, 10);
}
function decode(
  image: Pixels,
  points: Point[],
  grid: ColorGrid,
  cached?: Int32Array,
) {
  const project = projection(points, grid);
  if (!project) return null;
  const l = colorLayout(grid),
    { data, width, height } = image;
  const at = (x: number, y: number) => {
    const q = project(x, y),
      px = Math.floor(q.x),
      py = Math.floor(q.y);
    return px >= 0 && px < width && py >= 0 && py < height
      ? (py * width + px) * 4
      : -1;
  };
  const low = [255, 255, 255],
    high = [0, 0, 0];
  for (let n = 0; n < 8; n++) {
    const i = at(12 + ((n + 0.5) * grid) / 8, 14);
    if (i < 0) return null;
    for (let c = 0; c < 3; c++) {
      low[c] = Math.min(low[c], data[i + c]);
      high[c] = Math.max(high[c], data[i + c]);
    }
  }
  if (high.some((v, c) => v - low[c] < 40)) return null;
  const mid = low.map((v, c) => (v + high[c]) / 2),
    header = new Uint8Array(80);
  for (let k = 0; k < 640; k++) {
    const i = at(12.5 + (k % grid), 17.5 + Math.floor(k / grid));
    if (i < 0) {
      header.fill(0);
      return null;
    }
    if (data[i] > mid[0]) header[k >> 3] |= 1 << (k & 7);
  }
  const parsed = readColorHeader(header);
  if (!parsed || parsed.grid !== grid) {
    header.fill(0);
    return null;
  }
  const offsets = cached ?? new Int32Array(grid * grid),
    packet = new Uint8Array(80 + colorCapacity(grid));
  packet.set(header);
  header.fill(0);
  for (let k = 0; k < grid * grid; k++) {
    const i = cached
      ? offsets[k]
      : (offsets[k] = at(
          12.5 + (k % grid),
          l.top + 0.5 + Math.floor(k / grid),
        ));
    if (i < 0) {
      packet.fill(0);
      if (!cached) offsets.fill(0);
      return null;
    }
    const n =
        (data[i] > mid[0] ? 1 : 0) |
        (data[i + 1] > mid[1] ? 2 : 0) |
        (data[i + 2] > mid[2] ? 4 : 0),
      bit = k * 3,
      j = 80 + (bit >> 3),
      shift = bit & 7;
    packet[j] |= n << shift;
    if (shift > 5) packet[j + 1] |= n >> (8 - shift);
  }
  if (!parseColorPacket(packet)) {
    packet.fill(0);
    if (!cached) offsets.fill(0);
    return null;
  }
  return { packet, offsets };
}
export class ColorTracker {
  private geometry: Geometry | null = null;
  private misses = 0;
  clear() {
    this.geometry?.offsets.fill(0);
    this.geometry = null;
    this.misses = 0;
  }
  scan(image: Pixels): Uint8Array<ArrayBuffer> | null {
    if (!valid(image)) return null;
    const g = this.geometry;
    if (g && g.width === image.width && g.height === image.height) {
      const result = decode(image, g.points, g.grid, g.offsets);
      if (result) {
        this.misses = 0;
        return result.packet;
      }
    }
    // Reacquire immediately on first CRC miss, then at most one of three frames.
    if (++this.misses > 1 && this.misses % 3 !== 0) return null;
    const found = finders(image);
    let attempts = 0;
    for (let a = 0; a < found.length; a++)
      for (let b = a + 1; b < found.length; b++)
        for (let c = b + 1; c < found.length; c++)
          for (let d = c + 1; d < found.length; d++) {
            const points = [found[a], found[b], found[c], found[d]],
              cx = points.reduce((s, p) => s + p.x, 0) / 4,
              cy = points.reduce((s, p) => s + p.y, 0) / 4;
            points.sort(
              (p, q) =>
                Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx),
            );
            const edges = points.map((p, i) =>
              Math.hypot(
                p.x - points[(i + 1) % 4].x,
                p.y - points[(i + 1) % 4].y,
              ),
            );
            if (
              Math.min(...edges) < 100 ||
              Math.max(...edges) / Math.min(...edges) > 2 ||
              Math.max(...points.map((p) => p.area)) /
                Math.min(...points.map((p) => p.area)) >
                3
            )
              continue;
            if (++attempts > 12) return null;
            for (const direction of [1, -1])
              for (let turn = 0; turn < 4; turn++)
                for (const grid of [256, 128, 64] as const) {
                  const ordered = points.map(
                    (_, i) => points[(turn + direction * i + 8) % 4],
                  );
                  const result = decode(image, ordered, grid);
                  if (result) {
                    this.geometry?.offsets.fill(0);
                    this.geometry = {
                      points: ordered,
                      grid,
                      width: image.width,
                      height: image.height,
                      offsets: result.offsets,
                    };
                    this.misses = 0;
                    return result.packet;
                  }
                }
          }
    return null;
  }
}
