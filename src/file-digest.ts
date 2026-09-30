// HTTP에서도 동일한 SHA-256을 유지하며, 지원되는 환경에서는 Web Crypto를 사용합니다.
export async function fileDigest(
  bytes: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const result = new Uint8Array(await subtle.digest("SHA-256", bytes));
    signal?.throwIfAborted();
    return result;
  }

  const { sha256 } = await import("@noble/hashes/sha2.js");
  const hash = sha256.create();
  try {
    // 큰 파일을 처리하는 동안에도 취소 및 화면 갱신을 허용합니다.
    const chunkSize = 1_048_576;
    signal?.throwIfAborted();
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      signal?.throwIfAborted();
      hash.update(bytes.subarray(offset, offset + chunkSize));
      if (offset + chunkSize < bytes.length)
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    signal?.throwIfAborted();
    return Uint8Array.from(hash.digest());
  } finally {
    hash.destroy();
  }
}
