import { describe, expect, it } from "vitest";
import { answerPrompt } from "../src/prompts";
import { bestSentence, chunkPages, selectContext, tokensOf, TAUGHT_TAG } from "../src/retrieve";

const questions = [
  ["hi", "यह कंपनी कितने देशों में काम करती है?", "Hindi"],
  ["it", "In quanti paesi lavora questa azienda?", "Italian"],
  ["es", "¿En cuántos países trabaja esta empresa?", "Spanish"],
  ["en", "How many countries does this company work in?", "English"],
];
const missingQuestions = [
  ["hi", "संस्थापक का जन्मदिन कब है?"],
  ["it", "Qual è il compleanno del fondatore?"],
  ["es", "¿Cuál es el cumpleaños del fundador?"],
  ["en", "When is the founder's birthday?"],
];
const fact = "We operate in 15 countries.";
const pages = Array.from({ length: 20 }, (_, i) => ({
  tag: `slide ${i + 1}`,
  text: ((i === 11 ? `Our reach\n${fact}\n` : i === 1 ? "Our team\nWe employ 50 people.\n" : `Background ${i + 1}\n`) +
    "Product architecture and deployment background. ".repeat(40)).slice(0, 1000),
}));
const deck = chunkPages(pages);

describe("English-only Stage slides without translated captions", () => {
  it("counts taught evidence and keyword hits together before reserving fallback excerpts", () => {
    const taught = { tag: TAUGHT_TAG, title: "Approved", text: "Approved details. ".repeat(200).slice(0, 3000) };
    const hits = Array.from({ length: 3 }, (_, i) => ({ tag: `slide ${i + 1}`, title: "ROCm", text: "ROCm details. ".repeat(100).slice(0, 1200) }));
    const hints = [
      { tag: "slide 12", title: "Reach", text: (fact + " ").repeat(40).slice(0, 800) },
      { tag: "said at 4:00", title: "Recent", text: "Our office is in Italy. ".repeat(40).slice(0, 800) },
    ];
    const { picked, best } = selectContext([...hits, ...hints, taught], "ROCm", 1500, hints.map((c) => c.tag));
    expect(picked[0]).toEqual(taught);
    expect(best).toEqual(hits[0]);
    const fallback = picked.filter((c) => hints.some((h) => h.tag === c.tag));
    expect(fallback).toHaveLength(2);
    expect(fallback.reduce((n, c) => n + tokensOf(c.text), 0)).toBe(300);
    expect(picked.reduce((n, c) => n + tokensOf(c.text), 0)).toBe(1500);
    expect(new Set(picked.map((c) => c.tag)).size).toBe(picked.length);
  });

  it("does not double-count a taught source that is also a keyword hit and a fallback", () => {
    const taught = { tag: TAUGHT_TAG, title: "Countries", text: `Q: Countries?\nA: ${fact}` };
    const slide = { tag: "slide 1", title: "Welcome", text: "Background." };
    const { picked, best } = selectContext([slide, taught], "countries", 1500, [TAUGHT_TAG, "slide 1"]);
    expect(picked).toEqual([taught, slide]);
    expect(best).toEqual(taught);
    expect(bestSentence("countries", best)).toEqual({ covered: true, text: fact, cite: TAUGHT_TAG });
  });

  it.each(questions)("includes the current slide as evidence for a %s question in a long deck", (lang, question, language) => {
    const { picked, best } = selectContext(deck, question, 1500, ["slide 12"]);
    expect(picked.find((c) => c.tag === "slide 12")?.text).toContain(fact);
    expect(picked.reduce((n, c) => n + tokensOf(c.text), 0)).toBeLessThanOrEqual(1500);
    expect(picked.every((c) => !c.translations)).toBe(true);
    const prompt = answerPrompt(picked, question, lang);
    expect(String(prompt.messages[0].content)).toContain(`[slide 12] Our reach\n${fact}`);
    expect(String(prompt.messages[0].content)).toContain(`Write the answer in ${language}`);
    expect(prompt.messages[1].content).toBe(question);
    if (lang === "en") {
      expect(best?.tag).toBe("slide 12");
      expect(bestSentence(question, best, lang).text).toBe(fact);
    } else {
      // Context selection is not a claim that these words matched or that the mock can translate.
      expect(best).toBeNull();
      expect(bestSentence(question, best, lang).covered).toBe(false);
    }
  });

  it.each(missingQuestions)("does not treat fallback context as an answer to an unsupported %s question", (lang, question) => {
    const { picked, best } = selectContext(deck, question, 1500, ["slide 12"]);
    expect(picked.some((c) => c.tag === "slide 12")).toBe(true);
    expect(best).toBeNull();
    expect(bestSentence(question, best, lang)).toEqual({ covered: false, text: "", cite: "" });
    expect(String(answerPrompt(picked, question, lang).messages[0].content)).toContain("If the sources do not contain the answer, set covered to false");
  });

  it("keeps an actual keyword match ahead of a distracting current slide", () => {
    const { picked, best } = selectContext(deck, questions[3][1], 1500, ["slide 2"]);
    expect(best?.tag).toBe("slide 12");
    expect(picked[0].tag).toBe("slide 12");
    expect(picked.find((c) => c.tag === "slide 2")?.text).toContain("50 people");
  });

  it("can still miss an unreferenced slide for a nonmatching question", () => {
    const { picked, best } = selectContext(deck, questions[0][1], 1500, ["slide 20"]);
    expect(best).toBeNull();
    expect(picked.some((c) => c.text.includes(fact))).toBe(false);
  });

  it("keeps current-slide and recent-speech evidence when three keyword hits would fill the budget", () => {
    const hits = Array.from({ length: 3 }, (_, i) => ({
      tag: `slide ${i + 1}`, title: "ROCm", text: "ROCm accelerator details. ".repeat(100).slice(0, 2000),
    }));
    const recent = { tag: "said at 4:00", title: "Slide 12", text: "Our newest office is in Italy." };
    const { picked, best } = selectContext([...hits, { tag: "slide 12", title: "Our reach", text: fact }, recent],
      "ROCm कितने देशों में उपलब्ध है?", 1500, ["slide 12", recent.tag]);
    expect(picked[0].tag).toBe("slide 1");
    expect(best?.tag).toBe("slide 1");
    expect(picked.find((c) => c.tag === "slide 12")?.text).toBe(fact);
    expect(picked.find((c) => c.tag === recent.tag)?.text).toBe(recent.text);
    expect(picked.reduce((n, c) => n + tokensOf(c.text), 0)).toBeLessThanOrEqual(1500);
  });

  it("keeps part of an oversized best match alongside bounded fallback excerpts", () => {
    const hits = [{ tag: "slide 1", title: "ROCm", text: "ROCm accelerator details. ".repeat(400).slice(0, 6000) }];
    const fallback = [
      { tag: "slide 12", title: "Our reach", text: (fact + " ").repeat(100) },
      { tag: "said at 4:00", title: "Recent", text: "Our newest office is in Italy. ".repeat(100) },
    ];
    const { picked, best } = selectContext([...hits, ...fallback], "ROCm", 1500, fallback.map((c) => c.tag));
    expect(picked.map((c) => c.tag)).toEqual(["slide 1", "slide 12", "said at 4:00"]);
    expect(best).toEqual(picked[0]); // the mock/citation fallback must not see excluded source text
    expect(picked[0].text.length).toBeLessThan(hits[0].text.length);
    expect(picked.filter((c) => c.tag !== "slide 1").reduce((n, c) => n + tokensOf(c.text), 0)).toBeLessThanOrEqual(300);
    expect(picked.reduce((n, c) => n + tokensOf(c.text), 0)).toBeLessThanOrEqual(1500);
  });

  it("does not shorten fallback sources when keyword hits and all hints fit", () => {
    const chunks = [
      { tag: "slide 1", title: "ROCm", text: "ROCm accelerator details." },
      { tag: "slide 12", title: "Our reach", text: (fact + " ").repeat(30) },
      { tag: "said at 4:00", title: "Recent", text: "Our newest office is in Italy. ".repeat(30) },
    ];
    const { picked } = selectContext(chunks, "ROCm", 1500, ["slide 12", "said at 4:00", "slide 12"]);
    expect(picked).toEqual(chunks);
  });

  it("does not let a clipped original use facts from its unabridged translated caption", () => {
    const chunks = [
      { tag: "said at 0:00", title: "Talk", text: "Background details. ".repeat(300) + fact,
        translations: { hi: "यह कंपनी 15 देशों में काम करती है।" } },
      { tag: "slide 12", title: "Recent", text: "Current slide details. ".repeat(100) },
    ];
    const { best } = selectContext(chunks, questions[0][1], 1500, ["slide 12"]);
    expect(best?.text).not.toContain(fact);
    expect(bestSentence(questions[0][1], best, "hi").covered).toBe(false);
  });

  it("never expands a tight budget or duplicates a preferred source", () => {
    const { picked, best } = selectContext(deck, questions[0][1], 10, ["slide 12", "slide 12", "missing"]);
    expect(picked.reduce((n, c) => n + tokensOf(c.text), 0)).toBeLessThanOrEqual(10);
    expect(picked).toHaveLength(1);
    expect(picked[0].tag).toBe("slide 12");
    expect(best).toBeNull();
  });
});
