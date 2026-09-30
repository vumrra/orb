import { useEffect, useRef } from "react";
import type { BinarySource } from "./binary-transfer";
import { drawUltraBoard, ULTRA_SLOT_MS, ultraLayout } from "./ultra-qr";
export function UltraBoard({
  source,
  onError,
}: {
  source: BinarySource;
  onError: (error: unknown) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    error = useRef(onError);
  error.current = onError;
  useEffect(() => {
    const el = canvas.current!;
    const stage = el.parentElement!;
    const ctx = el.getContext("2d");
    if (!ctx) {
      error.current(new Error("Canvas is unavailable."));
      return;
    }
    let raf = 0,
      last = -Infinity,
      stopped = false;
    let layout = ultraLayout(0, 0);
    const resize = () => {
      const shell = el.closest(".app-shell")!;
      layout = ultraLayout(
        Math.min(shell.clientWidth, innerWidth) - 40,
        Math.max(231, innerHeight - 300),
      );
      if (layout.tile < 231) {
        error.current(
          new Error("More screen space is needed for a readable QR."),
        );
        return;
      }
      stage.style.width = `${layout.size}px`;
      el.width = el.height = layout.size;
      el.dataset.cells = String(layout.cells);
      last = -Infinity;
    };
    const tick = (now: number) => {
      if (stopped) return;
      if (!document.hidden && now - last >= ULTRA_SLOT_MS) {
        let packets: Uint8Array[] = [];
        try {
          packets = source.next(layout.cells);
          drawUltraBoard(ctx, packets, layout.cells, el.width);
          last = now;
        } catch (reason) {
          stopped = true;
          error.current(reason);
          return;
        } finally {
          packets.forEach((packet) => packet.fill(0));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el.closest(".app-shell")!);
    window.addEventListener("resize", resize);
    resize();
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("resize", resize);
      stage.style.removeProperty("width");
      el.width = el.height = 0;
    };
  }, [source]);
  return (
    <canvas
      ref={canvas}
      className="ultra-canvas"
      aria-label="Ultrafast QR transfer board"
    />
  );
}
