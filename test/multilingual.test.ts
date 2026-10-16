import { describe, expect, it } from "vitest";
import { answerPrompt } from "../src/prompts";
import { bestSentence, questionKey, selectContext, terms, tokensOf, transcriptChunks, type Chunk } from "../src/retrieve";

const question = "यह कंपनी कितने देशों में काम करती है?";
const fact = {
  at: 240, slide: 7, src: "We operate in 15 countries.",
  out: { hi: "हम 15 देशों में काम करते हैं।", it: "Operiamo in 15 paesi.", es: "Operamos en 15 países." },
};
// More source text than an answer call can hold: the fact must be retrieved, not included by luck.
const background: Chunk[] = Array.from({ length: 6 }, (_, i) => ({
  tag: `slide ${i + 1}`, title: "Background", text: "Unrelated product background. ".repeat(40).slice(0, 1000),
}));

describe("multilingual Stage retrieval", () => {
  it.each([
    ["hi", question, fact.out.hi],
    ["it", "In quanti paesi operate?", fact.out.it],
    ["es", "¿En cuántos países operan?", fact.out.es],
    ["en", "How many countries does this company work in?", fact.src],
  ])("retrieves the same English evidence for a %s question beyond the context window", (lang, text, expected) => {
    const chunks = [...background, ...transcriptChunks([fact])];
    const { picked, best } = selectContext(chunks, text);
    expect(best?.tag).toBe("said at 4:00");
    expect(picked[0].text).toBe(fact.src);
    expect(picked.reduce((n, c) => n + tokensOf(c.text), 0)).toBeLessThanOrEqual(1500);
    expect(bestSentence(text, best, lang)).toEqual({ covered: true, text: expected, cite: "said at 4:00" });
    const prompt = answerPrompt(picked, text, lang);
    expect(String(prompt.messages[0].content)).toContain(`[said at 4:00] ${fact.src}`);
    expect(String(prompt.messages[0].content)).not.toContain(fact.out.hi);
    expect(prompt.messages[1].content).toBe(text);
  });

  it("finds a Hindi question even when English is selected as the answer language", () => {
    const { best } = selectContext(transcriptChunks([fact]), question);
    expect(bestSentence(question, best, "en").text).toBe(fact.src);
  });

  it("selects 15 countries rather than an unrelated figure of 50 employees", () => {
    const distractor = { at: 30, slide: 2, src: "We work with 50 employees.", out: { hi: "हम 50 कर्मचारियों के साथ काम करते हैं।" } };
    const { best } = selectContext([...background, ...transcriptChunks([distractor, fact])], question);
    expect(best?.text).toBe(fact.src);
    expect(bestSentence(question, best, "hi").text).toBe(fact.out.hi);
  });

  it("does not claim to translate English-only sources locally", () => {
    const { picked, best } = selectContext([...background, ...transcriptChunks([{ ...fact, out: {} }])], question);
    expect(best).toBeNull();
    expect(picked.some((c) => c.text.includes("15 countries"))).toBe(false);
    expect(bestSentence(question, best, "hi").covered).toBe(false);
  });

  it("keeps phrases aligned when a translated caption is missing and respects slide boundaries", () => {
    const lines = [
      { ...fact, at: 230, src: "Welcome to the company.", out: {} },
      fact,
      { ...fact, at: 260, slide: 8, src: "Next topic.", out: {} },
    ];
    const chunks = transcriptChunks(lines);
    expect(chunks).toHaveLength(2);
    expect(bestSentence(question, selectContext(chunks, question).best, "hi")).toEqual({
      covered: true, text: fact.out.hi, cite: "said at 3:50",
    });
    expect(chunks[1].text).toBe("Next topic.");
  });

  it("does not return an answer for an unrelated question", () => {
    const { best } = selectContext(transcriptChunks([fact]), "मुख्यालय?");
    expect(bestSentence("मुख्यालय?", best, "hi").covered).toBe(false);
  });

  it("ignores malformed translation values rather than breaking source retrieval", () => {
    const malformed = { ...fact, out: { hi: 42, es: null } as unknown as Record<string, string> };
    const chunks = transcriptChunks([malformed]);
    expect(chunks[0].translations).toEqual({});
    expect(selectContext(chunks, "How many countries?").best?.text).toBe(fact.src);
  });

  it("preserves Hindi combining marks in searchable words", () => {
    expect(terms("देशों कंपनी कितने")).toEqual(["देशों", "कंपनी", "कितने"]);
  });
});

describe("question cache identity", () => {
  it("keeps negation, Hindi vowel differences, and answer languages distinct", () => {
    expect(questionKey("Do we operate in India?", "en")).not.toBe(questionKey("Do we not operate in India?", "en"));
    expect(questionKey("कितने देशों में?", "hi")).not.toBe(questionKey("किन देशों में?", "hi"));
    expect(questionKey(question, "hi")).not.toBe(questionKey(question, "en"));
    expect(questionKey("कुल", "hi")).not.toBe(questionKey("काल", "hi"));
  });

  it("normalizes whitespace, case, and canonically equivalent Unicode", () => {
    expect(questionKey("  What  is ROCm? ", "en")).toBe(questionKey("what is rocm?", "en"));
    expect(questionKey("café", "en")).toBe(questionKey("cafe\u0301", "en"));
  });
});
