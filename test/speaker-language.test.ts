import { afterEach, describe, expect, it, vi } from "vitest";
import { answerPrompt, mockSummary, utterancePrompt } from "../src/prompts";
import { bestSentence, selectContext, tokensOf, transcriptChunks } from "../src/retrieve";
// @ts-expect-error plain browser module, tested in Node
import { captionFor } from "../public/js/caps.js";

const src = "La nostra azienda opera in 15 paesi.";
const en = "Our company operates in 15 countries.";
const question = "How many countries does the company operate in?";
const line = { at: 42, slide: 7, src, out: { en } };

describe("Italian presenter and English listener", () => {
  it("selects English captions and labels untranslated originals without guessing their language", () => {
    expect(captionFor(line, "en")).toEqual({ text: en, lang: "en" });
    expect(captionFor({ ...line, out: {} }, "en")).toEqual({ text: src, lang: null });
    expect(captionFor({ ...line, out: { en: " " } }, "en")).toEqual({ text: src, lang: null });
    expect(captionFor({ src: en }, "en").text).toBe(en); // legacy English-presenter captions
    expect(captionFor({ src: en, out: { it: src } }, "it")).toEqual({ text: src, lang: "it" });
  });

  it("retrieves Italian source evidence through the English caption beyond a long deck", () => {
    const deck = Array.from({ length: 20 }, (_, i) => ({ tag: `slide ${i + 1}`, title: "Team", text: "We employ 50 people. ".repeat(50) }));
    const { picked, best } = selectContext([...deck, ...transcriptChunks([line])], question);
    expect(best?.text).toBe(src);
    expect(bestSentence(question, best, "en")).toEqual({ covered: true, text: en, cite: "said at 0:42" });
    expect(picked.reduce((n, c) => n + tokensOf(c.text), 0)).toBeLessThanOrEqual(1500);
    const prompt = answerPrompt(picked, question, "en");
    expect(String(prompt.messages[0].content)).toContain(`[said at 0:42] ${src}`);
    expect(String(prompt.messages[0].content)).toContain("Write the answer in English");
    expect(String(prompt.messages[0].content)).not.toContain(en); // translations rank; original remains the evidence
  });

  it("only supplies contextual evidence when the English caption is absent", () => {
    const { picked, best } = selectContext(transcriptChunks([{ ...line, out: {} }]), question, 1500, ["said at 0:42"]);
    expect(picked[0].text).toBe(src);
    expect(best).toBeNull();
    expect(bestSentence(question, best, "en").covered).toBe(false); // no invented local translation
  });

  it("does not invent an answer absent from the Italian source and English caption", () => {
    const question = "When is the founder's birthday?";
    const { best } = selectContext(transcriptChunks([line]), question);
    expect(bestSentence(question, best, "en")).toEqual({ covered: false, text: "", cite: "" });
  });

  it("can request English explicitly in the existing phrase call without rewriting the Italian original", () => {
    const request = utterancePrompt({ text: src }, ["en", "hi"], []);
    expect(String(request.messages[0].content)).toContain("English, Hindi");
    expect(String(request.messages[0].content)).toContain('"en": string');
    expect(JSON.stringify(request.messages[1].content)).toContain(src);
    expect(request.max_tokens).toBe(300);
  });

  it("uses stored English translations in mock recaps and keeps legacy English sources", () => {
    expect(mockSummary([line], ["en"]).en).toBe(`- ${en}`);
    expect(mockSummary([{ ...line, src: en, out: {} }], ["en"]).en).toBe(`- ${en}`);
  });
});

