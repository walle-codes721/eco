// Phase A voice: the phone reads each line aloud. Phase B fills line.audio[lang] and this plays it instead.
const synth = window.speechSynthesis;
const LOCALE = { it: "it-IT", es: "es-ES", hi: "hi-IN", en: "en-US", fr: "fr-FR", de: "de-DE", pt: "pt-PT", zh: "zh-CN", ja: "ja-JP" };
let audioEl = null;

function voiceFor(lang) {
  const all = synth?.getVoices() ?? [];
  const mine = all.filter((v) => v.lang.toLowerCase().startsWith(lang));
  return mine.find((v) => /premium|enhanced|natural|neural/i.test(v.name)) ?? mine.find((v) => v.localService) ?? mine[0] ?? null;
}

export const voice = {
  on: false,
  /** Must run inside a tap: iOS only allows speech/audio that starts from a user gesture. */
  unlock() {
    this.on = true;
    synth?.speak(new SpeechSynthesisUtterance(" "));
    audioEl ??= new Audio();
    audioEl.play().catch(() => {});
  },
  off() {
    this.on = false;
    synth?.cancel();
    audioEl?.pause();
  },
  /** Speaks text; drops older lines if the phone falls 2+ lines behind (latency over completeness). */
  say(text, lang, url) {
    if (!this.on || !text) return;
    if (url) {
      audioEl.src = url;
      return void audioEl.play().catch(() => {});
    }
    if (!synth) return;
    if (synth.pending || synth.speaking) {
      if ((this._queued = (this._queued ?? 0) + 1) > 2) { synth.cancel(); this._queued = 0; }
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = LOCALE[lang] ?? lang;
    const v = voiceFor(lang);
    if (v) u.voice = v;
    u.rate = 1.04;
    u.onend = () => (this._queued = Math.max(0, (this._queued ?? 1) - 1));
    synth.speak(u);
  },
  has: (lang) => !!synth && (synth.getVoices().length === 0 || !!voiceFor(lang)),
};
synth?.addEventListener?.("voiceschanged", () => {});
