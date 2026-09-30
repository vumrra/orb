import { W, H, source, raster, decode, locate, Collector } from "./codec.mjs";
const $ = (s) => document.querySelector(s),
  board = $("#board"),
  video = $("#video"),
  status = $("#status");
const logical = document.createElement("canvas");
logical.width = W;
logical.height = H;
const lc = logical.getContext("2d");
let generation = 0,
  stream = null,
  sendRAF = 0,
  receiveRAF = 0,
  objectURL = null,
  cancelTrial = null;
function stop() {
  const cancel = cancelTrial;
  cancelTrial = null;
  cancel?.();
  generation++;
  cancelAnimationFrame(sendRAF);
  cancelAnimationFrame(receiveRAF);
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.pause();
  video.srcObject = null;
  if (objectURL) URL.revokeObjectURL(objectURL);
  objectURL = null;
  $("#download").hidden = true;
}
$("#stop").onclick = () => {
  stop();
  status.textContent = "Stopped";
};
function paint(frame) {
  const p = raster(frame);
  lc.putImageData(new ImageData(p.data, W, H), 0, 0);
  const c = board.getContext("2d");
  c.imageSmoothingEnabled = false;
  c.drawImage(logical, 0, 0, board.width, board.height);
}
async function listen(media, token, collector, onDone, counters) {
  if (token !== generation) {
    media.getTracks().forEach((t) => t.stop());
    return;
  }
  stream = media;
  video.srcObject = media;
  await video.play();
  const capture = document.createElement("canvas"),
    ctx = capture.getContext("2d", { willReadFrequently: true });
  const small = document.createElement("canvas");
  small.width = W;
  small.height = H;
  const sc = small.getContext("2d", { willReadFrequently: true });
  sc.imageSmoothingEnabled = false;
  let box = null,
    bad = 0,
    done = false,
    lastMedia = -1;
  const tick = async () => {
    if (token !== generation || done) return;
    if (video.readyState >= 2 && video.currentTime !== lastMedia) {
      lastMedia = video.currentTime;
      const start = performance.now();
      counters.samples++;
      if (!box) {
        capture.width = video.videoWidth;
        capture.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        box = locate(ctx.getImageData(0, 0, capture.width, capture.height));
      }
      if (box) {
        sc.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, W, H);
        const p = decode(sc.getImageData(0, 0, W, H));
        if (p) {
          bad = 0;
          counters.valid++;
          const complete = collector.add(p);
          status.textContent = `${collector.count} / ${collector.seen.length} chunks · repaired ${collector.repaired}`;
          if (complete) {
            done = true;
            try {
              await collector.verify();
              if (token !== generation) return;
              await onDone();
            } catch (e) {
              status.textContent = String(e);
              onDone(e);
            }
            return;
          }
        } else {
          counters.rejected++;
          if (++bad >= 3) {
            box = null;
            bad = 0;
          }
        }
      }
      counters.decodeMs += performance.now() - start;
    }
    if (token === generation) receiveRAF = requestAnimationFrame(tick);
  };
  receiveRAF = requestAnimationFrame(tick);
}
window.runTrial = async ({
  bytes = 10_000_000,
  bits = 3,
  fps = 60,
  dropEvery = 0,
  blur = 0,
  move = false,
  angle = 0,
  timeoutMs = 90000,
} = {}) => {
  stop();
  const token = generation,
    original = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 65536)
    crypto.getRandomValues(original.subarray(i, i + 65536));
  const started = performance.now(),
    sender = await source(original, bits),
    collector = new Collector(),
    counters = { samples: 0, valid: 0, rejected: 0, decodeMs: 0 };
  if (token !== generation) return { ok: false, reason: "cancelled" };
  const scene = document.createElement("canvas");
  scene.width = board.width + 100;
  scene.height = board.height + 100;
  const cx = scene.getContext("2d");
  const media = scene.captureStream(fps);
  let sent = 0,
    last = -Infinity;
  const tick = (time) => {
    if (token !== generation) return;
    if (time - last >= 1000 / fps - 1) {
      last = time;
      paint(sender.frame());
      sent++;
      cx.fillStyle = "#090a0b";
      cx.fillRect(0, 0, scene.width, scene.height);
      if (!dropEvery || sent % dropEvery) {
        cx.filter = `blur(${blur}px)`;
        cx.save();
        cx.translate(
          30 + board.width / 2 + (move ? (Math.floor(sent / 30) % 3) * 3 : 0),
          30 + board.height / 2,
        );
        cx.rotate((angle * Math.PI) / 180);
        cx.drawImage(board, -board.width / 2, -board.height / 2);
        cx.restore();
        cx.filter = "none";
      }
    }
    sendRAF = requestAnimationFrame(tick);
  };
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => {
      const result = {
        ok: false,
        reason: "timeout",
        bytes,
        bits,
        fps,
        dropEvery,
        blur,
        move,
        angle,
        received: collector.count,
        total: collector.seen?.length,
        ...counters,
      };
      cancelTrial = null;
      stop();
      window.lastResult = result;
      status.textContent = JSON.stringify(result, null, 2);
      resolve(result);
    }, timeoutMs);
    const finish = async (error) => {
      clearTimeout(timer);
      const elapsedMs = performance.now() - started;
      if (error) {
        cancelTrial = null;
        stop();
        reject(error);
        return;
      }
      const equal =
        collector.bytes.length === original.length &&
        collector.bytes.every((b, i) => b === original[i]);
      const result = {
        ok: equal,
        sha256Verified: true,
        bytes,
        bits,
        fps,
        dropEvery,
        blur,
        move,
        angle,
        elapsedMs,
        bytesPerSecond: (bytes * 1000) / elapsedMs,
        under10Seconds: elapsedMs <= 10000,
        sent,
        repaired: collector.repaired,
        ...counters,
        boundary:
          "preparation-through-SHA256, real canvas -> captureStream -> video; axis-aligned synthetic",
      };
      cancelTrial = null;
      stop();
      window.lastResult = result;
      status.textContent = JSON.stringify(result, null, 2);
      resolve(result);
    };
    cancelTrial = () => {
      clearTimeout(timer);
      resolve({ ok: false, reason: "cancelled" });
    };
    try {
      sendRAF = requestAnimationFrame(tick);
      await listen(media, token, collector, finish, counters);
    } catch (e) {
      clearTimeout(timer);
      cancelTrial = null;
      stop();
      reject(e);
    }
  });
};
$("#bench").onclick = () =>
  window
    .runTrial({ bits: Number($("#bits").value) })
    .catch((e) => (status.textContent = String(e)));
