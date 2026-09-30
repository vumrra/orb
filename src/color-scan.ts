import {
  colorCapacity,
  colorLayout,
  parseColorPacket,
  readColorHeader,
  COLOR_WORD_DATA,
  COLOR_WORD_BYTES,
  COLOR_HEADER_BYTES,
} from "./color-grid";
import type { ColorGrid } from "./color-grid";
import { rsDecode } from "./sound-fec";
type Pixels = { width: number; height: number; data: Uint8ClampedArray };
type Point = { x: number; y: number };
type Finder = Point & { module: number; quality: number };
type Geometry = {
  points: Point[];
  grid: ColorGrid;
  width: number;
  height: number;
};
const CELL_SAMPLES = [
  [0, 0],
  [-0.2, -0.2],
  [0.2, -0.2],
  [-0.2, 0.2],
  [0.2, 0.2],
];
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
    const u = (x - 6.5) / (l.width - 13),
      v = (y - 6.5) / (l.height - 13),
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
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
function finders({ width, height, data }: Pixels): Finder[] {
  // Local mean, bounded to one megapixel. A bright lamp elsewhere cannot move
  // the threshold here; the nested ring test rejects plain bright rectangles.
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 1024));
  const w = Math.ceil(width / step),
    h = Math.ceil(height / step),
    stride = w + 1;
  const gray = new Uint8Array(w * h),
    integral = new Uint32Array((w + 1) * (h + 1));
  const luminance = (x: number, y: number) => {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || x >= width || y < 0 || y >= height) return 0;
    const i = (y * width + x) * 4;
    return (data[i] + 2 * data[i + 1] + data[i + 2]) / 4;
  };
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < w; x++) {
      const value = (gray[y * w + x] = luminance(
        x * step + 0.5,
        y * step + 0.5,
      ));
      sum += value;
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + sum;
    }
  }
  const mask = new Uint8Array(w * h),
    queue = new Int32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 16),
        x1 = Math.min(w, x + 17);
      const y0 = Math.max(0, y - 16),
        y1 = Math.min(h, y + 17);
      const mean =
        (integral[y1 * stride + x1] -
          integral[y0 * stride + x1] -
          integral[y1 * stride + x0] +
          integral[y0 * stride + x0]) /
        ((x1 - x0) * (y1 - y0));
      mask[y * w + x] = gray[y * w + x] > mean + 12 ? 1 : 0;
    }
  const found: Finder[] = [];
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
      tail > 1600 ||
      bw / bh < 0.5 ||
      bw / bh > 2 ||
      // A square rotated 45 degrees occupies half its axis-aligned box.
      tail / (bw * bh) < 0.42
    )
      continue;
    // Refine the isolated center at native resolution using edge weights.
    const left = Math.max(0, x0 * step - step),
      right = Math.min(width - 1, x1 * step + step);
    const top = Math.max(0, y0 * step - step),
      bottom = Math.min(height - 1, y1 * step + step);
    let low = 255,
      high = 0;
    for (let y = top; y <= bottom; y++)
      for (let x = left; x <= right; x++) {
        const v = luminance(x, y);
        low = Math.min(low, v);
        high = Math.max(high, v);
      }
    if (high - low < 35) continue;
    let sx = 0,
      sy = 0,
      weight = 0;
    for (let y = top; y <= bottom; y++)
      for (let x = left; x <= right; x++) {
        const q = Math.max(0, (luminance(x, y) - low) / (high - low));
        sx += (x + 0.5) * q;
        sy += (y + 0.5) * q;
        weight += q;
      }
    if (!weight) continue;
    const center = { x: sx / weight, y: sy / weight },
      module = Math.sqrt(weight) / 3;
    if (module < 1.4 || module > 22) continue;
    let quality = 0;
    for (let angle = 0; angle < Math.PI / 2; angle += Math.PI / 12) {
      let contrast = 255;
      for (let side = 0; side < 4; side++) {
        const dx = Math.cos(angle + (side * Math.PI) / 2) * module;
        const dy = Math.sin(angle + (side * Math.PI) / 2) * module;
        const sample = (r: number) =>
          luminance(center.x + dx * r, center.y + dy * r);
        const white = Math.min(sample(0), sample(3));
        const black = Math.max(sample(2), sample(4.3));
        contrast = Math.min(contrast, white - black);
      }
      quality = Math.max(quality, contrast);
    }
    if (quality > 28) found.push({ ...center, module, quality });
  }
  gray.fill(0);
  integral.fill(0);
  mask.fill(0);
  queue.fill(0);
  return found.sort((a, b) => b.quality - a.quality).slice(0, 64);
}

