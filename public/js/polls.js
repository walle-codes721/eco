// Poll text and results, drawn the same way on the speaker's console and the listener's phone.
import { h } from "/js/eco.js";
import { t } from "/js/i18n.js";

/** The poll in `lang`: room languages are always there; anything else reads the speaker's original. */
export const pollQ = (p, lang) => p.q[lang] ?? p.q.en ?? p.q[p.lang];
export const pollOpts = (p, lang) => p.options[lang] ?? p.options.en ?? p.options[p.lang];

const bar = (label, n, total, hot) => h("div", { style: { marginTop: "10px" } },
  h("div.kv", { style: { padding: "0 0 4px" } }, h("span", { style: hot ? { fontWeight: 700 } : {} }, label), h("span.muted.mono", {}, String(n))),
  h("div.meter", {}, h("i", { style: { width: `${total ? (n / total) * 100 : 0}%` } })));

/** `p.tally` from the server (src/poll.ts tally()), in `lang`. */
export function pollResults(p, lang) {
  const r = p.tally;
  if (!r) return null;
  const T = (k) => t(lang, k);
  const head = h("p.tiny.muted", { style: { marginTop: "8px" } }, `${r.n} ${T("votes")}`);
  if (p.kind === "free") {
    if (!r.texts) return head;
    return h("div", {}, head, ...r.texts.map((x) => h("p.small", { style: { padding: "8px 0", borderTop: "1px solid var(--line)" } },
      x.out[lang] ?? x.a, x.out[lang] ? null : h("span.chip", { style: { marginLeft: "6px" } }, T("original")))));
  }
  if (p.kind === "rating") {
    return h("div", {}, h("div.row", { style: { alignItems: "baseline", marginTop: "8px" } },
      h("span.stat", {}, r.avg == null ? "—" : r.avg.toFixed(1)), h("span.muted.small", {}, `/ ${p.max} · ${r.n} ${T("votes")}`)),
      ...r.counts.map((n, i) => bar(String(p.min + i), n, r.n)));
  }
  const opts = pollOpts(p, lang);
  if (p.kind === "rank") {
    const order = opts.map((o, i) => [o, r.avg[i]]).sort((a, b) => (a[1] ?? 99) - (b[1] ?? 99));
    return h("div", {}, head, ...order.map(([o, avg], i) => h("div.kv", {}, h("span", {}, `${i + 1}. ${o}`), h("span.muted.mono", {}, avg == null ? "—" : avg.toFixed(1)))));
  }
  const top = Math.max(...r.counts);
  return h("div", {}, head, ...opts.map((o, i) => bar(o, r.counts[i], r.n, top > 0 && r.counts[i] === top)));
}
