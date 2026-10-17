// Teleprompter script: split the speaker's text into short phrases, and read text out of a .docx.
// No imports, so vitest can load it directly.

/**
 * Phrases of about 5–10 words. A line break always ends a phrase (headings, paragraphs); inside a line,
 * cut at sentence ends first, then at , ; : — –, else hard at 8 words. Lines with no words ("---") are dropped.
 */
export function splitScript(text) {
  const seg = new Intl.Segmenter("en", { granularity: "sentence" });
  const n = (p) => p.split(" ").length;
  return String(text ?? "").split(/\n/).filter((l) => /[\p{L}\p{N}]/u.test(l)).flatMap((l) => {
    const out = [];
    for (const { segment } of seg.segment(l.replace(/\s+/g, " "))) {
      let words = segment.split(" ").filter(Boolean);
      while (words.length > 10) {
        let cut = 8;
        for (let i = 9; i >= 4; i--) if (/[,;:—–]$/.test(words[i])) { cut = i + 1; break; }
        out.push(words.slice(0, cut).join(" "));
        words = words.slice(cut);
      }
      if (words.length) out.push(words.join(" "));
    }
    // Join 1–2 word scraps ("Thanks.", "So,") to a neighbour on the same line, when that stays readable.
    return out.reduce((acc, p) => {
      const last = acc[acc.length - 1];
      if (last && (n(p) < 3 || n(last) < 3) && n(last) + n(p) <= 12) acc[acc.length - 1] = `${last} ${p}`;
      else acc.push(p);
      return acc;
    }, []);
  });
}

const CUE_LINE = /^[\s\-=#*_>\[(]*slide\s+(\d+)\s*(?:[:.\-–—\])]|$)/i; // "--- Slide 3: Title ---", "## Slide 3", "SLIDE 3"
const NEXT_LINE = /^\W*next slide\W*$/i;
const BRACKET = /\[([^\]]*)\]|\{([^}]*)\}|\((next slide|advance|click|slide\s+\d+)\)/gi;
const INLINE_CUE = /^(?:next slide|next|advance|click|slide\s+(\d+))$/i;

/**
 * The speaker's raw script as teleprompter lines: [{ text, slide, note }].
 * Slide cues set `slide` for the text after them; [bracketed] notes ride on the line before them,
 * "--- headings ---" on the line after.
 * With no cues every slide is null. Text before a first "Slide 1" cue is a preamble and is dropped.
 */
