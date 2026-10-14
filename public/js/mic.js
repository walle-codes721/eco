// Microphone: continuous phrase mode (stage) and hold-to-talk (counter). Both produce 16 kHz WAV.
import { Cutter, encodeWav, resample } from "/js/vad.js";

async function open(onFrame) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule("/js/worklet.js");
  const src = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, "eco-tap");
  tap.port.onmessage = (e) => onFrame(resample(e.data, ctx.sampleRate));
  src.connect(tap);
  return () => { tap.disconnect(); src.disconnect(); stream.getTracks().forEach((t) => t.stop()); ctx.close(); };
}

/** Stage: listens until stopped, calls onPhrase(wavBlob, cutAt) at each pause. */
export async function phraseMic({ onPhrase, onLevel = () => {}, maxTotalMs = Infinity }) {
  const cut = new Cutter();
  const started = performance.now();
  let stop;
  const end = () => {
    const rest = cut.flush();
    if (rest) onPhrase(encodeWav(rest), performance.now());
    stop?.();
  };
  stop = await open((frame) => {
    const { level, phrase } = cut.push(frame);
    onLevel(level);
    if (phrase) onPhrase(encodeWav(phrase), performance.now());
    if (performance.now() - started > maxTotalMs) end();
  });
  return end;
}

/** Counter: press and hold. Returns stop() which resolves to a WAV blob (or null if too short). */
export async function holdMic({ onLevel = () => {}, maxMs = 15000 } = {}) {
  const parts = [];
  let len = 0, finished = false, resolve;
  const done = new Promise((r) => (resolve = r));
  const finish = () => {
    if (finished) return;
    finished = true;
    close();
    onLevel(0);
    if (len < 16000 * 0.5) return resolve(null);
    const all = new Float32Array(len);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    resolve(encodeWav(all));
  };
  const close = await open((frame) => {
    if (finished) return;
    parts.push(frame);
    len += frame.length;
    let peak = 0;
    for (const x of frame) peak = Math.max(peak, Math.abs(x));
    onLevel(Math.min(1, peak * 2));
    if (len > (16000 * maxMs) / 1000) finish();
  });
  return { stop: () => (finish(), done) };
}

/** Wires a .hold button: press to talk, release to send. Space bar works too when `key` is set. */
export function bindHold(btn, { onBlob, onError = () => {}, key = false }) {
  let rec = null, pressed = false;
  const level = (l) => btn.style.setProperty("--level", l.toFixed(2));
  const down = async (e) => {
    e?.preventDefault();
    if (pressed || btn.classList.contains("busy")) return;
    pressed = true;
    btn.classList.add("on");
    navigator.vibrate?.(10);
    try {
      const r = await holdMic({ onLevel: level });
      if (pressed) rec = r;
      else r.stop(); // released before the mic opened
    } catch (err) {
      pressed = false;
      btn.classList.remove("on");
      onError(err);
    }
  };
  const up = async () => {
    if (!pressed) return;
    pressed = false;
    btn.classList.remove("on");
    const r = rec;
    rec = null;
    const blob = await r?.stop();
    if (blob) onBlob(blob);
  };
  btn.addEventListener("pointerdown", down);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", up);
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  if (key) {
    addEventListener("keydown", (e) => e.code === "Space" && !e.repeat && e.target === document.body && down(e));
    addEventListener("keyup", (e) => e.code === "Space" && up());
  }
}

/** "Now speaking" from the mic level, with hysteresis so a breath doesn't flicker it. Wrap phraseMic's onLevel. */
export function speakingSignal(send, onLevel = () => {}) {
  let on = false, quietSince = 0;
  return (level) => {
    onLevel(level);
    const now = performance.now();
    if (level > 0.25) {
      quietSince = 0;
      if (!on) send({ type: "speaking", on: (on = true) });
    } else if (on) {
      quietSince ||= now;
      if (now - quietSince > 1500) send({ type: "speaking", on: (on = false) });
    }
  };
}
