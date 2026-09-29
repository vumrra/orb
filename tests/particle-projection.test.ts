import { expect, it } from "vitest";
import * as optical from "../src/optical";

it("projects nearer particles farther from center and larger with true perspective", () => {
  expect(optical).toHaveProperty("createParticleProjection");
  const project = optical.createParticleProjection(0);
  const near = project({ x: 0.3, y: 0.2, z: 0.7 });
  const far = project({ x: 0.3, y: 0.2, z: -0.7 });
  expect(near.x / far.x).toBeCloseTo((3.2 + 0.7) / (3.2 - 0.7));
  expect(near.y / far.y).toBeCloseTo(near.scale / far.scale);
  expect(near.scale).toBeGreaterThan(far.scale);
  expect(near.z).toBeGreaterThan(far.z);
});

it("rotates full 3D depth over time while retaining a round perspective envelope", () => {
  expect(optical).toHaveProperty("createParticleProjection");
  const point = { x: 0.4, y: -0.3, z: Math.sqrt(0.75) };
  const start = optical.createParticleProjection(0)(point);
  const moved = optical.createParticleProjection(0.75)(point);
  for (const key of ["x", "y", "z", "scale"] as const)
    expect(Math.abs(moved[key] - start[key])).toBeGreaterThan(0.01);
  for (const time of [0, 0.37, 1.2, 2.1]) {
    const project = optical.createParticleProjection(time);
    let minDepth = 1,
      maxDepth = -1,
      rim = 0;
    for (let i = 0; i < 2000; i++) {
      const z = 1 - (2 * (i + 0.5)) / 2000;
      const r = Math.sqrt(1 - z * z),
        a = i * 2.3999632297;
      const p = project({ x: r * Math.cos(a), y: r * Math.sin(a), z });
      minDepth = Math.min(minDepth, p.z);
      maxDepth = Math.max(maxDepth, p.z);
      rim = Math.max(rim, Math.hypot(p.x, p.y));
      expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(1.000001);
    }
    expect(minDepth).toBeLessThan(-0.99);
    expect(maxDepth).toBeGreaterThan(0.99);
    expect(rim).toBeGreaterThan(0.99);
  }
});
