import { useEffect, useRef, useState, type ReactNode } from "react";
import { MetalFx } from "metal-fx";
import { Orb } from "./Orb";
import { Camera, cameraError } from "./camera";
import { Collector, splitFrames, MAX_TEXT_BYTES } from "./protocol";

type Mode = "send" | "receive";
type Phase = "idle" | "broadcasting" | "requesting" | "scanning" | "received";
const NO_FRAMES: Uint8Array[] = [];
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
  const [mode, setMode] = useState<Mode>("send");
  const [phase, setPhase] = useState<Phase>("idle");
  const [text, setText] = useState("");
  const [frames, setFrames] = useState<Uint8Array[]>(NO_FRAMES);
  const [received, setReceived] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState({ count: 0, total: 0 });
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [offlineReady, setOfflineReady] = useState(false);
  const camera = useRef(new Camera());
  const collector = useRef(new Collector());
  const video = useRef<HTMLVideoElement>(null);
  const generation = useRef(0);
  const frameStore = useRef<Uint8Array[]>(NO_FRAMES);
  const copying = useRef(false);
  const byteCount = new TextEncoder().encode(text).length;
  const inCamera = phase === "requesting" || phase === "scanning";
  const locked = phase !== "idle";

  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    media.addEventListener("change", change);
    const readiness = () =>
      setOfflineReady(!!navigator.serviceWorker?.controller);
    readiness();
    navigator.serviceWorker?.addEventListener("controllerchange", readiness);
    return () => {
      media.removeEventListener("change", change);
      navigator.serviceWorker?.removeEventListener(
        "controllerchange",
        readiness,
      );
      generation.current++;
      camera.current.stop();
      collector.current.clear();
      frameStore.current.forEach((frame) => frame.fill(0));
    };
  }, []);

  function reset(nextMode = mode) {
    generation.current++;
    camera.current.stop();
    collector.current.clear();
    frameStore.current.forEach((frame) => frame.fill(0));
    frameStore.current = NO_FRAMES;
    setFrames(NO_FRAMES);
    setText("");
    setReceived("");
    copying.current = false;
    setCopied(false);
    setError("");
    setProgress({ count: 0, total: 0 });
    setPhase("idle");
    setMode(nextMode);
  }

  function send() {
    if (!byteCount || byteCount > MAX_TEXT_BYTES || phase !== "idle") return;
    const packet = new TextEncoder().encode(text);
    setError("");
    try {
      const result = splitFrames(packet);
      frameStore.current = result;
      setFrames(result);
      setText("");
      setPhase("broadcasting");
    } catch {
      setError("Could not create the orb. Please try again.");
    } finally {
      packet.fill(0);
    }
  }

  async function startCamera() {
    if (phase !== "idle" || !video.current) return;
    const token = ++generation.current;
    let completed = false;
    collector.current.clear();
    setReceived("");
    setProgress({ count: 0, total: 0 });
    setError("");
    setPhase("requesting");
    const fail = (reason: unknown) => {
      if (token !== generation.current) return;
      generation.current++;
      camera.current.stop();
      collector.current.clear();
      setReceived("");
      setProgress({ count: 0, total: 0 });
      setPhase("idle");
      setError(cameraError(reason));
    };
    try {
      const started = await camera.current.start(
        video.current,
        facing,
        (frame) => {
          if (token !== generation.current || completed) return;
          const packet = collector.current.add(frame);
          setProgress({
            count: collector.current.count,
            total: collector.current.total,
          });
          setReceived(collector.current.prefix);
          if (!packet) return;
          completed = true;
          camera.current.stop();
          collector.current.clear();
          packet.fill(0);
          setPhase("received");
        },
        fail,
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
      ? "Ready to scan"
      : phase === "received"
        ? "Message received"
        : mode === "send"
          ? "A message, in light."
          : "Catch the light.";
  const status =
    phase === "requesting"
      ? "Waiting for camera permission…"
      : phase === "scanning"
        ? progress.total
          ? `${progress.count} / ${progress.total} frames received`
          : "원 안에 상대 기기의 orb를 맞춰 주세요."
        : phase === "broadcasting"
          ? "다른 기기에서 Receive를 열고 이 orb를 스캔하세요."
          : phase === "received"
            ? "All frames received · checksum verified"
            : mode === "send"
              ? "화면에서 카메라로, 네트워크 없이."
              : "카메라를 켜고 상대 orb를 비춰 주세요.";

  return (
    <div className="app-shell">
      <header className="header">
        <a className="wordmark" href="/" aria-label="Orb home">
          <svg
            width="23"
            height="23"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
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
          </svg>
          orb
        </a>
        <span className="header-note">a little less connected.</span>
      </header>
      <main className="main">
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
            className={`orb-stage ${inCamera ? "camera-active" : ""} ${phase === "received" ? "is-received" : ""}`}
          >
            <Orb frames={frames} reduced={reduced} still={inCamera} />
            <video
              ref={video}
              className="camera-video"
              muted
              playsInline
              aria-label="Camera preview"
              style={{ visibility: inCamera ? "visible" : "hidden" }}
            />
            {mode === "receive" && phase !== "received" && (
              <div className="reticle" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
                <span className="target-label">Align orb here</span>
              </div>
            )}
            {inCamera && (
              <span className="camera-indicator">
                <span />
                Camera on
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
              <span className="field-label">
                {phase === "received" ? "YOUR MESSAGE" : "RECEIVING"}
              </span>
              <pre
                aria-label="Received message"
                aria-live="polite"
                aria-atomic="true"
              >
                {Array.from(received).map((character, index) => (
                  <span className="decoded-character" key={index}>
                    {character}
                  </span>
                ))}
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
                Optical stream
              </div>
              <Primary reduced={reduced} onClick={() => reset()}>
                Stop sending <span aria-hidden="true">×</span>
              </Primary>
              <p className="microcopy">
                받은 기기에서 완료를 확인한 뒤 멈추세요.
              </p>
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
                    {byteCount} / {MAX_TEXT_BYTES} bytes
                  </span>
                </div>
              )}
              {mode === "receive" && phase === "idle" && (
                <div className="camera-choice">
                  <label htmlFor="camera-facing">Camera</label>
                  <select
                    id="camera-facing"
                    value={facing}
                    onChange={(event) =>
                      setFacing(event.target.value as "environment" | "user")
                    }
                  >
                    <option value="environment">Back / default</option>
                    <option value="user">Front / webcam</option>
                  </select>
                </div>
              )}
              {inCamera && progress.total > 0 && (
                <progress
                  max={progress.total}
                  value={progress.count}
                  aria-label="Received frames"
                />
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
                  ? "Listening for light…"
                  : mode === "send"
                    ? "Create orb"
                    : "Start camera"}
                {!locked && <Arrow down={mode === "receive"} />}
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
        <p className="camera-warning">
          Not encrypted. Anyone who can film the orb can read it.
        </p>
      </main>
      <footer>
        <details>
          <summary>
            Only light travels.<span aria-hidden="true">＋</span>
          </summary>
          <div className="details-content">
            <p>
              Plain UTF-8 travels through the orb. Frame and message checksums
              detect accidental corruption; they do not authenticate the sender.
              Partial text is provisional until the whole message checks out.
            </p>
            <p>
              메시지와 카메라 영상은 서버에 보내거나 저장하지 않습니다. 브라우저
              메모리의 완전한 삭제는 보장할 수 없습니다. 복사한 메시지는
              클립보드에 남을 수 있습니다.
            </p>
            <p>
              카메라에는 HTTPS 또는 localhost가 필요합니다. 화면을 정면으로
              비추고 orb가 원을 채우도록 맞추세요. 실기기 촬영 성능과 보안
              감사는 아직 검증 전입니다.
            </p>
            <p>
              {offlineReady
                ? "Offline app ready. 최초 로딩 이후 인터넷 없이 다시 열 수 있습니다."
                : "오프라인 재실행은 production build의 최초 로딩 후 사용할 수 있습니다."}
            </p>
          </div>
        </details>
      </footer>
    </div>
  );
}
