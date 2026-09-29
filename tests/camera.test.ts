import { afterEach, expect, it, vi } from "vitest";
import { Camera } from "../src/camera";

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
    width: 640,
    height: 360,
    data: new Uint8ClampedArray(640 * 360 * 4),
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
  expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 360);
  expect(getImageData).toHaveBeenCalledWith(0, 0, 640, 360);
  camera.stop();
});
