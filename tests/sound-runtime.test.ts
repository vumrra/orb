import { afterEach, expect, it, vi } from "vitest";
import { Sound } from "../src/sound-runtime";
afterEach(() => vi.unstubAllGlobals());
function setup() {
  const close = vi.fn().mockResolvedValue(undefined),
    resume = vi.fn().mockResolvedValue(undefined);
  const context = {
    close,
    resume,
    state: "running",
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
  };
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function () {
      return context;
    }),
  );
  vi.stubGlobal("isSecureContext", true);
  const stop = vi.fn(),
    stream = { getTracks: () => [{ stop, addEventListener: vi.fn() }] };
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  return { context, close, resume, stop, stream, getUserMedia };
}
it("resumes in the initiating gesture and closes on cancellation", async () => {
  const { resume, close } = setup();
  const sound = new Sound();
  const opening = sound.open();
  expect(resume).toHaveBeenCalledOnce();
  sound.stop();
  expect(await opening).toBe(false);
  expect(close).toHaveBeenCalledOnce();
});
it("stops microphone permission delivered after cancellation", async () => {
  const { getUserMedia, stream, stop, close } = setup();
  let grant!: (s: unknown) => void;
  getUserMedia.mockImplementation(
    () =>
      new Promise((r) => {
        grant = r;
      }),
  );
  const sound = new Sound();
  const starting = sound.receive(vi.fn(), vi.fn(), vi.fn());
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
  sound.stop();
  grant(stream);
  expect(await starting).toBe(false);
  expect(stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(getUserMedia).toHaveBeenCalledWith({
    video: false,
    audio: {
      echoCancellation: { ideal: false },
      noiseSuppression: { ideal: false },
      autoGainControl: { ideal: false },
      channelCount: { ideal: 1 },
    },
  });
});
it("closes context after denied permission and rejects insecure origins before permission", async () => {
  const { getUserMedia, close } = setup();
  getUserMedia.mockRejectedValue(new Error("denied"));
  await expect(new Sound().receive(vi.fn(), vi.fn(), vi.fn())).rejects.toThrow(
    "denied",
  );
  expect(close).toHaveBeenCalledOnce();
  vi.stubGlobal("isSecureContext", false);
  getUserMedia.mockClear();
  await expect(new Sound().receive(vi.fn(), vi.fn(), vi.fn())).rejects.toThrow(
    "HTTPS",
  );
  expect(getUserMedia).not.toHaveBeenCalled();
});

it("schedules bounded real PCM lazily, and cancels every output on interruption", async () => {
  const { createFrames } = await import("../src/protocol");
  const { context, close } = setup();
  vi.useFakeTimers();
  const nodes: {
    buffer: AudioBuffer | null;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    onended: unknown;
  }[] = [];
  Object.assign(context, {
    sampleRate: 48000,
    currentTime: 0,
    destination: {},
    onstatechange: null,
    createBuffer: (_channels: number, size: number, rate: number) => {
      const data = new Float32Array(size);
      return { duration: size / rate, getChannelData: () => data };
    },
    createBufferSource: () => {
      const node = {
        buffer: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      nodes.push(node);
      return node;
    },
  });
  const sound = new Sound();
  const source = createFrames(new TextEncoder().encode("a".repeat(1048576))),
    get = vi.spyOn(source, "get"),
    fail = vi.fn();
  try {
    await sound.open();
    sound.send(source, fail);
    expect(get.mock.calls.length).toBeGreaterThan(0);
    expect(get.mock.calls.length).toBeLessThanOrEqual(3);
    expect(
      nodes.every((n) => n.buffer!.getChannelData(0).some((x) => x !== 0)),
    ).toBe(true);
    const mutable = context as typeof context & {
      currentTime: number;
      onstatechange: () => void;
    };
    mutable.currentTime = 0.09;
    vi.advanceTimersByTime(25);
    expect(sound.meter.level).toBeGreaterThan(0);
    expect(sound.meter.waveform.some((sample) => sample !== 0)).toBe(true);
    context.state = "suspended";
    mutable.onstatechange();
    expect(fail).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(
      nodes.every(
        (n) =>
          n.stop.mock.calls.length === 1 &&
          n.disconnect.mock.calls.length === 1 &&
          n.buffer!.getChannelData(0).every((x) => x === 0),
      ),
    ).toBe(true);
    const count = get.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(get).toHaveBeenCalledTimes(count);
  } finally {
    sound.stop();
    source.clear();
    vi.useRealTimers();
  }
});
