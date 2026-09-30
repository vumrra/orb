import { expect, it } from "vitest";
import {
  BinaryCollector,
  createBinarySource,
  SHARD_BYTES,
} from "../src/binary-transfer";

it.each([0, 1, 8])(
  "recovers 280 shards with permanent tile %i occlusion, including the manifest tile",
  async (hidden) => {
    const bytes = Uint8Array.from(
      { length: 280 * SHARD_BYTES },
      (_, i) => i % 251,
    );
    const source = await createBinarySource(bytes, {
      name: "image.png",
      mime: "image/png",
      kind: "file",
    });
    const receiver = new BinaryCollector();
    for (let frame = 0; frame < 400 && !receiver.ready; frame++) {
      const packets = source.next(9);
      packets.forEach((packet, tile) => {
        if (tile !== hidden) receiver.add(packet);
        packet.fill(0);
      });
    }
    expect(receiver.ready).toBe(true);
    expect((await receiver.verify()).bytes).toEqual(bytes);
    source.clear();
  },
);
