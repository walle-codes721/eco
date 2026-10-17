import { h, icon, api, accountLink, linkField, qrSvg, fullUrl, shortUrl, toast, langName, phoneLang } from "/js/eco.js";
import { openPdf, pdfPages } from "/js/slides.js";

const HOURS = ["hours", "Opening hours", "Every day 12:00–23:00. Closed Mondays in November."];
const PAY = ["payment", "Payment", "Cash, cards, Apple Pay and Google Pay."];
const HEALTH_LANGS = ["languages", "Languages spoken", "Italian, English and Hindi at the front desk."];
const HEALTH_WHERE = ["where", "Where to find us", "Via Roma 12, ground floor. Bus 14 stops outside. Step-free entrance."];
const TYPES = {
  restaurant: { label: "Restaurant or café", icon: "store", fields: [HOURS, PAY, ["dietary", "Allergens & dietary", "Gluten-free cones on request. Nuts are used in our kitchen."], ["takeaway", "Takeaway & delivery", "Takeaway boxes 500 g €12, 1 kg €22."]] },
  shop: { label: "Shop", icon: "store", fields: [HOURS, PAY, ["returns", "Returns & exchanges", "Exchanges within 14 days with the receipt."], ["taxfree", "Tax-free shopping", "Tax-free for non-EU residents on purchases over €70."], ["shipping", "Shipping", "We ship within the EU, 3–5 days."]] },
  service: { label: "Service", sub: "salon, massage, studio…", icon: "spark", fields: [HOURS, PAY, ["services", "Services & prices", "Haircut 30 min €25. Colour 90 min from €60."], ["booking", "Booking & cancellation", "Walk-ins welcome. Please cancel 24 hours ahead."]] },
  other: { label: "Other", icon: "globe", fields: [HOURS, PAY, ["about", "About us", "What you do, in a few lines."]] },
  // Front desk only: Eco shares what the owner writes and never gives medical advice (see src/health.ts).
  pharmacy: { label: "Pharmacy", icon: "store", health: true, fields: [
    ["hours", "Opening hours", "Every day 8:00–20:00. Night service: see the sign on the door."], ["payment", "Payment & insurance", "Cash and cards. Health card accepted."],
    ["services", "Services & prices", "Blood pressure check €5. Flu vaccination €20."], ["products", "Products & prices", "Bandages €2. Sun cream from €9."],
    ["prescriptions", "Prescriptions", "Bring your prescription and an ID."], HEALTH_LANGS, HEALTH_WHERE] },
  clinic: { label: "Clinic", sub: "doctor's office", icon: "store", health: true, fields: [
    ["hours", "Opening hours", "Mon–Fri 9:00–18:00."], ["payment", "Payment & insurance", "Private fees. Most travel insurance accepted."],
    ["services", "Services & prices", "General visit €60. Vaccinations from €25."], ["booking", "Booking", "By appointment, or walk-in 9:00–11:00."],
    ["bring", "What to bring", "ID, insurance card and any earlier reports."], HEALTH_LANGS, HEALTH_WHERE] },
  hospital: { label: "Hospital", sub: "front desk only", icon: "store", health: true, fields: [
    ["visiting", "Visiting hours", "Every day 15:00–19:00."], ["emergency", "Emergency department", "Entrance B, open 24 hours."],
    ["departments", "Departments & how to find them", "Radiology: floor 1, follow the blue line. Cafeteria: ground floor."],
    ["payment", "Payment & insurance", "Cards and cash at the cashier on the ground floor."], ["bring", "What to bring", "ID, insurance card and your referral letter."],
    HEALTH_LANGS, HEALTH_WHERE] },
};
const OWNER_LANGS = ["it", "en", "es", "fr", "de", "pt", "zh", "ar", "hi"];

let type = "restaurant";
const name = h("input", { type: "text", placeholder: "Gelateria Luna", maxlength: 120, autocomplete: "organization" });
const ownerLang = h("select", {}, ...OWNER_LANGS.map((l) => h("option", { value: l, selected: l === (OWNER_LANGS.includes(phoneLang()) ? phoneLang() : "it") }, langName(l, l))));
const fieldsEl = h("div.stack");
const healthEl = h("div.stack"); // only for pharmacy, clinic and hospital
const emergency = h("input", { type: "text", inputmode: "tel", placeholder: "112", maxlength: 16, autocomplete: "off" }); // text so it matches the other fields; inputmode opens the number pad on phones
const healthOk = h("input", { type: "checkbox" });
const fieldInputs = new Map();
const sourcesEl = h("div.stack");
const sources = []; // { tag, textarea, el }