// Recognition is a fake event emitter; no browser speech service, microphone or network is used.
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("Stage browser speech recognition language", () => {
  it.each([
    ["it-IT", undefined, "it-IT"],
    ["en-US", undefined, "en-US"],
    ["en-US", "it", "it-IT"],
  ])("uses browser %s and explicit language %s as %s", async (language, lang, expected) => {
    let recognition: FakeRecognition;
    class FakeRecognition {
      lang = "";
      startedLang = "";
      onstart?: () => void;
      onresult?: (event: unknown) => void;
      constructor() { recognition = this; }
      start() { this.startedLang = this.lang; this.onstart?.(); }
      stop() {}
    }
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    vi.stubGlobal("navigator", { language });
    // @ts-expect-error plain browser module, tested in Node
    const { phraseMic, phraseInit } = await import("../public/js/mic.js");
    const onPhrase = vi.fn();
    const stop = await phraseMic({ onPhrase, lang });
    expect(recognition!.lang).toBe(expected);
    expect(recognition!.startedLang).toBe(expected); // set before recording begins
    recognition!.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: src } }] });
    expect(onPhrase).toHaveBeenCalledWith(src, expect.any(Number));
    expect(phraseInit(onPhrase.mock.calls[0][0])).toEqual([{ "content-type": "application/json" }, JSON.stringify({ text: src })]);
    stop();
  });

  it("switches languages between recordings and restores the unchanged browser default", async () => {
    const recordings: FakeRecognition[] = [];
    class FakeRecognition {
      lang = "";
      stopped = false;
      onstart?: () => void;
      start() { recordings.push(this); this.onstart?.(); }
      stop() { this.stopped = true; }
    }
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    vi.stubGlobal("navigator", { language: "en-GB" });
    // @ts-expect-error plain browser module, tested in Node
    const { phraseMic } = await import("../public/js/mic.js");
    for (const selected of ["it", "en", ""]) {
      const stop = await phraseMic({ lang: selected || undefined, onPhrase: vi.fn() });
      stop();
    }
    expect(recordings.map((r) => r.lang)).toEqual(["it-IT", "en-US", "en-GB"]);
    expect(recordings.every((r) => r.stopped)).toBe(true);
  });

  it("keeps speaker languages independent, including automatic recognition restarts", async () => {
    const recordings: FakeRecognition[] = [];
    class FakeRecognition {
      lang = "";
      starts: string[] = [];
      onstart?: () => void;
      onend?: () => void;
      constructor() { recordings.push(this); }
      start() { this.starts.push(this.lang); this.onstart?.(); }
      stop() { this.onend?.(); }
    }
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    vi.stubGlobal("navigator", { language: "en-US" });
    // @ts-expect-error plain browser module, tested in Node
    const { phraseMic } = await import("../public/js/mic.js");
    const stopPresenter = await phraseMic({ lang: "it", onPhrase: vi.fn() });
    const stopCoSpeaker = await phraseMic({ lang: "en", onPhrase: vi.fn() });
    stopPresenter();
    const stopNewPresenter = await phraseMic({ lang: "es", onPhrase: vi.fn() });
    recordings[1].onend?.(); // silence restarts the co-speaker in their own language
    expect(recordings.map((r) => r.starts)).toEqual([["it-IT"], ["en-US", "en-US"], ["es-ES"]]);
    stopCoSpeaker();
    stopNewPresenter();
    expect(recordings.map((r) => r.starts.length)).toEqual([1, 2, 1]); // stopped sessions don't restart
  });

  it("supports the prefixed recognition API and exposes Eco's existing language choices", async () => {
    let usedLanguage = "";
    class FakeRecognition {
      lang = "";
      onstart?: () => void;
      start() { usedLanguage = this.lang; this.onstart?.(); }
      stop() {}
    }
    vi.stubGlobal("SpeechRecognition", undefined);
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    // @ts-expect-error plain browser module, tested in Node
    const { phraseMic, SPOKEN_LANGUAGES, hasSpeechRecognition } = await import("../public/js/mic.js");
    expect(hasSpeechRecognition).toBe(true);
    expect(SPOKEN_LANGUAGES).toEqual(["en", "it", "es", "hi", "fr", "de", "pt", "zh", "ja", "ko", "ar", "ru", "nl", "pl", "tr"]);
    const stop = await phraseMic({ lang: "it", onPhrase: vi.fn() });
    expect(usedLanguage).toBe("it-IT");
    stop();
  });

  it("reports unavailable browser recognition so the selector can be disabled for WAV upload", async () => {
    vi.stubGlobal("SpeechRecognition", undefined);
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    // @ts-expect-error plain browser module, tested in Node
    const { hasSpeechRecognition } = await import("../public/js/mic.js");
    expect(hasSpeechRecognition).toBe(false);
  });
});
