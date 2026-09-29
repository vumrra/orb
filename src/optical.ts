import { FRAME_BYTES, parseFrame } from './protocol';

// Spatial chroma modulation: the moving light field is the carrier.
// No dots, binary glyphs, or three-point fiducials are painted on top.
const TAU = Math.PI * 2;
const INNER = 0.30;
const BAND = 0.06875;
const SYNC_RADIUS = 0.928;
const RESOLUTION = 384;
const SINE = Float32Array.from({ length: 8192 }, (_, i) => Math.sin(i * TAU / 8192));
const sin = (angle: number) => SINE[(Math.round(angle * 8192 / TAU) & 8191)];
const SYNC = Array.from({ length: 64 }, (_, i) => {
  // Fixed balanced pilot sequence, independent of the transmitted secret.
  let x = (i + 1) * 0x45d9f3b;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return ((x ^ (x >>> 16)) & 1) ? 1 : -1;
});
interface Surface {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  image: ImageData;
  radius: Float32Array;
  angle: Float32Array;
  x: Float32Array;
  y: Float32Array;
}
const surfaces = new WeakMap<object, Surface>();
function surfaceFor(ctx: CanvasRenderingContext2D): Surface {
  const cached = surfaces.get(ctx);
  if (cached) return cached;
  // Canvas constructor fallback is used by the real raster unit tests, not the app.
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas')
    : new (ctx.canvas.constructor as new (w: number, h: number) => HTMLCanvasElement)(RESOLUTION, RESOLUTION);
  canvas.width = canvas.height = RESOLUTION;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(RESOLUTION, RESOLUTION);
  const count = RESOLUTION * RESOLUTION;
  const radius = new Float32Array(count), angle = new Float32Array(count), x = new Float32Array(count), y = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    x[i] = ((i % RESOLUTION) + 0.5 - RESOLUTION / 2) / (RESOLUTION / 2 / 1.05);
    y[i] = (Math.floor(i / RESOLUTION) + 0.5 - RESOLUTION / 2) / (RESOLUTION / 2 / 1.05);
    radius[i] = Math.hypot(x[i], y[i]); angle[i] = Math.atan2(y[i], x[i]);
  }
  const surface = { canvas, context, image, radius, angle, x, y };
  surfaces.set(ctx, surface);
  return surface;
}

export function drawOptical(ctx: CanvasRenderingContext2D, frame: Uint8Array | null, cx: number, cy: number, radius: number, rotation = 0, time = 0) {
  if (frame && frame.length !== FRAME_BYTES) throw new Error('Invalid optical frame.');
  const surface = surfaceFor(ctx), pixels = surface.image.data;
  const turn = rotation + time * 0.22;
  for (let i = 0; i < surface.radius.length; i++) {
    const r = surface.radius[i], a = surface.angle[i], p = i * 4;
    const angle = ((a - turn) % TAU + TAU) % TAU;
    const sector = Math.floor(angle * 64 / TAU) % 64;
    let signal = 0;
    if (frame && r >= INNER && r < INNER + BAND * 8) {
      const bit = Math.floor((r - INNER) / BAND) * 64 + sector;
      signal = frame[bit >> 3] & (1 << (7 - (bit & 7))) ? 1 : -1;
    } else if (frame && r > 0.902 && r < 0.954) signal = SYNC[sector];

    // Advected spiral ridges and granular interference create a flowing swarm.
    const flow = a + 0.35 * sin(r * 10 - time * 1.6) + time * 0.48;
    const ribbon = (sin(r * 27 + sin(flow * 3) * 2.5 - time * 3.2) + 1) * 0.5;
    const curl = (sin(flow * 6 - r * 15 + time * 1.9) + 1) * 0.5;
    const grain = (sin(surface.x[i] * 281 + time * 13 + sin(surface.y[i] * 79 - time * 4) * 3)
      * sin(surface.y[i] * 247 - time * 11 + sin(surface.x[i] * 67 + time * 3) * 3) + 1) * 0.5;
    const edge = Math.max(0, Math.min(1, (0.975 - r) / 0.07));
    const body = r < 0.975 ? (24 + 40 * ribbon ** 4 + 100 * ribbon ** 9 * grain ** 3 + 44 * curl ** 12 * grain ** 2) * edge : 0;
    // A continuous faint rim gives geometric registration, not data glyphs.
    const rim = Math.abs(r - 0.992) < 0.008 ? 86 * (1 - Math.abs(r - 0.992) / 0.008) : 0;
    const light = Math.max(body, rim);
    const amplitude = light * 0.28 * signal;
    pixels[p] = 9 + light + amplitude;
    pixels[p + 1] = 10 + light - amplitude * 0.1963;
    pixels[p + 2] = 11 + light - amplitude;
    pixels[p + 3] = r <= 1.003 ? 255 : 0;
  }
  surface.context.putImageData(surface.image, 0, 0);
  ctx.drawImage(surface.canvas, cx - radius * 1.05, cy - radius * 1.05, radius * 2.1, radius * 2.1);
}

