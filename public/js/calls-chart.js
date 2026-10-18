// The presenter's calls chip opens this (issue #67): Token Factory calls today, from the local log. Makes no API call.
import { h, icon, api } from "/js/eco.js";
import { rangeStart, modelsIn, filterCalls, perMinute, summary, mockCalls } from "/js/call-chart-data.js";

const VIEWS = { all: "Calls over time", ok: "Succeeded", failed: "Failed", rpm: "Requests per minute" };
const RANGE_NAMES = { "15m": "15 min", "1h": "1 hour", today: "Today" };
// src/limits.ts: ACCOUNT_RPM, RPM, VOICE_RPM
const LIMITS = [[20, "20/min account"], [12, "12 text"], [6, "6 voice"]];
const W = 640, L = 132, R = 12;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const tip = (r) => `${new Date(r.t).toLocaleTimeString()} · ${r.kind} · ${r.model}\n${r.status === 200 ? "OK" : `Failed ${r.status}`} · ${(r.ms / 1000).toFixed(1)} s · ${r.tin} in / ${r.tout} out tokens`;

function axis(from, to, y) {
  const x = (t) => L + ((t - from) / (to - from)) * (W - L - R);
  return [from, (from + to) / 2, to].map((t, i) => `<text x="${x(t)}" y="${y}" class="cc-label" text-anchor="${["start", "middle", "end"][i]}">${hhmm(t)}</text>`).join("");
}

/** One lane per model: a dot for each call that worked, a cross for each that failed. */
function timeline(rows, models, from, to) {
  const lane = 26, H = models.length * lane + 24;
  const x = (t) => L + ((t - from) / (to - from)) * (W - L - R);
  const marks = rows.map((r) => {
    const cx = x(r.t).toFixed(1), cy = models.indexOf(r.model) * lane + lane / 2;
    return r.status === 200
      ? `<circle cx="${cx}" cy="${cy}" r="3.5" class="cc-ok"><title>${esc(tip(r))}</title></circle>`
      : `<path d="M${cx - 4} ${cy - 4}l8 8m0-8l-8 8" class="cc-fail"><title>${esc(tip(r))}</title></path>`;
  });
  const lanes = models.map((m, i) => `<line x1="${L}" x2="${W - R}" y1="${i * lane + lane / 2}" y2="${i * lane + lane / 2}" class="cc-grid"/><text x="0" y="${i * lane + lane / 2 + 4}" class="cc-label">${esc(m)}</text>`);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Calls over time, by model">${lanes.join("")}${marks.join("")}${axis(from, to, H - 4)}</svg>`;
}

/** Calls per minute, stacked worked/failed, against the Token Factory and Eco limits. */
function rpmChart(buckets, from, to) {
  const H = 150, top = 8, bottom = H - 22;
  const max = Math.max(22, ...buckets.map((b) => b.ok + b.failed + 2));
  const y = (n) => bottom - (n / max) * (bottom - top);
  const bw = (W - L - R) / buckets.length;
  const bars = buckets.map((b, i) => {
    if (!b.ok && !b.failed) return "";
    const bx = (L + i * bw).toFixed(1), w = Math.max(1, bw - 1).toFixed(1);
    return `<g><title>${esc(`${hhmm(b.t)} · ${b.ok + b.failed} calls (${b.failed} failed)`)}</title>` +
      `<rect x="${bx}" y="${y(b.ok)}" width="${w}" height="${bottom - y(b.ok)}" class="cc-ok"/>` +
      (b.failed ? `<rect x="${bx}" y="${y(b.ok + b.failed)}" width="${w}" height="${y(b.ok) - y(b.ok + b.failed)}" class="cc-fail-bar"/>` : "") + "</g>";
  });
  const refs = LIMITS.map(([n, name]) => `<line x1="${L}" x2="${W - R}" y1="${y(n)}" y2="${y(n)}" class="cc-limit"/><text x="0" y="${y(n) + 4}" class="cc-label">${name}</text>`);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Requests per minute">${refs.join("")}${bars.join("")}${axis(from, to, H - 4)}</svg>`;
}

