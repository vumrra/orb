import { scanQr, unpackQr } from "./qr";
import { scanUltra, preloadUltraReader } from "./ultra-qr";
import { parseBinaryPacket } from "./binary-transfer";
import { OpticalTracker } from "./optical";
import { OpticalRecovery } from "./optical-fec";
import { BarCollector, BarTracker } from "./bar";
import { ColorTracker } from "./color-scan";
export class Camera {
  private generation = 0;
  private fragments = new BarCollector();
  private bar = new BarTracker();
  private optical = new OpticalTracker();
  private recovery = new OpticalRecovery();
  private color = new ColorTracker();
  private detected: "orb" | "bar" | "qr" | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private raf = 0;
  stop() {
    this.generation++;
    this.fragments.clear();
    this.bar.clear();
    this.optical.clear();
    this.recovery.clear();
    this.color.clear();
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
    preferred: "auto" | "orb" | "bar" | "qr" = "auto",
    options?: {
      ultra?: boolean;
      onBinary?: (packet: Uint8Array) => void;
      color?: boolean;
      onColor?: (packet: Uint8Array) => void;
    },
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
        width: { ideal: options?.ultra || options?.color ? 2048 : 1280 },
        height: { ideal: options?.ultra || options?.color ? 2048 : 1280 },
        frameRate: { ideal: options?.color ? 60 : 30 },
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
      // 지원되는 기기만 자동 초점·노출을 설정하고, 미지원 시 기본 촬영을 유지합니다.
      const track = stream.getVideoTracks?.()[0];
      try {
        const capabilities = track?.getCapabilities?.() as
          (MediaTrackCapabilities & Record<string, unknown>) | undefined;
        const automatic: Record<string, string> = {};
        for (const key of ["focusMode", "exposureMode", "whiteBalanceMode"]) {
          const modes = capabilities?.[key];
          if (Array.isArray(modes) && modes.includes("continuous"))
            automatic[key] = "continuous";
        }
        if (track && Object.keys(automatic).length)
          await track.applyConstraints({ advanced: [automatic] });
      } catch {
        // Optional device controls must not block an otherwise usable stream.
      }
      if (generation !== this.generation) return false;
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
        lastQr = -Infinity,
        lastQrSignal = -Infinity,
        lastOtherSignal = -Infinity,
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
      if (options?.color) {
        interval = 1000 / 60 - 0.5;
        let scanning = false;
        const tickColor = async (time: number) => {
          if (generation !== this.generation || scanning) return;
          if (
            !document.hidden &&
            time - last >= interval &&
            video.readyState >= 2 &&
            video.videoWidth &&
            video.videoHeight
          ) {
            scanning = true;
            last = time;
            const began = performance.now();
            let pixels: ImageData | undefined;
            let packet: Uint8Array | null = null;
            try {
              const scale = Math.min(
                1,
                2048 / Math.max(video.videoWidth, video.videoHeight),
              );
              const width = Math.round(video.videoWidth * scale),
                height = Math.round(video.videoHeight * scale);
              if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
              }
              ctx.drawImage(video, 0, 0, width, height);
              pixels = ctx.getImageData(0, 0, width, height);
              packet = await this.color.scan(pixels);
              if (generation !== this.generation) return;
              // Only a bounds/CRC-validated packet confirms a visible carrier.
              if (packet) {
                lastCandidate = time;
                options.onColor?.(packet);
              }
              const visible = time - lastCandidate < 500;
              if (visible !== candidate && generation === this.generation) {
                candidate = visible;
                onCandidate(visible);
              }
            } catch (error) {
              fail(error);
              return;
            } finally {
              pixels?.data.fill(0);
              packet?.fill(0);
              ctx.clearRect(0, 0, canvas.width, canvas.height);
              scanning = false;
              interval = Math.max(
                1000 / 60 - 0.5,
                (performance.now() - began) * 1.1,
              );
            }
          }
          if (generation === this.generation)
            this.raf = requestAnimationFrame(tickColor);
        };
        this.raf = requestAnimationFrame(tickColor);
        return true;
      }
      if (options?.ultra) {
        await preloadUltraReader();
        if (generation !== this.generation) return false;
        const tickUltra = async (time: number) => {
          if (generation !== this.generation) return;
          if (
            !document.hidden &&
            time - last >= interval &&
            video.readyState >= 2 &&
            video.videoWidth &&
            video.videoHeight
          ) {
            last = time;
            const began = performance.now();
            let pixels: ImageData | undefined;
            let packets: Uint8Array[] = [];
            try {
              const scale = Math.min(
                1,
                2048 / Math.max(video.videoWidth, video.videoHeight),
              );
              const width = Math.round(video.videoWidth * scale),
                height = Math.round(video.videoHeight * scale);
              if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
              }
              ctx.drawImage(video, 0, 0, width, height);
              pixels = ctx.getImageData(0, 0, width, height);
              packets = await scanUltra(pixels);
              if (generation !== this.generation) return;
              let visible = false;
              // Manifest first allows a receiver to join any captured board.
              packets.sort((a, b) => (a[4] ?? 0) - (b[4] ?? 0));
              for (const packet of packets) {
                if (generation !== this.generation) break;
                if (parseBinaryPacket(packet)) {
                  visible = true;
                  options.onBinary?.(packet);
                } else {
                  const frames = unpackQr(packet);
                  if (frames) {
                    visible = true;
                    try {
                      for (const frame of frames) {
                        if (generation !== this.generation) break;
                        onFrame(frame);
                      }
                    } finally {
                      frames.forEach((frame) => frame.fill(0));
                    }
                  }
                }
              }
              if (visible) lastCandidate = time;
              const nextCandidate = time - lastCandidate < 500;
              if (
                nextCandidate !== candidate &&
                generation === this.generation
              ) {
                candidate = nextCandidate;
                onCandidate(candidate);
              }
            } catch (error) {
              fail(error);
              return;
            } finally {
              // The async reader must finish consuming pixels before clearing them.
              pixels?.data.fill(0);
              packets.forEach((packet) => packet.fill(0));
              interval = Math.max(25, (performance.now() - began) * 1.5);
            }
          }
          // Exactly one decode in flight. Stop/reset cannot re-arm this pump.
          if (generation === this.generation)
            this.raf = requestAnimationFrame(tickUltra);
        };
        this.raf = requestAnimationFrame(tickUltra);
        return true;
      }
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
            let qrFrames: Uint8Array[] | null = null;
            const qrFirst =
              this.detected === "qr" || (!this.detected && preferred === "qr");
            const tryQr = () => {
              lastQr = time;
              const decoded = scanQr(pixels);
              if (decoded) {
                this.detected = "qr";
                lastQrSignal = time;
                markCandidate();
              }
              return decoded;
            };
            if (qrFirst) qrFrames = tryQr();
            // After acquisition, leave every available camera sample to QR. A
            // missed slot can be recovered next loop; fall back after 600 ms.
            if (!qrFrames && time - lastQrSignal > 600) {
              const opticalFirst = this.detected === "orb";
              if (opticalFirst)
                result = this.optical.scan(pixels, markCandidate);
              if (!result.frame) {
                const bar = this.bar.scan(pixels);
                if (bar.candidate) markCandidate();
                if (bar.symbol) {
                  this.detected = "bar";
                  lastOtherSignal = time;
                  result = { frame: this.fragments.add(bar.symbol) };
                  bar.symbol.fill(0);
                } else if (!opticalFirst) {
                  result = this.optical.scan(pixels, markCandidate);
                  if (result.frame) this.detected = "orb";
                }
              }
              if (result.frame) lastOtherSignal = time;
              // Unknown QR costs at most one attempt per 300 ms, and never
              // takes decoding time away from an acquired Orb/Bar signal.
              if (
                !qrFirst &&
                !result.frame &&
                time - lastOtherSignal > 200 &&
                time - lastQr >= 300
              )
                qrFrames = tryQr();
            }
            pixels.data.fill(0);
            // Leave rendering headroom on slower devices, without throwing away camera detail.
            interval = Math.max(25, (performance.now() - began) * 1.5);

            if (generation !== this.generation) {
              result.frame?.fill(0);
              qrFrames?.forEach((data) => data.fill(0));
              return;
            }
            if (candidate && time - lastCandidate >= 500) {
              candidate = false;
              onCandidate(false);
            }
            if (qrFrames) {
              try {
                for (const data of qrFrames) {
                  if (generation !== this.generation) break;
                  onFrame(data);
                }
              } finally {
                qrFrames.forEach((data) => data.fill(0));
              }
            }
            const frame = result.frame;
            if (frame) {
              try {
                const recovered =
                  this.detected === "orb" ? this.recovery.add(frame) : [frame];
                try {
                  for (const data of recovered) {
                    if (generation !== this.generation) break;
                    onFrame(data);
                  }
                } finally {
                  recovered.forEach((data) => data.fill(0));
                }
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
