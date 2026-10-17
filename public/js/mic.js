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

export function micErrorMessage(error) {
  if (error.name === "NotAllowedError") return "Microphone blocked: allow it in your browser settings, then retry.";
  return ({
    network: "Speech recognition couldn't connect. Check your connection and retry.",
    "audio-capture": "No microphone is available. Check your microphone connection and permissions, then retry.",
    "language-not-supported": "This browser can't recognize that spoken language. Choose another language and retry.",
    "no-speech": "No speech was detected. Start the microphone again and speak.",
    aborted: "Speech recognition stopped before starting. Please retry.",
  })[error.code] ?? "Couldn't start speech recognition. Check your microphone and retry.";
}

/** fetch headers + body for a phrase: recognised text, or a WAV blob. */
export const phraseInit = (p) => (typeof p === "string" ? [{ "content-type": "application/json" }, JSON.stringify({ text: p })] : [{ "content-type": "audio/wav" }, p]);

function sr(lang) {
  const r = new SR();
  r.lang = BCP47[lang] ?? lang;
  r.continuous = true;
  r.interimResults = false;
  return r;
}

function srPhrases({ onPhrase, onLevel, maxTotalMs, lang, onError }) {
  const r = sr(lang);
  let stopped = false;
  let started = false;
  let timer;
  const end = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    try { r.stop(); } catch {} // the browser may already have stopped
    onLevel(0);
  };
  r.onspeechstart = () => onLevel(1);
  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i].isFinal && e.results[i][0].transcript.trim();
      if (t) onPhrase(t, performance.now());
    }
    onLevel(0);
  };
  return new Promise((ok, fail) => {
    const failed = (error) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      // Detach before aborting: abort can itself emit error/end events.
      r.onstart = r.onend = r.onerror = r.onresult = r.onspeechstart = null;
      try { r.abort ? r.abort() : r.stop(); } catch {}
      onLevel(0);
      if (!started) fail(error);
      else onError(error);
    };
    const start = () => { try { r.start(); } catch (error) { failed(error); } };
    r.onend = () => {
      if (stopped) return;
      if (!started) failed(Object.assign(new Error("Recognition ended before starting"), { code: "aborted" }));
      else start(); // silence: restart with the same language
    };
    r.onstart = () => {
      if (stopped) return;
      started = true;
      r.onstart = null;
      if (maxTotalMs < Infinity) timer = setTimeout(end, maxTotalMs);
      ok(end);
    };
    r.onerror = (e) => {
      if (started && (e.error === "no-speech" || e.error === "aborted")) return;
      failed(/not-allowed/.test(e.error) ? denied(e) : Object.assign(new Error(e.error), { code: e.error }));
    };
    start();
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

/** HACKATHON mode: the mic only moves the level bar and "now speaking". Nothing is recognised or sent. Returns stop(). */
export async function levelMic(onLevel) {
  const cut = new Cutter();
  const stop = await open((frame) => onLevel(cut.push(frame).level));
  return () => (stop(), onLevel(0));
}

/** Stage: listens until stopped, calls onPhrase(textOrWav, cutAt) at each pause. */
export async function phraseMic({ onPhrase, onLevel = () => {}, onError = () => {}, maxTotalMs = Infinity, lang = navigator.language }) {
  if (SR) return srPhrases({ onPhrase, onLevel, onError, maxTotalMs, lang });
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
/** `wav: true` always records audio (voice samples), even where the browser could transcribe. */
export async function holdMic({ onLevel = () => {}, maxMs = 15000, lang = navigator.language, wav = false } = {}) {
  if (SR && !wav) return srHold({ onLevel, lang });
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
export function bindHold(btn, { onBlob, onStart = () => undefined, onError = () => {}, key = false, lang = () => navigator.language }) {
  // Object identity is the per-press token, including while startup is pending.
  let session = null;
  const level = (l) => btn.style.setProperty("--level", l.toFixed(2));
  const down = async (e) => {
    e?.preventDefault();
    if (session || btn.classList.contains("busy")) return;
    const current = { recorder: null, context: undefined };
    session = current;
    btn.classList.add("on");
    navigator.vibrate?.(10);
    try {
      // Keep the destination with this recording, including while stop() awaits final speech.
      current.context = onStart();
      const r = await holdMic({ onLevel: (l) => { if (session === current) level(l); }, lang: lang() });
      if (session === current) current.recorder = r;
      else await r.stop(); // stale startup: release its resources and discard its result
    } catch (err) {
      if (session !== current) return;
      session = null;
      btn.classList.remove("on");
      level(0);
      onError(err);
    }
  };
  const up = async (deliver = true) => {
    const current = session;
    if (!current) return;
    session = null; // invalidate before any await or later press
    btn.classList.remove("on");
    level(0);
    try {
      const blob = await current.recorder?.stop();
      if (deliver && blob) onBlob(blob, current.context);
    } catch (err) {
      if (!session) onError(err);
    }
  };
  btn.addEventListener("pointerdown", down);
  addEventListener("pointerup", () => up());
  addEventListener("pointercancel", () => up(false));
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
