// One decision per caption, in caption order. No network requests are made here.
/** How long to wait for a cloned clip before the phone speaks. Matches tfSpeech timeout (OmniVoice can take several seconds). */
export const CLONE_WAIT_MS = 12_000;

export function stageAudio({ play, stop }) {
  const pending = new Map();
  let active = null, latest = 0;
  const remove = (item) => { clearTimeout(item.timer); pending.delete(item.seq); };
  const drain = () => {
    if (active) return;
    const item = pending.values().next().value;
    if (!item?.ready) return;
    remove(item);
    active = item;
    Promise.resolve().then(() => active === item && play(item.text, item.lang, item.url, item.speaker)).catch(() => {}).finally(() => {
      if (active !== item) return;
      active = null;
      drain();
    });
  };
  const ready = (item, url) => {
    if (item.ready || pending.get(item.seq) !== item) return;
    clearTimeout(item.timer);
    item.ready = true;
    item.url = url;
    drain();
    // Only ready phrases are a playback backlog. Protect captions that are
    // still within their clone deadlines, even when playback is currently idle.
    const backlog = [...pending.values()].filter((entry) => entry.ready);
    for (const entry of backlog.slice(0, Math.max(0, backlog.length - 3))) remove(entry);
    drain();
  };
  const pickUrl = (item, audio) => {
    if (!item.audioKey) return null;
    return audio[item.audioKey] ?? null;
  };
  return {
    line({ seq, text, lang, speaker, url, audioKey = lang, wait, enabled }) {
      if (seq <= latest) return; // duplicate frames/reconnect history must not replay
      latest = seq;
      if (!enabled) return;
      const item = { seq, text, lang, speaker, url, audioKey, ready: false, deadline: Date.now() + CLONE_WAIT_MS, timer: null };
      pending.set(seq, item);
      if (wait && audioKey && !url) item.timer = setTimeout(() => ready(item, null), CLONE_WAIT_MS);
      else ready(item, url ?? null);
      drain();
    },
    audio(seq, audio) {
      const item = pending.get(seq);
      if (!item || item.ready) return;
      if (item.audioKey && !Object.prototype.hasOwnProperty.call(audio, item.audioKey)) return;
      const url = pickUrl(item, audio);
      ready(item, Date.now() < item.deadline ? url : null);
    },
    clear(sequence = latest) {
      for (const item of pending.values()) clearTimeout(item.timer);
      pending.clear();
      active = null;
      latest = sequence;
      stop();
    },
  };
}
