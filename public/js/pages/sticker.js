import { h, icon, api, roomId, qrSvg, fullUrl, shortUrl, notFound } from "/js/eco.js";

const id = roomId();
let meta;
try {
  meta = await api(`/api/rooms/${id}/meta`);
} catch {
  notFound();
  throw new Error("no room");
}
const HELLO = [["Talk to us in your language", "en"], ["Parlez-nous dans votre langue", "fr"], ["Háblanos en tu idioma", "es"], ["Sprich mit uns in deiner Sprache", "de"], ["用你的语言和我们交流", "zh"], ["हमसे अपनी भाषा में बात करें", "hi"]];
document.body.style.background = "var(--bg-2)";
document.body.replaceChildren(
  h("div.no-print.center", { style: { padding: "20px" } }, h("button.btn.primary", { type: "button", onclick: () => print() }, icon("print"), "Print")),
  h("div.sticker", {},
    h("div.langs", {}, ...HELLO.map(([s, l], i) => (i === 0 ? h("b", { lang: l }, s) : h("span", { lang: l }, s)))),
    qrSvg(fullUrl(`/${id}`)),
    h("div", { style: { fontSize: "22px", fontWeight: 700, letterSpacing: "-0.03em" } }, meta.title),
    h("p.url", { style: { fontSize: "13px", color: "#6e6e73", marginTop: "6px" } }, shortUrl(`/${id}`)),
    h("p", { style: { fontSize: "12px", color: "#a1a1a6", marginTop: "14px" } }, "Eco · no app needed · scan with your camera"),
  ),
);
