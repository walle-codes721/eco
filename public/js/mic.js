// Microphone: continuous phrase mode (stage) and hold-to-talk (counter).
// With the browser's speech recognition they produce text; without it (Firefox), 16 kHz WAV.
import { Cutter, encodeWav, resample } from "./vad.js";

// ponytail: Token Factory stopped taking audio on 15 Oct, so the browser does speech-to-text (Chrome/Safari; Chrome sends
// the audio to Google). Delete SR and the sr* functions to go back to WAV → MiMo if AMD restores audio input.
const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
const BCP47 = { en: "en-US", it: "it-IT", es: "es-ES", hi: "hi-IN", fr: "fr-FR", de: "de-DE", pt: "pt-PT", zh: "zh-CN", ja: "ja-JP", ko: "ko-KR", ar: "ar-SA", ru: "ru-RU", nl: "nl-NL", pl: "pl-PL", tr: "tr-TR" };
export const SPOKEN_LANGUAGES = Object.keys(BCP47);
export const hasSpeechRecognition = !!SR;
const denied = (e) => Object.assign(new Error(e.error), { name: "NotAllowedError" });

/** fetch headers + body for a phrase: recognised text, or a WAV blob. */
export const phraseInit = (p) => (typeof p === "string" ? [{ "content-type": "application/json" }, JSON.stringify({ text: p })] : [{ "content-type": "audio/wav" }, p]);

function sr(lang) {
  const r = new SR();
  r.lang = BCP47[lang] ?? lang;
  r.continuous = true;
  r.interimResults = false;
  return r;
}

function srPhrases({ onPhrase, onLevel, maxTotalMs, lang }) {
  const r = sr(lang);
  let stopped = false;
  const end = () => ((stopped = true), r.stop(), onLevel(0));
  r.onspeechstart = () => onLevel(1);
  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i].isFinal && e.results[i][0].transcript.trim();
      if (t) onPhrase(t, performance.now());
    }
    onLevel(0);
  };
  r.onend = () => !stopped && r.start(); // Chrome ends the session after a silence: keep listening
  return new Promise((ok, fail) => {
    r.onstart = () => {
      r.onstart = null;
      if (maxTotalMs < Infinity) setTimeout(end, maxTotalMs);
      ok(end);
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return; // a silence: onend restarts
      stopped = true; // network, no mic, blocked: don't restart in a loop
      if (/not-allowed/.test(e.error)) fail(denied(e));
    };
    r.start();
  });
}

function srHold({ onLevel, lang }) {
  const r = sr(lang);
  let text = "", resolve;
  const done = new Promise((ok) => (resolve = ok));
  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) text += e.results[i][0].transcript + " ";
  };
  r.onend = () => (onLevel(0), resolve(text.trim() || null));
  return new Promise((ok, fail) => {
    r.onstart = () => (onLevel(0.6), ok({ stop: () => (r.stop(), done) }));
    r.onerror = (e) => /not-allowed/.test(e.error) && fail(denied(e));
    r.start();
  });
}

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

/** Stage: listens until stopped, calls onPhrase(textOrWav, cutAt) at each pause. */
export async function phraseMic({ onPhrase, onLevel = () => {}, maxTotalMs = Infinity, lang = navigator.language }) {
  if (SR) return srPhrases({ onPhrase, onLevel, maxTotalMs, lang });
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

/** Counter: press and hold. Returns stop() which resolves to text or a WAV blob (or null if too short). */
export async function holdMic({ onLevel = () => {}, maxMs = 15000, lang = navigator.language } = {}) {
  if (SR) return srHold({ onLevel, lang });
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

/** Wires a .hold button: press to talk, release to send (text or WAV). Space bar works too when `key` is set. */
export function bindHold(btn, { onBlob, onError = () => {}, key = false, lang = () => navigator.language }) {
  let rec = null, pressed = false;
  const level = (l) => btn.style.setProperty("--level", l.toFixed(2));
  const down = async (e) => {
    e?.preventDefault();
    if (pressed || btn.classList.contains("busy")) return;
    pressed = true;
    btn.classList.add("on");
    navigator.vibrate?.(10);
    try {
      const r = await holdMic({ onLevel: level, lang: lang() });
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
