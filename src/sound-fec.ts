// GF(256), primitive polynomial x^8+x^4+x^3+x^2+1. Bounded shortened sound RS(n,n-16), n <= 255.
const exp = new Uint8Array(510),
  log = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  exp[i] = x;
  log[x] = i;
  x <<= 1;
  if (x & 256) x ^= 0x11d;
}
for (let i = 255; i < 510; i++) exp[i] = exp[i - 255];
const mul = (a: number, b: number) => (a && b ? exp[log[a] + log[b]] : 0);
const div = (a: number, b: number) => {
  if (!b) throw new Error("Zero GF divisor");
  return a ? exp[(log[a] - log[b] + 255) % 255] : 0;
};
function product(a: number[], b: number[]) {
  const out = Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) out[i + j] ^= mul(a[i], b[j]);
  return out;
}
let generator = [1];
for (let i = 0; i < 16; i++) generator = product(generator, [1, exp[i]]);
export function rsEncode(data: Uint8Array) {
  if (data.length < 1 || data.length > 239)
    throw new Error("RS message must contain 1–239 bytes");
  const out = new Uint8Array(data.length + 16);
  out.set(data);
  for (let i = 0; i < data.length; i++) {
    const c = out[i];
    for (let j = 1; j <= 16; j++) out[i + j] ^= mul(generator[j], c);
  }
  out.set(data);
  return out;
}
const evaluate = (p: ArrayLike<number>, x: number) => {
  let v = 0;
  for (let i = 0; i < p.length; i++) v = mul(v, x) ^ p[i];
  return v;
};
function locator(s: number[]) {
  let c = [1],
    b = [1],
    length = 0,
    shift = 1,
    last = 1;
  for (let n = 0; n < s.length; n++) {
    let delta = s[n];
    for (let i = 1; i <= length; i++) delta ^= mul(c[i] || 0, s[n - i]);
    if (!delta) {
      shift++;
      continue;
    }
    const before = c.slice(),
      factor = div(delta, last);
    while (c.length < b.length + shift) c.push(0);
    for (let i = 0; i < b.length; i++) c[i + shift] ^= mul(factor, b[i]);
    if (2 * length <= n) {
      length = n + 1 - length;
      b = before;
      last = delta;
      shift = 1;
    } else shift++;
  }
  return c.slice(0, length + 1);
}
export function rsDecode(
  code: Uint8Array,
  erasures: number[] = [],
): Uint8Array | null {
  if (
    code.length < 17 ||
    code.length > 255 ||
    erasures.length > 16 ||
    new Set(erasures).size !== erasures.length ||
    erasures.some((p) => !Number.isInteger(p) || p < 0 || p >= code.length)
  )
    return null;
  const syndromes = Array.from({ length: 16 }, (_, i) =>
    evaluate(code, exp[i]),
  );
  if (syndromes.every((s) => s === 0)) return code.slice(0, code.length - 16);
  let reduced = syndromes.slice(),
    known = [1];
  for (const p of erasures) {
    const x = exp[code.length - 1 - p];
    known = product(known, [1, x]);
    reduced = reduced.slice(1).map((s, i) => s ^ mul(x, reduced[i]));
  }
  const unknown = locator(reduced);
  if (2 * (unknown.length - 1) + erasures.length > 16) return null;
  const loc = product(known, unknown),
    positions: number[] = [];
  for (let p = 0; p < code.length; p++)
    if (
      evaluate(
        loc.slice().reverse(),
        exp[(255 - (code.length - 1 - p)) % 255],
      ) === 0
    )
      positions.push(p);
  const n = loc.length - 1;
  if (!n || positions.length !== n) return null;
  // Solve at most a 16x16 Vandermonde system; never a message-sized matrix.
  const rows = Array.from({ length: n }, (_, i) => [
    ...positions.map((p) => exp[((code.length - 1 - p) * i) % 255]),
    syndromes[i],
  ]);
  for (let c = 0; c < n; c++) {
    const pivot = rows.findIndex((r, i) => i >= c && r[c] !== 0);
    if (pivot < 0) return null;
    [rows[c], rows[pivot]] = [rows[pivot], rows[c]];
    const factor = rows[c][c];
    for (let j = c; j <= n; j++) rows[c][j] = div(rows[c][j], factor);
    for (let i = 0; i < n; i++)
      if (i !== c) {
        const f = rows[i][c];
        for (let j = c; j <= n; j++) rows[i][j] ^= mul(f, rows[c][j]);
      }
  }
  const out = code.slice();
  positions.forEach((p, i) => (out[p] ^= rows[i][n]));
  try {
    if (
      Array.from({ length: 16 }, (_, i) => evaluate(out, exp[i])).some(Boolean)
    )
      return null;
    return out.slice(0, code.length - 16); // Caller must validate CRC and metadata.
  } finally {
    out.fill(0);
  }
}
