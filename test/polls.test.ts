import { describe, expect, it } from "vitest";
import { cleanPoll, validVote, tally, pollView, answerLangs, type Poll } from "../src/poll";
import { pollPrompt, pollAnswersPrompt } from "../src/prompts";

const poll = (over: Partial<Poll>): Poll => ({
  id: "p1", t: 0, kind: "choice", lang: "it", q: { it: "Quale?", en: "Which?" }, options: { it: ["a", "b", "c"], en: ["a", "b", "c"] },
  share: false, open: true, answers: [], ...over,
});

describe("cleanPoll", () => {
  it("rejects polls nobody could answer", () => {
    expect(cleanPoll({ kind: "choice", q: "Which?", options: ["only one"] })).toBeNull();
    expect(cleanPoll({ kind: "choice", q: " ", options: ["a", "b"] })).toBeNull();
    expect(cleanPoll({ kind: "tf", q: "True?", options: ["Yes"] })).toBeNull();
    expect(cleanPoll({ kind: "rating", q: "How much?", min: 5, max: 5 })).toBeNull();
    expect(cleanPoll({ kind: "rating", q: "How much?", min: 0, max: 11 })).toBeNull();
    expect(cleanPoll({ kind: "quiz", q: "?" })).toBeNull();
  });

  it("keeps results private unless the speaker ticks the box", () => {
    expect(cleanPoll({ kind: "free", q: "Why?", lang: "it" })).toMatchObject({ share: false, lang: "it" });
    expect(cleanPoll({ kind: "free", q: "Why?", share: "yes" })!.share).toBe(false);
    expect(cleanPoll({ kind: "free", q: "Why?", share: true })!.share).toBe(true);
    expect(cleanPoll({ kind: "choice", q: "Which?", options: ["a", " ", "b"] })!.options).toEqual(["a", "b"]);
  });
});

describe("validVote", () => {
  it("accepts only answers that fit the poll", () => {
    const choice = poll({});
    expect(validVote(choice, 2)).toBe(2);
    expect(validVote(choice, 3)).toBeNull();
    expect(validVote(choice, -1)).toBeNull();
    const rating = poll({ kind: "rating", min: 1, max: 5 });
    expect(validVote(rating, 5)).toBe(5);
    expect(validVote(rating, 2.5)).toBeNull();
    expect(validVote(rating, 0)).toBeNull();
    const rank = poll({ kind: "rank" });
    expect(validVote(rank, [2, 0, 1])).toEqual([2, 0, 1]);
    expect(validVote(rank, [0, 0, 1])).toBeNull();
    expect(validVote(rank, [0, 1])).toBeNull();
    const free = poll({ kind: "free" });
    expect(validVote(free, "  good talk ")).toBe("good talk");
    expect(validVote(free, "   ")).toBeNull();
  });
});

describe("tally and pollView", () => {
  it("counts, averages and ranks", () => {
    expect(tally(poll({ answers: [{ voter: "1", lang: "en", a: 0 }, { voter: "2", lang: "es", a: 0 }, { voter: "3", lang: "it", a: 2 }] }))).toEqual({ n: 3, counts: [2, 0, 1] });
    expect(tally(poll({ kind: "rating", min: 1, max: 3, answers: [{ voter: "1", lang: "en", a: 1 }, { voter: "2", lang: "en", a: 3 }] }))).toEqual({ n: 2, counts: [1, 0, 1], avg: 2 });
    expect(tally(poll({ kind: "rank", answers: [{ voter: "1", lang: "en", a: [2, 0, 1] }, { voter: "2", lang: "en", a: [2, 1, 0] }] }))).toEqual({ n: 2, avg: [2.5, 2.5, 1] });
  });

  it("shows free answers only once closed", () => {
    const answers = [{ voter: "1", lang: "es", a: "muy bien", out: { it: "molto bene" } }];
    expect(tally(poll({ kind: "free", answers }))).toEqual({ n: 1 });
    expect(tally(poll({ kind: "free", open: false, answers }))).toEqual({ n: 1, texts: [{ lang: "es", a: "muy bien", out: { it: "molto bene" } }] });
  });

  it("never sends raw answers, and no results for a private poll", () => {
    const p = poll({ answers: [{ voter: "secret", lang: "en", a: 1 }] });
    expect(pollView(p, false)).not.toHaveProperty("tally");
    expect(JSON.stringify(pollView(p, false))).not.toContain("secret");
    expect(JSON.stringify(pollView(p, true))).not.toContain("secret");
    expect(answerLangs(p)).toEqual(["it"]);
    expect(answerLangs({ ...p, share: true })).toEqual(["it", "en"]);
  });
});

describe("poll prompts", () => {
  it("asks once for every other language", () => {
    const r = pollPrompt("Quale preferisci?", ["Pizza", "Pasta"], "it", ["en", "es", "hi"]);
    const sys = String(r.messages[0].content);
    expect(sys).toContain("wrote in Italian into English, Spanish, Hindi");
    expect(sys).toContain('"es": [string]');
    expect(sys).not.toContain('"it"');
    expect(r.max_tokens).toBe(600);
  });

  it("keeps the answers in order and sizes the output to the languages", () => {
    const r = pollAnswersPrompt(["uno", "dos"], ["it"], false);
    expect(r.messages[1].content).toBe('["uno","dos"]');
    expect(r.max_tokens).toBe(1500);
    expect(pollAnswersPrompt(["uno"], ["it", "en", "hi"], true).max_tokens).toBe(2500);
  });
});
