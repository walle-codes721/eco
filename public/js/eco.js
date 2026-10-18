// Shared helpers for every page. No framework: small DOM builders, all text via textContent.
import { qrcode } from "/vendor/qrcode.mjs";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h("div.card", {onclick}, "text", child) — class shorthand after the tag. */
export function h(tag, props = {}, ...kids) {
  const [name, ...cls] = tag.split(".");
  const el = name === "svg" ? document.createElementNS("http://www.w3.org/2000/svg", "svg") : document.createElement(name || "div");
  if (cls.length) el.setAttribute("class", cls.join(" "));
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

const PATHS = {
  mic: "M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm6-3a6 6 0 0 1-12 0M12 18v3m-3 0h6",
  micoff: "M3 3l18 18M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3M18 12a6 6 0 0 1-.9 3.1M6 12a6 6 0 0 0 9.5 4.9M12 18v3m-3 0h6",
  up: "M12 19V5m-6 6 6-6 6 6",
  down: "M12 5v14m6-6-6 6-6-6",
  right: "M5 12h14m-6-6 6 6-6 6",
  left: "M19 12H5m6 6-6-6 6-6",
  next: "m9 6 6 6-6 6",
  prev: "m15 6-6 6 6 6",
  sound: "M11 5 6 9H3v6h3l5 4V5Zm4.5 3.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12",
  mute: "M11 5 6 9H3v6h3l5 4V5Zm5 4 5 5m0-5-5 5",
  copy: "M8 8h11v11H8zM5 16V5h11",
  check: "m5 12 5 5L20 7",
  x: "M6 6l12 12M18 6 6 18",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-9 9h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3Z",
  doc: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6m-6 4h6",
  photo: "M4 6h16v13H4zM4 15l4-4 4 4 3-3 5 5M15.5 9.5h.01",
  text: "M5 6h14M5 11h14M5 16h9",
  qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z",
  users: "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM21 19v-1a4 4 0 0 0-3-3.9M16 3.1a3.5 3.5 0 0 1 0 6.8",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v4l3 2",
  share: "M12 3v12m-4-8 4-4 4 4M5 13v6h14v-6",
  print: "M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z",
  split: "M4 12h16M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z",
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13",
  stage: "M3 4h18v12H3zM8 20h8M12 16v4",
  store: "M4 9l1.5-5h13L20 9M4 9h16M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0A2.7 2.7 0 0 0 20 9M5 11v9h14v-9M10 20v-5h4v5",
  spark: "M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5m7 7L18 18M6 18l2.5-2.5m7-7L18 6",
  ext: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  play: "M7 4v16l13-8z",
  flag: "M5 21V4h11l-1.5 4L16 12H5",
  expand: "M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6",
};
export function icon(name, cls = "i") {
  const svg = h("svg." + cls, { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.9", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", PATHS[name] ?? "");
  svg.append(p);
  return svg;
}

/** Room id "stage/{user}/{talk}" or "counter/{user}/{shop}" from the page URL. Links are `/${id}/...`. */
export const roomId = () => location.pathname.split("/").slice(1, 4).join("/");

/** Host key arrives once in the URL fragment (#k=...), then lives in localStorage. */
export function hostKey(id) {
  const m = location.hash.match(/k=([a-f0-9]+)/);
  try {
    if (m) {
      localStorage.setItem(`eco:host:${id}`, m[1]);
      history.replaceState(null, "", location.pathname + location.search);
    }
    return m?.[1] ?? localStorage.getItem(`eco:host:${id}`);
  } catch {
    return m?.[1] ?? null;
  }
}

export async function api(path, { method = "GET", body, key, headers = {} } = {}) {
  const isBlob = body instanceof Blob;
  const res = await fetch(path, {
    method,
    headers: { ...(key ? { "x-key": key } : {}), ...(body && !isBlob ? { "content-type": "application/json" } : {}), ...headers },
    body: body == null ? undefined : isBlob ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

let toastEl;
export function toast(msg, ms = 2400) {
  toastEl ??= document.body.appendChild(h("div.toast", { role: "status" }));
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove("show"), ms);
}

export function qrSvg(text) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  const svg = h("svg", { viewBox: `0 0 ${n} ${n}`, "shape-rendering": "crispEdges", role: "img", "aria-label": `QR code for ${text}` });
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d);
  p.setAttribute("fill", "#000");
  svg.append(p);
  return h("div.qr", {}, svg);
}

export const fullUrl = (path) => `${location.origin}${path}`;
export const shortUrl = (path) => `${location.host}${path}`;
export const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function langName(code, inLang = navigator.language) {
  try {
    const n = new Intl.DisplayNames([inLang], { type: "language" }).of(code);
    return n ? n[0].toLocaleUpperCase(inLang) + n.slice(1) : code;
  } catch {
    return code;
  }
}
export const phoneLang = () => (navigator.language || "en").slice(0, 2).toLowerCase();

/** The honest mode pill: Live (real Token Factory calls), Mock (canned) or Replay (recorded take). */
export function modePill(meta) {
  const [cls, label] = meta.demo && meta.mode === "stage" ? ["replay", "Replay"] : meta.live ? ["live", "Live"] : ["mock", "Mock"];
  return h(`span.pill.${cls}`, { title: cls === "mock" ? "Mock mode: sample responses, no API calls" : "" }, h("span.dot"), label);
}

export async function keepAwake() {
  try {
    let lock = await navigator.wakeLock?.request("screen");
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "visible") lock = await navigator.wakeLock?.request("screen");
    });
    return lock;
  } catch {}
}

