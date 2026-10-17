import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {
  constructor(protected ctx: DurableObjectState, protected env: Env) {}
} }));
import { Room } from "../src/room";
import * as client from "../src/tf";
import { customerTurnPrompt, langName } from "../src/prompts";

const menu = "Vanilla: small €3.00, medium €4.50, large €6.00.\nPistachio: small €3.50, medium €5.00, large €6.50.";
const questions = [
  ["es", "¿Cuánto cuesta un gelato pequeño de vainilla?", "El gelato pequeño de vainilla cuesta €3.00."],
  ["hi", "वनीला के छोटे कप की कीमत क्या है?", "वनीला के छोटे कप की कीमत €3.00 है।"],
  ["it", "Quanto costa un gelato piccolo alla vaniglia?", "Il gelato piccolo alla vaniglia costa €3.00."],
  ["en", "How much is a small vanilla gelato?", "A small vanilla gelato costs €3.00."],
  ["de", "Wie viel kostet ein kleines Vanilleeis?", "Ein kleines Vanilleeis kostet €3.00."],
  ["fr", "Combien coûte une petite glace à la vanille ?", "Une petite glace à la vanille coûte €3.00."],
];
const valid = () => ({ src: "Price?", lang: "es", to_owner: "Quanto costa?", answer: {
  covered: true, text: "Cuesta €3.00.", text_owner: "Costa €3.00.", cite: "menu",
} });
const uncovered = () => ({ ...valid(), answer: { covered: false, text: "", text_owner: "", cite: "" } });
afterEach(() => vi.restoreAllMocks());

async function shop(bizType = "restaurant") {
  let ready!: Promise<unknown>;
  const saved = new Map<string, unknown>();
  const ctx = {
    storage: { get: async (keys: string[]) => new Map(keys.map((k) => [k, saved.get(k)])),
      put: vi.fn(async (values: Record<string, unknown>) => Object.entries(values).forEach(([k, v]) => saved.set(k, v))) },
    blockConcurrencyWhile: (f: () => Promise<unknown>) => (ready = f()), getWebSockets: () => [], waitUntil: () => {},
  };
  const room = new Room(ctx as unknown as DurableObjectState, { ECO_LIVE: "0" } as Env);
  await ready;
  await room.init("counter/test/prices", { title: "Gelato", bizType, ownerLang: "it", pages: [
    { tag: "menu", text: menu }, { tag: "allergens", text: "Pistachio contains nuts." },
  ] });
  const tf = vi.spyOn(client, "tf").mockImplementation(async () => { throw new Error("Missing offline response"); });
  const post = (data: unknown, body: Record<string, unknown> = {}) => {
    tf.mockResolvedValueOnce({ data, live: true, ms: 1 } as never);
    return room.fetch(new Request("https://room/turn", { method: "POST", headers: {
      "x-room": "counter/test/prices", "x-key": room.meta!.hostKey, "content-type": "application/json",
    }, body: JSON.stringify({ cid: "c1", side: "customer", lang: "es", text: questions[0][1], ...body }) }));
  };
  return { room, post, tf, save: ctx.storage.put };
}

