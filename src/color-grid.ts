import { MAX_FILE_BYTES, sanitizeName } from "./binary-transfer";
import type { TransferMeta, VerifiedTransfer } from "./binary-transfer";
import { crc32, MAX_TEXT_BYTES } from "./protocol";
import { fileDigest } from "./file-digest";
import { rsEncode } from "./sound-fec";

export type ColorGrid = 64 | 128 | 256;
const HEADER = 80;
const NAME_LIMIT = 1024,
  MIME_LIMIT = 80;
export const COLOR_ENVELOPE_ALLOWANCE = 8 + NAME_LIMIT + MIME_LIMIT;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const colorCapacity = (grid: ColorGrid) => (grid * grid * 3) / 8;
// Each 128-byte stripe has 16 RS parity bytes (up to eight bad bytes).
// Interleaving stripes spreads short rolling/shadow/scratch bands across words.
export const COLOR_WORD_DATA = 128,
  COLOR_WORD_BYTES = 144;
export const COLOR_HEADER_BYTES = HEADER + 16;
export function colorLayout(grid: ColorGrid) {
  const top = 18 + Math.ceil((COLOR_HEADER_BYTES * 8) / grid);
  const rows = Math.ceil(
    ((colorCapacity(grid) / COLOR_WORD_DATA) * COLOR_WORD_BYTES * 8) /
      (3 * grid),
  );
  return { width: grid + 28, height: top + rows + 18, top, rows };
}
export function colorGridForViewport(width: number, height: number): ColorGrid {
  const l = colorLayout(64);
  if (width >= l.width * 3 && height >= l.height * 3) return 64;
  throw new Error("More screen space is needed for a readable color tile.");
}
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
const mul = (a: number, b: number) => (a && b ? exp[log[a] + log[b]] : 0);
const div = (a: number, b: number) =>
  a ? exp[(log[a] - log[b] + 255) % 255] : 0;
