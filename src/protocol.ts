export const MAX_TEXT_BYTES = 384;
const MIN_PACKET_BYTES = 1;
const MAX_PACKET_BYTES = MAX_TEXT_BYTES;
export const FRAME_BYTES = 40;
export const CHUNK_BYTES = 16;
const MAX_FRAMES = Math.ceil(MAX_PACKET_BYTES / CHUNK_BYTES);
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
  checksum: number;
  chunk: Uint8Array;
}

export function splitFrames(packet: Uint8Array): Uint8Array[] {
  if (packet.length < MIN_PACKET_BYTES || packet.length > MAX_PACKET_BYTES)
    throw new Error("Packet out of bounds.");
  const id = crypto.getRandomValues(new Uint8Array(8));
  const total = Math.ceil(packet.length / CHUNK_BYTES);
  return Array.from({ length: total }, (_, index) => {
    const frame = new Uint8Array(FRAME_BYTES);
    const view = new DataView(frame.buffer);
    const chunk = packet.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
    frame.set([0x4f, 0x42, 3, index, total, chunk.length]);
    frame.set(id, 6);
    view.setUint16(14, packet.length);
    view.setUint32(16, crc32(packet));
    frame.set(chunk, 20);
    view.setUint32(FRAME_BYTES - 4, crc32(frame.subarray(0, FRAME_BYTES - 4)));
    return frame;
  });
}
export function parseFrame(bytes: Uint8Array): Frame | null {
  if (bytes.length !== FRAME_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes[0] !== 0x4f ||
    bytes[1] !== 0x42 ||
    bytes[2] !== 3 ||
    crc32(bytes.subarray(0, FRAME_BYTES - 4)) !==
      view.getUint32(FRAME_BYTES - 4)
  )
    return null;
  const index = bytes[3],
    total = bytes[4],
    size = bytes[5],
    length = view.getUint16(14);
  if (
    length < MIN_PACKET_BYTES ||
    length > MAX_PACKET_BYTES ||
    total < 1 ||
    total > MAX_FRAMES ||
    total !== Math.ceil(length / CHUNK_BYTES) ||
    index >= total
  )
    return null;
  if (size !== Math.min(CHUNK_BYTES, length - index * CHUNK_BYTES)) return null;
  if (bytes.subarray(20 + size, FRAME_BYTES - 4).some((value) => value !== 0))
    return null;
  return {
    id: Array.from(bytes.subarray(6, 14), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
    index,
    total,
    length,
    checksum: view.getUint32(16),
    chunk: bytes.slice(20, 20 + size),
  };
}

export class Collector {
  private meta: Frame | null = null;
  private chunks = new Map<number, Uint8Array>();
  private decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private next = 0;
  private text = "";
  get prefix() {
    return this.text;
  }
  get count() {
    return this.chunks.size;
  }
  get total() {
    return this.meta?.total ?? 0;
  }
  add(bytes: Uint8Array): Uint8Array | null {
    const frame = parseFrame(bytes);
    if (!frame) return null;
    const meta = this.meta;
    // Lock the first valid transfer until reset; interleaved senders cannot mix messages.
    if (
      meta &&
      (meta.id !== frame.id ||
        meta.total !== frame.total ||
        meta.length !== frame.length ||
        meta.checksum !== frame.checksum)
    ) {
      frame.chunk.fill(0);
      return null;
    }
    if (!meta) this.meta = { ...frame, chunk: new Uint8Array() };
    if (this.chunks.has(frame.index)) {
      frame.chunk.fill(0);
      return null;
    }
    this.chunks.set(frame.index, frame.chunk);
    let packet: Uint8Array | null = null;
    if (this.chunks.size === frame.total) {
      packet = new Uint8Array(frame.length);
      for (const [index, chunk] of this.chunks)
        packet.set(chunk, index * CHUNK_BYTES);
      if (crc32(packet) !== frame.checksum) {
        packet.fill(0);
        this.clear();
        throw new Error("Message checksum failed. Scan again.");
      }
    }
    try {
      while (this.chunks.has(this.next)) {
        this.text += this.decoder.decode(this.chunks.get(this.next), {
          stream: true,
        });
        this.next++;
      }
      if (packet) this.text += this.decoder.decode();
    } catch {
      packet?.fill(0);
      this.clear();
      throw new Error("Invalid UTF-8 message. Scan again.");
    }
    return packet;
  }

  clear() {
    for (const chunk of this.chunks.values()) chunk.fill(0);
    this.chunks.clear();
    this.meta = null;
    this.next = 0;
    this.text = "";
    this.decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  }
}
