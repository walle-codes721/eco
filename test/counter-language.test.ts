import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// Counter language routing: the customer's selection (hint) stays authoritative
// unless the model returns a clean 2-letter code. Mock AI path, no live calls.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  },
}));

import { Room } from "../src/room";
import { DEMO_SHOP } from "../src/fixtures/demo";
import { customerTurnPrompt, ownerTurnPrompt, langName } from "../src/prompts";
import * as client from "../src/tf";

let n = 0;

async function testCounter() {
  const saved = new Map<string, unknown>();
  let ready: Promise<unknown>;
  const ctx = {
    storage: {
      get: async (keys: string[]) => new Map(keys.map((key) => [key, saved.get(key)])),
      put: async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) saved.set(key, value); },
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => (ready = fn()),
    getWebSockets: () => [],
    waitUntil: (promise: Promise<unknown>) => { void promise; },
  };
  const room = new Room(ctx as unknown as DurableObjectState, { ECO_LIVE: "0" } as Env);
  await ready!;
  const id = "counter/test/gelato";
  await room.init(id, { title: "Gelateria Luna", bizType: "restaurant", ownerLang: "it", pages: DEMO_SHOP.sources });
  const key = room.meta!.hostKey;
  const turn = async (body: unknown, opts: { key?: string } = {}) => {
    const response = await room.fetch(new Request("https://room/turn", {
      method: "POST",
      headers: {
        "x-room": id, "x-ip": `test-${n++}`, "content-type": "application/json",
        ...(opts.key ? { "x-key": opts.key } : {}),
      },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(200);
    return response.json() as Promise<{ type: string; cid: string; lang: string; open: boolean; turns: any[] }>;
  };
  const turnAudio = async (cid: string, xlang: string | null, stubData: any) => {
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce({ data: stubData, live: true, ms: 0 });
    try {
      const headers: Record<string, string> = {
        "x-room": id, "x-ip": `test-${n++}`, "content-type": "audio/wav",
        "x-side": "customer", "x-cid": cid,
      };
      if (xlang !== null) headers["x-lang"] = xlang;
      const response = await room.fetch(new Request("https://room/turn", {
        method: "POST", headers, body: new Uint8Array(2000),
      }));
      expect(response.status).toBe(200);
      return response.json() as Promise<{ type: string; cid: string; lang: string; open: boolean; turns: any[] }>;
    } finally {
      spy.mockRestore();
    }
  };
  return { room, key, turn, turnAudio };
}

// Gelato price questions; the English-only list can't match non-English ones
// locally, so mock mode leaves them uncovered (open) — the live model answers.
const PRICE_QS: [string, string][] = [
  ["hi", "छोटे कप की कीमत क्या है?"],
  ["it", "Quanto costa una tazzina piccola?"],
  ["es", "¿Cuánto cuesta la taza pequeña?"],
  ["fr", "Combien coûte le petit pot ?"],
  ["de", "Wie viel kostet der kleine Becher?"],
];

describe("counter customer language routing", () => {
  it.each(PRICE_QS)("keeps the customer's selected %s on the convo and its turns", async (lang, text) => {
    const { room, turn } = await testCounter();
    const cid = `c-${lang}`;
    const m = await turn({ side: "customer", cid, lang, text });
    expect(m.lang).toBe(lang);
    expect(m.open).toBe(true); // mock can't translate the English list: waits for the owner
    const convo = room.convos.find((c) => c.id === cid)!;
    expect(convo.lang).toBe(lang); // the owner's label reads this
    expect(convo.turns).toHaveLength(1);
    expect(convo.turns[0]).toMatchObject({ side: "customer", lang });
  });

  it("answers a covered English question from the list and closes the convo", async () => {
    const { room, turn } = await testCounter();
    const m = await turn({ side: "customer", cid: "c-en", lang: "en", text: "Is the pistachio gluten-free?" });
    expect(m.lang).toBe("en");
    expect(m.open).toBe(false);
    expect(m.turns).toHaveLength(2);
    expect(m.turns[1]).toMatchObject({ side: "eco", lang: "en", cite: "menu" });
    expect(room.convos.find((c) => c.id === "c-en")!.open).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["three letters", "hin"],
    ["regional", "hi-IN"],
    ["unknown code", "xx"],
    ["not a language", "!!"],
  ])("falls back to the selection when the model returns an unusable lang (%s)", async (_name, bad) => {
    const { room, turn } = await testCounter();
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce({
      data: { src: "छोटे कप की कीमत क्या है?", lang: bad, to_owner: "Quanto costa?", answer: { covered: false, text: "", text_owner: "", cite: "" } },
      live: true, ms: 0,
    });
    try {
      const m = await turn({ side: "customer", cid: "c-hi", lang: "hi", text: "छोटे कप की कीमत क्या है?" });
      expect(m.lang).toBe("hi");
      expect(room.convos.find((c) => c.id === "c-hi")!.lang).toBe("hi");
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the ongoing language when a later model reply has no usable lang", async () => {
    const { room, turn } = await testCounter();
    await turn({ side: "customer", cid: "c-hi", lang: "hi", text: "छोटे कप की कीमत क्या है?" });
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce({
      data: { src: "1 किलो?", lang: "", to_owner: "1 chilo?", answer: { covered: false, text: "", text_owner: "", cite: "" } },
      live: true, ms: 0,
    });
    try {
      const m = await turn({ side: "customer", cid: "c-hi", lang: "hi", text: "1 किलो?" });
      expect(m.lang).toBe("hi");
    } finally {
      spy.mockRestore();
    }
  });

  it("accepts a clean code with different case or padding", async () => {
    const { turn } = await testCounter();
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce({
      data: { src: "Come Blätter?", lang: " DE ", to_owner: "Come Blätter?", answer: { covered: false, text: "", text_owner: "", cite: "" } },
      live: true, ms: 0,
    });
    try {
      expect((await turn({ side: "customer", cid: "c-de", lang: "de", text: "Come Blätter?" })).lang).toBe("de");
    } finally {
      spy.mockRestore();
    }
  });

  it("stores a covered live-style answer in the customer language plus the owner translation", async () => {
    const { room, turn } = await testCounter();
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce({
      data: {
        src: "क्या आप एक किलो का डिब्बा देते हैं?", lang: "hi", to_owner: "Fate una vaschetta da un chilo?",
        answer: { covered: true, text: "हाँ, 1 किलो €22.00।", text_owner: "Sì, 1 kg €22,00.", cite: "prices" },
      },
      live: true, ms: 0,
    });
    try {
      const m = await turn({ side: "customer", cid: "c-hi", lang: "hi", text: "क्या आप एक किलो का डिब्बा देते हैं?" });
      expect(m.lang).toBe("hi");
      expect(m.open).toBe(false);
      const [, eco] = room.convos.find((c) => c.id === "c-hi")!.turns;
      // Customer reads Hindi; the owner reads the Italian translation — both kept.
      expect(eco).toMatchObject({ side: "eco", lang: "hi", src: "हाँ, 1 किलो €22.00।", out: "Sì, 1 kg €22,00.", cite: "prices" });
    } finally {
      spy.mockRestore();
    }
  });

  it("stores the owner reply in the owner language and closes the convo", async () => {
    const { room, key, turn } = await testCounter();
    await turn({ side: "customer", cid: "c-hi", lang: "hi", text: "छोटे कप की कीमत क्या है?" });
    const m = await turn({ side: "owner", cid: "c-hi", text: "La tazzina piccola costa €3,00." }, { key });
    expect(m.open).toBe(false);
    const last = room.convos.find((c) => c.id === "c-hi")!.turns.at(-1)!;
    expect(last).toMatchObject({ side: "owner", lang: "it" });
  });
});

describe("counter prompts per customer language", () => {
  const biz = { name: "Gelateria Luna", type: "restaurant", ownerLang: "it" };
  it.each([
    ["hi", "Hindi"],
    ["it", "Italian"],
    ["es", "Spanish"],
    ["fr", "French"],
    ["de", "German"],
  ])("customer turn asks for %s detection plus the Italian owner translation", (_code, name) => {
    const p = customerTurnPrompt(biz, [], { text: "price?" });
    const sys = String(p.messages[0].content);
    expect(sys).toContain("Italian"); // to_owner + text_owner target
    expect(sys).toContain('"to_owner": string');
    expect(sys).toContain('"text_owner": string');
    expect(langName(_code)).toBe(name);
  });

  it.each([
    ["hi", "Hindi"],
    ["it", "Italian"],
    ["es", "Spanish"],
    ["fr", "French"],
    ["de", "German"],
  ])("owner reply is translated into the customer language (%s)", (code, name) => {
    const sys = String(ownerTurnPrompt("it", code, { text: "ciao" }).messages[0].content);
    expect(sys).toContain(name);
  });
});

describe("counter explicit selection vs model detection", () => {
  const uncovered = (lang: string) => ({
    src: "q", lang, to_owner: "q (owner)",
    answer: { covered: false, text: "", text_owner: "", cite: "" },
  });

  it("keeps German when the model wrongly detects Hindi", async () => {
    const { room, turn } = await testCounter();
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce({
      data: { ...uncovered("hi"), src: "Wie viel kostet der kleine Becher?" }, live: true, ms: 0,
    });
    try {
      const m = await turn({ side: "customer", cid: "c-de", lang: "de", text: "Wie viel kostet der kleine Becher?" });
      expect(m.lang).toBe("de");
      expect(room.convos.find((c) => c.id === "c-de")!.lang).toBe("de");
      expect(m.turns[0]).toMatchObject({ side: "customer", lang: "de" });
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps Italian when the model wrongly detects English, with a covered answer", async () => {
    const { room, turn } = await testCounter();
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce({
      data: {
        src: "Quanto costa una tazzina piccola?", lang: "en", to_owner: "Quanto costa (owner)",
        answer: { covered: true, text: "Costa \u20AC3,00.", text_owner: "Costa \u20AC3,00 (owner).", cite: "prices" },
      },
      live: true, ms: 0,
    });
    try {
      const m = await turn({ side: "customer", cid: "c-it", lang: "it", text: "Quanto costa una tazzina piccola?" });
      expect(m.lang).toBe("it");
      expect(m.open).toBe(false);
      const [, eco] = room.convos.find((c) => c.id === "c-it")!.turns;
      expect(eco).toMatchObject({ side: "eco", lang: "it", cite: "prices" });
    } finally {
      spy.mockRestore();
    }
  });

  it("still applies model detection to raw audio, where the language is genuinely unknown", async () => {
    const { room, turnAudio } = await testCounter();
    const m = await turnAudio("c-au", "en", { ...uncovered("hi"), src: "(audio hindi)" });
    expect(m.lang).toBe("hi");
    expect(room.convos.find((c) => c.id === "c-au")!.lang).toBe("hi");
  });

  it("falls back to the audio header hint when detection is unusable", async () => {
    const { turnAudio } = await testCounter();
    expect((await turnAudio("c-fr", "fr", uncovered(""))).lang).toBe("fr");
  });

  it("applies a changed selector on the next typed turn of the same conversation", async () => {
    const { room, key, turn } = await testCounter();
    await turn({ side: "customer", cid: "c-switch", lang: "de", text: "Wie viel kostet der kleine Becher?" });
    expect(room.convos.find((c) => c.id === "c-switch")!.lang).toBe("de");
    // Selector switched to Italian while the model still claims German: the explicit choice wins.
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce({
      data: { ...uncovered("de"), src: "Quanto costa una tazzina piccola?" }, live: true, ms: 0,
    });
    try {
      expect((await turn({ side: "customer", cid: "c-switch", lang: "it", text: "Quanto costa una tazzina piccola?" })).lang).toBe("it");
    } finally {
      spy.mockRestore();
    }
    const owner = await turn({ side: "owner", cid: "c-switch", text: "Costa \u20AC3,00." }, { key });
    expect(owner.open).toBe(false);
    expect(room.convos.find((c) => c.id === "c-switch")!.turns.at(-1)).toMatchObject({ side: "owner", lang: "it" });
  });

  it("keeps the convo language when a typed turn carries no usable hint", async () => {
    const { room, turn } = await testCounter();
    await turn({ side: "customer", cid: "c-nohint", lang: "de", text: "Wie viel kostet der kleine Becher?" });
    expect((await turn({ side: "customer", cid: "c-nohint", text: "Noch eine Frage" })).lang).toBe("de");
    expect(room.convos.find((c) => c.id === "c-nohint")!.lang).toBe("de");
  });
});
