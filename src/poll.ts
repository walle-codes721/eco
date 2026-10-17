// Polls on the Stage: the speaker asks, listeners answer. Pure rules, no Workers imports, so they can be unit tested.

export type PollKind = "free" | "choice" | "tf" | "rating" | "rank";
/** `out`: a free answer in each language it must be read in (the speaker's; every room language when shared). */
export interface PollAnswer { voter: string; lang: string; a: number | number[] | string; out?: Record<string, string> }
export interface Poll {
  id: string; t: number; kind: PollKind;
  lang: string; // the speaker's language: what they typed in and read results in
  q: Record<string, string>; options: Record<string, string[]>;
  min?: number; max?: number;
  share: boolean; // listeners see the results too
  open: boolean;
  answers: PollAnswer[];
}
export type Tally =
  | { n: number; counts: number[] } // choice, tf
  | { n: number; counts: number[]; avg: number | null } // rating: counts[v - min]
  | { n: number; avg: (number | null)[] } // rank: average place per option, 1 = first
  | { n: number; texts?: { lang: string; a: string; out: Record<string, string> }[] }; // free: texts once closed

const KINDS: PollKind[] = ["free", "choice", "tf", "rating", "rank"];
const str = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const isInt = (v: unknown): v is number => Number.isInteger(v);

/** The speaker's draft, trimmed and capped. null = not a poll anyone could answer. */
export function cleanPoll(body: any): Pick<Poll, "kind" | "lang" | "min" | "max" | "share"> & { q: string; options: string[] } | null {
  const kind = KINDS.find((k) => k === body?.kind);
  const q = str(body?.q, 200);
  if (!kind || !q) return null;
  const lang = str(body.lang, 5) || "en";
  const share = body.share === true;
  if (kind === "free") return { kind, lang, q, options: [], share };
  if (kind === "rating") {
    const min = Number(body.min), max = Number(body.max);
    if (!isInt(min) || !isInt(max) || max <= min || max - min > 10) return null;
    return { kind, lang, q, options: [], min, max, share };
  }
  const options = (Array.isArray(body.options) ? body.options : []).map((o: unknown) => str(o, 80)).filter(Boolean).slice(0, 10);
  if (kind === "tf" ? options.length !== 2 : options.length < 2) return null;
  return { kind, lang, q, options, share };
}

/** The listener's answer, or null when it doesn't fit the poll. */
export function validVote(p: Pick<Poll, "kind" | "options" | "lang" | "min" | "max">, a: unknown): PollAnswer["a"] | null {
  const n = p.options[p.lang]?.length ?? 0;
  if (p.kind === "free") return str(a, 200) || null;
  if (p.kind === "rating") return isInt(a) && a >= p.min! && a <= p.max! ? a : null;
  if (p.kind === "rank") {
    if (!Array.isArray(a) || a.length !== n || !a.every(isInt)) return null;
    return new Set(a).size === n && a.every((i) => i >= 0 && i < n) ? a : null;
  }
  return isInt(a) && a >= 0 && a < n ? a : null;
}

/** Anonymous results: no voter ids ever leave the room. */
export function tally(p: Poll): Tally {
  const as = p.answers;
  const n = as.length;
  if (p.kind === "free") return p.open ? { n } : { n, texts: as.map((x) => ({ lang: x.lang, a: String(x.a), out: x.out ?? {} })) };
  if (p.kind === "rating") {
    const counts = Array.from({ length: p.max! - p.min! + 1 }, () => 0);
    for (const x of as) counts[(x.a as number) - p.min!]++;
    return { n, counts, avg: n ? as.reduce((s, x) => s + (x.a as number), 0) / n : null };
  }
  const k = p.options[p.lang].length;
  if (p.kind === "rank") {
    const sum = Array.from({ length: k }, () => 0);
    for (const x of as) (x.a as number[]).forEach((opt, place) => (sum[opt] += place + 1));
    return { n, avg: sum.map((s) => (n ? s / n : null)) };
  }
  const counts = Array.from({ length: k }, () => 0);
  for (const x of as) counts[x.a as number]++;
  return { n, counts };
}

/** A poll as a page receives it: never the raw answers; results only when allowed. */
export function pollView(p: Poll, withTally: boolean) {
  const { answers: _, ...rest } = p;
  return withTally ? { ...rest, tally: tally(p) } : rest;
}

/** The languages a free answer must end up in. */
export const answerLangs = (p: Poll) => (p.share ? Object.keys(p.q) : [p.lang]);

/** How many free answers one close may translate: the call's output grows with every language. */
export const answerCap = (p: Poll) => (p.share ? 25 : 60);