const seg = h("div.seg", { role: "group", "aria-label": "Type of business" });
for (const [k, v] of Object.entries(TYPES)) {
  const b = h("button", { type: "button", "aria-pressed": String(k === type) }, v.label);
  b.onclick = () => {
    type = k;
    for (const x of seg.children) x.setAttribute("aria-pressed", String(x === b));
    drawFields();
  };
  seg.append(b);
}

function drawFields() {
  const keep = new Map([...fieldInputs].map(([k, el]) => [k, el.value]));
  fieldInputs.clear();
  fieldsEl.replaceChildren(...TYPES[type].fields.map(([tag, label, ph]) => {
    const ta = h("textarea", { placeholder: ph, rows: 2, style: { minHeight: "64px" } });
    ta.value = keep.get(tag) ?? "";
    fieldInputs.set(tag, ta);
    return h("label.field", {}, label, ta);
  }));
  healthEl.replaceChildren(...(TYPES[type].health ? [
    h("div.banner", {}, icon("flag"), h("div", {}, h("b", {}, "Front desk only. "),
      "Eco shares only what you write here. It never gives medical advice. If a customer describes an emergency or asks about doses or symptoms, Eco shows a fixed message, tells you, and asks them to speak to staff. Customers are asked not to type personal health details.")),
    h("label.field", {}, "Local emergency number", h("span.hint", {}, "Shown to customers in an emergency. 112 works across the EU and in India; leave it empty to use 112."), emergency),
    h("label.check", {}, healthOk, h("span", {}, "I understand that Eco gives front-desk information only. It is not for emergencies and never gives medical advice.")),
  ] : []));
}
drawFields();

function addSource(tag, text = "", note = "") {
  const tagIn = h("input", { type: "text", value: tag, maxlength: 40, style: { minHeight: "36px", padding: "6px 10px", fontWeight: 600, width: "auto", flex: 1 } });
  const ta = h("textarea", { placeholder: "Items, prices, ingredients, policies… one per line." });
  ta.value = text;
  const noteEl = h("span.tiny.muted", {}, note);
  const s = { tagIn, ta, noteEl };
  const el = h("div.source", {},
    h("div.row", {}, tagIn, noteEl, h("button.btn.ghost.icon-btn", { type: "button", "aria-label": "Remove", onclick: () => (el.remove(), sources.splice(sources.indexOf(s), 1)) }, icon("trash"))),
    ta);
  s.el = el;
  sources.push(s);
  sourcesEl.append(el);
  return s;
}

const fileIn = h("input", { type: "file", accept: ".pdf,.txt,.csv,.md,text/plain,text/csv,application/pdf", multiple: true, hidden: true });
const photoIn = h("input", { type: "file", accept: "image/*", capture: "environment", multiple: true, hidden: true });
fileIn.onchange = async () => {
  for (const f of fileIn.files) {
    const tag = f.name.replace(/\.[^.]+$/, "").slice(0, 40);
    try {
      if (/\.pdf$/i.test(f.name)) {
        const pages = await pdfPages(await openPdf(new Uint8Array(await f.arrayBuffer())));
        addSource(tag, pages.map((p) => p.text).join("\n\n"), "from PDF");
      } else addSource(tag, (await f.text()).slice(0, 20000), "from file");
    } catch {
      toast(`Couldn't read ${f.name}`);
    }
  }
  fileIn.value = "";
};
photoIn.onchange = async () => {
  for (const f of photoIn.files) {
    const s = addSource("menu", "", "Eco is reading the photo…");
    s.ta.disabled = true;
    try {
      const image = await shrink(f);
      const r = await api("/api/extract", { method: "POST", body: { image } });
      s.ta.value = r.text;
      s.noteEl.textContent = r.live ? "Read by Eco: check it" : "Sample (mock mode)";
    } catch (err) {
      s.noteEl.textContent = err.status === 503 ? "Eco is busy: type it instead" : "Couldn't read it: type it instead";
    }
    s.ta.disabled = false;
  }
  photoIn.value = "";
};