const weights = Array.from({ length: 8 }, (_, i) =>
  Uint8Array.from({ length: 256 }, (_, b) => mul(i + 1, b)),
);
function bounded(value: string, limit: number) {
  let result = "",
    length = 0;
  for (const c of value) {
    length += encoder.encode(c).length;
    if (length > limit) break;
    result += c;
  }
  return result;
}
function safeName(name: string) {
  const safe = sanitizeName(name);
  if (encoder.encode(safe).length <= NAME_LIMIT) return safe;
  const dot = safe.lastIndexOf(".");
  const extension = dot > 0 ? bounded(safe.slice(dot), 128) : "";
  return (
    bounded(
      safe.slice(0, dot > 0 ? dot : undefined),
      NAME_LIMIT - encoder.encode(extension).length,
    ) + extension
  );
}
function readHeader(header: Uint8Array) {
  if (
    header.length < HEADER ||
    header[0] !== 67 ||
    header[1] !== 71 ||
    header[2] !== 82 ||
    header[3] !== 3 ||
    ![6, 7, 8].includes(header[4]) ||
    header[5] > 2 ||
    header[6] ||
    header[7] ||
    header.subarray(72, 80).some(Boolean)
  )
    return null;
  const v = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (crc32(header.subarray(0, 68)) !== v.getUint32(68)) return null;
  const grid = (1 << header[4]) as ColorGrid,
    size = colorCapacity(grid),
    length = v.getUint32(24),
    index = v.getUint32(28),
    role = header[5];
  if (length < 12 || length > MAX_FILE_BYTES + COLOR_ENVELOPE_ALLOWANCE)
    return null;
  const total = Math.ceil(length / size);
  if (index >= (role ? Math.ceil(total / 8) : total)) return null;
  return {
    grid,
    size,
    length,
    index,
    role,
    total,
    crc: v.getUint32(64),
    hash: header.subarray(32, 64),
    id: header.subarray(8, 24),
  };
}
export function parseColorPacket(packet: Uint8Array) {
  const p = readHeader(packet);
  if (!p || packet.length !== HEADER + p.size) return null;
  const payload = packet.subarray(HEADER);
  if (
    crc32(payload) !== p.crc ||
    (!p.role &&
      p.index === p.total - 1 &&
      payload.subarray(p.length - p.index * p.size).some(Boolean))
  )
    return null;
  return { ...p, payload };
}
export type ColorSource = {
  readonly total: number;
  readonly grid: ColorGrid;
  next(): Uint8Array<ArrayBuffer>;
  data(index: number): Uint8Array<ArrayBuffer>;
  parity(block: number, kind: 0 | 1): Uint8Array<ArrayBuffer>;
  clear(): void;
};
export async function createColorSource(
  input: Uint8Array,
  meta: TransferMeta,
  signal?: AbortSignal,
  grid: ColorGrid = 64,
): Promise<ColorSource> {
  if (input.length > MAX_FILE_BYTES)
    throw new Error("Files must be at most 30,000,000 bytes.");
  if (meta.kind === "text" && input.length > MAX_TEXT_BYTES)
    throw new Error("Text exceeds 1 MiB.");
  if (![64, 128, 256].includes(grid) || !["text", "file"].includes(meta.kind))
    throw new Error("Invalid color transfer settings.");
  signal?.throwIfAborted();
  const name = encoder.encode(safeName(meta.name));
  const mime = encoder.encode(
    /^[\w.+-]+\/[\w.+-]+$/.test(meta.mime) &&
      encoder.encode(meta.mime).length <= MIME_LIMIT
      ? meta.mime
      : "application/octet-stream",
  );
  const bytes = new Uint8Array(8 + name.length + mime.length + input.length);
  const v = new DataView(bytes.buffer);
  bytes.set([67, 69, 1, meta.kind === "text" ? 1 : 0]);
  v.setUint16(4, name.length);
  v.setUint16(6, mime.length);
  bytes.set(name, 8);
  bytes.set(mime, 8 + name.length);
  bytes.set(input, 8 + name.length + mime.length);
  name.fill(0);
  mime.fill(0);
  let hash = new Uint8Array(0),
    id = new Uint8Array(0),
    cleared = false,
    cursor = 0,
    lap = 0;
  const clear = () => {
    cleared = true;
    bytes.fill(0);
    hash.fill(0);
    id.fill(0);
    signal?.removeEventListener("abort", clear);
  };
  signal?.addEventListener("abort", clear, { once: true });
  const check = () => {
    signal?.throwIfAborted();
    if (cleared) throw new Error("Transfer cancelled.");
  };
  try {
    hash = await fileDigest(bytes, signal);
    check();
    id = crypto.getRandomValues(new Uint8Array(16));
    const size = colorCapacity(grid),
      total = Math.ceil(bytes.length / size),
      blocks = Math.ceil(total / 8),
      frames = total + blocks * 2;
    // 카메라가 매 2/3/4/5번째 프레임만 잡아도 같은 shard를 계속 놓치지 않게 합니다.
    let lapStep = 0;
    while ([2, 3, 5].some((divisor) => (frames - lapStep) % divisor === 0))
      lapStep++;
    function packet(role: number, index: number) {
      check();
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= (role ? blocks : total)
      )
        throw new Error("Color shard index out of bounds.");
      const out = new Uint8Array(HEADER + size),
        view = new DataView(out.buffer),
        payload = out.subarray(HEADER);
      if (role) {
        for (let slot = 0; slot < 8; slot++) {
          const offset = (index * 8 + slot) * size;
          for (let j = 0; j < size && offset + j < bytes.length; j++)
            payload[j] ^=
              role === 2 ? weights[slot][bytes[offset + j]] : bytes[offset + j];
        }
      } else payload.set(bytes.subarray(index * size, (index + 1) * size));
      out.set([67, 71, 82, 3, Math.log2(grid), role]);
      out.set(id, 8);
      view.setUint32(24, bytes.length);
      view.setUint32(28, index);
      out.set(hash, 32);
      view.setUint32(64, crc32(payload));
      view.setUint32(68, crc32(out.subarray(0, 68)));
      return out;
    }
    return {
      total,
      grid,
      clear,
      data: (i) => packet(0, i),
      parity: (b, kind) => {
        if (kind !== 0 && kind !== 1) throw new Error("Invalid parity kind.");
        return packet(kind + 1, b);
      },
      next() {
        check();
        // 한 바퀴의 길이와 회전량을 함께 고려해 샘플링 주기 고정을 피합니다.
        const position = (cursor + lap) % frames,
          block = Math.floor(position / 10),
          slot = position % 10,
          dataCount = Math.min(8, total - block * 8);
        if (++cursor === frames) {
          cursor = 0;
          lap = (lap + lapStep) % frames;
        }
        return slot < dataCount
          ? packet(0, block * 8 + slot)
          : packet(slot - dataCount + 1, block);
      },
    };
  } catch (error) {
    clear();
    throw error;
  }
}
export class ColorCollector {
  count = 0;
  total = 0;
  repaired = 0;
  private bytes = new Uint8Array(0);
  private seen = new Uint8Array(0);
  private hash = new Uint8Array(0);
  private id = new Uint8Array(0);
  private size = 0;
  // At most 16 * 2 * 24,576 bytes, regardless of file size or packet order.
  private parities = new Map<number, (Uint8Array | undefined)[]>();
  private generation = 0;
  private verification: AbortController | null = null;
  get ready() {
    return this.total > 0 && this.count === this.total;
  }
  clear() {
    this.generation++;
    this.verification?.abort();
    this.verification = null;
    this.bytes.fill(0);
    this.seen.fill(0);
    this.hash.fill(0);
    this.id.fill(0);
    for (const pair of this.parities.values()) pair.forEach((p) => p?.fill(0));
    this.parities.clear();
    this.bytes = new Uint8Array(0);
    this.seen = new Uint8Array(0);
    this.hash = new Uint8Array(0);
    this.id = new Uint8Array(0);
    this.count = this.total = this.size = this.repaired = 0;
  }
  add(packet: Uint8Array) {
    const p = parseColorPacket(packet);
    if (!p) return false;
    if (!this.total) {
      this.total = p.total;
      this.size = p.size;
      this.bytes = new Uint8Array(p.length);
      this.seen = new Uint8Array(p.total);
      this.hash = p.hash.slice();
      this.id = p.id.slice();
    }
    if (
      p.length !== this.bytes.length ||
      p.size !== this.size ||
      p.id.some((v, i) => v !== this.id[i]) ||
      p.hash.some((v, i) => v !== this.hash[i])
    )
      return false;
    const block = p.role ? p.index : Math.floor(p.index / 8);
    if (!p.role) this.store(p.index, p.payload);
    else {
      if (!this.parities.has(block)) {
        if (this.parities.size >= 16)
          this.drop(this.parities.keys().next().value!);
        this.parities.set(block, []);
      }
      const pair = this.parities.get(block)!;
      if (!pair[p.role - 1]) pair[p.role - 1] = p.payload.slice();
    }
    this.repair(block);
    return this.ready;
  }
  private drop(block: number) {
    this.parities.get(block)?.forEach((p) => p?.fill(0));
    this.parities.delete(block);
  }
  private store(index: number, data: Uint8Array) {
    if (this.seen[index]) return;
    const length = Math.min(this.size, this.bytes.length - index * this.size);
    this.bytes.set(data.subarray(0, length), index * this.size);
    this.seen[index] = 1;
    this.count++;
  }
  private repair(block: number) {
    const pair = this.parities.get(block);
    if (!pair) return;
    const start = block * 8,
      end = Math.min(this.total, start + 8),
      missing: number[] = [];
    for (let i = start; i < end; i++) if (!this.seen[i]) missing.push(i);
    if (!missing.length) {
      this.drop(block);
      return;
    }
    if (missing.length > 2 || (missing.length === 2 && (!pair[0] || !pair[1])))
      return;
    const residual = pair.map((p, kind) => {
      if (!p) return undefined;
      const out = p.slice();
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
    const first = new Uint8Array(this.size),
      second = missing.length === 2 ? new Uint8Array(this.size) : null;
    const a = missing[0] - start + 1,
      b = (missing[1] ?? 0) - start + 1;
    for (let j = 0; j < this.size; j++) {
      first[j] = second
        ? div(residual[1]![j] ^ mul(b, residual[0]![j]), a ^ b)
        : residual[0]
          ? residual[0][j]
          : div(residual[1]![j], a);
      if (second) second[j] = residual[0]![j] ^ first[j];
    }
    const chunks = second ? [first, second] : [first];
    if (
      chunks.every(
        (p, i) =>
          !p
            .subarray(
              Math.min(this.size, this.bytes.length - missing[i] * this.size),
            )
            .some(Boolean),
      )
    ) {
      chunks.forEach((p, i) => this.store(missing[i], p));
      this.repaired += chunks.length;
    }
    chunks.forEach((p) => p.fill(0));
    residual.forEach((p) => p?.fill(0));
    this.drop(block);
  }
  async verify(): Promise<VerifiedTransfer> {
    if (!this.ready) throw new Error("Transfer incomplete.");
    if (this.verification) throw new Error("Verification already in progress.");
    const generation = this.generation,
      controller = new AbortController();
    this.verification = controller;
    let digest: Uint8Array | undefined;
    try {
      digest = await fileDigest(this.bytes, controller.signal);
      if (generation !== this.generation)
        throw new Error("Verification cancelled.");
      if (digest.some((v, i) => v !== this.hash[i]))
        throw new Error("SHA-256 verification failed. Please receive again.");
      const bytes = this.bytes,
        view = new DataView(bytes.buffer),
        nameLength = view.getUint16(4),
        mimeLength = view.getUint16(6),
        offset = 8 + nameLength + mimeLength;
      if (
        bytes[0] !== 67 ||
        bytes[1] !== 69 ||
        bytes[2] !== 1 ||
        bytes[3] > 1 ||
        !nameLength ||
        nameLength > NAME_LIMIT ||
        !mimeLength ||
        mimeLength > MIME_LIMIT ||
        offset > bytes.length ||
        bytes.length - offset > (bytes[3] ? MAX_TEXT_BYTES : MAX_FILE_BYTES)
      )
        throw new Error("Invalid color transfer metadata or size.");
      const name = decoder.decode(bytes.subarray(8, 8 + nameLength)),
        mime = decoder.decode(bytes.subarray(8 + nameLength, offset));
      if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime))
        throw new Error("Invalid color transfer MIME type.");
      const result: VerifiedTransfer = {
        bytes: bytes.slice(offset),
        meta: {
          name: sanitizeName(name),
          mime,
          kind: bytes[3] ? "text" : "file",
        },
      };
      this.clear();
      return result;
    } catch (error) {
      if (generation !== this.generation)
        throw new Error("Verification cancelled.");
      this.clear();
      throw error;
    } finally {
      digest?.fill(0);
    }
  }
}

