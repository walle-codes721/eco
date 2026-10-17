// Phase A voice: the phone reads each line aloud. Phase B fills line.audio[lang] and this plays it instead.
const synth = window.speechSynthesis;
const LOCALE = { it: "it-IT", es: "es-ES", hi: "hi-IN", en: "en-US", fr: "fr-FR", de: "de-DE", pt: "pt-PT", zh: "zh-CN", ja: "ja-JP" };
let audioEl = null;
let stopStage = null;
const STAGE_STARTUP_MS = 10000;
const STAGE_STALL_MS = 15000;

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
    this.stopStage();
    synth?.cancel();
    audioEl?.pause();
  },
  stopStage() { stopStage?.(); },
  /** Stage's scheduler awaits completion so clips and phone speech cannot overlap. */
  playStage(text, lang, url, speaker = 0, rush = false) {
    if (!this.on || !text) return Promise.resolve();
    this.stopStage();
    return new Promise((resolve) => {
      let finished = false, started = false, utterance = null, phase = "clip";
      let watchdog, progress;
      const clearTimers = () => { clearTimeout(watchdog); clearInterval(progress); };
      const detach = () => {
        if (audioEl) audioEl.onended = audioEl.onerror = audioEl.onplaying = null;
        if (utterance) utterance.onend = utterance.onerror = utterance.onstart = utterance.onboundary = null;
      };
      const releaseClip = () => {
        audioEl?.pause();
        audioEl?.removeAttribute("src");
        audioEl?.load(); // abort a pending download/start; no source means no new request
      };
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimers();
        detach();
        releaseClip();
        if (utterance) synth?.cancel();
        stopStage = null;
        resolve();
      };
      stopStage = done;
      const phone = () => {
        if (finished || phase === "phone") return;
        phase = "phone";
        clearTimers();
        detach();
        releaseClip();
        if (!synth) return done();
        utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = LOCALE[lang] ?? lang;
        const v = voiceFor(lang, speaker);
        if (v) utterance.voice = v;
        if (speaker && v === voiceFor(lang)) utterance.pitch = [1, 0.85, 1.15][speaker % 3];
        utterance.rate = rush ? 1.2 : 1.04;
        // Some voices never emit boundaries. Allow slow speech (3 Unicode code
        // points/sec) plus 30 s slack, and extend only on actual forward progress.
        // Unlike a fixed playback cap this lets long, progressing speech finish.
        const speechWindowMs = 30000 + [...text].length / 3 * 1000;
        let phoneStarted = false, boundary = -1;
        const speechProgress = () => { clearTimeout(watchdog); watchdog = setTimeout(done, speechWindowMs); };
        utterance.onstart = () => {
          if (finished || phoneStarted) return;
          phoneStarted = true;
          speechProgress();
        };
        utterance.onboundary = (event) => {
          if (finished || !Number.isFinite(event.charIndex) || event.charIndex <= boundary) return;
          boundary = event.charIndex;
          phoneStarted = true;
          speechProgress();
        };
        utterance.onend = utterance.onerror = done;
        watchdog = setTimeout(done, STAGE_STARTUP_MS);
        try { synth.speak(utterance); } catch { done(); }
      };
      if (!url) return phone();
      audioEl ??= new Audio();
      let failed = false;
      const failure = () => {
        if (finished || failed || phase !== "clip") return;
        failed = true;
        // A failed download may use phone speech; never repeat a partially played clip.
        if (started) done(); else phone();
      };
      let position = audioEl.currentTime, lastProgress = performance.now();
      const began = () => {
        if (finished || phase !== "clip" || started) return;
        started = true;
        clearTimeout(watchdog);
        lastProgress = performance.now();
      };
      audioEl.onplaying = began;
      audioEl.onended = () => { if (!finished && phase === "clip") done(); };
      audioEl.onerror = failure;
      audioEl.src = url;
      audioEl.playbackRate = rush ? 1.15 : 1; // after src: a new source resets it
      watchdog = setTimeout(failure, STAGE_STARTUP_MS);
      progress = setInterval(() => {
        if (finished || phase !== "clip") return;
        if (audioEl.ended) return done();
        if (audioEl.currentTime > position) {
          began();
          position = audioEl.currentTime;
          lastProgress = performance.now();
        }
        if (started && performance.now() - lastProgress >= STAGE_STALL_MS) done();
      }, 1000);
      try { audioEl.play().catch(failure); } catch { failure(); }
    });
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
