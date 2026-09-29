import { afterEach, expect, it, vi } from "vitest";
import { Camera } from "../src/camera";
import { createCanvas } from "@napi-rs/canvas";
import { drawBar, splitBarFrame } from "../src/bar";
import { Collector, splitFrames } from "../src/protocol";

afterEach(() => vi.unstubAllGlobals());
function setup() {
  const stop = vi.fn();
  const track = { stop, addEventListener: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ clearRect: vi.fn() }),
    }),
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn().mockReturnValue(7));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const video = {
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    srcObject: null,
  } as unknown as HTMLVideoElement;
  return { stream, stop, getUserMedia, video };
}
it("stops a stream granted after cancellation, without attaching it", async () => {
  const { stream, stop, getUserMedia, video } = setup();
  let grant!: (s: MediaStream) => void;
  getUserMedia.mockImplementation(
    () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
  );
  const camera = new Camera();
  const result = camera.start(video, "environment", vi.fn(), vi.fn());
  camera.stop();
  grant(stream);
  expect(await result).toBe(false);
  expect(stop).toHaveBeenCalledOnce();
  expect(video.srcObject).toBeNull();
  expect(video.play).not.toHaveBeenCalled();
});
it("releases tracks and cancels capture on stop", async () => {
  const { video, stop } = setup();
  const camera = new Camera();
  expect(await camera.start(video, "environment", vi.fn(), vi.fn())).toBe(true);
  camera.stop();
  expect(stop).toHaveBeenCalledOnce();
  expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
  expect(video.srcObject).toBeNull();
});
it("cleans up on video playback failure", async () => {
  const { video, stop } = setup();
  const camera = new Camera();
  vi.mocked(video.play).mockRejectedValue(new Error("play failed"));
  await expect(camera.start(video, "user", vi.fn(), vi.fn())).rejects.toThrow(
    "play failed",
  );
  expect(stop).toHaveBeenCalledOnce();
  expect(video.srcObject).toBeNull();
});
it("rejects insecure contexts before requesting permission", async () => {
  const { video, getUserMedia } = setup();
  vi.stubGlobal("isSecureContext", false);
  await expect(
    new Camera().start(video, "environment", vi.fn(), vi.fn()),
  ).rejects.toThrow("HTTPS");
  expect(getUserMedia).not.toHaveBeenCalled();
});

it("captures the whole landscape frame, preserving off-center signals", async () => {
  const { video } = setup();
  Object.assign(video, { readyState: 2, videoWidth: 1280, videoHeight: 720 });
  const drawImage = vi.fn();
  const getImageData = vi.fn(() => ({
    width: 1024,
    height: 576,
    data: new Uint8ClampedArray(1024 * 576 * 4),
  }));
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage, getImageData }),
    }),
  });
  let tick!: (time: number) => void;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((fn) => {
      tick = fn;
      return 7;
    }),
  );
  const camera = new Camera();
  await camera.start(video, "environment", vi.fn(), vi.fn());
  tick(0);
  expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1024, 576);
  expect(getImageData).toHaveBeenCalledWith(0, 0, 1024, 576);
  camera.stop();
});
it("skips hidden captures and resumes full-frame scanning when visible", async () => {
  const { video } = setup();
  Object.assign(video, { readyState: 2, videoWidth: 1280, videoHeight: 720 });
  const drawImage = vi.fn(),
    doc = {
      hidden: true,
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage,
          getImageData: () => ({
            width: 1024,
            height: 576,
            data: new Uint8ClampedArray(1024 * 576 * 4),
          }),
        }),
      }),
    };
  vi.stubGlobal("document", doc);
  let tick!: (time: number) => void;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((fn) => {
      tick = fn;
      return 7;
    }),
  );
  const camera = new Camera();
  await camera.start(video, "environment", vi.fn(), vi.fn());
  tick(0);
  expect(drawImage).not.toHaveBeenCalled();
  doc.hidden = false;
  tick(50);
  expect(drawImage).toHaveBeenCalledOnce();
  camera.stop();
});

it("passes raster pixels through Camera and Collector, clearing incomplete fragments on stop", async () => {
  setup();
  const source = createCanvas(1280, 720),
    ctx = source.getContext("2d");
  const video = Object.assign(source, {
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    readyState: 2,
    videoWidth: 1280,
    videoHeight: 720,
    srcObject: null,
  }) as unknown as HTMLVideoElement;
  vi.stubGlobal("document", {
    hidden: false,
    createElement: () => createCanvas(1, 1),
  });
  let tick!: (time: number) => void,
    now = 0;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((fn) => {
      tick = fn;
      return 7;
    }),
  );
  const camera = new Camera(),
    collector = new Collector(),
    delivered = vi.fn((frame: Uint8Array) => collector.add(frame));
  const [frame] = splitFrames(new TextEncoder().encode("pixels"));
  const symbols = splitBarFrame(frame);
  const paint = (index: number) => {
    ctx.fillStyle = "#090909";
    ctx.fillRect(0, 0, 1280, 720);
    ctx.save();
    ctx.translate(970, 350);
    ctx.rotate(0.23);
    ctx.scale(-1, 1);
    drawBar(
      ctx as unknown as CanvasRenderingContext2D,
      symbols[index],
      0,
      0,
      330,
      290,
    );
    ctx.restore();
    tick((now += 160));
  };
  await camera.start(video, "environment", delivered, vi.fn());
  paint(0);
  camera.stop();
  await camera.start(video, "environment", delivered, vi.fn());
  for (const i of [1, 1]) paint(i);
  expect(delivered).not.toHaveBeenCalled();
  paint(0);
  expect(delivered).toHaveBeenCalledOnce();
  expect(collector.prefix).toBe("pixels");
  camera.stop();
});
