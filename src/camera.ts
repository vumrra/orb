import { OpticalTracker } from "./optical";
import { BarCollector, scanBarPixels } from "./bar";
export class Camera {
  private generation = 0;
  private fragments = new BarCollector();
  private optical = new OpticalTracker();
  private detected: "orb" | "bar" | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private raf = 0;
  stop() {
    this.generation++;
    this.fragments.clear();
    this.optical.clear();
    this.detected = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video = null;
    }
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas = null;
    }
  }
  async start(
    video: HTMLVideoElement,
    facing: "environment" | "user",
    onFrame: (frame: Uint8Array) => void,
    onError: (error: unknown) => void,
    onCandidate: (visible: boolean) => void = () => {},
  ): Promise<boolean> {
    this.stop();
    const generation = this.generation;
    if (!globalThis.isSecureContext)
      throw new Error(
        "Camera needs HTTPS or localhost. 휴대폰에서는 HTTPS로 열어 주세요.",
      );
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("Camera is unavailable in this browser.");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1280 },
        height: { ideal: 1280 },
      },
    });
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }
    this.stream = stream;
    this.video = video;
    video.srcObject = stream;
    try {
      await video.play();
      if (generation !== this.generation) return false;
      const canvas = document.createElement("canvas");

      this.canvas = canvas;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx)
        throw new Error("Canvas capture is unavailable in this browser.");
      let interval = 25;
      let last = -Infinity,
        lastCandidate = -Infinity,
        candidate = false;
      const fail = (error: unknown) => {
        if (generation === this.generation) {
          this.stop();
          onError(error);
        }
      };
      stream
        .getTracks()
        .forEach((track) =>
          track.addEventListener(
            "ended",
            () => fail(new Error("Camera disconnected. Try again.")),
            { once: true },
          ),
        );
      const tick = (time: number) => {
        if (generation !== this.generation) return;
        if (
          !document.hidden &&
          time - last >= interval &&
          video.readyState >= 2 &&
          video.videoWidth &&
          video.videoHeight
        ) {
          last = time;
          try {
            const began = performance.now();
            const scale = Math.min(
              1,
              1024 / Math.max(video.videoWidth, video.videoHeight),
            );
            const width = Math.round(video.videoWidth * scale),
              height = Math.round(video.videoHeight * scale);
            if (canvas.width !== width || canvas.height !== height) {
              canvas.width = width;
              canvas.height = height;
            }
            ctx.drawImage(video, 0, 0, width, height);
            const pixels = ctx.getImageData(0, 0, width, height);
            const markCandidate = () => {
              lastCandidate = time;
              if (!candidate && generation === this.generation) {
                candidate = true;
                onCandidate(true);
              }
            };
            let result: { frame: Uint8Array | null } = { frame: null };
            const opticalFirst = this.detected === "orb";
            if (opticalFirst) result = this.optical.scan(pixels, markCandidate);
            if (!result.frame) {
              const bar = scanBarPixels(pixels);
              if (bar.candidate) markCandidate();
              if (bar.symbol) {
                this.detected = "bar";
                result = { frame: this.fragments.add(bar.symbol) };
                bar.symbol.fill(0);
              } else if (!opticalFirst) {
                result = this.optical.scan(pixels, markCandidate);
                if (result.frame) this.detected = "orb";
              }
            }
            pixels.data.fill(0);
            // Leave rendering headroom on slower devices, without throwing away camera detail.
            interval = Math.max(25, (performance.now() - began) * 1.5);

            if (generation !== this.generation) {
              result.frame?.fill(0);
              return;
            }
            if (candidate && time - lastCandidate >= 500) {
              candidate = false;
              onCandidate(false);
            }
            const frame = result.frame;
            if (frame) {
              try {
                onFrame(frame);
              } finally {
                frame.fill(0);
              }
            }
          } catch (error) {
            fail(error);
            return;
          }
        }
        if (generation === this.generation)
          this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
      return true;
    } catch (error) {
      if (generation === this.generation) this.stop();
      throw error;
    }
  }
}
export function cameraError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError")
      return "Camera access was denied. 브라우저의 카메라 권한을 확인해 주세요.";
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError")
      return "No camera found. Try another device.";
    if (error.name === "NotReadableError")
      return "Camera is busy. Close other camera apps and try again.";
  }
  return error instanceof Error
    ? error.message
    : "Could not start the camera. Please try again.";
}
