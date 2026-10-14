// Pure decisions for scrollable captions: whether to follow new lines, and the unread count.
// Kept DOM-free so the engine tests can run them (same pattern as vad.js).

export const NEAR_BOTTOM_PX = 48;

/** Is the view within `threshold` px of the bottom (or has nothing to scroll)? */
export function nearBottom(v, threshold = NEAR_BOTTOM_PX) {
  return v.scrollHeight - (v.scrollTop + v.clientHeight) <= threshold;
}

/** Next unread count: a line while reading history adds one; following live (or tapping back) clears it. */
export function nextNewCount(current, atBottom) {
  return atBottom ? 0 : current + 1;
}
