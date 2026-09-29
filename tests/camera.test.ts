import { afterEach, expect, it, vi } from "vitest";
import { Camera } from "../src/camera";
import { createCanvas } from "@napi-rs/canvas";
import { BarTracker, drawBar, splitBarFrame } from "../src/bar";
import { Collector, splitFrames } from "../src/protocol";

afterEach(() => vi.unstubAllGlobals());
function setup() {
  const stop = vi.fn();
  const track = {
    stop,
    addEventListener: vi.fn(),
    getCapabilities: vi.fn().mockReturnValue({}),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
  };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
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
  return { stream, stop, getUserMedia, video, track };
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
  for (const i of [1, 1, 2]) paint(i);
  expect(delivered).not.toHaveBeenCalled();
  paint(0);
  expect(delivered).toHaveBeenCalledOnce();
  expect(collector.prefix).toBe("pixels");
  camera.stop();
});

it("Camera restores 1k from degraded optical pixels with two data frames missing per block", async () => {
  setup();
  const { drawOptical } = await import("../src/optical");
  const { opticalFrames, parseOpticalFrame } =
    await import("../src/optical-fec");
  const { createFrames } = await import("../src/protocol");
  const source = createCanvas(640, 520),
    ctx = source.getContext("2d");
  const video = Object.assign(source, {
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    readyState: 2,
    videoWidth: 640,
    videoHeight: 520,
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
    bytes = new TextEncoder().encode("abcdefghij".repeat(100));
  const frames = opticalFrames(createFrames(bytes));
  let result: Uint8Array | null = null;
  const errors = vi.fn();
  await camera.start(
    video,
    "environment",
    (f) => {
      expect(f[1]).toBe(4);
      result = collector.add(f) || result;
    },
    errors,
  );
  const clean = createCanvas(640, 520),
    c = clean.getContext("2d");
  for (let i = 0; i < frames.length; i++) {
    const frame = frames.get(i),
      meta = parseOpticalFrame(frame)!;
    if (frame[1] === 4 && meta.index % 8 < 2) continue;
    c.fillStyle = "#090909";
    c.fillRect(0, 0, 640, 520);
    drawOptical(
      c as unknown as CanvasRenderingContext2D,
      frame,
      365,
      255,
      210,
      0.23,
      0.75,
    );
    ctx.filter = "blur(2px)";
    ctx.drawImage(clean, 0, 0);
    ctx.filter = "none";
    tick((now += 1000));
  }
  expect(errors).not.toHaveBeenCalled();
  expect(result).toEqual(bytes);
  expect(collector.count).toBe(collector.total);
  camera.stop();
  frames.clear();
});

it("Camera.stop clears the Bar reference frame and scan counters", async () => {
  const { video } = setup();
  const clear = vi.spyOn(BarTracker.prototype, "clear");
  try {
    const camera = new Camera();
    await camera.start(video, "environment", vi.fn(), vi.fn());
    clear.mockClear();
    camera.stop();
    expect(clear).toHaveBeenCalledOnce();
  } finally {
    clear.mockRestore();
  }
});

it("enables only supported continuous camera controls", async () => {
  const { video, track, getUserMedia } = setup();
  track.getCapabilities.mockReturnValue({
    focusMode: ["manual", "continuous"],
    exposureMode: ["continuous"],
    whiteBalanceMode: ["manual"],
  });
  const camera = new Camera();
  await camera.start(video, "environment", vi.fn(), vi.fn());
  expect(track.applyConstraints).toHaveBeenCalledWith({
    advanced: [{ focusMode: "continuous", exposureMode: "continuous" }],
  });
  expect(getUserMedia.mock.calls[0][0].video.frameRate).toEqual({ ideal: 30 });
  camera.stop();
});
it("camera remains usable when optional automatic controls are rejected", async () => {
  const { video, track } = setup();
  track.getCapabilities.mockReturnValue({ focusMode: ["continuous"] });
  track.applyConstraints.mockRejectedValue(
    new DOMException("Unsupported", "OverconstrainedError"),
  );
  const camera = new Camera();
  expect(await camera.start(video, "environment", vi.fn(), vi.fn())).toBe(true);
  expect(track.applyConstraints).toHaveBeenCalledOnce();
  camera.stop();
});
it("cancellation during automatic camera setup cannot restart playback", async () => {
  const { video, track, stop } = setup();
  track.getCapabilities.mockReturnValue({ focusMode: ["continuous"] });
  let finish!: () => void;
  track.applyConstraints.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const camera = new Camera();
  const started = camera.start(video, "environment", vi.fn(), vi.fn());
  await Promise.resolve();
  expect(track.applyConstraints).toHaveBeenCalledOnce();
  camera.stop();
  finish();
  expect(await started).toBe(false);
  expect(stop).toHaveBeenCalledOnce();
  expect(video.play).not.toHaveBeenCalled();
});