async function shrink(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = h("canvas", { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.82);
}

const consent = h("input", { type: "checkbox" });
const link = linkField("counter", name);
const section = (head, sub, ...body) => h("section.form-section", {}, h("header", {}, h("h2", {}, head), h("p", {}, sub)), h("div.stack", {}, ...body));
const create = h("button.btn.primary.big", { type: "submit" }, "Create my counter", icon("right"));

const form = h("form", {},
  section("Your business", "Customers see this name when they scan.", h("label.field", {}, "Name", name), link.el, h("div.field", {}, h("span", { style: { fontSize: "14px", fontWeight: 600 } }, "Type"), seg)),
  section("The basics", "All optional. Eco answers customers from what you write here.", fieldsEl, healthEl),
  section("More info", "Add as many as you need: a menu, a price list, services, policies.",
    h("div.row", { style: { flexWrap: "wrap" } },
      h("button.btn", { type: "button", onclick: () => addSource("info").ta.focus() }, icon("text"), "Type or paste"),
      h("button.btn", { type: "button", onclick: () => photoIn.click() }, icon("photo"), "Photo of a menu"),
      h("button.btn", { type: "button", onclick: () => fileIn.click() }, icon("doc"), "Upload a file"),
    ),
    h("p.tiny.muted", {}, "Files: PDF, TXT, CSV. A Word file? Save it as PDF first. Photos are read once by Eco; check the text before you save."),
    fileIn, photoIn, sourcesEl,
  ),
  section("Your language", "What you read and speak at the counter.", ownerLang),
  h("div.banner.red", { style: { margin: "8px 0 16px" } }, icon("flag"),
    h("div", {}, h("b", {}, "Everything you add here can be shown to customers. "), "Don't add internal or private documents: staff details, costs, suppliers, or anyone's personal data.")),
  h("label.check", {}, consent, h("span", {}, "I understand that customers can ask about anything I add.")),
  h("div.row", { style: { padding: "28px 0 80px", justifyContent: "flex-end" } }, create),
);

form.onsubmit = async (e) => {
  e.preventDefault();
  if (!name.value.trim()) return (name.focus(), toast("Add your business name"));
  if (!consent.checked) return toast("Please confirm the box above");
  if (TYPES[type].health && !healthOk.checked) return (healthOk.focus(), toast("Please confirm the front-desk note"));
  const label = Object.fromEntries(TYPES[type].fields.map(([tag, l]) => [tag, l]));
  const pages = [
    ...[...fieldInputs].filter(([, el]) => el.value.trim()).map(([tag, el]) => ({ tag, text: `${label[tag]}\n${el.value.trim()}` })),
    ...sources.filter((s) => s.ta.value.trim()).map((s) => ({ tag: s.tagIn.value.trim() || "info", text: s.ta.value.trim() })),
  ];
  if (!pages.length && !confirm("You haven't added any info, so Eco can only translate, not answer. Continue?")) return;
  create.disabled = true;
  try {
    const { id, hostKey } = await api("/api/rooms", { method: "POST", body: { mode: "counter", slug: link.value(), title: name.value, bizType: type, ownerLang: ownerLang.value, pages, ...(TYPES[type].health ? { emergency: emergency.value.trim() } : {}) } });
    try { localStorage.setItem(`eco:host:${id}`, hostKey); } catch {}
    ready(id, hostKey);
  } catch (err) {
    toast(err.message || "Couldn't create it");
    create.disabled = false;
  }
};

function ready(id, key) {
  const owner = `/${id}/owner#k=${key}`;
  document.querySelector("main").replaceChildren(h("section.ready.narrow", {},
    h("span.pill.ok", {}, h("span.dot"), "Counter ready"),
    h("h1", { style: { fontSize: "clamp(32px,5vw,48px)", margin: "18px 0 8px", letterSpacing: "-0.04em" } }, name.value),
    h("p.muted", {}, "Print the sticker and put it on the counter. Customers scan it with their phone camera."),
    h("div", { style: { margin: "28px 0 12px" } }, qrSvg(fullUrl(`/${id}`))),
    h("p.url", { style: { fontSize: "20px" } }, shortUrl(`/${id}`)),
    h("div.row", { style: { justifyContent: "center", flexWrap: "wrap", margin: "32px 0 12px" } },
      h("a.btn.primary.big", { href: owner }, icon("store"), "Open my counter"),
      h("a.btn.big", { href: `/${id}/sticker`, target: "_blank" }, icon("print"), "Print sticker"),
    ),
    h("button.btn", { type: "button", onclick: () => navigator.clipboard.writeText(fullUrl(owner)).then(() => toast("Counter link copied")) }, icon("copy"), "Copy counter link"),
    h("p.small.muted", { style: { marginTop: "24px" } }, "Open the counter link on the iPad by the till, then use Share → Add to Home Screen. Keep the link private: it's the owner's view."),
  ));
}

document.body.replaceChildren(
  h("header.bar", {}, h("div.inner", {}, h("a.brand", { href: "/" }, "Eco"), h("span.title.muted", {}, "New counter"), h("span.spacer"), accountLink())),
  h("main.wrap", { style: { maxWidth: "900px" } },
    h("div.page-head", {}, h("p.eyebrow", {}, "Counter"), h("h1", {}, "Set up your business")),
    form,
  ),
);
