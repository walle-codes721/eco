// Local retrieval: no embeddings endpoint exists, and this costs zero tokens (see CONTRIBUTING.md, token rule 5).

export interface Chunk {
  tag: string; // "slide 6", "menu", "hours"... shown to users as the citation
  title: string; // first line, used as the board topic
  text: string;
  translations?: Record<string, string>; // aligned caption lines, used locally for search only
}

const STOP = new Set(
  (
    "the a an and or of to in on for is are was were be it this that with as at by from what how why who " +
    "do does did can you your i we our me my not no yes about which when where there their they them " +
    "il lo la i gli le un una di da in con su per tra fra che e è sono come cosa quanto dove quando del della dei " +
    "el los las unos unas de en con por para que es son como qué cuánto dónde cuándo del al " +
    "have has can could would like there here much many please thanks get want need " +
    "posso possiamo potete avete abbiamo fate vorrei vorremmo grazie portare prendere avere essere fare c'è ci si ne mi ti " +
    "puedo tienen hay quiero gracias le les se " +
    "est sont avez pouvez je vous nous merci das der die ist sind haben kann ich sie wir danke"
  ).split(" "),
);

export function terms(s: string): string[] {
  // Marks belong to their letters: splitting them breaks Hindi words such as देशों.
  return (s.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

export function normalize(q: string): string {
  return terms(q).join(" ");
}

/** Answer identity must preserve negation, Hindi vowel marks and other meaningful words. */
export function questionKey(q: string, lang: string): string {
  return JSON.stringify(["qa-v2", lang, q.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim()]);
}

export const tokensOf = (s: string) => Math.ceil(s.length / 4);

/** Fingerprint exactly the ordered source tags/text sent to the model, without storing copies in every cache entry. */
export async function contextFingerprint(chunks: Chunk[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(chunks.map(({ tag, text }) => [tag, text])));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Split pages into ~300-word chunks, keeping each page's tag. */
export function chunkPages(pages: { tag: string; text: string }[], words = 300): Chunk[] {
  const out: Chunk[] = [];
  for (const p of pages) {
    const clean = p.text.replace(/\s+\n/g, "\n").trim();
    if (!clean) continue;
    const title = clean.split("\n").find((l) => l.trim())!.trim().slice(0, 80);
    const w = clean.match(/\S+\s*/g) ?? []; // keep line breaks: they separate menu items and slide lines
    for (let i = 0; i < w.length; i += words) out.push({ tag: p.tag, title, text: w.slice(i, i + words).join("").trim() });
  }
  return out;
}

/** Keep each phrase aligned with its existing translations; never generate new ones for retrieval. */
export function transcriptChunks(lines: { at: number; slide: number; src: string; out?: Record<string, string> }[]): Chunk[] {
  const chunks: Chunk[] = [];
  let buf: typeof lines = [];
  let words = 0;
  const flush = () => {
    if (!buf.length) return;
    const at = buf[0].at;
    const langs = [...new Set(buf.flatMap((l) => Object.entries(l.out ?? {})
      .filter(([, text]) => typeof text === "string" && text.trim()).map(([lang]) => lang)))];
    chunks.push({
      tag: `said at ${Math.floor(at / 60)}:${String(at % 60).padStart(2, "0")}`,
      title: `Slide ${buf[0].slide}`,
      text: buf.map((l) => l.src.replace(/\s+/g, " ").trim()).join("\n"),
      translations: Object.fromEntries(langs.map((lang) => [lang,
        buf.map((l) => {
          const translated = l.out?.[lang];
          return (typeof translated === "string" && translated.trim() ? translated : l.src).replace(/\s+/g, " ").trim();
        }).join("\n"),
      ])),
    });
    buf = [];
    words = 0;
  };
  for (const line of lines) {
    if (!line.src.trim()) continue;
    if (buf.length && (buf[0].slide !== line.slide || words + line.src.split(/\s+/).length > 150)) flush();
    buf.push(line);
    words += line.src.split(/\s+/).length;
  }
  flush();
  return chunks;
}

/** The list page that holds what the owner taught Eco. Customers see it as the citation. */
export const TAUGHT_TAG = "answers";
const TAUGHT_MAX = 8000; // one page, same ceiling as the rest of the list

/**
 * Teach Eco: add one owner-approved answer to the list's "answers" page.
 * `q` is the question in the owner's language, `asked` the customer's own words (helps keyword search in their language).
 * Never changes `pages`. Says why when nothing was added.
 */
export function teach(
  pages: { tag: string; text: string }[],
  e: { q: string; asked?: string; a: string },
): { pages: { tag: string; text: string }[]; added: boolean; reason?: "empty" | "duplicate" | "full" } {
  // One line per field, so a customer's words can never start a second entry or fake a "Q:" line.
  const one = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const q = one(e.q, 200);
  const a = one(e.a, 500);
  const asked = one(e.asked, 200);
  if (!q || !a) return { pages, added: false, reason: "empty" };

  const entry = `Q: ${q}\n${asked && asked.toLowerCase() !== q.toLowerCase() ? `Asked as: ${asked}\n` : ""}A: ${a}`;
  const old = pages.find((p) => p.tag === TAUGHT_TAG)?.text ?? "";
  const key = (s: string) => s.toLowerCase();
  const same = old.split("\n\n").some((b) => key(b.match(/^Q: (.*)$/m)?.[1] ?? "") === key(q) && key(b.match(/^A: (.*)$/m)?.[1] ?? "") === key(a));
  if (same) return { pages, added: false, reason: "duplicate" };

  const text = old ? `${old}\n\n${entry}` : entry;
  if (text.length > TAUGHT_MAX) return { pages, added: false, reason: "full" };
  const next = old ? pages.map((p) => (p.tag === TAUGHT_TAG ? { ...p, text } : p)) : [...pages, { tag: TAUGHT_TAG, text }];
  return { pages: next, added: true };
}

/** BM25 scores for every chunk, same order as `chunks`. */
export function bm25(chunks: Chunk[], query: string, k1 = 1.2, b = 0.75): number[] {
  const q = [...new Set(terms(query))];
  const docs = chunks.map((c) => terms([c.title, c.text, ...Object.values(c.translations ?? {})].join(" ")));
  const avg = docs.reduce((n, d) => n + d.length, 0) / (docs.length || 1);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  return docs.map((d) => {
    let s = 0;
    for (const t of q) {
      const f = d.filter((x) => x === t).length;
      if (!f) continue;
      const idf = Math.log(1 + (docs.length - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
    }
    return s;
  });
}

/**
 * Context for one answer call, at most `budget` tokens.
 * Top-3 keyword hits first; then caller-provided fallback tags, then the source in order.
 * Stage can prefer its current slide/recent speech when there is no cross-language match.
 * With keyword hits, reserve up to 20% of the same budget for distinct fallback excerpts.
 * Fallbacks are context hints, never evidence of a keyword match (they don't set `best`).
 * Transcript translations participate in ranking; only the original text consumes model context.
 */
export function selectContext(chunks: Chunk[], query: string, budget = 1500, fallbackTags: string[] = []): { picked: Chunk[]; best: Chunk | null } {
  const scores = bm25(chunks, query);
  const order = chunks.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const hits = order.filter((i) => scores[i] > 0).slice(0, 3);
  const fallback = [...new Set(fallbackTags.flatMap((tag) => chunks.flatMap((c, i) => c.tag === tag ? [i] : [])))];
  const separate = fallback.filter((i) => !hits.includes(i));
  const reserved = new Map<number, Chunk>();
  const preferredCost = [...hits, ...separate].reduce((n, i) => n + tokensOf(chunks[i].text), 0);
  let allowance = hits.length && preferredCost > budget ? Math.floor(budget * 0.2) : 0;
  // Share the reservation so a long current slide cannot crowd out every recent phrase.
  for (const [position, i] of separate.entries()) {
    const c = chunks[i];
    const cost = Math.min(tokensOf(c.text), Math.ceil(allowance / (separate.length - position)));
    if (cost <= 0) continue;
    const excerpt = { ...c, text: c.text.slice(0, cost * 4) };
    reserved.set(i, excerpt);
    allowance -= tokensOf(excerpt.text);
  }
  const picked: Chunk[] = [];
  let best: Chunk | null = null;
  // Count reserved excerpts now, but emit them after the keyword matches.
  let used = [...reserved.values()].reduce((n, c) => n + tokensOf(c.text), 0);
  for (const i of new Set([...hits, ...fallback, ...chunks.map((_, i) => i)])) {
    const excerpt = reserved.get(i);
    if (excerpt) {
      picked.push(excerpt);
      continue;
    }
    const c = chunks[i];
    const cost = tokensOf(c.text);
    if (used + cost > budget) {
      if ((reserved.size && hits.includes(i) && used < budget) || (used < budget * 0.8 && !hits.includes(i))) {
        const room = (budget - used) * 4;
        // A complete translated line may contain facts beyond this original-text excerpt.
        const partial = { ...c, text: c.text.slice(0, room), translations: undefined };
        picked.push(partial);
        if (i === hits[0]) best = partial;
        used = budget;
      }
      continue;
    }
    picked.push(c);
    if (i === hits[0]) best = c;
    used += cost;
  }
  return { picked, best };
}

/** Mock answers: the sentence of the best chunk that shares the most words with the question. */
export function bestSentence(question: string, chunk: Chunk | null, lang?: string): { covered: boolean; text: string; cite: string } {
  if (!chunk) return { covered: false, text: "", cite: "" };
  const q = new Set(terms(question));
  if (chunk.tag === TAUGHT_TAG) {
    // Taught entries: find the entry that shares the most words, and say its answer, not the "Q:" line.
    let ans = "";
    let top = 0;
    for (const block of chunk.text.split(/\n(?=Q: )/)) { // chunkPages drops the blank lines between entries, so cut at each "Q:"
      const n = terms(block).filter((t) => q.has(t)).length;
      const a = block.match(/^A: (.*)$/m)?.[1];
      if (a && n > top) [ans, top] = [a, n];
    }
    return top ? { covered: true, text: ans, cite: chunk.tag } : { covered: false, text: "", cite: "" };
  }
  let best = "";
  let score = 0;
  const translations = Object.values(chunk.translations ?? {}).map((t) => t.split("\n"));
  const target = lang ? chunk.translations?.[lang]?.split("\n") : undefined;
  const units = chunk.text.split("\n").flatMap((l) => (!translations.length && l.length > 200 ? l.split(/(?<=[.!?])\s+/) : [l]));
  for (const [i, s] of units.entries()) {
    const n = Math.max(...[s, ...translations.map((t) => t[i] ?? "")].map((t) => terms(t).filter((w) => q.has(w)).length));
    if (n > score) [best, score] = [(target?.[i] || s).trim(), n];
  }
  return score ? { covered: true, text: best, cite: chunk.tag } : { covered: false, text: "", cite: "" };
}

/** Word overlap (Jaccard) of two phrases: two mics hearing the same voice give > 0.8. */
export function overlap(a: string, b: string): number {
  const A = new Set(terms(a)), B = new Set(terms(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / (A.size + B.size - n);
}

/** Two mics in one room hear the same voice: drop a line that repeats another speaker's line from the last 4 s. */
export function isEcho(lines: { speaker?: string; t: number; src: string }[], speaker: string, src: string, now: number): boolean {
  return lines.some((l) => (l.speaker ?? "s0") !== speaker && now - l.t < 4000 && overlap(l.src, src) > 0.8);
}
