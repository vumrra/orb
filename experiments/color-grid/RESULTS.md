# Color-grid spike: PARTIAL

Goal: send 10,000,000 incompressible bytes in at most 10 seconds through optical pixels, including preparation and final SHA-256 verification.

Implemented a separate experiment, not a replacement of the production Ultrafast mode. Open `/experiments/color-grid/` on the existing Vite server. `Send file` and `Receive camera` provide manual prototype controls; `10 MB loopback` runs the synthetic experiment. HTTPS or localhost is required. Camera receipt currently downloads as `received.bin`.

## Observed verification

Chrome headless, 256×256 data cells, 8 RGB colors, 780×810 raster, axis-aligned border acquisition, per-frame CRC-32, whole-file SHA-256, two GF(256) parity shards per eight data shards. Each trial generates fresh random bytes before timing. Time includes sender hashing, renderer → canvas.captureStream → video → receiver pixel decoding and receiver SHA-256. Full byte equality is additionally asserted. No decoded-packet injection or network data transport is used.

| Capture condition | Final verification time | Verdict |
|---|---:|---|
| 60fps, clean, repeat 1 | 8,550.8ms | Pass |
| 60fps, clean, repeat 2 | 8,460.9ms | Pass |
| 30fps | 16,905.6ms | Above target |
| 60fps, every thirteenth transmitted frame replaced by blank | 8,503.4ms | Pass |
| 60fps, 0.5px canvas blur | 8,468.3ms | Pass |
| 60fps, horizontal translation in 3px steps | 8,456.9ms | Pass |
| 60fps, 2° in-plane rotation | No valid frames in 8 seconds | Failed acquisition |

Seven scenarios collected: six byte-exact completions, five within ten seconds. These are synthetic camera streams, not phone measurements. Blur uses the Canvas filter and is not a calibrated physical lens model. Capture/display clocks on two physical devices, rolling shutter, perspective, exposure and color cross-talk remain unverified. The locator is deliberately axis-aligned; rotation failure is an unresolved blocker for product integration. Color modes are manually selected, not automatically adapted.

`node experiments/color-grid/test.mjs`: all 45 two-erasure combinations for each of monochrome, four colors and eight colors recovered byte-exactly; ten corrupted frames rejected per palette. `npm run build` passed with the existing bundle-size warning. Existing product code is unchanged by this spike.

## Reproduction

- Start a static server: `python3 -m http.server 50931 --bind 127.0.0.1 --directory experiments/color-grid`
- Run: `COLOR_GRID_URL=http://127.0.0.1:50931/ node experiments/color-grid/bench.mjs`
- Results append per scenario to `/tmp/orb-color-grid-results.jsonl` (a new run resets that file).
- Use a static server for measurements: Vite HMR can navigate/reload during a trial after experiment files change.

## Decision

The clean-channel bitrate target is feasible in this browser experiment. Do not label production or physical-phone 10MB/10s support complete. Preserve the existing QR mode until projective acquisition/tracking and physical-device trials pass. No commit or push performed.
