import { h, icon, api, accountLink, linkField, qrSvg, fullUrl, shortUrl, toast, langName, me } from "/js/eco.js";
import { openPdf, pdfPages, pdfDeckRows, renderPage, saveDeck, uploadDeck, scriptFileText } from "/js/slides.js";
import { deckPreviewSetup } from "/js/deck-preview.js";
import { splitScript } from "/js/script.js";

const LANGS = ["it", "es", "hi", "fr", "de", "pt", "zh", "ja", "ar"];
const state = { langs: ["it", "es", "hi"], pages: [], deckPages: [], deckLang: "en", bytes: null, pdf: null };

const title = h("input", { type: "text", placeholder: "One engine, two rooms", maxlength: 120, autocomplete: "off" });
const speaker = h("input", { type: "text", placeholder: "Your name", maxlength: 80, autocomplete: "name" });
const notes = h("textarea", { placeholder: "Things you'll say that aren't on the slides: numbers, links, answers to likely questions." });
const file = h("input", { type: "file", accept: "application/pdf", hidden: true });

// Teleprompter script: pasted or read from a file, split into phrases on submit. Only the speaker sees it.
const script = h("textarea", { placeholder: "Paste what you plan to say. Eco shows it to you a few words at a time while you present." });
const scriptInfo = h("span.small.muted");
const scriptFile = h("input", { type: "file", accept: ".txt,.md,.pdf,.docx", hidden: true });
const scriptCount = () => {
  const n = splitScript(script.value).length;
  scriptInfo.textContent = n ? `${n} lines` : "";
};
script.oninput = scriptCount;
scriptFile.onchange = async () => {
  const f = scriptFile.files[0];
  scriptFile.value = "";
  if (!f) return;
  try {
    script.value = await scriptFileText(f);
    scriptCount();
  } catch (err) {
    toast(err.message.startsWith("Save") ? err.message : "Couldn't read that file");
  }
};
const scriptUpload = h("button.btn.sm", { type: "button", onclick: () => scriptFile.click() }, icon("doc"), "Upload script");
const thumbs = h("div.thumbs");
const deckInfo = h("p.small.muted");
const deckPreview = h("div");
const drop = h("div.drop", { role: "button", tabindex: 0 },
  icon("doc"), h("p", { style: { marginTop: "8px", fontWeight: 600, color: "var(--ink)" } }, "Drop your slides (PDF)"),
  h("p.small", {}, "Export from Keynote, PowerPoint or Google Slides. Eco keeps the PDF so the projector and any laptop you present from show your real slides."),
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
  deckPreview.replaceChildren();
  try {
    state.bytes = new Uint8Array(await f.arrayBuffer());
    const pdf = await openPdf(state.bytes);
    state.pdf = pdf;
    state.pages = await pdfPages(pdf);
    state.deckPages = await pdfDeckRows(pdf);
    state.deckLang = "en";
    const withText = state.pages.filter((p) => p.text).length;
    deckInfo.textContent = `${f.name} · ${pdf.numPages} slides · text found on ${withText}` + (withText < pdf.numPages / 2 ? ". Some slides are images; add what they say in Notes." : "");
    if (!title.value) title.value = state.pages[0]?.text.split("\n")[0].slice(0, 120) ?? "";
    for (let n = 1; n <= Math.min(pdf.numPages, 24); n++) {
      const slot = h("div");
      thumbs.append(slot);
      slot.append(await renderPage(pdf, n, 160));
    }
    deckPreview.replaceChildren(deckPreviewSetup(thumbs, state.pdf, state.deckPages, {
      getDeckLang: () => state.deckLang,
      onLang: (l) => { state.deckLang = l; },
      onChange: (pages) => { state.deckPages = pages; },
    }));
  } catch (err) {
    console.error(err);
    state.bytes = null;
    state.pages = [];
    state.deckPages = [];
    state.pdf = null;
    deckPreview.replaceChildren();
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
  h("div.option", { role: "radio", tabindex: 0, "aria-checked": String(checked), "aria-disabled": String(!!disabled) },
    h("span.radio"), h("div", {}, h("div", { style: { fontWeight: 600 } }, name), h("div.small.muted", {}, desc)));

// Voice: the account's saved voice (record once on /me), a sample for this talk, or the phone's voice.
const { user } = await me();
state.voice = user?.voice ? "saved" : "sample";
const voices = {
  saved: option("Your saved voice", user?.voice ? "The voice you recorded on your account page. Nothing to record for this talk."
    : h("span", {}, user ? "Record it once on " : "Sign in and record it once on ", h("a", { href: user ? "/me" : "/auth/google?next=/me" }, "your account page"), ", then every talk can use it."), state.voice === "saved", !user?.voice),
  sample: option("Record for this talk", "Record a 10-second sample from the presenter page (and each co-speaker from theirs). Listeners hear each speaker's cloned voice in their language.", state.voice === "sample"),
  phone: option("Phone voice", "No cloning: each phone reads the translation aloud, a different voice per speaker.", false),
};
for (const [v, el] of Object.entries(voices)) {
  const pick = () => {
    if (el.getAttribute("aria-disabled") === "true") return;
    state.voice = v;
    for (const [k, o] of Object.entries(voices)) o.setAttribute("aria-checked", String(k === v));
  };
  el.onclick = (e) => e.target.closest("a") || pick();
  el.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick());
}

const link = linkField("stage", title);
const section = (head, sub, ...body) =>
  h("section.form-section", {}, h("header", {}, h("h2", {}, head), h("p", {}, sub)), h("div.stack", {}, ...body));

const create = h("button.btn.primary.big", { type: "submit" }, "Create the room", icon("right"));
const form = h("form", {},
  section("Your talk", "Shown on every listener's phone.", h("label.field", {}, "Title", title), h("label.field", {}, "Speaker", speaker), link.el),
  section("Slides", "Eco answers questions only from these and from what you say. Answers cite the slide.", drop, file, deckInfo, thumbs, deckPreview),
  section("Notes", "Optional. Also used to answer questions.", notes),
  section("Script", "Optional. Only you see it, as a teleprompter above your slides. Word, PDF or text.", script, h("div.row", { style: { gap: "10px" } }, scriptUpload, scriptFile, scriptInfo)),
  section("Languages", "Up to 3. Listeners pick one when they scan. You speak English.", h("div.lang-grid", {}, langBtns)),
  section("Voice", "What listeners hear when they turn sound on.", h("div.stack", { role: "radiogroup", "aria-label": "Voice" }, ...Object.values(voices))),
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
      body: {
        mode: "stage", slug: link.value(), title: title.value, speaker: speaker.value, langs: state.langs,
        pages: state.pages, notes: notes.value, voice: state.voice, script: splitScript(script.value),
      },
    });
    if (state.bytes) {
      create.firstChild.textContent = "Storing slide rows…";
      await api(`/api/rooms/${id}/deckrows`, { method: "POST", key: hostKey, body: { deckLang: state.deckLang, pages: state.deckPages } });
      await saveDeck(id, state.bytes);
      create.firstChild.textContent = "Uploading slides…";
      if (!(await uploadDeck(id, state.bytes, hostKey))) toast("Slides didn't upload: this laptop will still show them", 4000);
    }
    try { localStorage.setItem(`eco:host:${id}`, hostKey); } catch {}
    ready(id, hostKey);
  } catch (err) {
    toast(err.message || "Couldn't create the room");
    create.disabled = false;
    create.firstChild.textContent = "Create the room";
  }
};

function ready(id, key) {
  const listen = `/${id}`;
  const presenter = `/${id}/speak#k=${key}`;
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
        h("a.btn.big", { href: `/${id}/screen`, target: "_blank" }, icon("ext"), "Open projector window"),
      ),
      h("div.row", { style: { justifyContent: "center", flexWrap: "wrap" } }, copy(fullUrl(listen), "Listener link"), copy(fullUrl(presenter), "Presenter link")),
      h("p.small.muted", { style: { marginTop: "24px" } }, "Keep the presenter link private: it controls the talk. Drag the projector window to the projector and press F for full screen."),
    ),
  );
}

document.body.replaceChildren(
  h("header.bar", {}, h("div.inner", {}, h("a.brand", { href: "/" }, "Eco"), h("span.title.muted", {}, "New talk"), h("span.spacer"), accountLink())),
  h("main.wrap", { style: { maxWidth: "900px" } },
    h("div.page-head", {}, h("p.eyebrow", {}, "Stage"), h("h1", {}, "Create a talk")),
    form,
  ),
);