export function colorRaster(packet: Uint8Array) {
  const p = parseColorPacket(packet);
  if (!p) throw new Error("Invalid color packet.");
  const l = colorLayout(p.grid),
    data = new Uint8ClampedArray(l.width * l.height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    const i = (y * l.width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  };
  // Inverted QR-style 1:1:3:1:1 nested finders. Black surrounds them in
  // either UI theme. Every local tile carries its own four finders and CRC.
  for (const x0 of [3, l.width - 10])
    for (const y0 of [3, l.height - 10])
      for (let y = 0; y < 7; y++)
        for (let x = 0; x < 7; x++)
          if (
            x === 0 ||
            x === 6 ||
            y === 0 ||
            y === 6 ||
            (x >= 2 && x <= 4 && y >= 2 && y <= 4)
          )
            put(x0 + x, y0 + y, 255, 255, 255);
  const palette = (x: number, y: number, n: number) =>
    put(
      x,
      y,
      32 + 192 * (n & 1),
      32 + 192 * ((n >> 1) & 1),
      32 + 192 * ((n >> 2) & 1),
    );
  // Four observed palettes allow interpolation over an unevenly lit tile.
  for (const y0 of [12, l.top + l.rows + 2])
    for (let y = y0; y < y0 + 4; y++)
      for (let x = 0; x < p.grid; x++)
        palette(14 + x, y, Math.floor((x * 16) / p.grid) % 8);
  const header = rsEncode(packet.subarray(0, HEADER));
  for (let k = 0; k < header.length * 8; k++) {
    const c = header[k >> 3] & (1 << (k & 7)) ? 224 : 32;
    put(14 + (k % p.grid), 17 + Math.floor(k / p.grid), c, c, c);
  }
  header.fill(0);
  const words = p.size / COLOR_WORD_DATA;
  const coded = new Uint8Array(words * COLOR_WORD_BYTES);
  for (let w = 0; w < words; w++) {
    const code = rsEncode(
      p.payload.subarray(w * COLOR_WORD_DATA, (w + 1) * COLOR_WORD_DATA),
    );
    for (let j = 0; j < COLOR_WORD_BYTES; j++) coded[j * words + w] = code[j];
    code.fill(0);
  }
  for (let k = 0; k < (coded.length * 8) / 3; k++) {
    const bit = k * 3,
      i = bit >> 3,
      shift = bit & 7;
    const n = ((coded[i] >> shift) | ((coded[i + 1] ?? 0) << (8 - shift))) & 7;
    palette(14 + (k % p.grid), l.top + Math.floor(k / p.grid), n);
  }
  coded.fill(0);
  return { data, width: l.width, height: l.height };
}
// Also usable on a transformed canvas for raster fixtures. The live board uses
// the identical raster with one nearest-neighbor drawImage per tile.
export function drawColorGrid(
  ctx: CanvasRenderingContext2D,
  packet: Uint8Array,
  cell: number,
) {
  if (!Number.isInteger(cell) || cell < 1)
    throw new Error("Integral color cell size required.");
  const image = colorRaster(packet);
  try {
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, image.width * cell, image.height * cell);
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width;) {
        const i = (y * image.width + x) * 4,
          d = image.data;
        let end = x + 1;
        while (end < image.width) {
          const j = (y * image.width + end) * 4;
          if (d[i] !== d[j] || d[i + 1] !== d[j + 1] || d[i + 2] !== d[j + 2])
            break;
          end++;
        }
        if (d[i] || d[i + 1] || d[i + 2]) {
          ctx.fillStyle = `rgb(${d[i]},${d[i + 1]},${d[i + 2]})`;
          ctx.fillRect(x * cell, y * cell, (end - x) * cell, cell);
        }
        x = end;
      }
    }
  } finally {
    image.data.fill(0);
  }
}
// Header decoding is shared with the pixel scanner so a false finder cannot
// select unbounded dimensions or trigger payload allocation.
export { readHeader as readColorHeader };
