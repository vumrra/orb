import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { source, raster, decode, Collector, capacity } from "./codec.mjs";
for (const bits of [1, 2, 3]) {
  const bytes = randomBytes(capacity(bits) * 8 - 97),
    s = await source(bytes, bits),
    packets = [];
  let rejected = 0;
  for (let i = 0; i < 10; i++) {
    const image = raster(s.frame()),
      packet = decode(image);
    assert(packet);
    packets.push(packet);
    image.data[(12 * 260 + 2) * 4] = 255 - image.data[(12 * 260 + 2) * 4];
    if (!decode(image)) rejected++;
  }
  let combinations = 0;
  for (let a = 0; a < 10; a++)
    for (let b = a + 1; b < 10; b++) {
      const r = new Collector();
      packets.forEach((p, i) => {
        if (i !== a && i !== b) r.add(p);
      });
      await r.verify();
      assert.deepEqual(Buffer.from(r.bytes), bytes);
      combinations++;
    }
  assert.equal(rejected, 10);
  console.log(
    JSON.stringify({
      bits,
      roundtrip: true,
      twoErasureCombinations: combinations,
      corruptionRejected: rejected,
    }),
  );
}
