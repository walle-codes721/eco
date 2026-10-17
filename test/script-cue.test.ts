import { describe, it, expect } from "vitest";
// @ts-expect-error browser module
import { parseScript, cueFollower, words } from "../public/js/script.js";

// HACKATHON mode: the follower must fire every script line in order as the speaker starts it, never before.
const script = `--- Slide 1: Why Gold Is Booming ---
Good afternoon, everyone. My name is Sebastian.
In 1971, one ounce of gold cost about thirty-five dollars. Today it costs more than four thousand.
That is more than a hundred times higher. So today I want to answer one question: why is gold booming right now?
--- Slide 2: The long view ---
Let's start with the long view.
In 1971, the United States stopped exchanging dollars for gold. From that day, the price of gold was free to move.
For a long time, it moved slowly. Gold first passed two thousand dollars in August 2020.
Then things got fast. In March 2025, gold passed three thousand.
--- Slide 3: Central banks ---
The first driver is central banks. In 2022, central banks bought about one thousand and eighty tonnes of gold.
To give you a sense of size: one tonne is about thirty-two thousand ounces.
A bond can default. A bank account abroad can be frozen. A bar of gold in your own vault cannot.`;
const { lines } = parseScript(script);
type Word = [string, number]; // a spoken word and the line it belongs to

/** Feeds words one at a time like interim speech recognition (restarting every 30 words); returns [line, fired while saying line]. */
function follow(stream: Word[], setup?: (f: any) => void) {
  const f = cueFollower(lines);
  setup?.(f);
  const fired: [number, number][] = [];
  let text: string[] = [], run = 0;
  stream.forEach(([w, cur], k) => {
    if (k % 30 === 0) (run++, (text = []));
    text.push(w);
    for (const i of f.heard(text.join(" "), run)) fired.push([i, cur]);
  });
  return fired;
}
const spoken = (from = 0): Word[] => lines.slice(from).flatMap((l: { text: string }, j: number) => words(l.text).map((w: string) => [w, from + j] as Word));
const order = (fired: [number, number][]) => fired.map(([i]) => i);

describe("HACKATHON cue follower", () => {
  it("fires every line in order, while that line is being said", () => {
    const fired = follow(spoken());
    expect(order(fired)).toEqual(lines.map((_: unknown, i: number) => i));
    for (const [i, cur] of fired) expect(cur).toBe(i);
  });

  it("keeps up when recognition drops every third word or says numbers as digits", () => {
    const digits: Record<string, string> = { thirty: "35", five: "", four: "4", thousand: "000", two: "2" };
    for (const stream of [spoken().filter((_, k) => k % 3 !== 2), spoken().map(([w, i]): Word => [digits[w] ?? w, i])]) {
      const fired = follow(stream);
      expect(order(fired)).toEqual(lines.map((_: unknown, i: number) => i));
      for (const [i, cur] of fired) expect(i).toBeLessThanOrEqual(cur);
    }
  });

  it("stays quiet through an ad-lib, then finds its place", () => {
    const at = spoken().findIndex(([, i]) => i === 5);
    const adlib = "um sorry let me grab some water real quick okay".split(" ").map((w): Word => [w, 4]);
    const fired = follow([...spoken().slice(0, at), ...adlib, ...spoken().slice(at)]);
    expect(order(fired)).toEqual(lines.map((_: unknown, i: number) => i));
    for (const [i, cur] of fired) expect(i).toBeLessThanOrEqual(cur);
  });

  it("jumps ahead when the speaker skips lines, without playing the skipped ones", () => {
    const fired = follow([...spoken().filter(([, i]) => i < 4), ...spoken(9)]);
    expect(order(fired)).toEqual([0, 1, 2, 3, ...lines.slice(9).map((_: unknown, j: number) => 9 + j)]);
  });

  it("follows the teleprompter when it is moved by hand", () => {
    const fired = follow(spoken(6), (f) => f.reset(6));
    expect(order(fired)[0]).toBe(6);
    const f = cueFollower(lines);
    f.fired(0); // ↓ fired the first line by hand: saying it doesn't fire it again
    expect(f.heard(words(lines[0].text).join(" "), 1)).toEqual([]);
  });
});
