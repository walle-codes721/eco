import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// Exercise the real Counter turn handler for pharmacies, clinics and hospitals, with a fake AI client.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  },
}));

import { Room } from "../src/room";
import * as client from "../src/tf";
import { adviceLine, emergencyLine } from "../src/health";
import { staffLine } from "../src/safety";

type Reply = Awaited<ReturnType<typeof client.tf>>;
const answer = (over: Record<string, unknown> = {}, lang = "en"): Reply => ({
  data: { src: "?", lang, to_owner: "?", answer: { covered: true, text: "", text_owner: "", cite: "hours" }, ...over },
  live: true, ms: 1,
}) as Reply;
// What a careless model would say: a confident medical answer. It must never reach the customer.
const risky = (src: string, lang = "en") => answer({ src, lang, to_owner: src, answer: { covered: true, text: "Take two tablets every four hours.", text_owner: "Prendi due compresse ogni quattro ore.", cite: "hours" } }, lang);

const pages = [
  { tag: "hours", text: "Hours\nOpen every day 8:00 to 20:00." },
  { tag: "services", text: "Services\nBlood pressure check €5. Flu vaccination €20." },
  { tag: "products", text: "Products\nCream with almond oil. Bandages. Painkillers on request." },
  { tag: "allergens", text: "Allergens\nThe cream contains almond oil (tree nuts)." },
];

async function health(bizType: string, extra: Record<string, unknown> = {}) {
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
  const id = "counter/test/front-desk";
  await room.init(id, { title: "Front desk", bizType, ownerLang: "it", pages, ...extra });
  const post = async (init: RequestInit) => {
    const res = await room.fetch(new Request("https://room/turn", { method: "POST", headers: { "x-room": id, "x-ip": "t", ...(init.headers as object) }, body: init.body }));
    expect(res.status).toBe(200);
    return (await res.json()) as { turns: { side: string; src: string; out: string; cite?: string; allergy?: boolean; health?: string }[]; open: boolean };
  };
  const say = (text: string, lang = "en", cid = "c1") =>
    post({ headers: { "content-type": "application/json" }, body: JSON.stringify({ side: "customer", cid, lang, text }) });
  const speak = (lang = "en", cid = "c1") =>
    post({ headers: { "content-type": "audio/wav", "x-side": "customer", "x-cid": cid, "x-lang": lang }, body: new Uint8Array(2000) });
  const ownerReplies = async (text = "Venga in farmacia.") => {
    const res = await room.fetch(new Request("https://room/turn", {
      method: "POST", headers: { "x-room": id, "x-key": room.meta!.hostKey, "content-type": "application/json" },
      body: JSON.stringify({ side: "owner", cid: "c1", text }),
    }));
    expect(res.status).toBe(200);
  };
  return { room, say, speak, ownerReplies };
}
const eco = <T extends { side: string }>(r: { turns: T[] }) => r.turns.filter((t) => t.side === "eco").at(-1)!;

