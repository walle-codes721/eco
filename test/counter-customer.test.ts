// @ts-expect-error test-only Node built-in
import { readFileSync } from "node:fs";
import * as ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute the actual page handlers with offline DOM/transport substitutes.
function customer() {
  const source = ts.createSourceFile("customer.js", readFileSync("public/js/pages/customer.js", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const code = source.statements.filter((n) => ts.isFunctionDeclaration(n) && ["draw", "merge", "send"].includes(n.name?.text ?? "")).map((n) => n.getText(source)).join("\n");
  const calls: { resolve: (m: unknown) => void; reject: (e: unknown) => void }[] = [];
  const bindings = {
    api: vi.fn(() => new Promise((resolve, reject) => calls.push({ resolve, reject }))),
    voice: { say: vi.fn() }, toast: vi.fn(), input: { value: "" }, status: { textContent: "" },
    intro: {}, thread: { replaceChildren: vi.fn() }, h: () => ({}), T: (k: string) => k,
    document: { body: { scrollHeight: 0 } }, scrollTo: vi.fn(),
  };
  const handlers = new Function(...Object.keys(bindings), `const id='test', cid='c', lang='es'; let turns=[], open=false, sendError=null; ${code}; return {send, merge, turns:()=>turns};`)(...Object.values(bindings));
  return { ...handlers, ...bindings, calls };
}
const reply = (id = "a") => ({ lang: "es", open: false, turns: [
  { id, side: "customer", src: "¿Cuánto cuesta?" },
  { id: `eco-${id}`, side: "eco", src: "Cuesta €3.00.", cite: "menu" },
] });

describe("Counter customer delivery", () => {
  it("keeps failure feedback visible and clears it when a successful retry starts", async () => {
    const app = customer();
    const first = app.send("Price?");
    app.calls[0].reject({ status: 503 });
    await first;
    expect(app.status.textContent).toBe("busy");
    expect(app.input.value).toBe("Price?");
    const retry = app.send("Price?");
    expect(app.status.textContent).toBe("");
    app.calls[1].resolve(reply());
    await retry;
    expect(app.status.textContent).toBe("");
    expect(app.turns()).toEqual(reply().turns);
  });

  it("a failed overlapping send preserves the accepted answer and another pending request", async () => {
    const app = customer();
    const a = app.send("A"), b = app.send("B"), c = app.send("C");
    app.calls[0].resolve(reply());
    await a;
    app.calls[1].reject({ status: 503 });
    await b;
    expect(app.turns().map((t: any) => t.id ?? t.src)).toEqual(["a", "eco-a", "C"]);
    expect(app.turns()[2].pending).toBe(true);
    expect(app.toast).toHaveBeenCalledWith("busy");
    expect(app.status.textContent).toBe("busy");
    expect(app.input.value).toBe("B");
    app.calls[2].resolve(reply("c"));
    await c;
    expect(app.turns().map((t: any) => t.id)).toEqual(["a", "eco-a", "c", "eco-c"]);
  });

  it.each(["socket-first", "http-first"])("deduplicates text and speech with %s delivery", async (order) => {
    const app = customer();
    const pending = app.send("A"), m = reply();
    if (order === "socket-first") {
      app.merge(m);
      expect(app.turns().filter((t: any) => t.pending)).toHaveLength(1);
    }
    app.calls[0].resolve(m);
    await pending;
    app.merge(m);
    expect(app.turns()).toEqual(m.turns);
    expect(app.voice.say).toHaveBeenCalledExactlyOnceWith("Cuesta €3.00.", "es");
  });

  it("keeps a socket-delivered answer if its HTTP request fails", async () => {
    const app = customer();
    const pending = app.send("A"), m = reply();
    app.merge(m);
    app.calls[0].reject({ status: 503 });
    await pending;
    expect(app.turns()).toEqual(m.turns);
    expect(app.voice.say).toHaveBeenCalledTimes(1);
  });

  it("keeps successful replies in delivery order when requests finish out of order", async () => {
    const app = customer();
    const a = app.send("A"), b = app.send("B");
    app.calls[1].resolve(reply("b")); await b;
    expect(app.turns().at(-1)).toMatchObject({ src: "A", pending: true });
    app.calls[0].resolve(reply("a")); await a;
    expect(app.turns().map((t: any) => t.id)).toEqual(["b", "eco-b", "a", "eco-a"]);
  });

  it("shows staff feedback only for a successful escalation, and preserves a new draft on failure", async () => {
    const app = customer();
    const pending = app.send("Book price?");
    app.calls[0].resolve({ lang: "es", open: true, turns: [{ id: "book", side: "customer", src: "Book price?" }] });
    await pending;
    expect(app.status.textContent).toBe("sentToStaff ✓");
    expect(app.voice.say).not.toHaveBeenCalled();
    const failed = app.send("Another question");
    app.input.value = "New draft";
    app.calls[1].reject({ status: 503 }); await failed;
    expect(app.turns()).toHaveLength(1);
    expect(app.input.value).toBe("New draft");
    expect(app.toast).toHaveBeenCalledWith("busy");
    expect(app.status.textContent).toBe("busy");
  });
});
