import type { FrameSource } from "./protocol";
import { encodeSound, SoundDecoder } from "./sound";

// Capture only. The worklet's output stays zero, so microphones never echo to speakers.
const CAPTURE = `class PCM extends AudioWorkletProcessor {
  constructor(){super();this.pcm=new Float32Array(1024);this.used=0;}
  process(inputs){const input=inputs[0]?.[0];if(input)for(const x of input){
    this.pcm[this.used++]=x;if(this.used===1024){this.port.postMessage(this.pcm);this.used=0;}
  }return true;}
}registerProcessor('orb-pcm',PCM);`;
export class Sound {
  private generation = 0;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private nodes = new Set<AudioNode>();
  private buffers = new Set<AudioBufferSourceNode>();
  private decoder: SoundDecoder | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  // Shared with the canvas, sampled at paint time; no per-symbol React updates.
  readonly meter = { level: 0, waveform: new Float32Array(64) };
  private sampleWaveform(samples: Float32Array, offset = 0) {
    const count = Math.min(256, samples.length - offset);
    for (let i = 0; i < this.meter.waveform.length; i++)
      this.meter.waveform[i] =
        count > 0 ? samples[offset + Math.floor((i * count) / 64)] : 0;
  }
  stop() {
    this.generation++;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const node of this.buffers) {
      node.onended = null;
      try {
        node.stop();
      } catch {}
      node.buffer?.getChannelData(0).fill(0);
      node.disconnect();
    }
    this.buffers.clear();
    for (const node of this.nodes) {
      if (
        typeof AudioWorkletNode !== "undefined" &&
        node instanceof AudioWorkletNode
      ) {
        node.port.onmessage = null;
        node.port.close();
      }
      node.disconnect();
    }
    this.nodes.clear();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.decoder?.clear();
    this.decoder = null;
    this.meter.level = 0;
    this.meter.waveform.fill(0);
    const context = this.context;
    this.context = null;
    if (context) {
      context.onstatechange = null;
      void context.close().catch(() => {});
    }
  }
  async open() {
    this.stop();
    if (typeof AudioContext === "undefined")
      throw new Error("Sound is unavailable in this browser.");
    const token = this.generation;
    const context = new AudioContext();
    this.context = context;
    try {
      await context.resume();
      return token === this.generation;
    } catch (error) {
      if (token === this.generation) this.stop();
      throw error;
    }
  }
  private watch(token: number, onError: (e: unknown) => void) {
    const fail = (e: unknown) => {
      if (token === this.generation) {
        this.stop();
        onError(e);
      }
    };
    this.context!.onstatechange = () => {
      if (this.context && this.context.state !== "running")
        fail(new Error("Audio interrupted. Try again."));
    };
    return fail;
  }
  send(frames: FrameSource, onError: (e: unknown) => void) {
    const context = this.context;
    if (!context || context.state !== "running")
      throw new Error("Audio could not start. Try again.");
    const token = this.generation,
      fail = this.watch(token, onError);
    let index = 0,
      next = context.currentTime + 0.06;
    const ends = new WeakMap<AudioBufferSourceNode, number>();
    const schedule = () => {
      if (token !== this.generation) return;
      try {
        // Bounded lookahead; never materialize an entire message or loop in PCM.
        while (next < context.currentTime + 0.35) {
          if (next < context.currentTime) next = context.currentTime + 0.02;
          const frame = frames.get(index++ % frames.length);
          let pcm: Float32Array;
          try {
            pcm = encodeSound(frame, context.sampleRate);
          } finally {
            frame.fill(0);
          }
          const buffer = context.createBuffer(
            1,
            pcm.length,
            context.sampleRate,
          );
          buffer.getChannelData(0).set(pcm);
          pcm.fill(0);
          const node = context.createBufferSource();
          node.buffer = buffer;
          node.connect(context.destination);
          this.buffers.add(node);
          node.onended = () => {
            buffer.getChannelData(0).fill(0);
            node.disconnect();
            this.buffers.delete(node);
          };
          ends.set(node, next);
          node.start(next);
          next += buffer.duration;
        }
        // Read the samples actually scheduled at the audio clock, including guard silence.
        const position = context.currentTime;
        this.meter.level = 0;
        this.meter.waveform.fill(0);
        for (const node of this.buffers) {
          const start = ends.get(node);
          if (
            start !== undefined &&
            position >= start &&
            position < start + node.buffer!.duration
          ) {
            const samples = node.buffer!.getChannelData(0),
              i = Math.floor((position - start) * context.sampleRate);
            this.sampleWaveform(samples, i);
            let energy = 0;
            const n = Math.min(256, samples.length - i);
            for (let j = 0; j < n; j++) energy += samples[i + j] ** 2;
            this.meter.level = Math.min(
              1,
              Math.sqrt(energy / Math.max(1, n)) * 12,
            );
          }
        }
      } catch (e) {
        fail(e);
      }
    };
    schedule();
    if (token === this.generation) this.timer = setInterval(schedule, 25);
  }

  async receive(
    onFrame: (f: Uint8Array) => void,
    onError: (e: unknown) => void,
    onCandidate: (v: boolean) => void,
  ) {
    if (!globalThis.isSecureContext)
      throw new Error("Microphone needs HTTPS or localhost.");
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("Microphone is unavailable in this browser.");
    if (!(await this.open())) return false;
    const token = this.generation,
      context = this.context!;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          echoCancellation: { ideal: false },
          noiseSuppression: { ideal: false },
          autoGainControl: { ideal: false },
          channelCount: { ideal: 1 },
        },
      });
      if (token !== this.generation) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      this.stream = stream;
      if (!context.audioWorklet || typeof AudioWorkletNode === "undefined")
        throw new Error(
          "Microphone PCM processing is unavailable in this browser.",
        );
      const url = URL.createObjectURL(
        new Blob([CAPTURE], { type: "text/javascript" }),
      );
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (token !== this.generation) return false;
      const fail = this.watch(token, onError);
      this.decoder = new SoundDecoder(
        context.sampleRate,
        (f) => {
          if (token === this.generation) {
            onCandidate(true);
            onFrame(f);
          }
        },
        (level) => {
          this.meter.level = level;
        },
      );
      const source = context.createMediaStreamSource(stream),
        capture = new AudioWorkletNode(context, "orb-pcm");
      this.nodes.add(source);
      this.nodes.add(capture);
      capture.port.onmessage = (e) => {
        if (token === this.generation)
          try {
            this.sampleWaveform(e.data);
            this.decoder?.push(e.data);
            e.data.fill(0);
          } catch (error) {
            fail(error);
          }
      };
      capture.onprocessorerror = () =>
        fail(new Error("Microphone processing failed. Try again."));
      source.connect(capture);
      capture.connect(context.destination);
      for (const track of stream.getTracks())
        track.addEventListener(
          "ended",
          () => fail(new Error("Microphone disconnected. Try again.")),
          { once: true },
        );
      return true;
    } catch (e) {
      if (token === this.generation) this.stop();
      throw e;
    }
  }
}
export function soundError(error: unknown) {
  if (error instanceof DOMException && error.name === "NotAllowedError")
    return "Microphone access was denied. Check browser permissions.";
  if (error instanceof DOMException && error.name === "NotFoundError")
    return "No microphone found. Try another device.";
  if (error instanceof DOMException && error.name === "NotReadableError")
    return "Microphone is busy. Close other audio apps and try again.";
  return error instanceof Error
    ? error.message
    : "Could not start sound. Please try again.";
}
