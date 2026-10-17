/** One slide's preview rows before upload (same shape as `DeckPageRows` without boxes in tests). */
export type DeckPreviewPage = { n: number; rows: { text: string; kept: boolean; box?: unknown }[] };

export function deckSlideNumbers(pages: DeckPreviewPage[]): number[] {
  return pages.map((p) => p.n).sort((a, b) => a - b);
}

/** Arrow-key step; clamped to the first and last slide. */
export function stepDeckSlide(numbers: number[], current: number, delta: number): number {
  if (!numbers.length) return current;
  let i = numbers.indexOf(current);
  if (i < 0) i = 0;
  const next = Math.max(0, Math.min(numbers.length - 1, i + delta));
  return numbers[next]!;
}

export function findDeckPage(pages: DeckPreviewPage[], n: number): DeckPreviewPage {
  return pages.find((p) => p.n === n) ?? { n, rows: [] };
}
