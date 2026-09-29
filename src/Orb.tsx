import { useEffect, useRef } from "react";
import {
  createQrPackets,
  drawQr,
  qrMatrix,
  QR_SLOT_MS,
  type QrMatrix,
} from "./qr";
import type { FrameSource } from "./protocol";
import { drawOptical, SYMBOL_MS } from "./optical";
import { opticalFrames } from "./optical-fec";
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
  meter,
}: {
  frames: FrameSource;
  reduced: boolean;
  still?: boolean;
  transport?: "orb" | "bar" | "sound" | "qr";
  meter?: { level: number; waveform?: Float32Array };
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (transport === "qr") return;
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    let raf = 0,
      timer = 0,
      last = -Infinity,
      index = -1;
    const opticalSource = transport === "orb" ? opticalFrames(frames) : null;
    const source = opticalSource ?? frames;
    const symbolCount =
      (transport === "sound" ? 0 : source.length) *
      (transport === "bar" ? 2 : 1);
    let cachedIndex = -1;
    let current: Uint8Array | null = null,
      previous: Uint8Array | null = null;
    function getSymbol(index: number) {
      const frame = source.get(
        transport === "bar" ? Math.floor(index / 2) : index,
      );
      if (transport !== "bar") return frame;
      const parts = splitBarFrame(frame);
      frame.fill(0);
      parts.forEach((part, i) => {
        if (i !== index % 2) part.fill(0);
      });
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
        ((transport === "sound" || (!reduced && !still)) &&
          now - last >= (reduced ? 100 : 16)) ||
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
        if (transport === "sound") {
          const level = meter?.level ?? 0;
          const center = el.width / 2;
          ctx.strokeStyle = "#fff";
          // Acoustic energy controls radius and opacity; no fabricated data waveform.
          for (let ring = 0; ring < 3; ring++) {
            ctx.globalAlpha = (0.13 + level * 0.65) / (ring + 1);
            ctx.lineWidth = ring === 0 ? 2.4 : 1;
            ctx.beginPath();
            ctx.arc(
              center,
              center,
              el.width * (0.16 + ring * 0.065 + level * 0.06),
              0,
              Math.PI * 2,
            );
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
          // The trace is sampled PCM, not an invented progress animation.
          const samples = meter?.waveform;
          const width = el.width * 0.76;
          const ink = ctx.createLinearGradient(
            center - width / 2,
            0,
            center + width / 2,
            0,
          );
          ink.addColorStop(0, "rgba(180,203,220,0)");
          ink.addColorStop(0.25, "rgba(200,218,231,0.65)");
          ink.addColorStop(0.5, "#ffffff");
          ink.addColorStop(0.75, "rgba(200,218,231,0.65)");
          ink.addColorStop(1, "rgba(180,203,220,0)");
          ctx.strokeStyle = ink;
          ctx.lineWidth = 2.5;
          ctx.lineCap = "round";
          for (let i = 0; i < 64; i++) {
            const envelope = Math.sin((Math.PI * i) / 63);
            const amplitude = Math.abs(samples?.[i] ?? 0) * el.width * 1.7;
            const height =
              1.5 + Math.min(el.width * 0.19, amplitude) * envelope;
            const x = center - width / 2 + (width * i) / 63;
            ctx.beginPath();
            ctx.moveTo(x, center - height);
            ctx.lineTo(x, center + height);
            ctx.stroke();
          }
          ctx.lineCap = "butt";
        } else if (transport === "bar") {
          const elapsed = (now - start) % cadence;
          const t = Math.min(1, elapsed / BAR_TRANSITION_MS);
          // Data symbols snap to exact heights: a blended camera sample is invalid.
          // Keep spring motion only for the non-transmitting preview.
          const blend =
            current || reduced || still || t === 1
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
      if ((reduced || still) && transport !== "sound") {
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
      opticalSource?.clear();
    };
  }, [frames, reduced, still, transport, meter]);
  if (transport === "qr") return <QrCanvas frames={frames} />;
  return (
    <canvas
      ref={canvas}
      width={720}
      height={720}
      className="orb-canvas"
      role="img"
      aria-label={
        transport === "sound"
          ? "Acoustic signal level"
          : transport === "bar"
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

function QrCanvas({ frames }: { frames: FrameSource }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    let timer = 0,
      matrix: QrMatrix | null = null,
      index = -1;
    // App owns the wire buffer and clears it on cancellation/unmount. Resizing
    // and StrictMode effect cleanup only release this renderer's packet view.
    let packets: ReturnType<typeof createQrPackets> | null = null;
    const clearMatrix = () => {
      matrix?.data.fill(0);
      matrix = null;
    };
    const paint = () => {
      if (document.hidden || !packets) return;
      if (!frames.length) {
        drawQr(ctx, null, el.width);
        return;
      }
      index = (index + 1) % packets.length;
      const packet = packets.get(index);
      try {
        clearMatrix();
        matrix = qrMatrix(packet, packets.profile.version);
      } finally {
        packet.fill(0);
      }
      drawQr(ctx, matrix, el.width);
    };
    const resize = () => {
      const size = Math.floor(el.parentElement!.getBoundingClientRect().width);
      if (!size) return;
      clearInterval(timer);
      packets?.clear();
      clearMatrix();
      index = -1;
      el.width = el.height = size;
      packets = createQrPackets(
        { get: (i) => frames.get(i), length: frames.length, clear() {} },
        size,
      );
      paint();
      if (frames.length) timer = window.setInterval(paint, QR_SLOT_MS);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el.parentElement!);
    resize();
    return () => {
      clearInterval(timer);
      observer.disconnect();
      clearMatrix();
      packets?.clear();
      ctx.clearRect(0, 0, el.width, el.height);
      el.width = el.height = 0;
    };
  }, [frames]);
  return (
    <canvas
      ref={canvas}
      className="orb-canvas qr-canvas"
      role="img"
      aria-label={
        frames.length ? "QR code carrying the message" : "QR finder outlines"
      }
    />
  );
}
