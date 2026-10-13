import { $$, icon, qrSvg, fullUrl, api } from "/js/eco.js";

for (const el of $$("[data-i]")) el.prepend(icon(el.dataset.i));
for (const el of $$(".qr-slot")) el.append(qrSvg(fullUrl(el.dataset.path)));

api("/api/stats")
  .then((s) => {
    const set = (k, v) => ($$(`[data-s="${k}"]`)[0].textContent = v);
    set("p50", s.p50.utterance ? `${(s.p50.utterance / 1000).toFixed(1)} s` : "—");
    set("today", String(s.today));
    set("mode", s.live ? (s.tripped ? "Paused" : "Live") : "Mock");
  })
  .catch(() => {});
