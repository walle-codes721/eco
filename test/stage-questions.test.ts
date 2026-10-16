import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// Exercise the real room question handler and mock AI path without a Workers runtime or API key.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  },
}));

import { Room, type Line } from "../src/room";
import { MODELS } from "../src/prompts";
import * as client from "../src/tf";

const question = "यह कंपनी कितने देशों में काम करती है?";
const line = (seq: number, countries: number): Line => ({
  seq, at: seq * 10, t: seq * 10000, slide: 7, speaker: "s0", ms: 0, live: false, flags: [],
  src: `We operate in ${countries} countries.`, out: { hi: `हम ${countries} देशों में काम करते हैं।` },
});

async function testRoom(pages = Array.from({ length: 6 }, (_, i) => ({
  tag: `slide ${i + 1}`, text: "Unrelated product background. ".repeat(40).slice(0, 1000),
})), mode: "stage" | "counter" = "stage") {
  const saved = new Map<string, unknown>();
  const listenerMessages: Record<string, unknown>[] = [];
  let ready: Promise<unknown>;
  const ctx = {
    storage: {
      get: async (keys: string[]) => new Map(keys.map((key) => [key, saved.get(key)])),
      put: async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) saved.set(key, value); },
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => (ready = fn()),
    getWebSockets: (tag?: string) => tag === "listener" ? [{ send: (msg: string) => listenerMessages.push(JSON.parse(msg)) }] : [],
    waitUntil: (promise: Promise<unknown>) => { void promise; },
  };
  const room = new Room(ctx as unknown as DurableObjectState, { ECO_LIVE: "0" } as Env);
  await ready!;
  const id = `${mode}/test/multilingual`;
  await room.init(id, {
    langs: ["hi"],
    pages,
  });
  return {
    room,
    listenerMessages,
    saved,
    update: async (action: string, body: unknown) => {
      const response = await room.fetch(new Request(`https://room/${action}`, {
        method: "POST", headers: { "x-room": id, "x-key": room.meta!.hostKey, "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      expect(response.status).toBe(200);
      return response.json();
    },
    ask: async (text = question, lang = "hi") => {
      const response = await room.fetch(new Request("https://room/ask", {
        method: "POST", headers: { "x-room": id, "x-ip": "test", "content-type": "application/json" },
        body: JSON.stringify({ text, lang }),
      }));
      expect(response.status).toBe(200);
      return response.json() as Promise<{ id: string; covered: boolean; answer: string; cite: string; cached: boolean }>;
    },
  };
}

describe("Stage question flow", () => {
  it.each([{ langs: ["it", "es", "hi"] }, { langs: ["en", "it", "hi"] }])("requests English once alongside $langs in one capped phrase call", async ({ langs }) => {
    const { room, update } = await testRoom();
    room.meta!.langs = langs;
    const spy = vi.spyOn(client, "tf");
    try {
      await update("utterance", { text: "La nostra azienda opera in 15 paesi." });
      expect(spy).toHaveBeenCalledTimes(1);
      const prompt = spy.mock.calls[0][3];
      const messages = JSON.stringify(prompt.messages);
      for (const lang of new Set(["en", ...langs])) expect(messages.split(`\\"${lang}\\": string`)).toHaveLength(2);
      expect(prompt.max_tokens).toBe(300);
      expect(prompt.response_format).toEqual({ type: "json_object" });
      expect(room.lines[0].src).toBe("La nostra azienda opera in 15 paesi.");
      if (!langs.includes("en")) expect(room.lines[0].out.en).toBeUndefined(); // the real mock cannot translate
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["presenter", "co-speaker"])("answers in English from an Italian %s with a stored English caption", async (role) => {
    const { room, ask, saved } = await testRoom();
    expect(room.meta!.langs).not.toContain("en"); // English listeners are supported without configuring another room target
    const src = "La nostra azienda opera in 15 paesi.";
    const en = "Our company operates in 15 countries.";
    let auth: Record<string, string> = { "x-key": room.meta!.hostKey };
    let speaker = "s0";
    if (role === "co-speaker") {
      // The presenter loads metadata to obtain the join QR before a co-speaker joins.
      await room.fetch(new Request("https://room/meta", { headers: { "x-room": room.meta!.id, ...auth } }));
      const joined = await room.fetch(new Request("https://room/join", {
        method: "POST", headers: { "x-room": room.meta!.id, "x-join": room.meta!.joinKey!, "content-type": "application/json" },
        body: JSON.stringify({ name: "Italian speaker" }),
      }));
      expect(joined.status).toBe(200);
      const body = await joined.json() as { key: string; id: string };
      auth = { "x-speaker-key": body.key };
      speaker = body.id;
    }
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce({ data: { src, out: { en }, flags: [] }, live: false, ms: 0 });
    try {
      const spoken = await room.fetch(new Request("https://room/utterance", {
        method: "POST", headers: { "x-room": room.meta!.id, ...auth, "content-type": "application/json" },
        body: JSON.stringify({ text: src }),
      }));
      expect(spoken.status).toBe(200);
      expect(saved.get("lines")).toEqual([expect.objectContaining({ src, out: { en }, speaker })]);
      expect(JSON.stringify(spy.mock.calls[0][3].messages)).toContain('\\"en\\": string');
      expect(JSON.stringify(spy.mock.calls[0][3].messages)).toContain('\\"hi\\": string');
      expect(spy.mock.calls[0][3].max_tokens).toBe(300);
      const text = "How many countries does the company operate in?";
      expect(await ask(text, "en")).toMatchObject({ covered: true, answer: en, cite: "said at 0:00", cached: false });
      expect((await ask(text, "en")).cached).toBe(true);
      expect(spy).toHaveBeenCalledTimes(2); // one fixture translation, one offline answer
      expect(JSON.stringify(spy.mock.calls[1][3].messages)).toContain(`[said at 0:00] ${src}`);
      expect(JSON.stringify(spy.mock.calls[1][3].messages)).toContain("Write the answer in English");
    } finally {
      spy.mockRestore();
    }
  });

  it("uses browser text captions for Hindi Q&A and invalidates a cached miss", async () => {
    const { room, ask, update } = await testRoom();
    expect(await ask()).toMatchObject({ covered: false, cached: false });
    expect((await ask()).cached).toBe(true);
    // Supply a translation fixture locally; neither the browser STT service nor an AI API is contacted.
    const phrase = line(1, 15);
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce({
      data: { src: phrase.src, out: phrase.out, flags: [] }, live: false, ms: 0,
    });
    try {
      await update("utterance", { text: phrase.src });
      expect(room.lines).toHaveLength(1);
      expect(room.lines[0]).toMatchObject({ src: phrase.src, out: phrase.out, seq: 1 });
      const [, kind, model, request] = spy.mock.calls[0];
      expect(kind).toBe("utterance");
      expect(model).toBe(MODELS.answer); // tf handles Gemma availability and automatic fallback
      expect(request.response_format).toEqual({ type: "json_object" });
      expect(JSON.stringify(request.messages)).toContain(phrase.src);
      expect(JSON.stringify(request.messages)).not.toContain("input_audio");
      expect(await ask()).toMatchObject({
        covered: true, answer: phrase.out.hi, cite: "said at 0:00", cached: false,
      });
      expect((await ask()).cached).toBe(true);
      expect(spy).toHaveBeenCalledTimes(2); // one phrase translation and one answer, no translation for retrieval
      expect(JSON.stringify(spy.mock.calls[1][3].messages)).toContain(phrase.src);
      expect(spy.mock.calls[1][3].response_format).toEqual({ type: "json_object" });
    } finally {
      spy.mockRestore();
    }
  });

  it("answers in Hindi from stored captions and caches an unchanged transcript with one model operation", async () => {
    const { room, ask } = await testRoom();
    room.lines = [line(1, 15)];
    const spy = vi.spyOn(client, "tf");
    try {
      expect(await ask()).toMatchObject({ covered: true, answer: "हम 15 देशों में काम करते हैं।", cite: "said at 0:10", cached: false });
      expect(await ask()).toMatchObject({ cached: true });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(spy.mock.calls[0][3].messages)).toContain("We operate in 15 countries.");
    } finally {
      spy.mockRestore();
    }
  });

  it("reconsiders a previously uncovered question after new speech arrives", async () => {
    const { room, ask } = await testRoom();
    expect(await ask()).toMatchObject({ covered: false, cached: false });
    expect(await ask()).toMatchObject({ covered: false, cached: true });
    room.lines.push(line(1, 15));
    expect(await ask()).toMatchObject({ covered: true, answer: "हम 15 देशों में काम करते हैं।", cached: false });
  });

  it("does not reuse an old answer after the retained transcript changes", async () => {
    const { room, ask } = await testRoom();
    room.lines = [line(1, 15)];
    expect((await ask()).answer).toContain("15");
    room.lines = [line(2, 20)];
    expect(await ask()).toMatchObject({ cached: false, answer: "हम 20 देशों में काम करते हैं।" });
  });

  it.each([
    ["hi", question, "Hindi"],
    ["it", "In quanti paesi lavora questa azienda?", "Italian"],
    ["es", "¿En cuántos países trabaja esta empresa?", "Spanish"],
    ["en", "How many countries does this company work in?", "English"],
  ])("passes useful English-only slide evidence to the existing %s answer call", async (lang, text, language) => {
    const pages = Array.from({ length: 20 }, (_, i) => ({
      tag: `slide ${i + 1}`,
      text: ((i === 11 ? "Our reach\nWe operate in 15 countries.\n" : "Our team\nWe employ 50 people.\n") +
        "Product background. ".repeat(100)).slice(0, 1000),
    }));
    const { room, ask, update } = await testRoom(pages);
    await update("slide", { n: 12 });
    expect(room.lines).toHaveLength(0); // no captions or translated source text
    const spy = vi.spyOn(client, "tf");
    try {
      const response = await ask(text, lang);
      expect(response.cached).toBe(false);
      expect(await ask(text, lang)).toMatchObject({ cached: true });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toBe("ask");
      const messages = JSON.stringify(spy.mock.calls[0][3].messages);
      expect(messages).toContain("[slide 12] Our reach\\nWe operate in 15 countries.");
      expect(messages).toContain(`Write the answer in ${language}`);
      if (lang === "en") expect(response).toMatchObject({ covered: true, answer: "We operate in 15 countries.", cite: "slide 12" });
      else expect(response).toMatchObject({ covered: false, answer: "", cite: "" }); // mock cannot translate English-only text
    } finally {
      spy.mockRestore();
    }
  });

  it("rechecks after slide navigation and source edits, while reusing unchanged context", async () => {
    const { ask, update } = await testRoom([
      { tag: "slide 1", text: "Welcome." }, { tag: "slide 2", text: "We operate in 15 countries." },
    ]);
    expect((await ask()).cached).toBe(false);
    expect((await ask()).cached).toBe(true);
    await update("slide", { n: 2 });
    expect((await ask()).cached).toBe(false);
    expect((await ask()).cached).toBe(true);
    await update("sources", { pages: [{ tag: "slide 2", text: "We operate in 20 countries." }] });
    expect((await ask()).cached).toBe(false);
  });

  it("does not repeat an answer call after navigation when the selected evidence is identical", async () => {
    const { ask, update } = await testRoom([
      { tag: "slide 1", text: "Welcome." }, { tag: "slide 2", text: "We operate in 15 countries." },
    ]);
    const spy = vi.spyOn(client, "tf");
    try {
      const text = "How many countries do we operate in?";
      expect(await ask(text, "en")).toMatchObject({ cached: false, answer: "We operate in 15 countries.", cite: "slide 2" });
      await update("slide", { n: 2 });
      expect(await ask(text, "en")).toMatchObject({ cached: true, answer: "We operate in 15 countries.", cite: "slide 2" });
      await update("slide", { n: 1 });
      expect((await ask(text, "en")).cached).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("rechecks a cached miss when navigation supplies new evidence and when that source is edited", async () => {
    const pages = Array.from({ length: 20 }, (_, i) => ({
      tag: `slide ${i + 1}`,
      text: ((i === 11 ? "We operate in 15 countries. " : "Background. ") + "Product details. ".repeat(100)).slice(0, 1000),
    }));
    const { ask, update } = await testRoom(pages);
    const spy = vi.spyOn(client, "tf");
    try {
      expect(await ask()).toMatchObject({ cached: false, covered: false });
      expect(JSON.stringify(spy.mock.calls[0][3].messages)).not.toContain("15 countries");
      await update("slide", { n: 12 });
      expect((await ask()).cached).toBe(false);
      expect((await ask()).cached).toBe(true);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(spy.mock.calls[1][3].messages)).toContain("15 countries");
      await update("sources", { pages: pages.map((p) => ({ ...p, text: p.text.replace("15 countries", "20 countries") })) });
      expect((await ask()).cached).toBe(false);
      expect(spy).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(spy.mock.calls[2][3].messages)).toContain("20 countries");
      expect(JSON.stringify(spy.mock.calls[2][3].messages)).not.toContain("15 countries");
    } finally {
      spy.mockRestore();
    }
  });

  it("includes recent English speech even without translated captions or a usable current slide", async () => {
    const { room, ask } = await testRoom();
    room.meta!.slide = 99; // e.g. slide text was not extracted
    room.lines = [{ ...line(1, 15), out: {} }];
    const spy = vi.spyOn(client, "tf");
    try {
      expect(await ask()).toMatchObject({ covered: false, answer: "", cite: "" });
      expect(JSON.stringify(spy.mock.calls[0][3].messages)).toContain("[said at 0:10] We operate in 15 countries.");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Teach Eco with multilingual retrieval", () => {
  it("keeps cached evidence when a speaker only marks a question answered or teaches an existing entry", async () => {
    const answer = "We operate in 15 countries.";
    const { room, ask, update, listenerMessages } = await testRoom([
      { tag: "slide 1", text: "Welcome." },
      { tag: "answers", text: `Q: How many countries?\nA: ${answer}` },
    ]);
    // The mock cannot translate English sources, but its miss already includes this taught evidence.
    const missing = await ask();
    expect(missing.covered).toBe(false);
    const cache = { ...room.cache };
    const spy = vi.spyOn(client, "tf");
    try {
      await update("answered", { qids: [missing.id] });
      expect(room.cache).toEqual(cache);
      expect((await ask()).cached).toBe(true);
      expect(await update("addanswer", { qids: [missing.id], q: "How many countries?", a: answer })).toMatchObject({ added: false });
      expect(room.cache).toEqual(cache); // no changed source and no model operation
      expect(spy).not.toHaveBeenCalled();
      expect(listenerMessages).toContainEqual({ type: "answered", qids: [missing.id], at: 0, answer });
      expect(await ask("How many countries?", "en")).toMatchObject({ covered: true, answer, cite: "answers" });
    } finally {
      spy.mockRestore();
    }
  });

  it("teaches Stage questions, updates listeners, and invalidates answers when taught sources change", async () => {
    const { room, ask, update, listenerMessages } = await testRoom([
      { tag: "slide 1", text: "Welcome." }, { tag: "notes", text: "Speaker notes." },
    ]);
    const first = await ask();
    const second = await ask();
    expect(first).toMatchObject({ covered: false, cached: false });
    expect(second.cached).toBe(true);
    const answer = "हम 15 देशों में काम करते हैं।";
    const spy = vi.spyOn(client, "tf");
    try {
      await update("addanswer", { qids: [first.id, second.id], q: "How many countries?", asked: question, a: answer });
      expect(spy).not.toHaveBeenCalled();
      expect(room.cache).toEqual({});
      expect(room.questions.slice(0, 2).every((q) => q.taught === answer && q.answeredAt !== null)).toBe(true);
      expect(listenerMessages).toContainEqual({ type: "answered", qids: [first.id, second.id], at: 0, answer });
      expect(room.publicMeta().slides).toEqual([{ tag: "slide 1", text: "Welcome." }]);
      await update("slide", { n: 3 });
      expect(room.meta!.slide).toBe(1); // notes and answers do not become slides
      expect(await ask()).toMatchObject({ covered: true, cached: false, answer, cite: "answers" });
      expect((await ask()).cached).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(spy.mock.calls[0][3].messages)).toContain("Write the answer in Hindi");

      await update("sources", { pages: room.pages.map((p) => ({ ...p, text: p.text.replace("15", "20") })) });
      expect(await ask()).toMatchObject({ cached: false, answer: answer.replace("15", "20"), cite: "answers" });
      await update("sources", { pages: [{ tag: "slide 1", text: "Welcome." }] });
      expect(await ask()).toMatchObject({ covered: false, cached: false, answer: "", cite: "" });
      expect((await ask()).cached).toBe(true);
      expect(spy).toHaveBeenCalledTimes(3);
      // A direct speaker reply remains historical; it is not used as a current cached/source answer.
      expect(room.questions[0].taught).toBe(answer);
    } finally {
      spy.mockRestore();
    }
  });

  it("clears a cached miss and retrieves an owner-approved answer by the original Hindi question", async () => {
    const { room, ask, update } = await testRoom([], "counter");
    expect(await ask()).toMatchObject({ covered: false, cached: false });
    expect((await ask()).cached).toBe(true);
    const answer = "We operate in 15 countries.";
    room.convos = [{
      id: "convo", lang: "hi", started: 0, open: true,
      turns: [{ id: "reply", t: 0, side: "owner", lang: "en", src: answer, out: "हम 15 देशों में काम करते हैं।", live: false }],
    }];
    const spy = vi.spyOn(client, "tf");
    try {
      await update("addanswer", { cid: "convo", tid: "reply", q: "How many countries?", asked: question, a: answer });
      expect(spy).not.toHaveBeenCalled();
      expect(room.cache).toEqual({});
      expect(room.convos[0].turns[0].taught).toBe(true);
      expect(room.pages[0].text).toContain(`Asked as: ${question}`);
      // Mock mode quotes the approved answer verbatim; it cannot translate it.
      expect(await ask()).toMatchObject({ covered: true, answer, cite: "answers", cached: false });
      expect((await ask()).cached).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(spy.mock.calls[0][3].messages)).toContain("Write the answer in Hindi");
    } finally {
      spy.mockRestore();
    }
  });
});
