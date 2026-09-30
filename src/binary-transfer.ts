import { crc32, MAX_TEXT_BYTES } from "./protocol";
import { fileDigest } from "./file-digest";

export const MAX_FILE_BYTES = 30_000_000;
export const SHARD_BYTES = 256;
export const BLOCK_SHARDS = 8;
const HEADER = 40;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export type TransferMeta = {
  name: string;
  mime: string;
  kind: "file" | "text";
};
export type VerifiedTransfer = {
  bytes: Uint8Array<ArrayBuffer>;
  meta: TransferMeta;
};
type Manifest = TransferMeta & { hash: Uint8Array };
export function sanitizeName(name: string) {
  return (
    name
      .replace(/[\\/\u0000-\u001f\u007f-\u009f]/g, "_")
      .replace(/^\.+/, "_")
      .trim() || "download"
  );
}
function bounded(value: string, limit: number) {
  let result = "";
  for (const char of value) {
    if (encoder.encode(result + char).length > limit) break;
    result += char;
  }
  return result;
}
function readManifest(payload: Uint8Array, length: number): Manifest | null {
  if (
    payload.length < 35 ||
    payload[32] > 1 ||
    payload[33] > 96 ||
    payload[34] > 80 ||
    payload.length !== 35 + payload[33] + payload[34]
  )
    return null;
  if (payload[32] === 1 && length > MAX_TEXT_BYTES) return null;
  try {
    const name = decoder.decode(payload.subarray(35, 35 + payload[33]));
    const mime = decoder.decode(payload.subarray(35 + payload[33]));
    if (!name || !/^[\w.+-]+\/[\w.+-]+$/.test(mime)) return null;
    return {
      hash: payload.slice(0, 32),
      kind: payload[32] ? "text" : "file",
      name: sanitizeName(name),
      mime,
    };
  } catch {
    return null;
  }
}
export function parseBinaryPacket(bytes: Uint8Array) {
  if (
    bytes.length < HEADER + 4 ||
    bytes.length > HEADER + SHARD_BYTES + 4 ||
    bytes[0] !== 0x4f ||
    bytes[1] !== 0x42 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 1 ||
    bytes[4] > 2 ||
    bytes.subarray(5, 8).some(Boolean) ||
    bytes[38] ||
    bytes[39]
  )
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const role = bytes[4],
    length = view.getUint32(24),
    total = view.getUint32(28),
    index = view.getUint32(32),
    size = view.getUint16(36);
  if (
    length > MAX_FILE_BYTES ||
    total !== Math.ceil(length / SHARD_BYTES) ||
    size !== bytes.length - HEADER - 4 ||
    crc32(bytes.subarray(0, -4)) !== view.getUint32(bytes.length - 4)
  )
    return null;
  const payload = bytes.subarray(HEADER, -4);
  let manifest: Manifest | null = null;
  if (role === 0) {
    if (index !== 0 || !(manifest = readManifest(payload, length))) return null;
  } else {
    if (
      size !== SHARD_BYTES ||
      index >= (role === 1 ? total : Math.ceil(total / BLOCK_SHARDS))
    )
      return null;
    if (
      role === 1 &&
      index === total - 1 &&
      payload.subarray(length - index * SHARD_BYTES).some(Boolean)
    )
      return null;
  }
  return {
    role,
    length,
    total,
    index,
    payload,
    manifest,
    id: Array.from(bytes.subarray(8, 24), (v) =>
      v.toString(16).padStart(2, "0"),
    ).join(""),
  };
}
function abort(signal?: AbortSignal) {
  signal?.throwIfAborted();
}
export async function createBinarySource(
  input: Uint8Array,
  meta: TransferMeta,
  signal?: AbortSignal,
) {
  if (input.length > MAX_FILE_BYTES)
    throw new Error("Files must be at most 30,000,000 bytes.");
  if (meta.kind === "text" && input.length > MAX_TEXT_BYTES)
    throw new Error("Text exceeds 1 MiB.");
  abort(signal);
  const bytes = input.slice();
  try {
    const hash = await fileDigest(bytes, signal);
    abort(signal);
    const name = encoder.encode(bounded(sanitizeName(meta.name), 96));
    const mime = encoder.encode(
      /^[\w.+-]+\/[\w.+-]+$/.test(meta.mime) &&
        encoder.encode(meta.mime).length <= 80
        ? meta.mime
        : "application/octet-stream",
    );
    const manifest = new Uint8Array(35 + name.length + mime.length);
    manifest.set(hash);
    manifest[32] = meta.kind === "text" ? 1 : 0;
    manifest[33] = name.length;
    manifest[34] = mime.length;
    manifest.set(name, 35);
    manifest.set(mime, 35 + name.length);
    const id = crypto.getRandomValues(new Uint8Array(16)),
      total = Math.ceil(bytes.length / SHARD_BYTES);
    let cleared = false,
      cursor = 0,
      lap = 0,
      single = 0;
    function check() {
      abort(signal);
      if (cleared) throw new Error("Transfer cancelled.");
    }
    function packet(role: number, index: number, payload: Uint8Array) {
      check();
      const out = new Uint8Array(HEADER + payload.length + 4),
        v = new DataView(out.buffer);
      out.set([0x4f, 0x42, 0x46, 1, role]);
      out.set(id, 8);
      v.setUint32(24, bytes.length);
      v.setUint32(28, total);
      v.setUint32(32, index);
      v.setUint16(36, payload.length);
      out.set(payload, HEADER);
      v.setUint32(out.length - 4, crc32(out.subarray(0, -4)));
      return out;
    }
    const source = {
      total,
      manifest: () => packet(0, 0, manifest),
      data(index: number) {
        check();
        if (!Number.isInteger(index) || index < 0 || index >= total)
          throw new Error("Shard index out of bounds.");
        const payload = new Uint8Array(SHARD_BYTES);
        payload.set(
          bytes.subarray(index * SHARD_BYTES, (index + 1) * SHARD_BYTES),
        );
        return packet(1, index, payload);
      },
      parity(index: number) {
        check();
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= Math.ceil(total / BLOCK_SHARDS)
        )
          throw new Error("Block index out of bounds.");
        const payload = new Uint8Array(SHARD_BYTES);
        for (
          let i = index * BLOCK_SHARDS * SHARD_BYTES;
          i < Math.min(bytes.length, (index + 1) * BLOCK_SHARDS * SHARD_BYTES);
          i++
        )
          payload[i % SHARD_BYTES] ^= bytes[i];
        return packet(2, index, payload);
      },
      next(cells: 1 | 4 | 9) {
        check();
        if (![1, 4, 9].includes(cells)) throw new Error("Invalid tile count.");
        if (!total) return [source.manifest()];
        if (cells === 1) {
          const slot = single++ % 10;
          if (slot === 0) return [source.manifest()];
          if (slot === 9)
            return [
              source.parity(
                Math.floor(((cursor - 1 + total) % total) / BLOCK_SHARDS),
              ),
            ];
          const out = source.data(cursor);
          cursor = (cursor + 1) % total;
          return [out];
        }
        const block = Math.floor(cursor / BLOCK_SHARDS),
          rotation = lap % cells,
          out = [source.manifest()];
        for (let i = 0; i < cells - 2; i++) {
          out.push(source.data(cursor));
          cursor = (cursor + 1) % total;
          if (cursor === 0) lap++;
        }
        out.push(source.parity(block));
        // 매 순환마다 위치를 바꿔 고정된 가림에서도 모든 역할을 수신합니다.
        return out.slice(rotation).concat(out.slice(0, rotation));
      },
      clear() {
        cleared = true;
        bytes.fill(0);
        manifest.fill(0);
        id.fill(0);
      },
    };
    signal?.addEventListener("abort", () => source.clear(), { once: true });
    return source;
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}
export type BinarySource = Awaited<ReturnType<typeof createBinarySource>>;

