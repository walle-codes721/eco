import { h, icon, api, qrSvg, fullUrl, shortUrl, toast, langName } from "/js/eco.js";
import { openPdf, pdfPages, renderPage, saveDeck } from "/js/slides.js";

const LANGS = ["it", "es", "hi", "fr", "de", "pt", "zh", "ja", "ar"];
const state = { langs: ["it", "es", "hi"], pages: [], bytes: null };

const title = h("input", { type: "text", placeholder: "One engine, two rooms", maxlength: 120, autocomplete: "off" });
const speaker = h("input", { type: "text", placeholder: "Your name", maxlength: 80, autocomplete: "name" });
const notes = h("textarea", { placeholder: "Things you'll say that aren't on the slides: numbers, links, answers to likely questions." });
const file = h("input", { type: "file", accept: "application/pdf", hidden: true });
const thumbs = h("div.thumbs");
const deckInfo = h("p.small.muted");
const drop = h("div.drop", { role: "button", tabindex: 0 },
  icon("doc"), h("p", { style: { marginTop: "8px", fontWeight: 600, color: "var(--ink)" } }, "Drop your slides (PDF)"),
  h("p.small", {}, "Export from Keynote, PowerPoint or Google Slides. The file stays on this laptop; only the text goes to Eco."),
);

drop.onclick = () => file.click();
drop.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && file.click();
drop.ondragover = (e) => (e.preventDefault(), drop.classList.add("over"));
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  if (e.dataTransfer.files[0]) readPdf(e.dataTransfer.files[0]);
};
file.onchange = () => file.files[0] && readPdf(file.files[0]);

async function readPdf(f) {
  if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) return toast("That isn't a PDF");
  deckInfo.textContent = "Reading slides…";
  thumbs.replaceChildren();
  try {
    state.bytes = new Uint8Array(await f.arrayBuffer());
    const pdf = await openPdf(state.bytes);
    state.pages = await pdfPages(pdf);
    const withText = state.pages.filter((p) => p.text).length;
    deckInfo.textContent = `${f.name} · ${pdf.numPages} slides · text found on ${withText}` + (withText < pdf.numPages / 2 ? ". Some slides are images; add what they say in Notes." : "");
    if (!title.value) title.value = state.pages[0]?.text.split("\n")[0].slice(0, 120) ?? "";
    for (let n = 1; n <= Math.min(pdf.numPages, 24); n++) {
      const slot = h("div");
      thumbs.append(slot);
      slot.append(await renderPage(pdf, n, 160));
    }
  } catch (err) {
    console.error(err);
    state.bytes = null;
    state.pages = [];
    deckInfo.textContent = "Couldn't read that PDF. Try exporting it again.";
  }
}

const langBtns = LANGS.map((l) => {
  const b = h("button.toggle", { type: "button", "aria-pressed": state.langs.includes(l) ? "true" : "false" }, langName(l, l));
  b.onclick = () => {
    const on = state.langs.includes(l);
    if (!on && state.langs.length >= 3) return toast("Up to 3 languages");
    state.langs = on ? state.langs.filter((x) => x !== l) : [...state.langs, l];
    b.setAttribute("aria-pressed", String(!on));
  };
  return b;
});

const option = (name, desc, checked, disabled) =>
  h("div.option", { role: "radio", "aria-checked": String(checked), "aria-disabled": String(!!disabled) },
    h("span.radio"), h("div", {}, h("div", { style: { fontWeight: 600 } }, name), h("div.small.muted", {}, desc)));

const section = (head, sub, ...body) =>
  h("section.form-section", {}, h("header", {}, h("h2", {}, head), h("p", {}, sub)), h("div.stack", {}, ...body));

const create = h("button.btn.primary.big", { type: "submit" }, "Create the room", icon("right"));
const form = h("form", {},
  section("Your talk", "Shown on every listener's phone.", h("label.field", {}, "Title", title), h("label.field", {}, "Speaker", speaker)),
  section("Slides", "Eco answers questions only from these and from what you say. Answers cite the slide.", drop, file, deckInfo, thumbs),
  section("Notes", "Optional. Also used to answer questions.", notes),
  section("Languages", "Up to 3. Listeners pick one when they scan. You speak English.", h("div.lang-grid", {}, langBtns)),
  section("Voice", "What listeners hear when they turn sound on.",
    option("Phone voice", "Each phone reads the translation aloud in a natural voice. Works today.", true),
    option("Your own voice", "Coming soon: your cloned voice in every language, waiting on AMD to host the model.", false, true),
  ),
  h("div.row", { style: { padding: "28px 0 80px", justifyContent: "flex-end" } }, create),
);

form.onsubmit = async (e) => {
  e.preventDefault();
  if (!state.langs.length) return toast("Pick at least one language");
  create.disabled = true;
  create.firstChild.textContent = "Creating…";
  try {
    const { id, hostKey } = await api("/api/rooms", {
      method: "POST",
      body: { mode: "stage", title: title.value, speaker: speaker.value, langs: state.langs, pages: state.pages, notes: notes.value },
    });
    if (state.bytes) await saveDeck(id, state.bytes);
    try { localStorage.setItem(`eco:host:${id}`, hostKey); } catch {}
    ready(id, hostKey);
  } catch (err) {
    toast(err.message || "Couldn't create the room");
    create.disabled = false;
    create.firstChild.textContent = "Create the room";
  }
};

function ready(id, key) {
  const listen = `/r/${id}`;
  const presenter = `/s/${id}#k=${key}`;
  const copy = (text, label) => h("button.btn", { type: "button", onclick: () => navigator.clipboard.writeText(text).then(() => toast(`${label} copied`)) }, icon("copy"), label);
  document.querySelector("main").replaceChildren(
    h("section.ready.narrow", {},
      h("span.pill.ok", {}, h("span.dot"), "Room ready"),
      h("h1", { style: { fontSize: "clamp(32px,5vw,48px)", margin: "18px 0 8px", letterSpacing: "-0.04em" } }, title.value || "Your talk"),
      h("p.muted", {}, "Show this to the room. Listeners scan it and pick their language."),
      h("div", { style: { margin: "28px 0 12px" } }, qrSvg(fullUrl(listen))),
      h("p.url", { style: { fontSize: "20px" } }, shortUrl(listen)),
      h("div.row", { style: { justifyContent: "center", flexWrap: "wrap", margin: "32px 0 12px" } },
        h("a.btn.primary.big", { href: presenter }, icon("stage"), "Open presenter"),
        h("a.btn.big", { href: `/s/${id}/screen`, target: "_blank" }, icon("ext"), "Open projector window"),
      ),
      h("div.row", { style: { justifyContent: "center", flexWrap: "wrap" } }, copy(fullUrl(listen), "Listener link"), copy(fullUrl(presenter), "Presenter link")),
      h("p.small.muted", { style: { marginTop: "24px" } }, "Keep the presenter link private: it controls the talk. Open the projector window on the same laptop so it shows your PDF; drag it to the projector and press F for full screen."),
    ),
  );
}

document.body.replaceChildren(
  h("header.bar", {}, h("div.inner", {}, h("a.brand", { href: "/" }, "Eco"), h("span.title.muted", {}, "New talk"))),
  h("main.wrap", { style: { maxWidth: "900px" } },
    h("div.page-head", {}, h("p.eyebrow", {}, "Stage"), h("h1", {}, "Create a talk")),
    form,
  ),
);