interface Pixels { width: number; height: number; data: Uint8ClampedArray }
interface Geometry { cx: number; cy: number; rx: number; ry: number; area: number }
export function decodePixels({ width, height, data }: Pixels): Uint8Array | null {
  if (width < 80 || height < 80 || width > 1024 || height > 1024 || data.length !== width * height * 4) return null;
  const size = width * height, gray = new Uint8Array(size), seen = new Uint8Array(size);
  for (let i = 0; i < size; i++) gray[i] = (data[i * 4] + data[i * 4 + 1] * 2 + data[i * 4 + 2]) / 4;
  const queue = new Int32Array(size), candidates: Geometry[] = [];
  // Find the continuous silhouette rim. The existing reticle keeps the search bounded.
  for (let i = 0; i < size; i++) {
    if (seen[i] || gray[i] < 36) continue;
    let head = 0, tail = 1, minX = width, maxX = 0, minY = height, maxY = 0;
    queue[0] = i; seen[i] = 1;
    while (head < tail) {
      const q = queue[head++], x = q % width, y = Math.floor(q / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      const neighbors = [x > 0 ? q - 1 : -1, x + 1 < width ? q + 1 : -1, y > 0 ? q - width : -1, y + 1 < height ? q + width : -1,
        x > 0 && y > 0 ? q - width - 1 : -1, x + 1 < width && y > 0 ? q - width + 1 : -1,
        x > 0 && y + 1 < height ? q + width - 1 : -1, x + 1 < width && y + 1 < height ? q + width + 1 : -1];
      for (const n of neighbors) if (n >= 0 && !seen[n] && gray[n] >= 36) { seen[n] = 1; queue[tail++] = n; }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    if (w < 160 || h < 160 || w / h < 0.70 || w / h > 1.43 || tail / (w * h) > 0.15 || tail < w + h) continue;
    candidates.push({ cx: (minX + maxX + 1) / 2, cy: (minY + maxY + 1) / 2, rx: w / 2 / 0.997, ry: h / 2 / 0.997, area: tail });
  }
  function chroma(x: number, y: number) {
    const ix = Math.round(x - 0.5), iy = Math.round(y - 0.5);
    if (ix < 1 || iy < 1 || ix + 1 >= width || iy + 1 >= height) return 0;
    let red = 0, blue = 0, light = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const p = ((iy + dy) * width + ix + dx) * 4;
      red += data[p]; blue += data[p + 2]; light += data[p] + data[p + 1] + data[p + 2];
    }
    return (red - blue) / (light + 1);
  }
  function at(g: Geometry, r: number, angle: number) {
    return chroma(g.cx + Math.cos(angle) * g.rx * r, g.cy + Math.sin(angle) * g.ry * r);
  }
  for (const g of candidates.sort((a, b) => b.area - a.area).slice(0, 4)) {
    const samples = Array.from({ length: 512 }, (_, i) => at(g, SYNC_RADIUS, i * TAU / 512));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const ranked: { offset: number; direction: number; score: number }[] = [];
    for (const direction of [1, -1]) for (let offset = 0; offset < 512; offset++) {
      let score = 0;
      for (let s = 0; s < 64; s++) score += SYNC[s] * (samples[(offset + direction * (s * 8 + 4) + 1024) % 512] - mean);
      ranked.push({ offset, direction, score });
    }
    ranked.sort((a, b) => b.score - a.score);
    for (const { offset, direction, score } of ranked.slice(0, 8)) {
      if (score < 1) continue;
      const rotation = offset * TAU / 512;
      const frame = new Uint8Array(FRAME_BYTES);
      for (let ring = 0; ring < 8; ring++) for (let sector = 0; sector < 64; sector++) {
        const r = INNER + (ring + 0.5) * BAND;
        const angle = rotation + direction * (sector + 0.5) * TAU / 64;
        let value = 0;
        for (const shift of [-0.012, 0, 0.012]) value += at(g, r + shift, angle);
        if (value / 3 > mean) { const bit = ring * 64 + sector; frame[bit >> 3] |= 1 << (7 - (bit & 7)); }
      }
      if (parseFrame(frame)) return frame;
    }
  }
  return null;
}
