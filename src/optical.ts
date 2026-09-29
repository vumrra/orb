import { FRAME_BYTES } from "./protocol";
import { rsEncode, rsDecode, parseOpticalFrame } from "./optical-fec";

const TAU = Math.PI * 2;
export const SYMBOL_MS = 140;
type Point = { x: number; y: number };
interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
export interface OpticalScan {
  candidate: boolean;
  frame: Uint8Array | null;
}
const PILOT = 0.55;
const pilots: Point[] = [
  { x: -PILOT, y: -PILOT },
  { x: PILOT, y: -PILOT },
  { x: PILOT, y: PILOT },
  { x: -PILOT, y: PILOT },
];
// Broad neighborhoods have no painted boundaries. Only their moving points emit light.
const sites: Point[] = [];
for (let row = -18; row <= 18; row++)
  for (let col = -18; col <= 18; col++) {
    const x = (col + (row & 1) * 0.5) * 0.075,
      y = row * 0.075 * 0.8660254;
    if (
      Math.hypot(x, y) < 0.92 &&
      pilots.every((p) => Math.hypot(x - p.x, y - p.y) > 0.105)
    )
      sites.push({ x, y });
  }
function encode(frame: Uint8Array) {
  const code = rsEncode(frame);
  return Uint8Array.from(
    { length: 480 },
    (_, i) => (code[i >> 3] >> (i & 7)) & 1,
  );
}
function recover(bits: Uint8Array) {
  const code = new Uint8Array(60);
  for (let i = 0; i < 480; i++) code[i >> 3] |= bits[i] << (i & 7);
  const frame = rsDecode(code);
  if (!frame) return null;
  const parsed = parseOpticalFrame(frame);
  parsed?.chunk.fill(0);
  return parsed ? frame : null;
}

const siteIndex = new Map(
  sites.map((p, i) => [
    `${Math.round(p.x / 0.0375)},${Math.round(p.y / (0.075 * 0.8660254))}`,
    i,
  ]),
);
function address(x: number, y: number) {
  const row = Math.round(y / (0.075 * 0.8660254)),
    col = Math.round(x / 0.075 - (row & 1) * 0.5);
  return siteIndex.get(`${col * 2 + (row & 1)},${row}`) ?? 0;
}
type Particle = Point & { z: number };
// Camera distance is in sphere radii. This focal length keeps the silhouette round.
export function createParticleProjection(time: number) {
  const cx = Math.cos(time * 0.57),
    sx = Math.sin(time * 0.57),
    cy = Math.cos(time * 0.83),
    sy = Math.sin(time * 0.83);
  return ({ x, y, z }: Particle) => {
    const ry = y * cx - z * sx,
      rz = y * sx + z * cx;
    const rx = x * cy + rz * sy,
      depth = rz * cy - x * sy;
    const scale = Math.sqrt(3.2 * 3.2 - 1) / (3.2 - depth);
    return { x: rx * scale, y: ry * scale, z: depth, scale };
  };
}
const cloud = Array.from({ length: 30000 }, (_, i) => {
  const z = 1 - (2 * (i + 0.5)) / 30000,
    angle = i * 2.3999632297 + 0.006 * Math.sin(i * 127.1),
    // Most points trace a shell; the rest give the currents an interior.
    radius = i % 7 === 0 ? 0.35 + 0.6 * ((i * 0.754877666) % 1) : 0.98,
    r = Math.sqrt(1 - z * z) * radius;
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r, z: z * radius };
});
// Reuse the projection/sort buffer across synchronous draws, including different canvases.
const particles = cloud.map((_, i) => ({
  x: 0,
  y: 0,
  z: 0,
  scale: 0,
  wave: 0,
  i,
}));
const surfaces = new WeakMap<
  object,
  { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; image: ImageData }
