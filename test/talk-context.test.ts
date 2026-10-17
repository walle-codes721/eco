import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { cleanTalkContext, pollPrompt, slideRowsPrompt, translateAnswerPrompt, utterancePrompt } from "../src/prompts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  },
}));

import { Room } from "../src/room";

const system = (p: { messages: { content: unknown }[] }) => String(p.messages[0].content);

describe("talk context", () => {
  it("parses words to keep from commas, new lines or an array, trimmed and deduped", () => {
    expect(cleanTalkContext({ keep: " Apple, Vision Pro\nTim  Cook,,apple " }).keep).toEqual(["Apple", "Vision Pro", "Tim Cook"]);
    expect(cleanTalkContext({ keep: ["Apple", " ", "Mac"] }).keep).toEqual(["Apple", "Mac"]);
  });

  it("caps about at 500 characters and words at 30 of 60 characters", () => {
    const c = cleanTalkContext({ about: "x".repeat(600), keep: Array.from({ length: 40 }, (_, i) => `${i}${"y".repeat(80)}`) });
    expect(c.about).toHaveLength(500);
    expect(c.keep).toHaveLength(30);
    expect(c.keep!.every((k) => k.length === 60)).toBe(true);
  });

  it("leaves empty fields out", () => {
    expect(cleanTalkContext({})).toEqual({});
    expect(cleanTalkContext({ about: "  ", keep: " , \n" })).toEqual({});
  });

  it("adds nothing to the prompts when empty", () => {
    expect(utterancePrompt({ text: "hi" }, ["it"], [], {})).toEqual(utterancePrompt({ text: "hi" }, ["it"], []));
    expect(slideRowsPrompt("en", ["it"], ["Hi"], {})).toEqual(slideRowsPrompt("en", ["it"], ["Hi"]));
  });

  it("puts the about text as-is and the words to keep into every translation prompt", () => {
    const ctx = { about: "Un keynote su Apple", keep: ["Apple", "Vision Pro"] };
    for (const p of [
      utterancePrompt({ text: "Apple is back" }, ["it", "de"], [], ctx),
      slideRowsPrompt("en", ["it"], ["Apple"], ctx),
      pollPrompt("Apple?", ["Yes", "No"], "en", ["it"], ctx),
      translateAnswerPrompt("Apple, yes.", ["it"], ctx),
    ]) {
      expect(system(p)).toContain("KEEP VERBATIM in every language, never translate: Apple, Vision Pro.");
      expect(system(p)).toContain("Un keynote su Apple");
    }
  });

  it("is stored with the stage room's meta, and absent when the speaker left it empty", async () => {
    const stored = async (body: object) => {
      const saved = new Map<string, unknown>();
      let ready: Promise<unknown>;
      const ctx = {
        storage: {
          get: async (keys: string[]) => new Map(keys.map((k) => [k, saved.get(k)])),
          put: async (v: Record<string, unknown>) => { for (const [k, x] of Object.entries(v)) saved.set(k, x); },
        },
        blockConcurrencyWhile: (fn: () => Promise<unknown>) => (ready = fn()),
      };
      const room = new Room(ctx as unknown as DurableObjectState, { ECO_LIVE: "0" } as Env);
      await ready!;
      await room.init("stage/test/context", { langs: ["de"], ...body });
      return saved.get("meta");
    };
    expect(await stored({ about: "About Apple", keep: "Apple" })).toMatchObject({ about: "About Apple", keep: ["Apple"] });
    const plain = await stored({});
    expect(plain).not.toHaveProperty("about");
    expect(plain).not.toHaveProperty("keep");
  });
});
