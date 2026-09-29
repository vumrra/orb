import { useEffect, useRef } from "react";
import { drawOptical, SYMBOL_MS } from "./optical";

export function drawNebula(
  ctx: CanvasRenderingContext2D,
  size: number,
  time: number,
  _coded = false,
) {
  ctx.clearRect(0, 0, size, size);
  drawOptical(ctx, null, size / 2, size / 2, size * 0.414, 0, time);
}

export function Orb({
  frames,
  reduced,
  still = false,
}: {
  frames: Uint8Array[];
  reduced: boolean;
  still?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    let raf = 0,
      timer = 0,
      last = -Infinity,
      index = -1;
    const start = performance.now();
    function render(now: number) {
      if (!ctx || !el || document.hidden) return;
      const frame = frames.length
        ? Math.floor((now - start) / SYMBOL_MS) % frames.length
        : -1;
      if (
        (!reduced && !still && now - last >= 16) ||
        frame !== index ||
        last === -Infinity
      ) {
        last = now;
        index = frame;
        ctx.clearRect(0, 0, el.width, el.height);
        drawOptical(
          ctx,
          frame >= 0 ? frames[frame] : null,
          el.width / 2,
          el.height / 2,
          el.width * 0.414,
          0,
          reduced || still ? 0.75 : (now - start) / 1000 + 0.75,
        );
      }
      if (reduced || still) {
        if (frames.length)
          timer = window.setTimeout(() => render(performance.now()), 40);
      } else raf = requestAnimationFrame(render);
    }
    const resume = () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      if (!document.hidden) render(performance.now());
    };
    render(start);
    document.addEventListener("visibilitychange", resume);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      ctx.clearRect(0, 0, el.width, el.height);
    };
  }, [frames, reduced, still]);
  return (
    <canvas
      ref={canvas}
      width={720}
      height={720}
      className="orb-canvas"
      role="img"
      aria-label={
        frames.length
          ? "Moving light carrying the message"
          : "A flowing silver particle orb"
      }
    />
  );
}
