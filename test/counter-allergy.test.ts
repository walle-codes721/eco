import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// Exercise the real Counter turn handler with a fake AI client, no Workers runtime and no key.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  },
}));

import { Room } from "../src/room";
import * as client from "../src/tf";
import { noAllergenInfo, staffLine } from "../src/safety";

type Reply = Awaited<ReturnType<typeof client.tf>>;
const answer = (over: Record<string, unknown> = {}, lang = "en"): Reply => ({
  data: { src: "?", lang, to_owner: "?", answer: { covered: true, text: "", text_owner: "", cite: "allergens" }, ...over },
  live: true, ms: 1,
}) as Reply;

async function shop(pages: { tag: string; text: string }[]) {
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
  await room.init(id, { title: "Gelateria Luna", bizType: "restaurant", ownerLang: "it", pages });
  const post = async (init: RequestInit) => {
    const res = await room.fetch(new Request("https://room/turn", { method: "POST", headers: { "x-room": id, "x-ip": "t", ...(init.headers as object) }, body: init.body }));
    expect(res.status).toBe(200);
    return (await res.json()) as { turns: { side: string; src: string; out: string; cite?: string; allergy?: boolean }[]; open: boolean };
  };
  const say = (text: string, lang = "en", cid = "c1") =>
    post({ headers: { "content-type": "application/json" }, body: JSON.stringify({ side: "customer", cid, lang, text }) });
  const speak = (lang = "en", cid = "c1") =>
    post({ headers: { "content-type": "audio/wav", "x-side": "customer", "x-cid": cid, "x-lang": lang }, body: new Uint8Array(2000) });
  return { room, say, speak };
}

const withAllergens = [
  { tag: "menu", text: "Gelato flavours.\nPistachio: contains pistachio nuts and milk. Gluten-free." },
  { tag: "allergens", text: "Allergens\nNuts are used in our lab, so traces of nuts are possible in every flavour." },
  { tag: "hours", text: "Hours\nOpen every day 12:00 to 23:00." },
];
const noAllergens = [
  { tag: "menu", text: "Espresso €1.20\nCappuccino €1.80" },
  { tag: "hours", text: "Hours\nOpen every day 7:00 to 19:00." },
];
const last = <T extends { side: string }>(r: { turns: T[] }) => r.turns.filter((t) => t.side === "eco").at(-1)!;