export class BinaryCollector {
  count = 0;
  total = 0;
  repaired = 0;
  private id = "";
  private meta: Manifest | null = null;
  private bytes = new Uint8Array(0);
  private seen = new Uint8Array(0);
  // Bounded repair cache: missing older parity is retransmitted continuously.
  private parity = new Map<number, Uint8Array>();
  private generation = 0;
  get ready() {
    return !!this.meta && this.count === this.total;
  }
  clear() {
    this.generation++;
    this.bytes.fill(0);
    this.seen.fill(0);
    this.meta?.hash.fill(0);
    for (const p of this.parity.values()) p.fill(0);
    this.parity.clear();
    this.bytes = new Uint8Array(0);
    this.seen = new Uint8Array(0);
    this.id = "";
    this.meta = null;
    this.count = this.total = this.repaired = 0;
  }
  add(bytes: Uint8Array) {
    const p = parseBinaryPacket(bytes);
    if (!p) return false;
    if (!this.meta) {
      if (!p.manifest) return false;
      this.meta = p.manifest;
      this.id = p.id;
      this.total = p.total;
      this.bytes = new Uint8Array(p.length);
      this.seen = new Uint8Array(p.total);
    }
    if (
      p.id !== this.id ||
      p.length !== this.bytes.length ||
      p.total !== this.total
    )
      return false;
    if (p.role === 0) return this.ready;
    if (p.role === 1) {
      if (!this.seen[p.index]) {
        this.bytes.set(
          p.payload.subarray(
            0,
            Math.min(SHARD_BYTES, this.bytes.length - p.index * SHARD_BYTES),
          ),
          p.index * SHARD_BYTES,
        );
        this.seen[p.index] = 1;
        this.count++;
      }
    } else if (!this.parity.has(p.index)) {
      if (this.parity.size === 128) {
        const key = this.parity.keys().next().value!;
        this.parity.get(key)!.fill(0);
        this.parity.delete(key);
      }
      this.parity.set(p.index, p.payload.slice());
    }
    this.repair(p.role === 1 ? Math.floor(p.index / BLOCK_SHARDS) : p.index);
    return this.ready;
  }
  private repair(block: number) {
    const parity = this.parity.get(block);
    if (!parity) return;
    const start = block * BLOCK_SHARDS,
      end = Math.min(this.total, start + BLOCK_SHARDS);
    let missing = -1;
    for (let i = start; i < end; i++)
      if (!this.seen[i]) {
        if (missing !== -1) return;
        missing = i;
      }
    if (missing !== -1) {
      const recovered = parity.slice();
      for (let i = start; i < end; i++)
        if (i !== missing)
          for (
            let j = 0;
            j < SHARD_BYTES && i * SHARD_BYTES + j < this.bytes.length;
            j++
          )
            recovered[j] ^= this.bytes[i * SHARD_BYTES + j];
      const size = Math.min(
        SHARD_BYTES,
        this.bytes.length - missing * SHARD_BYTES,
      );
      if (recovered.subarray(size).some(Boolean)) {
        recovered.fill(0);
        parity.fill(0);
        this.parity.delete(block);
        return;
      }
      this.bytes.set(recovered.subarray(0, size), missing * SHARD_BYTES);
      recovered.fill(0);
      this.seen[missing] = 1;
      this.count++;
      this.repaired++;
    }
    parity.fill(0);
    this.parity.delete(block);
  }
  async verify(): Promise<VerifiedTransfer> {
    if (!this.ready) throw new Error("Transfer incomplete.");
    const generation = this.generation,
      meta = this.meta!;
    const hash = await fileDigest(this.bytes);
    if (generation !== this.generation)
      throw new Error("Verification cancelled.");
    if (hash.some((v, i) => v !== meta.hash[i])) {
      this.clear();
      throw new Error("SHA-256 verification failed. Please receive again.");
    }
    const bytes = this.bytes;
    this.bytes = new Uint8Array(0);
    const result = {
      bytes,
      meta: { name: meta.name, mime: meta.mime, kind: meta.kind },
    };
    this.clear();
    return result;
  }
}
