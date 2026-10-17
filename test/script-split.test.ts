import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error browser module
import { splitScript, docxText } from "../public/js/script.js";

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

// macOS only: textutil writes a real Word file.
describe.runIf(process.platform === "darwin")("teleprompter docxText", () => {
  it("reads paragraphs out of a .docx", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eco-docx-"));
    writeFileSync(join(dir, "s.txt"), "Gold is up & rising.\nSecond paragraph <here>.");
    execFileSync("textutil", ["-convert", "docx", join(dir, "s.txt")]);
    expect(await docxText(readFileSync(join(dir, "s.docx")))).toBe("Gold is up & rising.\nSecond paragraph <here>.");
  });
});
