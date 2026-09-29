import { useEffect, useRef, useState, useMemo, type ReactNode } from "react";
import { MetalFx } from "metal-fx";
import { Orb } from "./Orb";
import { Camera, cameraError } from "./camera";
import { Sound, soundError } from "./sound-runtime";
import {
  Collector,
  createWireFrames,
  MAX_TEXT_BYTES,
  type FrameSource,
} from "./protocol";

import { prepareMessage, decodeMessage } from "./message";

export function ReceivedText({ text }: { text: string }) {
  // Only examine the bounded tail; keys keep already-visible characters stable.
  let start = Math.max(0, text.length - 128);
  if (
    start &&
    text.charCodeAt(start) >= 0xdc00 &&
    text.charCodeAt(start) <= 0xdfff
  )
    start++;
  let offset = start;
  return (
    <>
      {text.slice(0, start)}
      {Array.from(text.slice(start)).map((character) => {
        const key = offset;
        offset += character.length;
        return (
          <span className="decoded-character" key={key}>
            {character}
          </span>
        );
      })}
    </>
  );
}

function CameraIcon({ front = false }: { front?: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 5 9.5 3h5L16 5h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
      {front ? (
        <>
          <circle cx="12" cy="10" r="2.2" />
          <path d="M7.5 17a4.5 4.5 0 0 1 9 0" />
        </>
      ) : (
        <circle cx="12" cy="13" r="4" />
      )}
    </svg>
  );
}

type Mode = "send" | "receive";
type Phase =
  | "idle"
  | "preparing"
  | "decoding"
  | "broadcasting"
  | "requesting"
  | "scanning"
  | "received";
