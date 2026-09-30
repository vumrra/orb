import { useEffect, useRef } from "react";
import { colorLayout, colorRaster } from "./color-grid";
import type { ColorSource } from "./color-grid";

export function ColorBoard({
  source,
  onError,
}: {
  source: ColorSource;
  onError: (error: unknown) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    error = useRef(onError);
  error.current = onError;
  useEffect(() => {
    const el = canvas.current!,
      stage = el.parentElement!,
      ctx = el.getContext("2d", { alpha: false });
    const buffer = document.createElement("canvas"),
      bctx = buffer.getContext("2d", { alpha: false });
    if (!ctx || !bctx) {
      error.current(new Error("Canvas is unavailable."));
      return;
    }
    const saved = {
      width: stage.style.width,
      height: stage.style.height,
      aspectRatio: stage.style.aspectRatio,
    };
    const layout = colorLayout(source.grid),
      shell = el.closest(".app-shell");
    buffer.width = layout.width;
    buffer.height = layout.height;
    let raf = 0,
      last = -Infinity,
      stopped = false,
      side = 1;
    const fail = (reason: unknown) => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      el.width = el.height = buffer.width = buffer.height = 0;
      error.current(reason);
    };
    const resize = () => {
      if (stopped) return;
      try {
        const width =
            Math.min(innerWidth, shell?.clientWidth || innerWidth) - 40,
          height = innerHeight - 300;
        // Wire grid stays fixed for the whole transfer. Only the number of
        // independently recoverable tiles changes when the viewport changes.
        const nextSide = Math.max(
          1,
          Math.min(
            3,
            Math.floor(
              Math.min(
                width / (layout.width * 3),
                height / (layout.height * 3),
              ),
            ),
          ),
        );
        const cell = Math.floor(
          Math.min(
            width / (layout.width * nextSide),
            height / (layout.height * nextSide),
          ),
        );
        if (cell < 3)
          throw new Error(
            "More screen space is needed for readable color cells.",
          );
        const w = layout.width * cell * nextSide,
          h = layout.height * cell * nextSide,
          ratio = Math.max(1, Math.floor(globalThis.devicePixelRatio || 1));
        if (
          el.width === w * ratio &&
          el.height === h * ratio &&
          side === nextSide
        )
          return;
        side = nextSide;
        stage.style.width = `${w}px`;
        stage.style.height = `${h}px`;
        stage.style.aspectRatio = `${w} / ${h}`;
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        el.width = w * ratio;
        el.height = h * ratio;
        el.dataset.grid = String(source.grid);
        el.dataset.tiles = String(side * side);
        el.dataset.cell = String(cell);
        last = -Infinity;
      } catch (reason) {
        fail(reason);
      }
    };
    const tick = (now: number) => {
      if (stopped) return;
      if (!document.hidden && now - last >= 1000 / 20 - 0.5) {
        try {
          ctx.imageSmoothingEnabled = false;
          for (let tile = 0; tile < side * side; tile++) {
            let packet: Uint8Array | undefined,
              raster: ReturnType<typeof colorRaster> | undefined,
              pixels: ImageData | undefined;
            try {
              packet = source.next();
              raster = colorRaster(packet);
              pixels = bctx.createImageData(raster.width, raster.height);
              pixels.data.set(raster.data);
              bctx.putImageData(pixels, 0, 0);
              ctx.drawImage(
                buffer,
                ((tile % side) * el.width) / side,
                (Math.floor(tile / side) * el.height) / side,
                el.width / side,
                el.height / side,
              );
            } finally {
              bctx.clearRect(0, 0, buffer.width, buffer.height);
              packet?.fill(0);
              raster?.data.fill(0);
              pixels?.data.fill(0);
            }
          }
          last = now; // Elapsed time, never catch-up bursts after a slow frame.
        } catch (reason) {
          fail(reason);
        }
      }
      if (!stopped) raf = requestAnimationFrame(tick);
    };
    const visibility = () => {
      if (!document.hidden) last = -Infinity;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(shell ?? stage);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", visibility);
    resize();
    if (!stopped) raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", visibility);
      Object.assign(stage.style, saved);
      el.width = el.height = buffer.width = buffer.height = 0;
      // App owns this source: StrictMode and effect cleanup must not cancel it.
    };
  }, [source]);
  return (
    <canvas
      ref={canvas}
      className="color-canvas"
      aria-label="Ultrafast color transfer board"
    />
  );
}