function decode(image: Pixels, points: Point[], grid: ColorGrid) {
  const project = projection(points, grid);
  if (!project) return null;
  const l = colorLayout(grid),
    { data, width, height } = image;
  // Average five interior samples with bilinear pixel weights. The footprint
  // stays inside the central half of a cell, avoiding adjacent-cell bleeding.
  const sample = (x: number, y: number): number[] | null => {
    const result = [0, 0, 0];
    for (const [dx, dy] of CELL_SAMPLES) {
      const q = project(x + dx, y + dy),
        px = q.x - 0.5,
        py = q.y - 0.5;
      const ix = Math.floor(px),
        iy = Math.floor(py),
        fx = px - ix,
        fy = py - iy;
      if (
        !Number.isFinite(px + py) ||
        ix < 0 ||
        iy < 0 ||
        ix + 1 >= width ||
        iy + 1 >= height
      )
        return null;
      const i = (iy * width + ix) * 4;
      for (let c = 0; c < 3; c++)
        result[c] +=
          ((data[i + c] * (1 - fx) + data[i + 4 + c] * fx) * (1 - fy) +
            (data[i + width * 4 + c] * (1 - fx) +
              data[i + width * 4 + 4 + c] * fx) *
              fy) /
          5;
    }
    return result;
  };
  const palettes: number[][][] = [];
  for (const y of [14, l.top + l.rows + 4])
    for (let side = 0; side < 2; side++) {
      const palette: number[][] = [];
      for (let n = 0; n < 8; n++) {
        const rgb = sample(14 + grid * (side / 2 + (n + 0.5) / 16), y);
        if (!rgb) return null;
        palette.push(rgb);
      }
      // Distinct observed colors are required before even reading a header.
      for (let a = 0; a < 8; a++)
        for (let b = a + 1; b < 8; b++)
          if (
            palette[a].reduce((s, v, c) => s + (v - palette[b][c]) ** 2, 0) <
            400
          )
            return null;
      palettes.push(palette);
    }
  const classify = (x: number, y: number, mono = false) => {
    const rgb = sample(x, y);
    if (!rgb) return -1;
    const u = Math.max(0, Math.min(1, (x - 14 - grid / 4) / (grid / 2)));
    const v = Math.max(0, Math.min(1, (y - 14) / (l.top + l.rows - 10)));
    let best = Infinity,
      symbol = -1;
    for (let n = 0; n < 8; n += mono ? 7 : 1) {
      let distance = 0;
      for (let c = 0; c < 3; c++) {
        const top = palettes[0][n][c] * (1 - u) + palettes[1][n][c] * u;
        const bottom = palettes[2][n][c] * (1 - u) + palettes[3][n][c] * u;
        distance += (rgb[c] - top * (1 - v) - bottom * v) ** 2;
      }
      if (distance < best) {
        best = distance;
        symbol = n;
      }
    }
    return symbol;
  };
  const headerCode = new Uint8Array(COLOR_HEADER_BYTES);
  for (let k = 0; k < headerCode.length * 8; k++) {
    const n = classify(14.5 + (k % grid), 17.5 + Math.floor(k / grid), true);
    if (n < 0) {
      headerCode.fill(0);
      return null;
    }
    if (n === 7) headerCode[k >> 3] |= 1 << (k & 7);
  }
  const header = rsDecode(headerCode);
  headerCode.fill(0);
  if (!header) return null;
  const parsed = readColorHeader(header);
  if (!parsed || parsed.grid !== grid) {
    header.fill(0);
    return null;
  }
  const words = colorCapacity(grid) / COLOR_WORD_DATA;
  const coded = new Uint8Array(words * COLOR_WORD_BYTES),
    packet = new Uint8Array(80 + parsed.size);
  packet.set(header);
  header.fill(0);
  let complete = false;
  try {
    for (let k = 0; k < (coded.length * 8) / 3; k++) {
      const n = classify(14.5 + (k % grid), l.top + 0.5 + Math.floor(k / grid));
      if (n < 0) return null;
      const bit = k * 3,
        i = bit >> 3,
        shift = bit & 7;
      coded[i] |= n << shift;
      if (shift > 5) coded[i + 1] |= n >> (8 - shift);
    }
    const code = new Uint8Array(COLOR_WORD_BYTES);
    try {
      for (let w = 0; w < words; w++) {
        for (let j = 0; j < COLOR_WORD_BYTES; j++)
          code[j] = coded[j * words + w];
        const decoded = rsDecode(code);
        if (!decoded) return null;
        packet.set(decoded, 80 + w * COLOR_WORD_DATA);
        decoded.fill(0);
      }
    } finally {
      code.fill(0);
    }
    complete = !!parseColorPacket(packet);
    return complete ? packet : null;
  } finally {
    coded.fill(0);
    if (!complete) packet.fill(0);
  }
}

