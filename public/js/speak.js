// Phase A voice: the phone reads each line aloud. Phase B fills line.audio[lang] and this plays it instead.
const synth = window.speechSynthesis;
const LOCALE = { it: "it-IT", es: "es-ES", hi: "hi-IN", en: "en-US", fr: "fr-FR", de: "de-DE", pt: "pt-PT", zh: "zh-CN", ja: "ja-JP" };
let audioEl = null;

/** Best voice for the language; speaker n > 0 gets a different voice when the phone has one. */
function voiceFor(lang, n = 0) {
  const all = synth?.getVoices() ?? [];
  const mine = all.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const best = mine.find((v) => /premium|enhanced|natural|neural/i.test(v.name)) ?? mine.find((v) => v.localService) ?? mine[0] ?? null;
  if (!n || mine.length < 2) return best;
  const others = mine.filter((v) => v !== best);
  return others[(n - 1) % others.length];
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
  say(text, lang, url, speaker = 0) {
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
    const v = voiceFor(lang, speaker);
    if (v) u.voice = v;
    if (speaker && v === voiceFor(lang)) u.pitch = [1, 0.85, 1.15][speaker % 3]; // same voice: shift pitch so speakers differ
    u.rate = 1.04;
    u.onend = () => (this._queued = Math.max(0, (this._queued ?? 1) - 1));
    synth.speak(u);
  },
  has: (lang) => !!synth && (synth.getVoices().length === 0 || !!voiceFor(lang)),
};
synth?.addEventListener?.("voiceschanged", () => {});
