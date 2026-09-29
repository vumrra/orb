import { useEffect, useRef } from "react";
import type { FrameSource } from "./protocol";
import { drawOptical, SYMBOL_MS } from "./optical";
import {
  drawBar,
  splitBarFrame,
  BAR_SYMBOL_MS,
  BAR_TRANSITION_MS,
} from "./bar";

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
  transport = "orb",
}: {
  frames: FrameSource;
  reduced: boolean;
  still?: boolean;
  transport?: "orb" | "bar";
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
    const symbolCount = frames.length * (transport === "bar" ? 2 : 1);
    let cachedIndex = -1;
    let current: Uint8Array | null = null,
      previous: Uint8Array | null = null;
    function getSymbol(index: number) {
      const frame = frames.get(
        transport === "bar" ? Math.floor(index / 2) : index,
      );
      if (transport !== "bar") return frame;
      const parts = splitBarFrame(frame);
      frame.fill(0);
      parts[1 - (index % 2)].fill(0);
      return parts[index % 2];
    }
    const cadence = transport === "bar" ? BAR_SYMBOL_MS : SYMBOL_MS;
    const start = performance.now();
    function render(now: number) {
      if (!ctx || !el || document.hidden || (symbolCount && !frames.length))
        return;
      const frame = symbolCount
        ? Math.floor((now - start) / cadence) % symbolCount
        : -1;
      if (
        (!reduced && !still && now - last >= 16) ||
        frame !== index ||
        last === -Infinity
      ) {
        last = now;
        index = frame;
        if (frame >= 0 && frame !== cachedIndex) {
          current?.fill(0);
          previous?.fill(0);
          current = getSymbol(frame);
          previous = getSymbol((frame + symbolCount - 1) % symbolCount);
          cachedIndex = frame;
        }
        ctx.clearRect(0, 0, el.width, el.height);
        if (transport === "bar") {
          const elapsed = (now - start) % cadence;
          const t = Math.min(1, elapsed / BAR_TRANSITION_MS);
          // A short spring snap, then exact stable endpoints for >=128ms at 30fps.
          const blend =
            reduced || still || t === 1
              ? 1
              : 1 - Math.exp(-6 * t) * Math.cos(8 * t);
          drawBar(
            ctx,
            current,
            el.width / 2,
            el.height / 2,
            el.width * 0.86,
            el.height * 0.72,
            previous,
            blend,
            reduced || still ? 0 : (now - start) / 1000,
          );
        } else
          drawOptical(
            ctx,
            current,
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
      current?.fill(0);
      previous?.fill(0);
    };
  }, [frames, reduced, still, transport]);
  return (
    <canvas
      ref={canvas}
      width={720}
      height={720}
      className="orb-canvas"
      role="img"
      aria-label={
        transport === "bar"
          ? frames.length
            ? "White bars carrying the message"
            : "White geometric bars"
          : frames.length
            ? "Moving light carrying the message"
            : "A flowing silver particle orb"
      }
    />
  );
}
