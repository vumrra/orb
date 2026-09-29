import {
  envelope,
  readEnvelope,
  validateBody,
  MAX_TEXT_BYTES,
  MAX_WIRE_BYTES,
  ENVELOPE_BYTES,
} from "./message";
export { MAX_TEXT_BYTES } from "./message";
export const FRAME_BYTES = 40;
export const CHUNK_BYTES = 20;
export const MAX_FRAMES = Math.ceil(MAX_WIRE_BYTES / CHUNK_BYTES);
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export interface Frame {
  id: string;
  index: number;
  total: number;
  length: number;
  chunk: Uint8Array;
}
export interface FrameSource {
  length: number;
  get(index: number): Uint8Array;
  clear(): void;
}
const get24 = (b: Uint8Array, offset: number) =>
  b[offset] * 65536 + b[offset + 1] * 256 + b[offset + 2];
function set24(b: Uint8Array, offset: number, n: number) {
  b[offset] = n >>> 16;
  b[offset + 1] = n >>> 8;
  b[offset + 2] = n;
}
// One owned wire buffer; no frame objects or Bar symbols are allocated until displayed.
export function createWireFrames(wire: Uint8Array): FrameSource {
  readEnvelope(wire);
  const packet = wire.slice(),
    id = crypto.getRandomValues(new Uint8Array(8));
  const total = Math.ceil(packet.length / CHUNK_BYTES);
  let cleared = false;
  return {
    length: total,
    get(index) {
      if (cleared || !Number.isInteger(index) || index < 0 || index >= total)
        throw new Error("Frame index out of bounds.");
      const frame = new Uint8Array(FRAME_BYTES);
      frame.set([0x4f, 4]);
      frame.set(id, 2);
      set24(frame, 10, index);
      set24(frame, 13, packet.length);
      frame.set(
        packet.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES),
        16,
      );
      new DataView(frame.buffer).setUint32(36, crc32(frame.subarray(0, 36)));
      return frame;
    },
    clear() {
      cleared = true;
      this.length = 0;
      packet.fill(0);
      id.fill(0);
    },
  };
}
export function createFrames(packet: Uint8Array): FrameSource {
  if (!packet.length || packet.length > MAX_TEXT_BYTES)
    throw new Error("Packet out of bounds in UTF-8 bytes.");
  const wire = envelope(packet, 0, packet.length, crc32(packet));
  try {
    return createWireFrames(wire);
  } finally {
    wire.fill(0);
  }
}
// Convenience for small fixtures only. Production rendering always uses FrameSource.
export function splitFrames(packet: Uint8Array): Uint8Array[] {
  if (packet.length > 65536)
    throw new Error("Use lazy createFrames for large packets.");
  const source = createFrames(packet);
  try {
    return Array.from({ length: source.length }, (_, i) => source.get(i));
  } finally {
    source.clear();
  }
}
export function parseFrame(bytes: Uint8Array): Frame | null {
  if (bytes.length !== FRAME_BYTES || bytes[0] !== 0x4f || bytes[1] !== 4)
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (crc32(bytes.subarray(0, 36)) !== view.getUint32(36)) return null;
  const index = get24(bytes, 10),
    length = get24(bytes, 13),
    total = Math.ceil(length / CHUNK_BYTES);
  if (length <= ENVELOPE_BYTES || length > MAX_WIRE_BYTES || index >= total)
    return null;
  const size = Math.min(CHUNK_BYTES, length - index * CHUNK_BYTES);
  if (bytes.subarray(16 + size, 36).some((v) => v !== 0)) return null;
  return {
    id: Array.from(bytes.subarray(2, 10), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
    index,
    total,
    length,
    chunk: bytes.slice(16, 16 + size),
  };
}
export class Collector {
  private meta: Frame | null = null;
  private packet = new Uint8Array();
  private seen = new Uint8Array();
  private decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private next = 0;
  private received = 0;
  private text = "";
  private compressed = false;
  // App needs the protected envelope for asynchronous final decompression.
  constructor(private wireResult = false) {}
  get prefix() {
    return this.text;
  }
  get count() {
    return this.received;
  }
  get total() {
    return this.meta?.total ?? 0;
  }
  add(bytes: Uint8Array): Uint8Array | null {
    const frame = parseFrame(bytes);
    if (!frame) return null;
    if (
      this.meta &&
      (this.meta.id !== frame.id || this.meta.length !== frame.length)
    ) {
      frame.chunk.fill(0);
      return null;
    }
    if (!this.meta) {
      this.meta = { ...frame, chunk: new Uint8Array() };
      this.packet = new Uint8Array(frame.length);
      this.seen = new Uint8Array(frame.total);
    }
    if (this.seen[frame.index]) {
      frame.chunk.fill(0);
      return null;
    }
    this.packet.set(frame.chunk, frame.index * CHUNK_BYTES);
    frame.chunk.fill(0);
    this.seen[frame.index] = 1;
    this.received++;
    try {
      // Decode each byte once, including when a late gap releases many frames.
      const from = this.next;
      while (this.seen[this.next]) this.next++;
      if (this.next > from) {
        if (from === 0) this.compressed = readEnvelope(this.packet).compressed;
        if (!this.compressed) {
          const begin = Math.max(ENVELOPE_BYTES, from * CHUNK_BYTES);
          const end = Math.min(this.packet.length, this.next * CHUNK_BYTES);
          try {
            this.text += this.decoder.decode(this.packet.subarray(begin, end), {
              stream: this.next !== frame.total,
            });
          } catch {
            throw new Error("Invalid UTF-8 message. Scan again.");
          }
        }
      }
      if (this.received !== frame.total) return null;
      const meta = validateBody(this.packet);
      if (!meta.compressed && meta.checksum !== meta.wireChecksum)
        throw new Error("Original message checksum failed. Scan again.");
      return this.wireResult || meta.compressed
        ? this.packet.slice()
        : this.packet.slice(ENVELOPE_BYTES);
    } catch (error) {
      this.clear();
      throw error;
    }
  }
  clear() {
    this.packet.fill(0);
    this.seen.fill(0);
    this.packet = new Uint8Array();
    this.seen = new Uint8Array();
    this.meta = null;
    this.next = 0;
    this.received = 0;
    this.text = "";
    this.compressed = false;
    this.decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  }
}