const NO_FRAMES: FrameSource = {
  length: 0,
  get() {
    throw new Error("No frames.");
  },
  clear() {},
};
function Arrow({ down = false }: { down?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={down ? { transform: "rotate(180deg)" } : undefined}
    >
      <path
        d="M12 19V5m-6 6 6-6 6 6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function Primary({
  children,
  disabled,
  reduced,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  reduced: boolean;
  onClick: () => void;
}) {
  return (
    <MetalFx
      preset="silver"
      theme="dark"
      strength={disabled ? 0.2 : 0.65}
      glowGain={0.2}
      paused={reduced || !!disabled}
      normalizeHostStyles={false}
      className="metal-action"
    >
      <button className="primary" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    </MetalFx>
  );
}
export function App() {
  const [transport, setTransport] = useState<"orb" | "bar" | "sound" | "qr">(
    "orb",
  );
  const [mode, setMode] = useState<Mode>("send");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [phase, setPhase] = useState<Phase>("idle");
  const [text, setText] = useState("");
  const [frames, setFrames] = useState<FrameSource>(NO_FRAMES);
  const [received, setReceived] = useState("");
  const [candidate, setCandidate] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState({ count: 0, total: 0 });
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const camera = useRef(new Camera());
  const sound = useRef(new Sound());
  const errorText = transport === "sound" ? soundError : cameraError;
  const collector = useRef(new Collector(true));
  const video = useRef<HTMLVideoElement>(null);
  const generation = useRef(0);
  const frameStore = useRef<FrameSource>(NO_FRAMES);
  const copying = useRef(false);
  const job = useRef<AbortController | null>(null);
  const updateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelJobs() {
    job.current?.abort();
    job.current = null;
    if (updateTimer.current !== null) clearTimeout(updateTimer.current);
    updateTimer.current = null;
  }
  const byteCount = useMemo(
    () => new TextEncoder().encode(text).length,
    [text],
  );
  const inCamera =
    transport !== "sound" && (phase === "requesting" || phase === "scanning");
  const locked = phase !== "idle";
  const percent =
    phase === "received"
      ? 100
      : progress.total
        ? Math.min(99, Math.round((progress.count / progress.total) * 100))
        : 0;

  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    media.addEventListener("change", change);
    return () => {
      media.removeEventListener("change", change);
      generation.current++;
      camera.current.stop();
      sound.current.stop();
      collector.current.clear();
      frameStore.current.clear();
      cancelJobs();
    };
  }, []);

  function reset(nextMode = mode, keepText = false) {
    generation.current++;
    camera.current.stop();
    sound.current.stop();
    collector.current.clear();
    frameStore.current.clear();
    cancelJobs();
    frameStore.current = NO_FRAMES;
    setFrames(NO_FRAMES);
    if (!keepText) setText("");
    setReceived("");
    copying.current = false;
    setCopied(false);
    setError("");
    setCandidate(false);
    setProgress({ count: 0, total: 0 });
    setPhase("idle");
    setMode(nextMode);
  }

  async function send() {
    if (!byteCount || byteCount > MAX_TEXT_BYTES || phase !== "idle") return;
    const token = ++generation.current;
    const controller = new AbortController();
    job.current = controller;
    setError("");
    setPhase("preparing");
    let packet: Uint8Array | undefined;
    try {
      if (transport === "sound" && !(await sound.current.open())) return;
      if (token !== generation.current) return;
      packet = await prepareMessage(text, controller.signal);
      if (token !== generation.current) return;
      const result = createWireFrames(packet);
      frameStore.current = result;
      setFrames(result);
      setText("");
      setPhase("broadcasting");
      if (transport === "sound")
        sound.current.send(result, (reason) => {
          if (token !== generation.current) return;
          reset();
          setError(soundError(reason));
        });
    } catch (reason) {
      if (token === generation.current) {
        sound.current.stop();
        frameStore.current.clear();
        setFrames(NO_FRAMES);
        setError(errorText(reason));
        setPhase("idle");
      }
    } finally {
      packet?.fill(0);
      if (token === generation.current) job.current = null;
    }
  }

  async function startCamera() {
    if (phase !== "idle" || (transport !== "sound" && !video.current)) return;
    const token = ++generation.current;
    let completed = false;
    collector.current.clear();
    setReceived("");
    setCandidate(false);
    setProgress({ count: 0, total: 0 });
    setError("");
    setPhase("requesting");
    const fail = (reason: unknown) => {
      if (token !== generation.current) return;
      generation.current++;
      cancelJobs();
      camera.current.stop();
      sound.current.stop();
      collector.current.clear();
      setReceived("");
      setCandidate(false);
      setProgress({ count: 0, total: 0 });
      setPhase("idle");
      setError(errorText(reason));
    };
    try {
      const onFrame = (frame: Uint8Array) => {
        if (token !== generation.current || completed) return;
        const packet = collector.current.add(frame);
        const flush = () => {
          updateTimer.current = null;
          if (token !== generation.current) return;
          setProgress({
            count: collector.current.count,
            total: collector.current.total,
          });
          setReceived(collector.current.prefix);
        };
        if (!packet) {
          if (updateTimer.current === null)
            updateTimer.current = setTimeout(flush, 100);
          return;
        }
        completed = true;
        if (updateTimer.current !== null) clearTimeout(updateTimer.current);
        flush();
        camera.current.stop();
        sound.current.stop();
        collector.current.clear();
        setPhase("decoding");
        const controller = new AbortController();
        job.current = controller;
        void decodeMessage(packet, controller.signal)
          .then((message) => {
            if (token !== generation.current) return;
            setReceived(message);
            setPhase("received");
          })
          .catch(fail)
          .finally(() => {
            packet.fill(0);
            if (token === generation.current) job.current = null;
          });
      };
      const onCandidate = (visible: boolean) => {
        if (token === generation.current && !completed) setCandidate(visible);
      };
      const started =
        transport === "sound"
          ? await sound.current.receive(onFrame, fail, onCandidate)
          : await camera.current.start(
              video.current!,
              facing,
              onFrame,
              fail,
              onCandidate,
              transport,
            );
      if (started && token === generation.current && !completed)
        setPhase("scanning");
    } catch (reason) {
      fail(reason);
    }
  }

  async function copy() {
    if (!received || copying.current) return;
    const token = generation.current;
    copying.current = true;
    setError("");
    try {
      await navigator.clipboard.writeText(received);
      if (token === generation.current) setCopied(true);
    } catch {
      if (token === generation.current)
        setError("복사 권한이 없습니다. 메시지를 선택해 직접 복사하세요.");
    } finally {
      if (token === generation.current) copying.current = false;
    }
  }

  const title =
    phase === "broadcasting"
      ? transport === "sound"
        ? "Sending in sound"
        : "Ready to scan"
      : phase === "received"
        ? "Message received"
        : mode === "send"
          ? transport === "sound"
            ? "A message, in sound."
            : "A message, in light."
          : transport === "sound"
            ? "Catch the sound."
            : "Catch the light.";
  const status =
    phase === "preparing"
      ? "Preparing message…"
      : phase === "decoding"
        ? "Verifying message…"
        : phase === "requesting"
          ? `Waiting for ${transport === "sound" ? "microphone" : "camera"} permission…`
          : phase === "scanning"
            ? progress.total
              ? `${progress.count} / ${progress.total} frames received`
              : candidate
                ? "Signal candidate · checking data…"
                : "Searching…"
            : "";

  return (
    <div className="app-shell" data-theme={theme} data-transport={transport}>
      <header className="header">
        <button
          className="wordmark"
          type="button"
          aria-label={`Switch to ${transport === "orb" ? "Bar" : transport === "bar" ? "Sound" : transport === "sound" ? "QR" : "Orb"}`}
          onClick={() => {
            reset(mode, phase === "idle");
            setTransport(
              transport === "orb"
                ? "bar"
                : transport === "bar"
                  ? "sound"
                  : transport === "sound"
                    ? "qr"
                    : "orb",
            );
          }}
        >
          <svg
            width="23"
            height="23"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            {transport === "qr" ? (
              <path
                d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3v3h3v3h-6z"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            ) : transport === "sound" ? (
              <path
                d="M4 10v4m4-7v10m4-13v16m4-13v10m4-7v4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            ) : transport === "bar" ? (
              <path
                d="M4 6v12M9 3v18M15 7v10M20 4v16"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            ) : (
              <>
                <circle
                  cx="12"
                  cy="12"
                  r="8.5"
                  stroke="currentColor"
                  strokeWidth="1"
                />
                <ellipse
                  cx="12"
                  cy="12"
                  rx="4"
                  ry="8.5"
                  transform="rotate(35 12 12)"
                  stroke="currentColor"
                  strokeWidth="0.8"
                />
              </>
            )}
          </svg>
          {transport === "orb"
            ? "Orb"
            : transport === "bar"
              ? "Bar"
              : transport === "sound"
                ? "Sound"
                : "QR"}
        </button>
        <button
          type="button"
          className="theme-toggle"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label={theme === "dark" ? "Light mode" : "Dark mode"}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            {theme === "dark" ? (
              <>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5" />
              </>
            ) : (
              <path d="M20.5 14.1A8.8 8.8 0 0 1 9.9 3.5 8.8 8.8 0 1 0 20.5 14.1Z" />
            )}
          </svg>
          <span>{theme === "dark" ? "Light" : "Dark"}</span>
        </button>
      </header>
      <main
        className={`main ${transport === "qr" && mode === "send" ? "qr-send" : ""}`}
      >
        <nav className="mode-switch" aria-label="Transfer mode">
          <button
            aria-pressed={mode === "send"}
            onClick={() => mode !== "send" && reset("send")}
          >
            <Arrow />
            Send
          </button>
          <button
            aria-pressed={mode === "receive"}
            onClick={() => mode !== "receive" && reset("receive")}
          >
            <Arrow down />
            Receive
          </button>
        </nav>
        <div className="light-stage">
          <div
            className={`orb-stage ${mode === "receive" && transport !== "sound" && phase !== "received" ? "camera-shell" : ""} ${inCamera ? "camera-active" : ""} ${inCamera && candidate ? "is-candidate" : ""} ${phase === "received" ? "is-received" : ""}`}
            data-camera-state={phase}
          >
            <Orb
              frames={frames}
              reduced={reduced}
              still={inCamera}
              transport={transport}
              meter={sound.current.meter}
            />
            <video
              ref={video}
              className="camera-video"
              muted
              playsInline
              aria-label="Camera preview"
              style={{ visibility: inCamera ? "visible" : "hidden" }}
            />
            {mode === "receive" &&
              transport !== "sound" &&
              (phase === "idle" || phase === "requesting") && (
                <div className="camera-ready" aria-hidden="true">
                  <CameraIcon front={facing === "user"} />
                </div>
              )}
            {mode === "receive" &&
              transport !== "sound" &&
              phase !== "received" && (
                <div className="reticle" aria-hidden="true">
                  {candidate && (
                    <span className="target-label">Signal acquired</span>
                  )}
                </div>
              )}
            {phase === "scanning" && (
              <span className="camera-indicator">
                <span />
                {transport === "sound" ? "Microphone on" : "Camera on"}
              </span>
            )}
            {phase === "received" && (
              <div className="received-mark" aria-hidden="true">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
                  <path
                    d="m5 12 4 4 10-10"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            )}
          </div>
          {mode === "receive" && (
            <div className={`received-message ${received ? "has-text" : ""}`}>
              {received && (
                <div
                  className="light-trails"
                  key={received.length}
                  aria-hidden="true"
                >
                  <i />
                  <i />
                  <i />
                </div>
              )}
              <div className="receive-meter">
                <div className="meter-heading">
                  <span className="field-label">
                    {phase === "received" ? "RECEIVED" : "RECEIVING"}
                  </span>
                  <span className="meter-percent">{percent}%</span>
                </div>
                <div
                  className="meter-track"
                  role="progressbar"
                  aria-label="Receive progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                >
                  <span
                    className="meter-fill"
                    style={{ transform: `scaleX(${percent / 100})` }}
                  />
                </div>
              </div>
              <pre
                aria-label="Received message"
                aria-live="polite"
                aria-atomic="true"
              >
                <ReceivedText text={received} />
              </pre>
            </div>
          )}
        </div>
        <div className="intro">
          <h1>{title}</h1>
          <p className="status" role="status" aria-live="polite">
            {status}
          </p>
        </div>
        <section
          className="controls"
          aria-label={mode === "send" ? "Send a message" : "Receive a message"}
        >
          {phase === "received" ? (
            <>
              <div className="result-actions">
                <button className="secondary" onClick={() => void copy()}>
                  {copied ? "Copied" : "Copy message"}
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    const message = received;
                    reset("send");
                    setText(message);
                  }}
                >
                  Send again <Arrow />
                </button>
              </div>
              <button className="quiet-button" onClick={() => reset()}>
                Reset
              </button>
            </>
          ) : phase === "broadcasting" ? (
            <>
              <div className="broadcast-note">
                <span className="live-dot" />
                {transport === "sound" ? "Acoustic stream" : "Optical stream"}
              </div>
              <Primary reduced={reduced} onClick={() => reset()}>
                Stop sending <span aria-hidden="true">×</span>
              </Primary>
            </>
          ) : (
            <>
              {mode === "send" && (
                <div className="message-field">
                  <label htmlFor="message">Your message</label>
                  <textarea
                    id="message"
                    placeholder="A thought. A note. Across devices."
                    value={text}
                    onChange={(event) => {
                      setText(event.target.value);
                      setError("");
                    }}
                    disabled={locked}
                    spellCheck={false}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    rows={2}
                    aria-describedby="byte-count"
                  />
                  <span
                    id="byte-count"
                    className={`byte-count ${byteCount > MAX_TEXT_BYTES ? "over-limit" : ""}`}
                  >
                    {byteCount.toLocaleString("en-US")} /{" "}
                    {MAX_TEXT_BYTES.toLocaleString("en-US")} UTF-8 bytes
                  </span>
                </div>
              )}
              {mode === "receive" &&
                transport !== "sound" &&
                phase === "idle" && (
                  <div
                    className="camera-choice"
                    role="group"
                    aria-label="Camera"
                  >
                    <button
                      type="button"
                      aria-pressed={facing === "environment"}
                      onClick={() => setFacing("environment")}
                    >
                      <CameraIcon /> Back camera
                    </button>
                    <button
                      type="button"
                      aria-pressed={facing === "user"}
                      onClick={() => setFacing("user")}
                    >
                      <CameraIcon front /> Front camera
                    </button>
                  </div>
                )}
              <Primary
                reduced={reduced}
                disabled={
                  locked ||
                  (mode === "send" &&
                    (!byteCount || byteCount > MAX_TEXT_BYTES))
                }
                onClick={() => void (mode === "send" ? send() : startCamera())}
              >
                {locked
                  ? phase === "preparing"
                    ? "Preparing message…"
                    : phase === "decoding"
                      ? "Verifying message…"
                      : transport === "sound"
                        ? "Listening for sound…"
                        : "Listening for light…"
                  : mode === "send"
                    ? `Create ${transport}`
                    : transport === "sound"
                      ? "Start microphone"
                      : "Start camera"}
                {!locked &&
                  (mode === "receive" && transport !== "sound" ? (
                    <CameraIcon />
                  ) : (
                    <Arrow down={mode === "receive"} />
                  ))}
              </Primary>
              {locked && (
                <button className="quiet-button" onClick={() => reset()}>
                  Cancel
                </button>
              )}
            </>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
