import { useEffect, useRef } from "react";
import { colorGridForViewport, colorLayout, colorRaster } from "./color-grid";
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
      stopped = false;
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
        if (colorGridForViewport(width, height) < source.grid)
          throw new Error(
            "The screen is too small for this color grid. More screen space is needed; restart the transfer after resizing.",
          );
        const cell = Math.floor(
          Math.min(width / layout.width, height / layout.height),
        );
        if (cell < 3)
          throw new Error(
            "More screen space is needed for readable color cells.",
          );
        const w = layout.width * cell,
          h = layout.height * cell,
          ratio = Math.max(1, Math.floor(globalThis.devicePixelRatio || 1));
        stage.style.width = `${w}px`;
        stage.style.height = `${h}px`;
        stage.style.aspectRatio = `${w} / ${h}`;
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        el.width = w * ratio;
        el.height = h * ratio;
        el.dataset.grid = String(source.grid);
        el.dataset.cell = String(cell);
        last = -Infinity;
      } catch (reason) {
        fail(reason);
      }
    };
    const tick = (now: number) => {
      if (stopped) return;
      if (!document.hidden && now - last >= 1000 / 60 - 0.5) {
        let packet: Uint8Array | undefined,
          raster: ReturnType<typeof colorRaster> | undefined,
          pixels: ImageData | undefined;
        try {
          packet = source.next();
          raster = colorRaster(packet);
          pixels = bctx.createImageData(raster.width, raster.height);
          pixels.data.set(raster.data);
          bctx.putImageData(pixels, 0, 0);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(buffer, 0, 0, el.width, el.height);
          bctx.clearRect(0, 0, buffer.width, buffer.height);
          last = now;
        } catch (reason) {
          fail(reason);
        } finally {
          packet?.fill(0);
          raster?.data.fill(0);
          pixels?.data.fill(0);
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