describe("Counter: allergy and diet questions", () => {
  it("adds the owner's own words, the fixed confirm line (in both languages), and tells the owner", async () => {
    const { say } = await shop(withAllergens);
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(answer({
      src: "Is it safe for a nut allergy?", to_owner: "È sicuro per un'allergia alle noci?",
      answer: { covered: true, text: "Nuts are used in our lab.", text_owner: "Nel nostro laboratorio si usano le noci.", cite: "allergens" },
    }));
    try {
      const r = await say("Is it safe for a nut allergy?");
      const eco = last(r);
      expect(eco.src).toBe(`Nuts are used in our lab. ${staffLine("en")}`);
      expect(eco.out).toBe(`Nel nostro laboratorio si usano le noci. ${staffLine("it")}`);
      expect(eco.cite).toBe("allergens");
      expect(r.turns[0]).toMatchObject({ side: "customer", allergy: true });
      expect(r.open).toBe(true); // the owner is told, even though Eco answered
    } finally {
      spy.mockRestore();
    }
  });

  it("always gives the AI the owner's allergen text, even when the question shares no words with it", async () => {
    const filler = Array.from({ length: 8 }, (_, i) => ({ tag: `flavour ${i}`, text: `Flavour ${i}\n` + "A very tasty gelato, made in house every day. ".repeat(25) }));
    const { say } = await shop([...filler, { tag: "allergens", text: "Allergens\nNuts are used in our lab." }]);
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(answer({ answer: { covered: true, text: "Nuts are used.", text_owner: "Noci.", cite: "allergens" } }));
    try {
      await say("My daughter is coeliac. Can she have a cone?");
      expect(JSON.stringify(spy.mock.calls[0][3].messages[0])).toContain("Nuts are used in our lab");
    } finally {
      spy.mockRestore();
    }
  });

  it("never guesses: a confident 'yes' from a list that says nothing about allergens becomes the fixed reply", async () => {
    const { say } = await shop(noAllergens);
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(answer({
      src: "Is the espresso gluten free?", answer: { covered: true, text: "Yes, it is completely safe!", text_owner: "Sì, è sicuro!", cite: "menu" },
    }));
    try {
      const r = await say("Is the espresso gluten free?");
      const eco = last(r);
      expect(eco.src).toBe(noAllergenInfo("en"));
      expect(eco.out).toBe(noAllergenInfo("it"));
      expect(eco.src).not.toContain("safe");
      expect(eco.cite).toBe("");
      expect(r.open).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("gives the fixed reply, not silence, when the owner wrote about allergens but not about this", async () => {
    const { say } = await shop(withAllergens);
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(answer({ answer: { covered: false, text: "", text_owner: "", cite: "" } }));
    try {
      const r = await say("Is the lemon sorbet free from celery?");
      expect(last(r).src).toBe(noAllergenInfo("en"));
      expect(r.open).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("uses the customer's own language for the fixed line", async () => {
    const { say } = await shop(withAllergens);
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(answer({
      src: "C'è glutine?", lang: "it", to_owner: "C'è glutine?", answer: { covered: true, text: "Il pistacchio è senza glutine.", text_owner: "Il pistacchio è senza glutine.", cite: "menu" },
    }, "it"));
    try {
      const r = await say("C'è glutine?", "it");
      expect(last(r).src).toBe(`Il pistacchio è senza glutine. ${staffLine("it")}`);
    } finally {
      spy.mockRestore();
    }
  });

  it("recognises a spoken allergy question once it is transcribed", async () => {
    const { speak } = await shop(withAllergens);
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(answer({
      src: "Is this gluten free?", to_owner: "È senza glutine?", answer: { covered: true, text: "Yes, gluten-free.", text_owner: "Sì, senza glutine.", cite: "menu" },
    }));
    try {
      const r = await speak();
      expect(r.turns[0].allergy).toBe(true);
      expect(last(r).src).toBe(`Yes, gluten-free. ${staffLine("en")}`);
      expect(r.open).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("leaves every other question exactly as before", async () => {
    const { say } = await shop(withAllergens);
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(answer({
      src: "What time do you open?", to_owner: "A che ora aprite?", answer: { covered: true, text: "Open every day 12:00 to 23:00.", text_owner: "Aperto ogni giorno dalle 12:00 alle 23:00.", cite: "hours" },
    }));
    try {
      const r = await say("What time do you open?");
      expect(r.turns[0].allergy).toBeUndefined();
      expect(last(r)).toMatchObject({ src: "Open every day 12:00 to 23:00.", out: "Aperto ogni giorno dalle 12:00 alle 23:00.", cite: "hours" });
      expect(last(r).src).not.toContain(staffLine("en"));
      expect(r.open).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("works in mock mode too, with no AI at all", async () => {
    const { say } = await shop(withAllergens);
    const r = await say("Is the pistachio gluten free?");
    expect(r.turns[0].allergy).toBe(true);
    expect(last(r).src.endsWith(staffLine("en"))).toBe(true);
    expect(r.open).toBe(true);
  });

  it("a later ordinary question does not cancel the owner's alert until the owner has replied", async () => {
    const { say, room } = await shop(withAllergens);
    const spy = vi.spyOn(client, "tf")
      .mockResolvedValueOnce(answer({ src: "Is it vegan?", answer: { covered: true, text: "Some flavours are.", text_owner: "Alcuni lo sono.", cite: "menu" } }))
      .mockResolvedValueOnce(answer({ src: "What time do you open?", answer: { covered: true, text: "Open every day 12:00 to 23:00.", text_owner: "Aperto ogni giorno.", cite: "hours" } }))
      .mockResolvedValueOnce({ data: { src: "Sì, due gusti sono vegani.", out: "Yes, two flavours are vegan." }, live: true, ms: 1 } as Reply) // the owner's reply is translated by the AI too
      .mockResolvedValueOnce(answer({ src: "And do you take cards?", answer: { covered: true, text: "Yes.", text_owner: "Sì.", cite: "payment" } }));
    try {
      expect((await say("Is it vegan?")).open).toBe(true);
      expect((await say("What time do you open?")).open).toBe(true); // still waiting for the owner
      expect(room.convos[0].open).toBe(true);
      const reply = await room.fetch(new Request("https://room/turn", {
        method: "POST", headers: { "x-room": "counter/test/gelato", "x-key": room.meta!.hostKey, "content-type": "application/json" },
        body: JSON.stringify({ side: "owner", cid: "c1", text: "Sì, due gusti sono vegani." }),
      }));
      expect(reply.status).toBe(200);
      expect(room.convos[0].open).toBe(false); // the owner has answered
      expect((await say("And do you take cards?")).open).toBe(false); // an ordinary question no longer raises it
    } finally {
      spy.mockRestore();
    }
  });

  it("the owner closing the conversation by replying still works after an allergy question", async () => {
    const { say, room } = await shop(withAllergens);
    await say("Is it vegan?");
    expect(room.convos[0].open).toBe(true);
    const res = await room.fetch(new Request("https://room/turn", {
      method: "POST", headers: { "x-room": "counter/test/gelato", "x-key": room.meta!.hostKey, "content-type": "application/json" },
      body: JSON.stringify({ side: "owner", cid: "c1", text: "Sì, abbiamo gusti vegani." }),
    }));
    expect(res.status).toBe(200);
    expect(room.convos[0].open).toBe(false);
  });
});
