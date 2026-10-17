// Reactions on the Stage: a Listener's one emoji on a Line. Pure rules, no Workers imports, so they can be unit tested.

// Single codepoints from Unicode 10 or earlier (❤️ with U+FE0F), so they render in colour on Android 8+.
export const REACTIONS = ["👍", "👎", "😂", "🤯", "❤️", "🤔"] as const;
export type Reaction = (typeof REACTIONS)[number];

/** The reactions on one Line. `at`/`slide` are copied from the Line so a later chart outlives the 600-Line trim. */
export interface LineReactions { seq: number; t: number; at: number; slide: number; by: Record<string, Reaction> }

/** A Line's key: Demo rooms reuse `seq` every loop, so `t` disambiguates (as audio clips do). */
export const lineKey = (seq: number, t: number) => `${seq}-${t}`;

/** A reaction from the list, null to clear, undefined when it's neither. */
export const validReaction = (r: unknown): Reaction | null | undefined => (r === null ? null : REACTIONS.find((x) => x === r));

/** Anonymous counts per Line, in talk order. No voter ids leave the room. */
export function tallyReactions(map: Record<string, LineReactions>) {
  return Object.values(map)
    .map((x) => {
      const counts: Partial<Record<Reaction, number>> = {};
      for (const r of Object.values(x.by)) counts[r] = (counts[r] ?? 0) + 1;
      return { seq: x.seq, t: x.t, at: x.at, slide: x.slide, n: Object.keys(x.by).length, counts };
    })
    .filter((x) => x.n)
    .sort((a, b) => a.t - b.t);
}

export const topLines = <T extends { n: number; t: number }>(tally: T[], n = 3) => [...tally].sort((a, b) => b.n - a.n || a.t - b.t).slice(0, n);
