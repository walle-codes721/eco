// Replay of an ended Stage: everything that happened, as the projector's own messages, in time order. Pure, so it can be unit tested.
import type { LineReactions, Reaction } from "./reaction";

export interface SlideMark { n: number; t: number }
export interface ReactMark { t: number; r: Reaction }
type L = { t: number; slide: number };
type Q = { t: number; lang: string; text: string };
export type ReplayEvent<Line extends L> = { t: number; m: { type: "line"; line: Line } | { type: "slide"; n: number } | { type: "react"; r: Reaction } | { type: "question"; q: { lang: string; text: string } } };

/** Talks from before the logs existed: slides from where each line was said, reactions at their line. Questions carry no id or answer. */
export function timeline<Line extends L>(lines: Line[], questions: Q[], slideLog: SlideMark[], reactLog: ReactMark[], reactions: Record<string, LineReactions>): ReplayEvent<Line>[] {
  const slides = slideLog.length ? slideLog : lines.filter((l, i) => l.slide !== (lines[i - 1]?.slide ?? 1)).map((l) => ({ n: l.slide, t: l.t - 1 }));
  const reacts = reactLog.length ? reactLog : Object.values(reactions).flatMap((x) => Object.values(x.by).map((r) => ({ t: x.t, r })));
  const events: ReplayEvent<Line>[] = [
    ...slides.map(({ n, t }) => ({ t, m: { type: "slide" as const, n } })),
    ...lines.map((line) => ({ t: line.t, m: { type: "line" as const, line } })),
    ...reacts.map(({ t, r }) => ({ t, m: { type: "react" as const, r } })),
    ...questions.map(({ t, lang, text }) => ({ t, m: { type: "question" as const, q: { lang, text } } })),
  ];
  return events.sort((a, b) => a.t - b.t); // stable: a slide logged at the same ms as a line stays first
}
