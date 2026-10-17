import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {
  constructor(protected ctx: DurableObjectState, protected env: Env) {}
} }));
import { Room } from "../src/room";
import * as client from "../src/tf";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const data = { src: "Question", lang: "en", to_owner: "Domanda", answer: { covered: false, text: "", text_owner: "", cite: "" } };

async function counter(id = "counter/test/shop", saved = new Map<string, unknown>(), options: Record<string, unknown> = {}) {
  let ready!: Promise<unknown>;
  const owner = { send: vi.fn() }, customer = { send: vi.fn() }, otherCustomer = { send: vi.fn() };
  const ctx = {
    storage: {
      get: async (keys: string[]) => new Map(keys.map((k) => [k, structuredClone(saved.get(k))])),
      put: vi.fn(async (values: Record<string, unknown>) => { for (const [k, v] of Object.entries(values)) saved.set(k, structuredClone(v)); }),
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => (ready = fn()),
    getWebSockets: (tag: string) => tag === "owner" ? [owner] : tag === "c:c1" ? [customer] : tag === "c:c2" ? [otherCustomer] : [],
    acceptWebSocket: vi.fn(), waitUntil: () => {},
  };
  const room = new Room(ctx as unknown as DurableObjectState, { ECO_LIVE: "0" } as Env);
  await ready;
  if (!room.meta) await room.init(id, { title: "Shop", ownerLang: "it", bizType: "restaurant", pages: [{ tag: "menu", text: "Vanilla €3.00" }], ...options }, "owner-a");
  const request = (action: string, method: string, body?: unknown, headers: Record<string, string> = {}) => room.fetch(new Request(`https://room/${action}`, {
    method, headers: { "x-room": id, "x-ip": "test", "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const add = (cid = "c1", side = "customer") => request("turn", "POST", { cid, side, lang: "en", text: "Unknown product?" }, { "x-key": room.meta!.hostKey });
  const remove = (cid = "c1", headers: Record<string, string> = { "x-key": room.meta!.hostKey }) => request("convo", "DELETE", { cid }, headers);
  return { room, saved, ctx, owner, customer, otherCustomer, request, add, remove };
}

describe("owner-only persistent Counter deletion", () => {
  it("deletes one conversation, persists its marker, and notifies only its customer and owners", async () => {
    const c = await counter();
    await c.add(); await c.add("c2");
    const untouched = structuredClone(c.room.convos[1]);
    const menu = structuredClone(c.room.pages), meta = structuredClone(c.room.meta);
    c.owner.send.mockClear(); c.customer.send.mockClear(); c.otherCustomer.send.mockClear();
    expect((await c.remove()).status).toBe(200);
    expect(c.room.convos).toEqual([untouched]);
    expect(c.saved.get("convos")).toEqual([untouched]);
    expect(c.room.pages).toEqual(menu); expect(c.room.meta).toEqual(meta);
    expect(c.customer.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: "conversationDeleted", cid: "c1" }));
    expect(c.owner.send).toHaveBeenCalledTimes(1);
    expect(c.otherCustomer.send).not.toHaveBeenCalled();
    const restored = await counter("counter/test/shop", c.saved);
    expect(restored.room.convos).toEqual([untouched]);
    const tf = vi.spyOn(client, "tf");
    const stale = await restored.add();
    expect(stale.status).toBe(410);
    expect(await stale.json()).toMatchObject({ deleted: true, cid: "c1" });
    expect(tf).not.toHaveBeenCalled();
    expect((await restored.remove()).status).toBe(200); // safe retry after a lost DELETE response
  });

  it.each([{}, { "x-key": "wrong" }, { "x-user": "owner-b" }, { "x-speaker-key": "speaker" }])("rejects unauthorized deletion %j", async (headers) => {
    const c = await counter(); await c.add();
    expect((await c.remove("c1", headers as Record<string, string>)).status).toBe(403);
    expect(c.room.convos).toHaveLength(1);
  });

  it("accepts the worker-verified owner identity and isolates business credentials and IDs", async () => {
    const a = await counter(), b = await counter("counter/other/shop");
    await a.add(); await b.add();
    expect((await b.remove("c1", { "x-key": a.room.meta!.hostKey })).status).toBe(403);
    expect((await a.request("convo", "DELETE", { cid: "c1" }, { "x-user": "owner-a", "x-room": "counter/other/shop" })).status).toBe(404);
    expect((await a.remove("c1", { "x-user": "owner-a" })).status).toBe(200);
    expect(b.room.convos).toHaveLength(1);
  });

  it("does not delete on GET, unknown ID, or a clipped ID", async () => {
    const c = await counter(); await c.add();
    expect((await c.request("convo", "GET", undefined, { "x-key": c.room.meta!.hostKey })).status).toBe(404);
    expect((await c.remove("missing")).status).toBe(404);
    expect((await c.remove("c1".padEnd(41, "x"))).status).toBe(400);
    expect(c.room.convos).toHaveLength(1);
  });

  it.each([{ demo: true }, { mode: "stage" }])("does not enable deletion in a demo or Stage %j", async (options) => {
    const c = await counter(options.mode === "stage" ? "stage/test/talk" : "counter/test/shop", undefined, options);
    expect((await c.remove()).status).toBe(403);
  });

  it("leaves memory and persistent history intact when storage fails", async () => {
    const c = await counter(); await c.add();
    const before = structuredClone(c.room.convos);
    c.owner.send.mockClear(); c.customer.send.mockClear();
    c.ctx.storage.put.mockRejectedValueOnce(new Error("offline storage failure"));
    expect((await c.remove()).status).toBe(503);
    expect(c.room.convos).toEqual(before);
    expect(c.saved.get("convos")).toEqual(before);
    expect(c.saved.get("deletedConvos")).toBeUndefined();
    expect(c.owner.send).not.toHaveBeenCalled(); expect(c.customer.send).not.toHaveBeenCalled();
    expect((await c.remove()).status).toBe(200);
  });

  it.each(["customer", "owner"])("discards an in-flight %s result after deletion", async (side) => {
    const c = await counter(); await c.add();
    let resolve!: (r: any) => void;
    const tf = vi.spyOn(client, "tf").mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const pending = c.add("c1", side);
    await vi.waitFor(() => expect(tf).toHaveBeenCalledTimes(1));
    await c.remove(); c.owner.send.mockClear(); c.customer.send.mockClear();
    resolve({ data: side === "customer" ? data : { src: "Reply", out: "Risposta" }, live: true, ms: 1 });
    expect((await pending).status).toBe(410);
    expect(c.room.convos).toEqual([]); expect(c.saved.get("convos")).toEqual([]);
    expect(c.owner.send).not.toHaveBeenCalled(); expect(c.customer.send).not.toHaveBeenCalled();
  });

  it("tells a reconnecting customer that its persisted chat ID was deleted", async () => {
    const c = await counter(); await c.add(); await c.remove();
    const restored = await counter("counter/test/shop", c.saved);
    const server = { send: vi.fn(), serializeAttachment: vi.fn() };
    vi.stubGlobal("WebSocketPair", class { 0 = {}; 1 = server; });
    const RealResponse = Response;
    vi.stubGlobal("Response", class extends RealResponse {
      constructor(body: BodyInit | null, init: ResponseInit) { super(body, { ...init, status: init.status === 101 ? 200 : init.status }); }
    });
    await restored.request("ws?role=customer&cid=c1", "GET");
    expect(JSON.parse(server.send.mock.calls[0][0])).toMatchObject({ type: "hello", deleted: true, convo: null });
  });
});