>();
export function drawOptical(
  ctx: CanvasRenderingContext2D,
  frame: Uint8Array | null,
  cx: number,
  cy: number,
  radius: number,
  rotation = 0,
  time = 0,
) {
  if (frame && frame.length !== FRAME_BYTES)
    throw new Error("Invalid optical frame.");
  const bits = frame ? encode(frame) : null;
  let surface = surfaces.get(ctx);
  const size = 720,
    scale = size / 2 / 1.04;
  if (!surface) {
    const canvas =
      typeof document !== "undefined"
        ? document.createElement("canvas")
        : new (
            ctx.canvas.constructor as new (
              w: number,
              h: number,
            ) => HTMLCanvasElement
          )(size, size);
    canvas.width = canvas.height = size;
    const out = canvas.getContext("2d")!;
    surface = { canvas, ctx: out, image: out.createImageData(size, size) };
    surfaces.set(ctx, surface);
  }
  const pixels = surface.image.data;
  pixels.fill(0);
  const cos = Math.cos(rotation),
    sin = Math.sin(rotation);
  const project = createParticleProjection(time);
  for (const particle of particles) {
    const point = cloud[particle.i];
    // Latitude-dependent twist is a continuous current, not independent jitter.
    const flow = 0.32 * Math.sin(point.y * 5 - time * 3.5),
      c = Math.cos(flow),
      s = Math.sin(flow);
    const x = point.x * c + point.z * s,
      z = point.z * c - point.x * s;
    Object.assign(particle, project({ x, y: point.y, z }));
    particle.wave =
      0.5 +
      0.5 *
        Math.sin(
          point.y * 13 +
            x * 4 +
            z * 5 -
            time * 9 +
            1.4 * Math.sin(x * 3 - time * 1.7),
        );
  }
  particles.sort((a, b) => a.z - b.z);
  // Back-to-front splats accumulate premultiplied color and source-over alpha.
  for (const { x, y, z, scale: perspective, wave, i } of particles) {
    const depth = (z + 1) / 2;
    const light = 50 + depth * (25 + (bits ? 90 : 150) * wave ** 3);
    // Dim currents still need enough optical energy to carry projected chroma.
    const opacity = (0.3 + 0.65 * depth) * (0.65 + 0.35 * wave * wave);
    let signal = bits ? bits[address(x, y) % bits.length] : 3;
    if (bits && pilots.some((p) => Math.hypot(x - p.x, y - p.y) < 0.064))
      signal = 2;
    const amp = light * (signal === 2 ? 0.7 : 0.48);
    // Equal luminance axes: R-B encodes data, 2G-R-B encodes registration.
    const d = signal === 0 ? -amp : signal === 1 ? amp : 0,
      p = signal === 2 ? amp : 0;
    const red = light + d - p,
      green = light + p,
      blue = light - d - p;
    const px = size / 2 + (x * cos - y * sin) * scale,
      py = size / 2 + (x * sin + y * cos) * scale;
    const pr =
      (0.0028 + 0.001 * depth) *
      perspective *
      (0.8 + 0.4 * ((i * 0.6180339) % 1)) *
      scale;
    for (let iy = Math.floor(py - pr); iy <= Math.ceil(py + pr); iy++)
      for (let ix = Math.floor(px - pr); ix <= Math.ceil(px + pr); ix++) {
        if (ix < 0 || iy < 0 || ix >= size || iy >= size) continue;
        const alpha =
          opacity *
          Math.max(
            0,
            Math.min(1, pr + 0.5 - Math.hypot(ix + 0.5 - px, iy + 0.5 - py)),
          );
        if (!alpha) continue;
        const q = (iy * size + ix) * 4,
          remain = 1 - alpha;
        pixels[q] = red * alpha + pixels[q] * remain;
        pixels[q + 1] = green * alpha + pixels[q + 1] * remain;
        pixels[q + 2] = blue * alpha + pixels[q + 2] * remain;
        pixels[q + 3] = 255 * alpha + pixels[q + 3] * remain;
      }
  }
  for (let i = 0; i < pixels.length; i += 4)
    if (pixels[i + 3]) {
      const a = 255 / pixels[i + 3];
      pixels[i] *= a;
      pixels[i + 1] *= a;
      pixels[i + 2] *= a;
    }
  surface.ctx.putImageData(surface.image, 0, 0);
  ctx.drawImage(
    surface.canvas,
    cx - radius * 1.04,
    cy - radius * 1.04,
    radius * 2.08,
    radius * 2.08,
  );
}

