import { afterEach, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { BinaryCollector, createBinarySource } from "../src/binary-transfer";

afterEach(() => vi.unstubAllGlobals());

it.each([0, 517, 30_000_000])(
  "retains SHA-256 without SubtleCrypto for %i bytes",
  async (size) => {
    vi.stubGlobal("crypto", {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    });
    const original = Uint8Array.from({ length: size }, (_, i) => i % 251);
    const source = await createBinarySource(original, {
      name: "file.bin",
      mime: "application/octet-stream",
      kind: "file",
    });
    const manifest = source.manifest();
    expect(Buffer.from(manifest.subarray(40, 72)).toString("hex")).toBe(
      createHash("sha256").update(original).digest("hex"),
    );
    const receiver = new BinaryCollector();
    receiver.add(manifest);
    for (let i = 0; i < source.total; i++) receiver.add(source.data(i));
    expect(
      Buffer.from((await receiver.verify()).bytes).equals(
        Buffer.from(original),
      ),
    ).toBe(true);
    source.clear();
  },
  30000,
);

it("still cancels preparation without SubtleCrypto", async () => {
  vi.stubGlobal("crypto", {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  });
  const controller = new AbortController();
  const pending = createBinarySource(
    new Uint8Array(2_000_000),
    { name: "file", mime: "application/octet-stream", kind: "file" },
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toThrow();
});
