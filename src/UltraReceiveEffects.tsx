import { useEffect, useRef } from "react";

// 수신 데이터와 분리된 배경. 해독용 canvas에는 장식을 그리지 않습니다.
export function UltraReceiveEffects({ reduced }: { reduced: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    let width = 0,
      height = 0,
      raf = 0,
      last = 0;
    let particles: {
      x: number;
      y: number;
      radius: number;
      speed: number;
      alpha: number;
    }[] = [];
    const draw = (time: number) => {
      const dt = reduced ? 0 : Math.min((time - last) / 1000, 0.05);
      last = time;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#fff";
      for (const p of particles) {
        p.y -= p.speed * dt;
        if (p.y < -8) p.y = height + 8;
        const fade = Math.min(1, p.y / 100, (height - p.y) / 100);
        ctx.globalAlpha = p.alpha * Math.max(0, fade);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!reduced && !document.hidden) raf = requestAnimationFrame(draw);
    };
    const resize = () => {
      cancelAnimationFrame(raf);
      width = innerWidth;
      height = innerHeight;
      const dpr = Math.min(devicePixelRatio || 1, 1.5);
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(
        280,
        Math.min(400, Math.max(220, Math.round((width * height) / 3800))),
      );
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        radius: 0.6 + Math.random() * 1.1,
        speed: 280 + Math.random() * 540,
        alpha: 0.12 + Math.random() * 0.48,
      }));
      last = performance.now();
      draw(last);
    };
    const visibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) {
        last = performance.now();
        draw(last);
      }
    };
    resize();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", visibility);
      el.width = el.height = 0;
    };
  }, [reduced]);
  return <canvas ref={canvas} className="ultra-particles" aria-hidden="true" />;
}