describe("Counter evidence, language and classification", () => {
  // These verify source/prompt and delivery contracts using supplied translations;
  // they do not pretend that an offline mock measures a model's language ability.
  it.each(questions)("passes %s pricing evidence and selected answer language through the real handler", async (lang, text, answer) => {
    const { post, tf } = await shop();
    const data = valid(); data.src = text; data.lang = "de"; data.answer.text = answer;
    const response = await post(data, { lang, text });
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result).toMatchObject({ lang, open: false });
    expect(result.turns[1]).toMatchObject({ side: "eco", lang, src: answer, out: "Costa €3.00.", cite: "menu" });
    const prompt = tf.mock.calls[0][3];
    expect(prompt.max_tokens).toBe(300);
    expect(JSON.stringify(prompt.messages)).toContain(menu.replaceAll("\n", "\\n"));
    expect(JSON.stringify(prompt.messages)).toContain(`text = the answer in ${langName(lang)}, the customer's selected language`);
    expect(JSON.stringify(prompt.messages)).toContain("text_owner = the same answer in Italian");
    expect(tf).toHaveBeenCalledTimes(1);
  });

  it("supplies the existing language when a typed hint is invalid, but leaves raw audio detection alone", async () => {
    const { post, tf } = await shop();
    await post(uncovered(), { lang: "fr" });
    await post(valid(), { lang: "invalid" });
    expect(JSON.stringify(tf.mock.calls[1][3])).toContain("answer in French, the customer's selected language");
    const audio = customerTurnPrompt({ name: "Shop", type: "restaurant", ownerLang: "it" }, [], { wavB64: "offline" }, "fr");
    expect(JSON.stringify(audio)).not.toContain("selected language");
  });

  it("allows supported pricing options plus clarification without introducing conversation memory", async () => {
    const { post, tf } = await shop();
    const data = valid();
    data.answer.text = "Vainilla: €3.00–€6.00; pistacho: €3.50–€6.50, de pequeño a grande. ¿Qué tamaño y sabor quieres?";
    data.answer.text_owner = "Vaniglia: €3.00–€6.00; pistacchio: €3.50–€6.50, da piccolo a grande. Quale formato e gusto?";
    const res = await post(data, { text: "How much is a cup of gelato?" });
    expect(await res.json()).toMatchObject({ open: false, turns: [{ side: "customer" }, { src: data.answer.text, cite: "menu" }] });
    const prompt = JSON.stringify(tf.mock.calls[0][3]);
    expect(prompt).toContain("several listed sizes or flavours");
    expect(prompt).toContain("Never use unrelated products to construct a range");
    expect(prompt).toContain("do not return only a clarification");
    expect(tf.mock.calls[0][3].messages).toHaveLength(2);
  });

  it.each(["What is the price of a book?", "Please ask the staff", "Hello"])("preserves deliberate escalation for %s", async (text) => {
    const { post, room } = await shop();
    const res = await post({ ...uncovered(), src: text }, { text });
    const result = await res.json() as any;
    expect(res.status).toBe(200);
    expect(result.open).toBe(true);
    expect(result.turns).toHaveLength(1);
    expect(room.convos[0].open).toBe(true);
  });

  it("keeps allergy confirmation and staff escalation even for a covered price question", async () => {
    const { post } = await shop();
    const res = await post({ ...valid(), src: "How much is pistachio? I have a nut allergy." }, { text: "How much is pistachio? I have a nut allergy." });
    const result = await res.json() as any;
    expect(result.open).toBe(true);
    expect(result.turns[0].allergy).toBe(true);
    expect(result.turns[1].src).toContain("Por favor, confírmalo con el personal.");
  });

  it("keeps the healthcare override ahead of an otherwise covered answer", async () => {
    const { post } = await shop("pharmacy");
    const res = await post(valid(), { text: "What dose should I take?" });
    const result = await res.json() as any;
    expect(result.open).toBe(true);
    expect(result.turns[1].src).toContain("No puedo dar consejos médicos");
    expect(result.turns[1].src).not.toContain("€3.00");
  });
});

describe("Counter invalid response handling", () => {
  const bad = [
    {}, [], { ...valid(), src: " " }, { ...valid(), to_owner: null }, { ...valid(), lang: undefined },
    { ...valid(), answer: undefined }, { ...valid(), answer: { ...valid().answer, covered: "true" } },
    ...["", "   ", "\n\t"].map((text) => ({ ...valid(), answer: { ...valid().answer, text } })),
    { ...valid(), answer: { ...valid().answer, text_owner: " " } },
    { ...valid(), answer: { ...valid().answer, cite: 12 } },
    { ...valid(), answer: { ...valid().answer, cite: " " } },
    { ...valid(), answer: { ...valid().answer, covered: false } },
  ];
  it.each(bad.map((data, i) => [i, data] as const))("rejects invalid response %s without changing an open conversation", async (_i, data) => {
    const { post, room, save } = await shop();
    await post(uncovered());
    const before = JSON.stringify(room.convos[0]);
    save.mockClear();
    const res = await post(data, { lang: "fr" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ fallback: "error" });
    expect(JSON.stringify(room.convos[0])).toBe(before);
    expect(save).not.toHaveBeenCalled();
    // The same question can be retried successfully; no malformed turn remains.
    expect((await post(valid())).status).toBe(200);
    expect(room.convos[0].turns).toHaveLength(3);
    expect(room.convos[0].open).toBe(false);
  });

  it("trims valid text and rejects a blank owner reply without closing staff escalation", async () => {
    const { post, room } = await shop();
    await post(uncovered());
    const res = await post({ src: "Answer", out: " " }, { side: "owner" });
    expect(res.status).toBe(503);
    expect(room.convos[0].open).toBe(true);
    expect(room.convos[0].turns).toHaveLength(1);
    await post({ src: " Costa €3.00. ", out: " Cuesta €3.00. " }, { side: "owner" });
    expect(room.convos[0].turns.at(-1)).toMatchObject({ src: "Costa €3.00.", out: "Cuesta €3.00." });
    expect(room.convos[0].open).toBe(false);
  });
});
