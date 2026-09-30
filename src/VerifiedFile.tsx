import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { ImageGeneration, type ImageGenerationHandle } from "img-fx";
import type { VerifiedTransfer } from "./binary-transfer";
import { rasterInfo } from "./file-preview";
class EffectBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
function RevealedImage({
  url,
  reduced,
  theme,
}: {
  url: string;
  reduced: boolean;
  theme: "dark" | "light";
}) {
  const ref = useRef<ImageGenerationHandle>(null);
  const [paused, setPaused] = useState(false),
    [fallback, setFallback] = useState(false);
  const ordinary = (
    <img src={url} alt="Verified received image" className="verified-image" />
  );
  useEffect(() => {
    if (reduced) return;
    // img-fx 0.5.1 creates its scheduler in a layout effect; its autoReveal=false
    // passive effect stops that scheduler. Trigger after both, never on ref attach.
    const frame = requestAnimationFrame(() =>
      ref.current?.triggerReveal({ hold: "manual" }),
    );
    const timeout = setTimeout(() => setFallback(true), 6000);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
    };
  }, [url, reduced]);
  if (reduced || fallback) return ordinary;
  return (
    <EffectBoundary fallback={ordinary}>
      <ImageGeneration
        ref={ref}
        images={[url]}
        preset="pixels-organic"
        theme={theme}
        autoReveal={false}
        revealInitialDelay={0}
        paused={paused}
        onCycle={(event) => {
          if (event.phase === "visible") setPaused(true);
        }}
        className="verified-effect"
      >
        <div className="verified-card">{ordinary}</div>
      </ImageGeneration>
    </EffectBoundary>
  );
}
export function VerifiedFile({
  file,
  reduced,
  theme,
}: {
  file: VerifiedTransfer;
  reduced: boolean;
  theme: "dark" | "light";
}) {
  const [download, setDownload] = useState(""),
    [preview, setPreview] = useState("");
  useEffect(() => {
    let active = true;
    const downloadUrl = URL.createObjectURL(
      new Blob([file.bytes], { type: "application/octet-stream" }),
    );
    setDownload(downloadUrl);
    setPreview("");
    const info = rasterInfo(file.bytes);
    const previewUrl = info
      ? URL.createObjectURL(new Blob([file.bytes], { type: info.mime }))
      : "";
    const image = new Image();
    if (info) {
      image.src = previewUrl;
      void image
        .decode()
        .then(() => {
          if (
            active &&
            image.naturalWidth === info.width &&
            image.naturalHeight === info.height
          )
            setPreview(previewUrl);
        })
        .catch(() => {
          /* Valid transfer, but not a decodable raster: download still works. */
        });
    }
    return () => {
      active = false;
      image.src = "";
      URL.revokeObjectURL(downloadUrl);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [file]);
  return (
    <div className="verified-file">
      <p>
        {file.meta.name}{" "}
        <span>
          · {file.bytes.length.toLocaleString("en-US")} bytes · SHA-256 verified
        </span>
      </p>
      {preview && (
        <RevealedImage
          key={preview}
          url={preview}
          reduced={reduced}
          theme={theme}
        />
      )}
      {download && (
        <a className="secondary" href={download} download={file.meta.name}>
          Download file
        </a>
      )}
    </div>
  );
}
