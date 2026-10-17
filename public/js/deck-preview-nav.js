/** Keep in sync with src/deck-preview.ts — test/deck-preview.test.ts checks parity. */

export function deckSlideNumbers(pages) {
  return pages.map((p) => p.n).sort((a, b) => a - b);
}

export function stepDeckSlide(numbers, current, delta) {
  if (!numbers.length) return current;
  let i = numbers.indexOf(current);
  if (i < 0) i = 0;
  const next = Math.max(0, Math.min(numbers.length - 1, i + delta));
  return numbers[next];
}

export function findDeckPage(pages, n) {
  return pages.find((p) => p.n === n) ?? { n, rows: [] };
}
