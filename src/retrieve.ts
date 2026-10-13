// Local retrieval: no embeddings endpoint exists, and this costs zero tokens (see CONTRIBUTING.md, token rule 5).

export interface Chunk {
  tag: string; // "slide 6", "menu", "hours"... shown to users as the citation
  title: string; // first line, used as the board topic
  text: string;
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
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

export function normalize(q: string): string {
  return terms(q).join(" ");
}

export const tokensOf = (s: string) => Math.ceil(s.length / 4);

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

/** BM25 scores for every chunk, same order as `chunks`. */
export function bm25(chunks: Chunk[], query: string, k1 = 1.2, b = 0.75): number[] {
  const q = [...new Set(terms(query))];
  const docs = chunks.map((c) => terms(c.title + " " + c.text));
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
 * Top-3 keyword hits first; then the rest of the source in order, so a question asked in
 * Hindi about an English deck still gets context (small decks fit whole).
 */
export function selectContext(chunks: Chunk[], query: string, budget = 1500): { picked: Chunk[]; best: Chunk | null } {
  const scores = bm25(chunks, query);
  const order = chunks.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const hits = order.filter((i) => scores[i] > 0).slice(0, 3);
  const picked: Chunk[] = [];
  let used = 0;
  for (const i of [...hits, ...chunks.map((_, i) => i).filter((i) => !hits.includes(i))]) {
    const c = chunks[i];
    const cost = tokensOf(c.text);
    if (used + cost > budget) {
      if (used < budget * 0.8 && !hits.includes(i)) {
        const room = (budget - used) * 4;
        picked.push({ ...c, text: c.text.slice(0, room) });
        used = budget;
      }
      continue;
    }
    picked.push(c);
    used += cost;
  }
  return { picked, best: hits.length ? chunks[hits[0]] : null };
}

/** Mock answers: the sentence of the best chunk that shares the most words with the question. */
export function bestSentence(question: string, chunk: Chunk | null): { covered: boolean; text: string; cite: string } {
  if (!chunk) return { covered: false, text: "", cite: "" };
  const q = new Set(terms(question));
  let best = "";
  let score = 0;
  const units = chunk.text.split("\n").flatMap((l) => (l.length > 200 ? l.split(/(?<=[.!?])\s+/) : [l]));
  for (const s of units) {
    const n = terms(s).filter((t) => q.has(t)).length;
    if (n > score) [best, score] = [s.trim(), n];
  }
  return score ? { covered: true, text: best, cite: chunk.tag } : { covered: false, text: "", cite: "" };
}