export function parseScript(text) {
  const events = [];
  for (let l of String(text ?? "").split(/\n/)) {
    const m = l.match(CUE_LINE);
    if (m) { events.push({ cue: +m[1] }); continue; }
    if (NEXT_LINE.test(l)) { events.push({ cue: "next" }); continue; }
    const head = l.match(/^\s*[-=*_]{2,}\s*(.*?)\s*[-=*_]{2,}\s*$/); // "--- Q&A (if asked) ---" heads the next line
    if (head) { if (head[1]) events.push({ heading: head[1] }); continue; }
    if (/^\s*#/.test(l)) continue;
    l = l.replace(/^\s*\(?\d{1,2}:\d{2}\)?\s*/, "");
    let at = 0;
    for (const b of l.matchAll(BRACKET)) {
      events.push({ text: l.slice(at, b.index) });
      const inner = (b[1] ?? b[2] ?? b[3]).trim();
      const c = inner.match(INLINE_CUE);
      if (c) events.push({ cue: c[1] ? +c[1] : "next" });
      else if (inner) events.push({ note: inner });
      at = b.index + b[0].length;
    }
    events.push({ text: l.slice(at) });
  }
  const first = events.findIndex((e) => "cue" in e);
  let slide = first < 0 ? null : 1;
  let cues = 0, notes = 0, sectionStart = 0, pending = "";
  const lines = [];
  for (const e of events.slice(first >= 0 && events[first].cue === 1 ? first : 0)) {
    if ("cue" in e) {
      slide = e.cue === "next" ? slide + 1 : e.cue;
      cues++;
      sectionStart = lines.length;
    } else if ("heading" in e) {
      pending = pending ? `${pending} · ${e.heading}` : e.heading;
    } else if ("note" in e) {
      notes++;
      const prev = lines.length > sectionStart ? lines[lines.length - 1] : null;
      if (prev) prev.note = prev.note ? `${prev.note} · ${e.note}` : e.note;
      else pending = pending ? `${pending} · ${e.note}` : e.note;
    } else {
      for (const t of splitScript(e.text)) {
        lines.push({ text: t, slide, note: pending });
        pending = "";
      }
    }
  }
  return { lines, cues, notes };
}

/** Lowercase words without punctuation or accents: what the script and speech recognition can agree on. */
export const words = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * HACKATHON mode: follows the speaker word by word through the teleprompter `lines` and says which line they just started.
 * heard(text, run) takes speech recognition's running text and returns the lines to fire, in order.
 * Each heard word moves the place in the script: to the next match at most NEAR script words ahead (dropped or misheard
 * words in between), or up to FAR ahead when the two words before it match too (the speaker skipped ahead).
 * A line fires once two of its words were heard (one for one-word lines), so a stray "the" or "so" doesn't fire it.
 * ponytail: words only, so a spoken "35" never meets a written "thirty-five" (the next words catch up); the ↓ key fires by hand.
 */
export function cueFollower(lines, from = -1) {
  const NEAR = 2, FAR = 400;
  const script = [], lineOf = [], start = [], size = [];
  lines.forEach((l, i) => {
    const w = words(l.text);
    start.push(script.length);
    size.push(w.length);
    for (const x of w) script.push(x), lineOf.push(i);
  });
  let pos = start[from + 1] ?? script.length; // the next script word expected
  let used = 0, seen = 0, run = null, last = ["", ""], hits = 0, hitLine = -1;
  const step = (w) => {
    let c = -1, far = false;
    for (let k = pos; k < Math.min(script.length, pos + FAR); k++) {
      if (script[k] !== w) continue;
      if (k - pos <= NEAR) { c = k; break; }
      if (script[k - 1] === last[1] && script[k - 2] === last[0]) { c = k; far = true; break; }
    }
    last = [last[1], w];
    if (c < 0) return [];
    pos = c + 1;
    const i = lineOf[c];
    // A jump is backed by three words in a row. A line is entered at its first or second word, not mid-line ("is a").
    hits = i === hitLine ? hits + (far ? 3 : 1) : far ? 3 : c - start[i] <= 1 ? 1 : 0;
    hitLine = i;
    const reached = hits >= Math.min(2, size[i]) ? i : i - 1;
    if (reached <= from) return [];
    // A small step crossed a line the recogniser missed: it was said, so play it. A jump plays only where it landed.
    const fire = far ? [reached] : Array.from({ length: reached - from }, (_, j) => from + 1 + j);
    from = reached;
    return fire;
  };
  return {
    get from() { return from; },
    heard(text, nextRun) {
      if (nextRun !== run) (run = nextRun), (used = 0); // recognition restarted: its text starts from empty
      const w = words(text);
      seen = w.length;
      const fire = [];
      for (let k = Math.min(used, w.length); k < w.length; k++) fire.push(...step(w[k]));
      used = w.length;
      return fire;
    },
    /** The speaker fired line i by hand (↓): expect its words next, without firing it again. */
    fired(i) { from = i; pos = start[i] ?? pos; hitLine = -1; },
    /** The teleprompter moved by hand: wait for line n, ignoring what was heard before. */
    reset(n) { from = n - 1; pos = start[n] ?? script.length; used = seen; hitLine = -1; },
  };
}

/** "112 lines · 9 slide cues · 1 note", plus a warning when cues run past the deck. */
export function scriptSummary(text, deckCount) {
  const { lines, cues, notes } = parseScript(text);
  if (!lines.length) return "";
  const last = Math.max(0, ...lines.map((l) => l.slide ?? 0));
  return [
    `${lines.length} lines`,
    cues && `${cues} slide cue${cues > 1 ? "s" : ""}`,
    notes && `${notes} note${notes > 1 ? "s" : ""}`,
    deckCount && last > deckCount && `cues go to slide ${last}, deck has ${deckCount}`,
  ].filter(Boolean).join(" · ");
}

/** Plain text of a .docx: finds word/document.xml in the zip, inflates it natively, one line per paragraph. */
export async function docxText(buf) {
  const b = new Uint8Array(buf);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = b.length - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("Not a .docx file");
  for (let p = v.getUint32(e + 16, true), left = v.getUint16(e + 10, true); left--; ) {
    const nameLen = v.getUint16(p + 28, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    if (name === "word/document.xml") {
      const local = v.getUint32(p + 42, true);
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      let data = b.subarray(start, start + v.getUint32(p + 20, true));
      if (v.getUint16(p + 10, true) === 8) {
        data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      }
      const ent = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      return new TextDecoder().decode(data).split("</w:p>")
        .map((para) => [...para.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(""))
        .map((t) => t.replace(/&(amp|lt|gt|quot|apos);/g, (_, k) => ent[k]))
        .filter((t) => t.trim())
        .join("\n");
    }
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  throw new Error("No text found in that .docx");
}