describe("pharmacy, clinic and hospital: medical advice", () => {
  it("gives the fixed line for the kind of shop, discards the AI's answer, and tells the owner", async () => {
    for (const [kind, who] of [["pharmacy", "pharmacist"], ["clinic", "doctor"], ["hospital", "nurse"]] as const) {
      const { say } = await health(kind);
      const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(risky("What dose should I take?"));
      try {
        const r = await say("What dose should I take?");
        expect(eco(r).src).toBe(adviceLine("en", kind));
        expect(eco(r).src).toContain(who);
        expect(eco(r).out).toBe(adviceLine("it", kind)); // the owner reads Italian
        expect(JSON.stringify(r)).not.toContain("tablets"); // the model's answer never reaches anyone
        expect(r.turns[0]).toMatchObject({ side: "customer", health: "advice" });
        expect(r.open).toBe(true);
      } finally {
        spy.mockRestore();
      }
    }
  });

  it("sends none of the shop's list to the AI for such a message, only the customer's words to translate", async () => {
    const { say } = await health("pharmacy");
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(risky("Can I take ibuprofen with aspirin?"));
    try {
      await say("Can I take ibuprofen with aspirin?");
      const prompt = JSON.stringify(spy.mock.calls[0][3].messages[0]);
      expect(prompt).not.toContain("Open every day");
      expect(prompt).not.toContain("Blood pressure check");
    } finally {
      spy.mockRestore();
    }
  });

  it("speaks the customer's language", async () => {
    const { say } = await health("pharmacy");
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(risky("Qual è il dosaggio?", "it"));
    try {
      expect(eco(await say("Qual è il dosaggio?", "it")).src).toBe(adviceLine("it", "pharmacy"));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("pharmacy, clinic and hospital: emergencies", () => {
  it("gives the emergency line with the shop's own number", async () => {
    const { say, room } = await health("clinic", { emergency: "118" });
    expect(room.meta!.emergency).toBe("118");
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(risky("I have chest pain"));
    try {
      const r = await say("I have chest pain");
      expect(eco(r).src).toBe(emergencyLine("en", "clinic", "118"));
      expect(eco(r).src).toContain("118");
      expect(eco(r).out).toBe(emergencyLine("it", "clinic", "118"));
      expect(r.turns[0]).toMatchObject({ health: "emergency" });
      expect(r.open).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("points a hospital's customer to the emergency department as well", async () => {
    const { say } = await health("hospital");
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(risky("He is not breathing"));
    try {
      expect(eco(await say("He is not breathing")).src).toContain("emergency department");
    } finally {
      spy.mockRestore();
    }
  });

  it("uses 112 when the owner gave no number, or gave rubbish", async () => {
    for (const emergency of [undefined, "", "abc"]) {
      const { say, room } = await health("pharmacy", emergency === undefined ? {} : { emergency });
      expect(room.meta!.emergency).toBe("112");
      const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(risky("It is an emergency"));
      try {
        expect(eco(await say("It is an emergency")).src).toContain("112");
      } finally {
        spy.mockRestore();
      }
    }
  });

  it("an emergency beats a medical question in the same message", async () => {
    const { say } = await health("pharmacy");
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(risky("I have chest pain, what dose should I take?"));
    try {
      const r = await say("I have chest pain, what dose should I take?");
      expect(r.turns[0].health).toBe("emergency");
      expect(eco(r).src).toBe(emergencyLine("en", "pharmacy"));
    } finally {
      spy.mockRestore();
    }
  });

  it("recognises a spoken emergency once it is transcribed", async () => {
    const { speak } = await health("hospital");
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(risky("My father is unconscious"));
    try {
      const r = await speak();
      expect(r.turns[0].health).toBe("emergency");
      expect(eco(r).src).toBe(emergencyLine("en", "hospital"));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("pharmacy, clinic and hospital: everything else is as before", () => {
  it("answers an ordinary question from the owner's list, with no health line", async () => {
    const { say } = await health("pharmacy");
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(answer({
      src: "What are your opening hours?", to_owner: "Quali sono gli orari?",
      answer: { covered: true, text: "Open every day 8:00 to 20:00.", text_owner: "Aperto ogni giorno dalle 8:00 alle 20:00.", cite: "hours" },
    }));
    try {
      const r = await say("What are your opening hours?");
      expect(r.turns[0].health).toBeUndefined();
      expect(eco(r)).toMatchObject({ src: "Open every day 8:00 to 20:00.", cite: "hours" });
      expect(r.open).toBe(false);
      expect(JSON.stringify(spy.mock.calls[0][3].messages[0])).toContain("Open every day"); // the list is sent as usual
    } finally {
      spy.mockRestore();
    }
  });

  it("does not treat a product question as medical advice", async () => {
    const { say } = await health("pharmacy");
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(answer({
      src: "Do you sell painkillers?", to_owner: "Vendete antidolorifici?",
      answer: { covered: true, text: "Painkillers on request.", text_owner: "Antidolorifici su richiesta.", cite: "products" },
    }));
    try {
      const r = await say("Do you sell painkillers?");
      expect(r.turns[0].health).toBeUndefined();
      expect(eco(r).src).toBe("Painkillers on request.");
    } finally {
      spy.mockRestore();
    }
  });

  it("other kinds of shop are untouched: a restaurant answers 'what dose' like any question", async () => {
    const { say } = await health("restaurant");
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(risky("What dose should I take?"));
    try {
      const r = await say("What dose should I take?");
      expect(r.turns[0].health).toBeUndefined();
      expect(eco(r).src).toBe("Take two tablets every four hours."); // no health rule applies outside the three kinds
    } finally {
      spy.mockRestore();
    }
  });

  it("an allergy question in a pharmacy still gets the allergen safety", async () => {
    const { say } = await health("pharmacy");
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(answer({
      src: "Does the cream contain nuts?", to_owner: "La crema contiene noci?",
      answer: { covered: true, text: "Cream with almond oil.", text_owner: "Crema con olio di mandorle.", cite: "allergens" },
    }));
    try {
      const r = await say("Does the cream contain nuts?");
      expect(r.turns[0]).toMatchObject({ allergy: true });
      expect(r.turns[0].health).toBeUndefined();
      expect(eco(r).src).toBe(`Cream with almond oil. ${staffLine("en")}`);
    } finally {
      spy.mockRestore();
    }
  });

  it("a medical question wins over an allergy question in the same message", async () => {
    const { say } = await health("pharmacy");
    const spy = vi.spyOn(client, "tf").mockResolvedValueOnce(risky("I'm allergic to nuts, what dose should I take?"));
    try {
      const r = await say("I'm allergic to nuts, what dose should I take?");
      expect(r.turns[0]).toMatchObject({ allergy: true, health: "advice" });
      expect(eco(r).src).toBe(adviceLine("en", "pharmacy"));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("pharmacy, clinic and hospital: what the customer's page is told", () => {
  it("shares the shop's emergency number, for the three kinds only", async () => {
    expect((await health("pharmacy", { emergency: "118" })).room.publicMeta().emergency).toBe("118");
    expect((await health("clinic")).room.publicMeta().emergency).toBe("112");
    expect((await health("hospital", { emergency: "  +39 06 1234 " })).room.publicMeta().emergency).toBe("+39 06 1234");
    for (const other of ["restaurant", "shop", "service", "other"]) expect((await health(other, { emergency: "118" })).room.publicMeta().emergency).toBeUndefined();
  });
});

describe("pharmacy, clinic and hospital: the owner's alert", () => {
  it("a later ordinary question does not cancel it until the owner has replied", async () => {
    const { say, room, ownerReplies } = await health("clinic");
    const spy = vi.spyOn(client, "tf")
      .mockResolvedValueOnce(risky("What dose should I take?"))
      .mockResolvedValueOnce(answer({ src: "What are your hours?", answer: { covered: true, text: "Open 8 to 20.", text_owner: "Aperto 8-20.", cite: "hours" } }))
      .mockResolvedValueOnce({ data: { src: "Venga alle 10.", out: "Come at 10." }, live: true, ms: 1 } as Reply)
      .mockResolvedValueOnce(answer({ src: "Do you take cards?", answer: { covered: true, text: "Yes.", text_owner: "Sì.", cite: "hours" } }));
    try {
      expect((await say("What dose should I take?")).open).toBe(true);
      expect((await say("What are your hours?")).open).toBe(true);
      await ownerReplies("Venga alle 10.");
      expect(room.convos[0].open).toBe(false);
      expect((await say("Do you take cards?")).open).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("pharmacy, clinic and hospital: mock mode, with no AI at all", () => {
  it("still gives the fixed lines", async () => {
    const { say } = await health("pharmacy");
    expect(eco(await say("What dose should I take?")).src).toBe(adviceLine("en", "pharmacy"));
    expect(eco(await say("I have chest pain", "en", "c2")).src).toBe(emergencyLine("en", "pharmacy"));
  });
});
