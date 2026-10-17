// Scrollable captions: whether to follow new lines, the unread count, and which line is big and bold.
// The decisions stay DOM-free so the engine tests can run them (same pattern as vad.js); setFocus applies them.

/** Prefer the requested translation, including English. The original has no stored language code. */
export function captionFor(line, lang) {
  const translated = line.out?.[lang];
  return typeof translated === "string" && translated.trim()
    ? { text: translated, lang }
    : { text: line.src ?? "", lang: null };
}

export const NEAR_BOTTOM_PX = 48;

/** Is the view within `threshold` px of the bottom (or has nothing to scroll)? */
export function nearBottom(v, threshold = NEAR_BOTTOM_PX) {
  return v.scrollHeight - (v.scrollTop + v.clientHeight) <= threshold;
}

/** Next unread count: a line while reading history adds one; following live (or tapping back) clears it. */
export function nextNewCount(current, atBottom) {
  return atBottom ? 0 : current + 1;
}

/**
 * Which line is big and bold: the last one when following live, else the bottom-most fully visible one.
 * Sticky: the `current` line keeps it while it's still on screen and no line below it fits, because the
 * big line resizes as it moves, and without this it would flip back and forth (or snap the view to live).
 */
export function focusIndex(rects, viewBottom, atBottom, current = -1) {
  if (!rects.length) return -1;
  if (atBottom) return rects.length - 1;
  const full = rects.findLastIndex((r) => r.bottom <= viewBottom + 2);
  if (rects[current] && rects[current].top < viewBottom && full <= current) return current;
  if (full >= 0) return full;
  return Math.max(0, rects.findLastIndex((r) => r.top < viewBottom));
}

/** Moves the big bold line (.focus) in a scroll view to focusIndex's pick; returns its index. */
export function setFocus(view, atBottom) {
  const ps = [...view.children];
  const i = focusIndex(ps.map((p) => p.getBoundingClientRect()), view.getBoundingClientRect().bottom, atBottom, ps.findIndex((p) => p.classList.contains("focus")));
  ps.forEach((p, j) => p.classList.toggle("focus", j === i));
  if (atBottom) view.scrollTop = view.scrollHeight; // the latest line just grew: stay pinned
  return i;
}