export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) ?? "null");
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return null;
  }
}

export function notFound(msg = "This room doesn't exist or has expired.") {
  document.body.replaceChildren(
    h("main.narrow.center", { style: { paddingTop: "22vh" } },
      h("a.brand", { href: "/" }, "Eco"),
      h("h1", { style: { fontSize: "28px", margin: "24px 0 8px" } }, "Room not found"),
      h("p.muted", {}, msg),
      h("p", { style: { marginTop: "24px" } }, h("a.btn.primary", { href: "/" }, "Go to Eco")),
    ),
  );
}

/** The signed-in speaker or owner, or null. One fetch per page. */
let mePromise;
export const me = () => (mePromise ??= api("/api/me").catch(() => ({ user: null, signin: false })));

/** Header link: "Sign in" (back to this page after Google) or your name, linking to /me. */
export function accountLink() {
  const slot = h("span.account");
  me().then(({ user, signin }) => {
    if (user) slot.append(h("a.btn.ghost.sm", { href: "/me" }, user.picture ? h("img.avatar", { src: user.picture, alt: "", referrerpolicy: "no-referrer" }) : icon("users"), user.handle));
    else if (signin) slot.append(h("a.btn.ghost.sm", { href: `/auth/google?next=${encodeURIComponent(location.pathname)}` }, "Sign in"));
  });
  return slot;
}

export const slugify = (s) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36).replace(/-+$/, "");

/** "Link" field on the create pages: eco.linolabs.co/{kind}/{you}/[name], filled from the title until edited. */
export function linkField(kind, titleInput) {
  const slug = h("input", { type: "text", maxlength: 36, autocomplete: "off", spellcheck: "false", placeholder: kind === "stage" ? "my-talk" : "my-shop" });
  const prefix = h("span.mono.muted.small", {}, `${location.host}/${kind}/…/`);
  const note = h("p.tiny.muted");
  let edited = false;
  slug.oninput = () => ((edited = true), (slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, "-")));
  titleInput.addEventListener("input", () => edited || (slug.value = slugify(titleInput.value)));
  me().then(({ user, signin }) => {
    prefix.textContent = `${location.host}/${kind}/${user?.handle ?? "guest-…"}/`;
    note.replaceChildren(
      user ? `Saved to your account. Find it later in My ${kind === "stage" ? "talks" : "shops"}.`
      : signin ? h("span", {}, h("a", { href: `/auth/google?next=${encodeURIComponent(location.pathname)}` }, "Sign in with Google"), " to save it and find it later. Without signing in you get a private link that only works on this device.")
      : "Without signing in you get a private link that only works on this device.",
    );
  });
  const el = h("label.field", {}, "Link", h("div.row", { style: { gap: "4px", alignItems: "center", flexWrap: "wrap" } }, prefix, slug), note);
  return { el, value: () => slug.value || slugify(titleInput.value) };
}

/** Speaker name before a caption, only when the talk has more than one speaker. */
export function who(meta, line) {
  if ((meta.speakers?.length ?? 0) < 2) return null;
  return h("span.who", {}, meta.speakers.find((s) => s.id === (line.speaker ?? "s0"))?.name ?? "");
}

/** "Website link" row for a Counter's list: paste an address, Eco reads that page once, and the text lands in an editable box
 *  for the owner to check. onText(tag, text, note) adds it. Returns { el, open }: show the row with open(). */
export function websiteImport(onText) {
  const input = h("input", { type: "text", inputmode: "url", placeholder: "luna.it/menu", maxlength: 2000, autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "Website address" });
  const go = h("button.btn.primary", { type: "button" }, "Read page");
  const msg = h("p.tiny.muted", { role: "status" }, "Eco reads this page once, now. It never browses the web while answering customers.");
  const el = h("div.stack", { hidden: true, style: { gap: "8px" } },
    h("div.row", { style: { flexWrap: "nowrap", gap: "8px" } }, h("div", { style: { flex: 1, minWidth: 0 } }, input), go), msg);
  const run = async () => {
    const url = input.value.trim();
    if (!url) return (msg.textContent = "Paste a website address first.");
    go.disabled = input.disabled = true;
    msg.textContent = "Reading the page…";
    try {
      const r = await api("/api/fetch-url", { method: "POST", body: { url } });
      const n = r.parts.length;
      r.parts.forEach((text, i) => onText((n > 1 ? `website ${r.host} ${i + 1}/${n}` : `website ${r.host}`).slice(0, 40), text, r.truncated && i === n - 1 ? "The page was longer: only this much was read" : "Read from the website: check it"));
      msg.textContent = (n > 1 ? `Added below in ${n} parts. ` : "Added below. ") + "Read it, fix anything wrong and delete what you don't want customers to see (a page may repeat itself or show old prices). For allergens, write them yourself above.";
      input.value = "";
    } catch (err) {
      msg.textContent = err.data?.error || "Couldn't read that website. Paste the text, take a photo or upload a file instead.";
    }
    go.disabled = input.disabled = false;
  };
  go.onclick = run;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") (e.preventDefault(), run()); }); // not onkeydown: returning false from it would block typing
  return { el, open: () => { el.hidden = false; input.focus(); } };
}
