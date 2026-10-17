import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error browser module
import { splitScript, docxText, parseScript, scriptSummary } from "../public/js/script.js";

describe("teleprompter splitScript", () => {
  const text = `Good morning everyone. Today I want to talk about why gold is booming, what is driving it, and what it means for you.
Thanks. Driver one is fear and inflation; central banks keep buying and buying and buying more gold every single quarter without stopping.`;
  const phrases: string[] = splitScript(text);

  it("keeps every word, in order", () => {
    expect(phrases.join(" ")).toBe(text.replace(/\s+/g, " "));
  });

  it("makes short readable phrases", () => {
    for (const p of phrases) expect(p.split(" ").length).toBeLessThanOrEqual(12);
    expect(phrases.filter((p) => p.split(" ").length < 3)).toEqual([]);
  });

  it("cuts long sentences at punctuation", () => {
    expect(phrases).toContain("Today I want to talk about why gold is booming,");
    expect(phrases).toContain("what is driving it, and what it means for you.");
    expect(phrases).toContain("Thanks. Driver one is fear and inflation;");
  });

  it("starts a new line at each line break and drops dividers", () => {
    expect(splitScript("Slide 1:\n---\nGood afternoon, everyone.")).toEqual(["Slide 1:", "Good afternoon, everyone."]);
  });

  it("handles empty input", () => {
    expect(splitScript("")).toEqual([]);
    expect(splitScript(undefined)).toEqual([]);
  });
});

describe("teleprompter parseScript", () => {
  // Same shape as a real exported speech: title, preamble, decorated cues, a [note], a Q&A heading.
  const speech = `Why Gold Is Booming: speech
About 6 minutes. One block per slide. [brackets] are cues, not spoken.

--- Slide 1: Why Gold Is Booming ---

Good afternoon, everyone. My name is Sebastian.

Today it costs more than four thousand. [Check a live price before you present and say it here.]

--- Slide 2: The long view ---

Let's start with the long view.

## Slide 3

The first driver is central banks.

--- Q&A (if asked) ---

Should I buy gold now?`;
  const { lines, cues } = parseScript(speech);
  type L = { text: string; slide: number | null; note: string };

  it("drops the preamble, cue lines and dividers", () => {
    expect(lines[0]).toEqual({ text: "Good afternoon, everyone.", slide: 1, note: "" });
    expect((lines as L[]).filter((l) => /---|\[|Slide \d/.test(l.text))).toEqual([]);
  });

  it("follows the slide cues in order", () => {
    expect(cues).toBe(3);
    expect([...new Set((lines as L[]).map((l) => l.slide))]).toEqual([1, 2, 3]);
    expect((lines as L[]).find((l) => l.slide === 2)?.text).toBe("Let's start with the long view.");
  });

  it("keeps [notes] on the line before them and headings on the line after", () => {
    expect((lines as L[]).find((l) => l.note.startsWith("Check a live price"))?.text).toBe("Today it costs more than four thousand.");
    expect((lines as L[]).find((l) => l.note === "Q&A (if asked)")?.text).toBe("Should I buy gold now?");
  });

  it("splits a line at an inline cue", () => {
    expect(parseScript("Slide 1:\nThis is the intro. [next slide] Now the numbers.").lines.map((l: L) => [l.text, l.slide]))
      .toEqual([["This is the intro.", 1], ["Now the numbers.", 2]]);
  });

  it("leaves slides alone when there are no cues", () => {
    expect(parseScript("Just a speech with no cues at all.").lines[0].slide).toBeNull();
  });

  it("keeps text before a first cue that isn't slide 1", () => {
    expect(parseScript("Welcome, everyone.\n--- Slide 2 ---\nOn to the data.").lines.map((l: L) => [l.text, l.slide]))
      .toEqual([["Welcome, everyone.", 1], ["On to the data.", 2]]);
  });

  it("warns when cues run past the deck", () => {
    expect(scriptSummary(speech, 3)).toBe("6 lines · 3 slide cues · 1 note");
    expect(scriptSummary(speech, 2)).toContain("cues go to slide 3, deck has 2");
  });
});

// macOS only: textutil writes a real Word file.
describe.runIf(process.platform === "darwin")("teleprompter docxText", () => {
  it("reads paragraphs out of a .docx", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eco-docx-"));
    writeFileSync(join(dir, "s.txt"), "Gold is up & rising.\nSecond paragraph <here>.");
    execFileSync("textutil", ["-convert", "docx", join(dir, "s.txt")]);
    expect(await docxText(readFileSync(join(dir, "s.docx")))).toBe("Gold is up & rising.\nSecond paragraph <here>.");
  });
});