function candidates(found: Finder[]) {
  const result: { points: Finder[]; grid: ColorGrid; score: number }[] = [],
    seen = new Set<string>();
  const spans = ([64, 128, 256] as const).flatMap((grid) => {
    const l = colorLayout(grid);
    return [l.width - 13, l.height - 13];
  });
  for (let a = 0; a < found.length; a++) {
    const p = found[a];
    // Rank by physical finder spacing, not merely nearest components: color
    // cells can resemble tiny rings inside a dense nine-tile board.
    const near = found
      .map((q, i) => {
        const d = distance(p, q),
          cells = d / ((p.module + q.module) / 2);
        return {
          i,
          d,
          fit: Math.min(...spans.map((span) => Math.abs(cells / span - 1))),
        };
      })
      .filter(
        ({ i, d }) =>
          i !== a &&
          d / p.module > 40 &&
          d / p.module < 420 &&
          found[i].module / p.module > 0.65 &&
          found[i].module / p.module < 1.55,
      )
      .sort((a, b) => a.fit - b.fit || a.d - b.d)
      .slice(0, 12);
    for (let ib = 0; ib < near.length; ib++)
      for (let ic = ib + 1; ic < near.length; ic++) {
        const b = near[ib].i,
          c = near[ic].i,
          q = found[b],
          r = found[c];
        const cosine = Math.abs(
          ((q.x - p.x) * (r.x - p.x) + (q.y - p.y) * (r.y - p.y)) /
            (near[ib].d * near[ic].d),
        );
        if (cosine > 0.45) continue;
        const guess = { x: q.x + r.x - p.x, y: q.y + r.y - p.y };
        let d = -1,
          delta = Math.min(near[ib].d, near[ic].d) * 0.28;
        for (let j = 0; j < found.length; j++) {
          if (j === a || j === b || j === c) continue;
          const dd = distance(found[j], guess);
          if (dd < delta) {
            d = j;
            delta = dd;
          }
        }
        if (d < 0) continue;
        const ids = [a, b, c, d].sort((a, b) => a - b),
          key = ids.join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        const points = [p, q, found[d], r],
          modules = points.map((p) => p.module);
        if (Math.max(...modules) / Math.min(...modules) > 1.65) continue;
        const module = modules.reduce((s, v) => s + v) / 4;
        const edges = points
          .map((p, i) => distance(p, points[(i + 1) % 4]) / module)
          .sort((a, b) => a - b);
        for (const grid of [64, 128, 256] as const) {
          const l = colorLayout(grid),
            small = l.width - 13,
            large = l.height - 13;
          const error =
            Math.abs((edges[0] + edges[1]) / (2 * small) - 1) +
            Math.abs((edges[2] + edges[3]) / (2 * large) - 1);
          if (error < 0.6)
            result.push({
              points,
              grid,
              score: error + cosine + delta / (module * small),
            });
        }
      }
  }
  return result.sort((a, b) => a.score - b.score).slice(0, 48);
}
export class ColorTracker {
  private geometries: Geometry[] = [];
  private scans = 0;
  private misses = 0;
  clear() {
    this.geometries = [];
    this.scans = this.misses = 0;
  }
  // Compatibility for single-tile callers. Live Camera consumes every tile.
  scan(image: Pixels): Uint8Array<ArrayBuffer> | null {
    const packets = this.scanAll(image),
      first = packets.shift() ?? null;
    packets.forEach((p) => p.fill(0));
    return first;
  }
  scanAll(image: Pixels): Uint8Array<ArrayBuffer>[] {
    if (!valid(image)) return [];
    const packets: Uint8Array<ArrayBuffer>[] = [],
      good: Geometry[] = [];
    const old = this.geometries.filter(
      (g) => g.width === image.width && g.height === image.height,
    );
    for (const g of old) {
      const packet = decode(image, g.points, g.grid);
      if (packet) {
        packets.push(packet);
        good.push(g);
      }
    }
    // Search periodically even when one tile remains locked, so newly visible
    // tiles are acquired. Failed geometry never becomes a confirmed carrier.
    const scan = this.scans++;
    this.misses = packets.length ? 0 : this.misses + 1;
    if (
      (good.length === old.length && good.length && scan % 6 !== 0) ||
      (this.misses > 1 && this.misses % 3 !== 0)
    )
      return packets;
    const found = finders(image),
      used = good.flatMap((g) => g.points);
    for (const candidate of candidates(found)) {
      if (good.length >= 9) break;
      if (
        candidate.points.some((p) =>
          used.some((q) => distance(p, q) < p.module * 2),
        )
      )
        continue;
      let matched = false;
      for (const direction of [1, -1]) {
        for (let turn = 0; turn < 4; turn++) {
          const points = candidate.points.map(
            (_, i) => candidate.points[(turn + direction * i + 8) % 4],
          );
          const packet = decode(image, points, candidate.grid);
          if (!packet) continue;
          packets.push(packet);
          const g = {
            points,
            grid: candidate.grid,
            width: image.width,
            height: image.height,
          };
          good.push(g);
          used.push(...points);
          matched = true;
          break;
        }
        if (matched) break;
      }
    }
    this.geometries = good.length ? good : old.slice(0, 9);
    return packets;
  }
}