export function openCallsChart({ id, key, chip }) {
  let range = "1h", data = null;
  const views = new Set(["all", "rpm"]);
  const off = new Set(); // models switched off; new models show up on
  const body = h("div.stack", { style: { gap: "14px" } });
  const close = () => (clearInterval(timer), wrap.remove(), chip.focus());

  const toggles = (names, on, flip) => h("div.lang-grid", {}, ...Object.entries(names).map(([k, name]) =>
    h("button.toggle", { type: "button", "aria-pressed": String(on(k)), onclick: () => (flip(k), draw()) }, name)));

  function draw() {
    if (!data) return body.replaceChildren(h("p.muted", {}, "Loading…"));
    const now = Date.now(), from = rangeStart(range, now);
    const inRange = filterCalls(data.rows, { since: from });
    const all = modelsIn(inRange);
    const models = new Set(all.filter((m) => !off.has(m)));
    const rows = filterCalls(inRange, { models });
    const shown = views.has("all") ? rows : rows.filter((r) => (r.status === 200 ? views.has("ok") : views.has("failed")));
    const s = summary(rows, from, now);
    const chart = h("div.cc-chart");
    chart.innerHTML = [
      views.has("all") || views.has("ok") || views.has("failed") ? timeline(shown, all.filter((m) => models.has(m)), from, now) : "",
      views.has("rpm") ? rpmChart(perMinute(rows, from, now), from, now) : "",
    ].join("");
    body.replaceChildren(
      data.live ? null : h("p.small.muted", {}, "Mock mode: sample calls for this presentation. No API calls were made."),
      toggles(RANGE_NAMES, (k) => k === range, (k) => (range = k)),
      toggles(VIEWS, (k) => views.has(k), (k) => (views.has(k) ? views.delete(k) : views.add(k))),
      all.length ? toggles(Object.fromEntries(all.map((m) => [m, m])), (m) => !off.has(m), (m) => (off.has(m) ? off.delete(m) : off.add(m))) : null,
      h("div.cc-summary", {},
        ...[["Calls", s.total], ["Succeeded", s.ok], ["Failed", s.failed], ["Peak / min", s.peak]].map(([k, v]) => h("div", {}, h("span.stat", {}, String(v)), h("span.tiny.muted", {}, k)))),
      rows.length ? chart : h("p.empty", {}, inRange.length ? "No calls from these models." : "No calls in this range."),
      h("p.tiny.muted", {}, "● worked  ✕ failed. Per-minute counts are by call time; the limiter uses a rolling 60 s window, so this is close, not exact. A Gemma call that falls back to another model isn't logged."),
      rows.length ? h("details", {}, h("summary.small", {}, "Table"), h("table.cc-table", {},
        h("thead", {}, h("tr", {}, ...["Time", "Kind", "Model", "Status", "Latency", "Tokens in/out"].map((c) => h("th", {}, c)))),
        h("tbody", {}, ...rows.slice(-100).reverse().map((r) => h("tr", {},
          h("td", {}, new Date(r.t).toLocaleTimeString()), h("td", {}, r.kind), h("td", {}, r.model),
          h("td", {}, r.status === 200 ? "OK" : `✕ ${r.status}`), h("td", {}, `${(r.ms / 1000).toFixed(1)} s`), h("td", {}, `${r.tin}/${r.tout}`)))))) : null,
    );
  }

  async function load() {
    const r = await api(`/api/rooms/${id}/calls`, { key }).catch(() => null);
    if (!r) return data || body.replaceChildren(h("p.empty", {}, "Couldn't load the call log."));
    data = r.live ? r : { live: false, rows: mockCalls(id, Date.now()) };
    draw();
  }

  const wrap = h("div.sheet-wrap", { onclick: (e) => e.target === wrap && close() },
    h("div.sheet.stack", { role: "dialog", "aria-modal": "true", "aria-labelledby": "cc-title", style: { gap: "14px", maxWidth: "720px", width: "100%", maxHeight: "92vh", overflowY: "auto" } },
      h("div.row", {}, h("h2", { id: "cc-title" }, "API calls"), h("span.spacer"), h("button.btn.icon-btn", { type: "button", "aria-label": "Close", onclick: close }, icon("x"))),
      body));
  // Esc closes; Tab stays inside the dialog. Keys stop here: Space and the arrows mean mic and slides on the console.
  wrap.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") return close();
    if (e.key !== "Tab") return;
    const f = [...wrap.querySelectorAll("button, summary, [tabindex]")].filter((el) => !el.disabled);
    const [first, last] = [f[0], f[f.length - 1]];
    if (e.shiftKey ? document.activeElement === first : document.activeElement === last) (e.preventDefault(), (e.shiftKey ? last : first).focus());
  });
  const timer = setInterval(load, 15000); // the chip's cadence, only while open
  document.body.append(wrap);
  wrap.querySelector("button").focus();
  draw();
  load();
}
