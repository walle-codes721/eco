// Call-history chart data (issue #67): pure, so test/call-chart-data.test.ts can check it. Rows are the Budget log:
// { t, kind, model, ms, status, tin, tout }. A call with status 200 succeeded; anything else failed.

export const RANGES = { "15m": 15 * 60_000, "1h": 60 * 60_000, today: Infinity };
export const MINUTE = 60_000;

const dayStart = (now) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); // same day as Budget.dayStart
};
export const rangeStart = (range, now) => (range === "today" ? dayStart(now) : now - RANGES[range]);

/** Models in the log, most calls first: the filter's options come from the data, not a hard-coded list. */
export function modelsIn(rows) {
  const n = new Map();
  for (const r of rows) n.set(r.model, (n.get(r.model) ?? 0) + 1);
  return [...n.keys()].sort((a, b) => n.get(b) - n.get(a) || a.localeCompare(b));
}

/** Rows in the range and, when `models` is given, from those models only. */
export const filterCalls = (rows, { since = 0, models = null } = {}) =>
  rows.filter((r) => r.t >= since && (!models || models.has(r.model)));

/** Calls per minute from `from` to `to`, by call time. The limiter counts a rolling 60 s window per lane
 *  (Budget.window, voiceWindow), so fixed buckets only approximate what it saw. */
export function perMinute(rows, from, to) {
  const start = Math.floor(from / MINUTE) * MINUTE;
  const buckets = Array.from({ length: Math.max(1, Math.ceil((to - start) / MINUTE)) }, (_, i) => ({ t: start + i * MINUTE, ok: 0, failed: 0 }));
  for (const r of rows) {
    const b = buckets[Math.floor((r.t - start) / MINUTE)];
    if (b) r.status === 200 ? b.ok++ : b.failed++;
  }
  return buckets;
}

export function summary(rows, from, to) {
  const ok = rows.filter((r) => r.status === 200).length;
  return { total: rows.length, ok, failed: rows.length - ok, peak: Math.max(0, ...perMinute(rows, from, to).map((b) => b.ok + b.failed)) };
}

// Mock mode makes no calls, so the chart shows a believable sample instead: the kinds a Stage makes, on the models
// the code picks for them (prompts.ts MODELS, tf.ts TEXT_FALLBACK / SLIDE_MODELS). Seeded by the room id: the
// same presentation draws the same sample on every refresh.
const MIX = [
  // [kind, model, weight, ms, tokens in, tokens out]
  ["utterance", "MiMo-V2.6-Flash", 34, 1400, 900, 180], // phrase audio in: the only audio model
  ["utterance", "DeepSeek-V4-Flash", 3, 1100, 700, 170], // text fallback while Gemma is off the catalog
  ["prep", "OmniVoice", 22, 5200, 0, 0], // script lines voiced before the talk
  ["voice", "OmniVoice", 6, 4800, 0, 0],
  ["script", "Gemma-4-31B-IT", 8, 9000, 1800, 1500],
  ["slide", "Gemma-4-31B-IT", 7, 6000, 1200, 500],
  ["slide", "MiMo-V2.6-Flash", 2, 5000, 1200, 480], // SLIDE_MODELS fallback
  ["ask", "Gemma-4-31B-IT", 10, 2600, 1500, 220],
  ["ask", "DeepSeek-V4-Flash", 2, 2000, 1500, 210],
  ["poll", "Gemma-4-31B-IT", 4, 2200, 400, 260],
  ["summary", "Gemma-4-31B-IT", 2, 7000, 3000, 250],
];
const FAILS = [429, 429, 599, 500, 400]; // mostly rate limits and timeouts; the odd bad request

function rng(seed) {
  let s = 2166136261;
  for (const c of String(seed)) s = Math.imul(s ^ c.charCodeAt(0), 16777619);
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) + 0x6d2b79f5), ((s >>> 0) % 1e6) / 1e6);
}

/** About 2 hours of sample calls ending at `now`: a prep burst, then a talk with phrases, questions and polls. */
export function mockCalls(seed, now) {
  const r = rng(seed);
  const total = MIX.reduce((s, m) => s + m[2], 0);
  const pick = () => {
    let x = r() * total;
    return MIX.find((m) => (x -= m[2]) < 0) ?? MIX[0];
  };
  const rows = [];
  for (let t = now - 2 * 60 * MINUTE; t < now; ) {
    const minute = (now - t) / MINUTE;
    const busy = minute > 100 ? 14 : minute < 40 ? 9 : 3; // prep burst at the start, the talk at the end
    t += (r() * 2 * MINUTE) / busy;
    if (t >= now) break;
    const [kind, model, , ms, tin, tout] = pick();
    const status = r() < 0.06 ? FAILS[Math.floor(r() * FAILS.length)] : 200;
    const spread = 0.6 + r() * 0.8;
    rows.push({
      t: Math.round(t), kind, model, status,
      ms: status === 599 ? 15000 : Math.round(ms * spread),
      tin: status === 200 ? Math.round(tin * spread) : 0,
      tout: status === 200 ? Math.round(tout * spread) : 0,
    });
  }
  return rows;
}