// Projective square -> camera quadrilateral, including rotation, reflection and mild tilt.
function projection(p: Point[]) {
  const dx = p[0].x - p[1].x + p[2].x - p[3].x,
    dy = p[0].y - p[1].y + p[2].y - p[3].y;
  const ax = p[1].x - p[2].x,
    bx = p[3].x - p[2].x,
    ay = p[1].y - p[2].y,
    by = p[3].y - p[2].y;
  const det = ax * by - bx * ay;
  if (Math.abs(det) < 1) return null;
  const g = (dx * by - bx * dy) / det,
    h = (ax * dy - dx * ay) / det;
  return (x: number, y: number) => {
    const u = (x / PILOT + 1) / 2,
      v = (y / PILOT + 1) / 2,
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
type Geometry = {
  points: Point[];
  small: number;
  width: number;
  height: number;
};
function decodeValues(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  const center = (sorted[120] + sorted[360]) / 2;
  for (const threshold of [center, 0, center - 0.06, center + 0.06]) {
    const frame = recover(
      Uint8Array.from(values, (v) => (v > threshold ? 1 : 0)),
    );
    if (frame) return frame;
  }
  return null;
}
export class OpticalTracker {
  private geometry: Geometry | null = null;
  private misses = 0;
  clear() {
    this.geometry = null;
    this.misses = 0;
  }
  scan(pixels: Pixels, onCandidate?: () => void): OpticalScan {
    const g = this.geometry;
    if (
      g &&
      g.width === pixels.width &&
      g.height === pixels.height &&
      pixels.data.length === pixels.width * pixels.height * 4
    ) {
      const project = projection(g.points)!;
      const values = sites.slice(0, FRAME_BYTES * 12).map((s) => {
        const q = project(s.x, s.y),
          r = g.small * 0.023;
        const x0 = Math.max(0, Math.floor(q.x - r)),
          x1 = Math.min(pixels.width, Math.ceil(q.x + r));
        const y0 = Math.max(0, Math.floor(q.y - r)),
          y1 = Math.min(pixels.height, Math.ceil(q.y + r));
        let chroma = 0,
          light = 0;
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const i = (y * pixels.width + x) * 4,
              d = pixels.data;
            chroma += d[i] - d[i + 2];
            light += (d[i] + 2 * d[i + 1] + d[i + 2]) / 4;
          }
        return chroma / (light + Math.max(1, (x1 - x0) * (y1 - y0)));
      });
      const frame = decodeValues(values);
      if (frame) {
        this.misses = 0;
        onCandidate?.();
        return { candidate: true, frame };
      }
    }
    // First miss immediately searches the entire field; repeated misses bound CPU.
    if (++this.misses >= 3) this.geometry = null;
    if (this.misses > 1 && this.misses % 3 !== 0)
      return { candidate: false, frame: null };
    return scanPixels(pixels, onCandidate, (geometry) => {
      this.geometry = geometry;
      this.misses = 0;
    });
  }
}
export function scanPixels(
  { width, height, data }: Pixels,
  onCandidate?: () => void,
  onGeometry?: (geometry: Geometry) => void,
): OpticalScan {
  const empty = { candidate: false, frame: null };
  if (
    width < 80 ||
    height < 80 ||
    width > 1024 ||
    height > 1024 ||
    data.length !== width * height * 4
  )
    return empty;
  const stride = width + 1,
    integral = new Float64Array(stride * (height + 1));
  const chroma = new Float64Array(integral.length),
    pilot = new Float64Array(integral.length);
  for (let y = 0; y < height; y++) {
    let sum = 0,
      redBlue = 0,
      green = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      sum += (data[i] + 2 * data[i + 1] + data[i + 2]) / 4;
      redBlue += data[i] - data[i + 2];
      green += 2 * data[i + 1] - data[i] - data[i + 2];
      const q = (y + 1) * stride + x + 1;
      integral[q] = integral[y * stride + x + 1] + sum;
      chroma[q] = chroma[y * stride + x + 1] + redBlue;
      pilot[q] = pilot[y * stride + x + 1] + green;
    }
  }
  function mean(x: number, y: number, r: number, channel = integral) {
    const x0 = Math.max(0, Math.floor(x - r)),
      x1 = Math.min(width, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r)),
      y1 = Math.min(height, Math.ceil(y + r));
    if (x1 <= x0 || y1 <= y0) return 0;
    return (
      (channel[y1 * stride + x1] -
        channel[y0 * stride + x1] -
        channel[y1 * stride + x0] +
        channel[y0 * stride + x0]) /
      ((x1 - x0) * (y1 - y0))
    );
  }
  let candidate = false;
  // A bounded three-scale pilot search. No full-resolution connected rim is required.
  for (const blur of [2, 4, 6]) {
    const step = 2,
      w = Math.floor(width / step),
      h = Math.floor(height / step),
      smooth = new Float32Array(w * h);
    let max = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v =
          mean(x * step + 0.5, y * step + 0.5, blur, pilot) /
          (mean(x * step + 0.5, y * step + 0.5, blur) + 1);
        smooth[y * w + x] = v;
        max = Math.max(max, v);
      }
    if (max < 0.06) continue;
    const threshold = max * 0.18,
      seen = new Uint8Array(w * h),
      queue = new Int32Array(w * h);
    const blobs: (Point & { area: number })[] = [];
    for (let i = 0; i < smooth.length; i++) {
      if (seen[i] || smooth[i] < threshold) continue;
      let head = 0,
        tail = 1,
        sx = 0,
        sy = 0,
        weight = 0;
      queue[0] = i;
      seen[i] = 1;
      while (head < tail) {
        const n = queue[head++],
          x = n % w,
          y = Math.floor(n / w),
          v = 1;
        sx += (x * step + 0.5) * v;
        sy += (y * step + 0.5) * v;
        weight += v;
        for (const q of [
          x > 0 ? n - 1 : -1,
          x < w - 1 ? n + 1 : -1,
          y > 0 ? n - w : -1,
          y < h - 1 ? n + w : -1,
        ])
          if (q >= 0 && !seen[q] && smooth[q] >= threshold) {
            seen[q] = 1;
            queue[tail++] = q;
          }
      }
      if (tail >= 3 && tail < 1500 && weight > 0)
        blobs.push({ x: sx / weight, y: sy / weight, area: tail });
    }
    const top = blobs.sort((a, b) => b.area - a.area).slice(0, 8);
    let attempts = 0;
    for (let a = 0; a < top.length; a++)
      for (let b = a + 1; b < top.length; b++)
        for (let c = b + 1; c < top.length; c++)
          for (let d = c + 1; d < top.length; d++) {
            const p = [top[a], top[b], top[c], top[d]];
            const mx = p.reduce((s, v) => s + v.x, 0) / 4,
              my = p.reduce((s, v) => s + v.y, 0) / 4;
            p.sort(
              (a, b) =>
                Math.atan2(a.y - my, a.x - mx) - Math.atan2(b.y - my, b.x - mx),
            );
            const edges = p.map((v, i) =>
              Math.hypot(v.x - p[(i + 1) % 4].x, v.y - p[(i + 1) % 4].y),
            );
            const small = Math.min(...edges),
              large = Math.max(...edges);
            if (
              small < 65 ||
              large / small > 1.55 ||
              Math.max(...p.map((v) => v.area)) /
                Math.min(...p.map((v) => v.area)) >
                2.8
            )
              continue;
            const diag1 = Math.hypot(p[0].x - p[2].x, p[0].y - p[2].y),
              diag2 = Math.hypot(p[1].x - p[3].x, p[1].y - p[3].y);
            if (
              Math.min(diag1, diag2) < large * 1.1 ||
              Math.max(diag1, diag2) / Math.min(diag1, diag2) > 1.4
            )
              continue;
            if (!candidate) {
              candidate = true;
              onCandidate?.();
            }
            if (++attempts > 3) break;
            for (const direction of [1, -1])
              for (let turn = 0; turn < 4; turn++) {
                const project = projection(
                  p.map((_, i) => p[(turn + direction * i + 8) % 4]),
                );
                if (!project) continue;
                const values = sites.slice(0, FRAME_BYTES * 12).map((s) => {
                  const q = project(s.x, s.y);
                  return (
                    mean(q.x, q.y, small * 0.023, chroma) /
                    (mean(q.x, q.y, small * 0.023) + 1)
                  );
                });
                const frame = decodeValues(values);
                if (frame) {
                  onGeometry?.({
                    points: p.map((_, i) => p[(turn + direction * i + 8) % 4]),
                    small,
                    width,
                    height,
                  });
                  return { candidate: true, frame };
                }
              }
          }
  }
  return { candidate, frame: null };
}
export function decodePixels(pixels: Pixels) {
  return scanPixels(pixels).frame;
}
