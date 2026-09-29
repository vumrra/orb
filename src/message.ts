import { crc32 } from "./protocol";

export const MAX_TEXT_BYTES = 1_048_576;
export const ENVELOPE_BYTES = 13;
export const MAX_WIRE_BYTES = MAX_TEXT_BYTES + ENVELOPE_BYTES;
// flag, original UTF8 length, original CRC32, transmitted-body CRC32.
export function envelope(
  body: Uint8Array,
  compressed: number,
  length: number,
  checksum: number,
) {
  const packet = new Uint8Array(ENVELOPE_BYTES + body.length);
  const view = new DataView(packet.buffer);
  packet[0] = compressed;
  view.setUint32(1, length);
  view.setUint32(5, checksum);
  view.setUint32(9, compressed ? crc32(body) : checksum);
  packet.set(body, ENVELOPE_BYTES);
  return packet;
}
export function readEnvelope(packet: Uint8Array, wireLength = packet.length) {
  if (
    packet.length < ENVELOPE_BYTES ||
    wireLength > MAX_WIRE_BYTES ||
    wireLength <= ENVELOPE_BYTES
  )
    throw new Error("Invalid message length in bytes.");
  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );
  const length = view.getUint32(1),
    compressed = packet[0];
  if (
    compressed > 1 ||
    !length ||
    length > MAX_TEXT_BYTES ||
    (!compressed && wireLength !== length + ENVELOPE_BYTES) ||
    (compressed && wireLength - ENVELOPE_BYTES >= length)
  )
    throw new Error("Invalid message length or compression flag.");
  return {
    compressed: !!compressed,
    length,
    checksum: view.getUint32(5),
    wireChecksum: view.getUint32(9),
  };
}

async function transform(
  bytes: Uint8Array,
  decompress: boolean,
  limit: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const stream = decompress
    ? new DecompressionStream("deflate")
    : new CompressionStream("deflate");
  let position = 0;
  // Backpressure plus small compressed inputs bounds native expansion between
  // output-limit checks; a Blob chunk could otherwise inflate tens of MB at once.
  const input = new ReadableStream<BufferSource>({
    pull(controller) {
      if (position === bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, position + (decompress ? 256 : 65536));
      controller.enqueue(bytes.slice(position, end));
      position = end;
    },
  });
  const reader = input.pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > limit) {
        value.fill(0);
        throw new Error("Decoded message exceeds the byte length limit.");
      }
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    for (const chunk of chunks) chunk.fill(0);
  }
}
export async function prepareMessage(text: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!text.length || text.length > MAX_TEXT_BYTES)
    throw new Error(
      `Message must contain 1–${MAX_TEXT_BYTES.toLocaleString("en-US")} UTF-8 bytes.`,
    );
  const raw = new TextEncoder().encode(text);
  let compressed: Uint8Array | undefined;
  try {
    if (!raw.length || raw.length > MAX_TEXT_BYTES)
      throw new Error(
        `Message must contain 1–${MAX_TEXT_BYTES.toLocaleString("en-US")} UTF-8 bytes.`,
      );
    const checksum = crc32(raw);
    if (raw.length >= 1024) {
      if (typeof CompressionStream === "undefined")
        throw new Error("This browser cannot compress large messages.");
      // Deflate may expand slightly. This bound accommodates its overhead at the byte cap.
      compressed = await transform(raw, false, MAX_TEXT_BYTES + 65536, signal);
      signal?.throwIfAborted();
      if (compressed.length < raw.length)
        return envelope(compressed, 1, raw.length, checksum);
    }
    return envelope(raw, 0, raw.length, checksum);
  } finally {
    raw.fill(0);
    compressed?.fill(0);
  }
}
export function validateBody(packet: Uint8Array) {
  const meta = readEnvelope(packet);
  if (crc32(packet.subarray(ENVELOPE_BYTES)) !== meta.wireChecksum)
    throw new Error("Message checksum failed. Scan again.");
  return meta;
}
export async function decodeMessage(
  packet: Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const meta = validateBody(packet);
  let raw: Uint8Array | undefined;
  try {
    if (meta.compressed && typeof DecompressionStream === "undefined")
      throw new Error("This browser cannot decompress messages.");
    raw = meta.compressed
      ? await transform(
          packet.subarray(ENVELOPE_BYTES),
          true,
          meta.length,
          signal,
        )
      : packet.slice(ENVELOPE_BYTES);
    signal?.throwIfAborted();
    if (raw.length !== meta.length)
      throw new Error("Decoded message length in bytes does not match.");
    if (crc32(raw) !== meta.checksum)
      throw new Error("Original message checksum failed. Scan again.");
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        raw,
      );
    } catch {
      throw new Error("Invalid UTF-8 message. Scan again.");
    }
  } finally {
    raw?.fill(0);
  }
}