$("#send").onclick = async () => {
  stop();
  const token = generation;
  try {
    const file = $("#file").files[0];
    if (!file || !file.size || file.size > 30_000_000)
      throw Error("Choose a nonempty file up to 30 MB");
    const sender = await source(
      new Uint8Array(await file.arrayBuffer()),
      Number($("#bits").value),
    );
    let last = -Infinity;
    status.textContent = "Sending experimental color grid";
    const tick = (time) => {
      if (token !== generation) return;
      if (time - last >= 1000 / 60 - 1) {
        last = time;
        paint(sender.frame());
      }
      sendRAF = requestAnimationFrame(tick);
    };
    sendRAF = requestAnimationFrame(tick);
  } catch (e) {
    status.textContent = String(e);
  }
};
$("#receive").onclick = async () => {
  stop();
  const token = generation;
  try {
    const media = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 },
        facingMode: { ideal: "environment" },
      },
      audio: false,
    });
    const receiver = new Collector();
    await listen(
      media,
      token,
      receiver,
      async (error) => {
        if (error) throw error;
        const bytes = receiver.bytes;
        stop();
        objectURL = URL.createObjectURL(
          new Blob([bytes], { type: "application/octet-stream" }),
        );
        const a = $("#download");
        a.href = objectURL;
        a.download = "received.bin";
        a.hidden = false;
        status.textContent = `SHA-256 verified · ${bytes.length} bytes`;
      },
      { samples: 0, valid: 0, rejected: 0, decodeMs: 0 },
    );
  } catch (e) {
    status.textContent = String(e);
  }
};
