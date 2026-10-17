// One decision per caption, in caption order. No network requests are made here.
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
  return {
    line({ seq, text, lang, speaker, url, wait, enabled }) {
      if (seq <= latest) return; // duplicate frames/reconnect history must not replay
      latest = seq;
      if (!enabled) return;
      const item = { seq, text, lang, speaker, url, ready: false, deadline: Date.now() + 4000, timer: null };
      pending.set(seq, item);
      if (wait && !url) item.timer = setTimeout(() => ready(item, null), 4000);
      else ready(item, url);
      drain();
    },
    audio(seq, audio) {
      const item = pending.get(seq);
      if (!item || item.ready || !audio[item.lang]) return;
      ready(item, Date.now() < item.deadline ? audio[item.lang] : null);
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
