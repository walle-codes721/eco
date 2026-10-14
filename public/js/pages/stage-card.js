import { h, icon, api, roomId, hostKey, fmtTime, langName, notFound } from "/js/eco.js";

const id = roomId();
const key = hostKey(id);
let c;
try {
  c = await api(`/api/rooms/${id}/card`, { key });
} catch (err) {
  notFound(err.status === 403 ? "Only the speaker can see this card. Open it from the presenter." : undefined);
  throw err;
}
const stats = await api("/api/stats").catch(() => null);
const totalQ = Object.values(c.qLangs).reduce((a, b) => a + b, 0);
const num = (n, label) => h("div.card", {}, h("div.stat", {}, n), h("p.small.muted", { style: { marginTop: "6px" } }, label));

document.body.replaceChildren(
  h("header.bar.no-print", {}, h("div.inner", {},
    h("a.brand", { href: "/" }, "Eco"), h("span.spacer"),
    h("a.btn.sm", { href: `/${id}/speak` }, "Back to console"),
    h("button.btn.sm.primary", { type: "button", onclick: () => print() }, icon("print"), "Print"))),
  h("main.report", {},
    h("p.eyebrow", {}, "After the talk"),
    h("h1", {}, c.title),
    h("p.muted", { style: { marginTop: "8px" } }, [c.speaker, new Date().toLocaleDateString(undefined, { dateStyle: "long" })].filter(Boolean).join(" · ")),
    h("div.big-num", {},
      num(fmtTime(c.duration), "duration"),
      num(String(c.peak), "peak listeners"),
      num(String(c.questions), "questions asked"),
      num(c.p50 ? `${(c.p50 / 1000).toFixed(1)} s` : "—", "median translation time"),
    ),
    c.worstSlide ? h("div.card", { style: { marginBottom: "16px" } },
      h("p.eyebrow", {}, "Where the room got lost"),
      h("h2", { style: { margin: "8px 0 4px" } }, `Slide ${c.worstSlide.slide}${c.worstSlide.title ? `: ${c.worstSlide.title}` : ""}`),
      h("p.muted", {}, `${c.worstSlide.count} question${c.worstSlide.count === 1 ? "" : "s"} were asked while it was on screen.`),
    ) : null,
    h("div.grid-2", {},
      h("div.card", {},
        h("p.eyebrow", { style: { marginBottom: "10px" } }, "What they asked about"),
        ...(c.topics.length ? c.topics.map((t) => h("div.kv", {}, h("span", {}, t.title), h("b", {}, String(t.count)))) : [h("p.muted.small", {}, "No answered questions.")]),
      ),
      h("div.card", {},
        h("p.eyebrow", { style: { marginBottom: "10px" } }, "Questions by language"),
        ...(totalQ ? Object.entries(c.qLangs).map(([l, n]) => h("div", { style: { marginBottom: "10px" } },
          h("div.kv", { style: { padding: "0 0 4px" } }, h("span", {}, langName(l)), h("span.muted", {}, String(n))),
          h("div.meter", {}, h("i", { style: { width: `${(n / totalQ) * 100}%` } })))) : [h("p.muted.small", {}, "No questions.")]),
      ),
    ),
    h("div.card", { style: { marginTop: "16px" } },
      h("p.eyebrow", { style: { marginBottom: "10px" } }, "Not covered by your slides"),
      ...(c.unanswered.length ? c.unanswered.map((u) => h("div.kv", {}, h("span", {}, u.q), h("span.muted", {}, `×${u.count}`))) : [h("p.muted.small", {}, "Everything asked was in the slides, or you answered it.")]),
      c.unanswered.length ? h("p.small", { style: { marginTop: "12px" } }, "Add these to your slides or notes, and Eco will answer them next time.") : null,
    ),
    h("p.tiny.faint", { style: { marginTop: "24px" } },
      `${c.lines} phrases translated into ${c.langs.map((l) => langName(l)).join(", ")}` +
      (stats?.live ? ` · ${stats.today} Token Factory calls today · ${stats.tokens.in + stats.tokens.out} tokens` : " · mock mode, no API calls")),
  ),
);
