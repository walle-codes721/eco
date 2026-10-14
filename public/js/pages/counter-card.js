import { h, icon, api, roomId, hostKey, langName, notFound } from "/js/eco.js";

const id = roomId();
const key = hostKey(id);
let c;
try {
  c = await api(`/api/rooms/${id}/card`, { key });
} catch (err) {
  notFound(err.status === 403 ? "Only the owner can see this card. Open it from the counter." : undefined);
  throw err;
}
const it = c.ownerLang === "it";
const total = Object.values(c.langs).reduce((a, b) => a + b, 0);
const num = (n, label) => h("div.card", {}, h("div.stat", {}, n), h("p.small.muted", { style: { marginTop: "6px" } }, label));

document.body.replaceChildren(
  h("header.bar.no-print", {}, h("div.inner", {},
    h("a.brand", { href: "/" }, "Eco"), h("span.spacer"),
    h("a.btn.sm", { href: `/${id}/owner` }, it ? "Torna al bancone" : "Back to counter"),
    h("button.btn.sm.primary", { type: "button", onclick: () => print() }, icon("print"), it ? "Stampa" : "Print"))),
  h("main.report", {},
    h("p.eyebrow", {}, it ? "La tua settimana" : "Your week"),
    h("h1", {}, c.title),
    h("div.big-num", {},
      num(String(c.conversations), it ? "conversazioni" : "conversations"),
      num(String(Object.keys(c.langs).length), it ? "lingue" : "languages"),
      num(String(c.unanswered.length), it ? "domande senza risposta" : "unanswered questions"),
    ),
    c.suggestion ? h("div.card", { style: { marginBottom: "16px", borderColor: "var(--red)" } },
      h("p.eyebrow", {}, it ? "Un consiglio" : "One suggestion"),
      h("h2", { style: { margin: "8px 0 4px" } }, it ? `Aggiungi informazioni su “${c.suggestion.word}”` : `Add info about “${c.suggestion.word}”`),
      h("p.muted", {}, it ? `I clienti l'hanno chiesto ${c.suggestion.count} volte e le tue informazioni non lo dicono.` : `Customers asked about it ${c.suggestion.count} times and your info doesn't cover it.`),
    ) : null,
    h("div.grid-2", {},
      h("div.card", {},
        h("p.eyebrow", { style: { marginBottom: "10px" } }, it ? "Cosa chiedono (Eco ha risposto)" : "What they asked (Eco answered)"),
        ...(c.topics.length ? c.topics.map((t) => h("div.kv", {}, h("span", {}, t.topic), h("b", {}, String(t.count)))) : [h("p.muted.small", {}, "—")]),
      ),
      h("div.card", {},
        h("p.eyebrow", { style: { marginBottom: "10px" } }, it ? "Lingue" : "Languages"),
        ...(total ? Object.entries(c.langs).sort((a, b) => b[1] - a[1]).map(([l, n]) => h("div", { style: { marginBottom: "10px" } },
          h("div.kv", { style: { padding: "0 0 4px" } }, h("span", {}, langName(l, c.ownerLang)), h("span.muted", {}, String(n))),
          h("div.meter", {}, h("i", { style: { width: `${(n / total) * 100}%` } })))) : [h("p.muted.small", {}, "—")]),
      ),
    ),
    h("div.card", { style: { marginTop: "16px" } },
      h("p.eyebrow", { style: { marginBottom: "10px" } }, it ? "Domande a cui non c'era risposta" : "Questions your info didn't answer"),
      ...(c.unanswered.length ? c.unanswered.map((u) => h("div.kv", {}, h("span", {}, u))) : [h("p.muted.small", {}, it ? "Nessuna." : "None.")]),
    ),
  ),
);
