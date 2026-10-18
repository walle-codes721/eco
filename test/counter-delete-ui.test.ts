// @ts-expect-error test-only Node built-in
import { readFileSync } from "node:fs";
import * as ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.useRealTimers(); });

function page(file: string, names: string[]) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const code = source.statements.filter((n) => ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? "")).map((n) => n.getText(source).replace(/^export /, "")).join("\n");
  let labels = "", messages = "";
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.name.getText(source) === "L") labels = n.initializer!.getText(source);
    if (ts.isCallExpression(n) && n.expression.getText(source) === "connect") messages = n.arguments[2].getText(source);
    ts.forEachChild(n, visit);
  };
  visit(source);
  return { code, labels, messages };
}
const all = (node: any): any[] => typeof node !== "object" || !node ? [] : [node, ...node.children.flatMap(all)];
const text = (node: any): string => typeof node === "string" ? node : node.textContent || node.children.map(text).join("");

function owner(italian = false) {
  const handlers = new Map<string, (e: any) => void>();
  const document: any = { activeElement: null };
  const h = (tag: string, props: any = {}, ...children: any[]) => {
    const node: any = { tag, props, children: children.flat().filter((x) => x != null && x !== false), disabled: false, isConnected: true, classList: { toggle: vi.fn() },
      ...props, focus() { document.activeElement = node; }, remove() { node.isConnected = false; },
      append(...kids: any[]) { node.children.push(...kids); }, replaceChildren(...kids: any[]) { node.children = kids; },
      querySelector() { return all(node).find((n) => n !== node && n.tag.startsWith("button")); },
    };
    return node;
  };
  document.body = h("body");
  const p = page("public/js/pages/owner.js", ["deleteChat", "deleteConversationRequest", "removeConversation", "drawList", "addTurns", "faceToFace", "bindOwnerMic"]);
  const bindings = {
    document, h, api: vi.fn(async (..._args: any[]) => ({})), icon: () => h("svg"),
    addEventListener: (name: string, f: any) => handlers.set(name, f), removeEventListener: (name: string) => handlers.delete(name),
    drawThread: vi.fn(), listEl: h("aside"), replyIn: { value: "draft" }, langName: (l: string) => l,
    qrSvg: () => null, fullUrl: (s: string) => s, shortUrl: (s: string) => s, voice: { say: vi.fn(), unlock: vi.fn() },
    bindHold: vi.fn(), sendOwner: vi.fn(), toast: vi.fn(),
  };
  const result = new Function(...Object.keys(bindings), `const id='counter/test/shop', key='owner-key', it=${italian}, OL=it?'it':'en', meta={host:true,demo:false};
    const L=${p.labels}, deletedConvos=new Set(), ago=()=>''; let active='c1', f2fDraw=null, deleteDialog=null;
    let convos=[{id:'c1',lang:'es',open:true,turns:[]},{id:'c2',lang:'en',open:false,turns:[]}];
    ${p.code}; return {deleteChat, removeConversation, addTurns, drawList, faceToFace, bindOwnerMic, redrawFace:()=>f2fDraw?.(), onMessage:${p.messages}, get:()=>({active,convos}), L};`)(...Object.values(bindings));
  result.drawList();
  const modal = () => document.body.children.at(-1);
  const button = (label: string) => all(modal()).find((n) => n.tag.startsWith("button") && (text(n) === label || n.props["aria-label"] === label));
  return { ...result, ...bindings, handlers, modal, button };
}

describe("owner Delete Chat confirmation", () => {
  it("uses a separate trash button that does not open or select its conversation", () => {
    const o = owner();
    const trash = all(o.listEl).filter((n) => n.props["aria-label"] === o.L.deleteChat);
    const stopPropagation = vi.fn();
    trash[1].onclick({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(o.get().active).toBe("c1");
    expect(o.api).not.toHaveBeenCalled();
    for (const card of all(o.listEl).filter((n) => n.tag === "button.convo-item")) {
      expect(all(card).slice(1).some((n) => n.tag.startsWith("button"))).toBe(false);
    }
  });

  it.each(["cancel", "escape", "close", "backdrop"])("%s leaves the conversation untouched", (how) => {
    const o = owner(); o.deleteChat(o.get().convos[0]);
    const wrap = o.modal();
    if (how === "cancel") o.button(o.L.cancel).onclick();
    if (how === "close") o.button(o.L.close).onclick();
    if (how === "escape") o.handlers.get("keydown")!({ key: "Escape", preventDefault() {} });
    if (how === "backdrop") wrap.onclick({ target: wrap });
    expect(wrap.isConnected).toBe(false);
    expect(o.handlers.has("keydown")).toBe(false);
    expect(o.get().convos).toHaveLength(2); expect(o.get().active).toBe("c1");
    expect(o.api).not.toHaveBeenCalled();
  });

  it.each([false, true])("localizes the modal and deletes only after confirmation (Italian=%s)", async (italian) => {
    const o = owner(italian); o.deleteChat(o.get().convos[0]);
    expect(text(o.modal())).toContain(italian ? "Eliminare la conversazione?" : "Delete conversation?");
    expect(o.api).not.toHaveBeenCalled();
    let finish!: () => void;
    o.api.mockImplementationOnce(() => new Promise<void>((r) => { finish = r; }) as any);
    const remove = o.button(o.L.deleteChat), pending = remove.onclick();
    expect(remove.disabled).toBe(true);
    await remove.onclick();
    expect(o.api).toHaveBeenCalledTimes(1);
    expect(o.get().convos).toHaveLength(2);
    finish(); await pending;
    expect(o.api).toHaveBeenCalledWith("/api/rooms/counter/test/shop/convo", { method: "DELETE", key: "owner-key", body: { cid: "c1" }, signal: expect.any(AbortSignal) });
    expect(o.get().active).toBe("c2");
    expect(o.get().convos.map((c: any) => c.id)).toEqual(["c2"]);
    expect(o.replyIn.value).toBe("");
    o.removeConversation("c2");
    expect(o.get()).toEqual({ active: null, convos: [] });
  });

  it("keeps the modal and chat on failure, shows an error, and permits retry", async () => {
    const o = owner(); o.deleteChat(o.get().convos[0]);
    o.api.mockRejectedValueOnce(new Error("storage unavailable"));
    const remove = o.button(o.L.deleteChat);
    await remove.onclick();
    expect(remove.disabled).toBe(false);
    expect(o.modal().isConnected).toBe(true);
    expect(all(o.modal()).find((n) => n.props.role === "alert").textContent).toBe(o.L.deleteFailed);
    expect(o.get().convos).toHaveLength(2);
    await remove.onclick();
    expect(o.get().convos).toHaveLength(1);
  });

  it.each(["retry", "cancel"])("unlocks a timed-out deletion for %s and ignores late completion", async (action) => {
    vi.useFakeTimers();
    const o = owner(); o.deleteChat(o.get().convos[0]);
    let finish!: () => void;
    o.api.mockImplementationOnce(() => new Promise<void>((r) => { finish = r; }) as any);
    const remove = o.button(o.L.deleteChat), pending = remove.onclick();
    const signal = (o.api.mock.calls[0] as any)[1].signal;
    o.handlers.get("keydown")!({ key: "Escape", preventDefault() {} });
    expect(o.modal().isConnected).toBe(true); // an issued deletion cannot be cancelled locally
    await vi.advanceTimersByTimeAsync(15000);
    await pending;
    expect(signal.aborted).toBe(true);
    expect(remove.disabled).toBe(false);
    expect(o.button(o.L.cancel).disabled).toBe(false);
    expect(o.button(o.L.close).disabled).toBe(false);
    expect(all(o.modal()).find((n) => n.props.role === "alert").textContent).toBe(o.L.deleteFailed);
    expect(o.get().convos).toHaveLength(2);
    if (action === "retry") {
      await remove.onclick();
      expect(o.get().convos.map((c: any) => c.id)).toEqual(["c2"]);
    } else {
      o.button(o.L.cancel).onclick();
      expect(o.get().convos).toHaveLength(2);
    }
    finish(); await Promise.resolve();
    expect(o.modal().isConnected).toBe(false);
    expect(o.api).toHaveBeenCalledTimes(action === "retry" ? 2 : 1);
    expect(o.get().convos).toHaveLength(action === "retry" ? 1 : 2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout after a successful deletion", async () => {
    vi.useFakeTimers();
    const o = owner(); o.deleteChat(o.get().convos[0]);
    await o.button(o.L.deleteChat).onclick();
    const signal = (o.api.mock.calls[0] as any)[1].signal;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(15000);
    expect(signal.aborted).toBe(false);
  });

  it.each(["event", "reconnect"])("reconciles late confirmed deletion via %s after a timeout", async (how) => {
    vi.useFakeTimers();
    const o = owner(); o.deleteChat(o.get().convos[0]);
    const wrap = o.modal(), remove = o.button(o.L.deleteChat);
    o.api.mockImplementationOnce(() => new Promise(() => {}));
    const pending = remove.onclick();
    await vi.advanceTimersByTimeAsync(15000); await pending;
    expect(wrap.isConnected).toBe(true);
    expect(all(wrap).find((n) => n.props.role === "alert").textContent).toBe(o.L.deleteFailed);
    if (how === "event") o.onMessage({ type: "conversationDeleted", cid: "c1" });
    else o.onMessage({ type: "hello", convos: [o.get().convos[1]], deletedConvos: ["c1"] });
    expect(wrap.isConnected).toBe(false);
    expect(o.handlers.has("keydown")).toBe(false);
    expect(o.get().convos.map((c: any) => c.id)).toEqual(["c2"]);
    await remove.onclick(); // a queued click on the closed modal cannot retry
    expect(o.api).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps another conversation's modal open when the timed-out deletion succeeds", async () => {
    vi.useFakeTimers();
    const o = owner(); o.deleteChat(o.get().convos[0]);
    o.api.mockImplementationOnce(() => new Promise(() => {}));
    const pending = o.button(o.L.deleteChat).onclick();
    await vi.advanceTimersByTimeAsync(15000); await pending;
    o.button(o.L.cancel).onclick();
    o.deleteChat(o.get().convos[1]);
    const other = o.modal();
    o.onMessage({ type: "conversationDeleted", cid: "c1" });
    expect(other.isConnected).toBe(true);
    expect(o.handlers.has("keydown")).toBe(true);
    expect(o.get().convos.map((c: any) => c.id)).toEqual(["c2"]);
    o.button(o.L.cancel).onclick();
    expect(other.isConnected).toBe(false);
    expect(o.api).toHaveBeenCalledTimes(1);
  });

  it.each(["resolve", "reject"])("ignores a late HTTP %s after socket success without disturbing the next modal", async (result) => {
    const o = owner(); o.deleteChat(o.get().convos[0]);
    let resolve!: () => void, reject!: (err: unknown) => void;
    o.api.mockImplementationOnce(() => new Promise<void>((r, j) => { resolve = r; reject = j; }) as any);
    const old = o.modal(), pending = o.button(o.L.deleteChat).onclick();
    o.onMessage({ type: "conversationDeleted", cid: "c1" });
    expect(old.isConnected).toBe(false);
    o.deleteChat(o.get().convos[0]);
    const other = o.modal();
    if (result === "resolve") resolve(); else reject(new Error("lost HTTP response"));
    await pending;
    expect(other.isConnected).toBe(true);
    expect(o.handlers.has("keydown")).toBe(true);
    expect(all(other).find((n) => n.props.role === "alert").textContent).toBeUndefined();
    o.button(o.L.cancel).onclick();
    expect(other.isConnected).toBe(false);
    expect(o.get().convos.map((c: any) => c.id)).toEqual(["c2"]);
  });

  it("closes a retrying modal on confirmation and tolerates repeated confirmations", async () => {
    vi.useFakeTimers();
    const o = owner(); o.deleteChat(o.get().convos[0]);
    o.api.mockImplementationOnce(() => new Promise(() => {}));
    const remove = o.button(o.L.deleteChat), first = remove.onclick();
    await vi.advanceTimersByTimeAsync(15000); await first;
    let finish!: () => void;
    o.api.mockImplementationOnce(() => new Promise<void>((r) => { finish = r; }) as any);
    const retry = remove.onclick(), wrap = o.modal();
    o.onMessage({ type: "conversationDeleted", cid: "c1" });
    o.onMessage({ type: "conversationDeleted", cid: "c1" });
    finish(); await retry;
    expect(wrap.isConnected).toBe(false);
    expect(o.get().convos.map((c: any) => c.id)).toEqual(["c2"]);
    expect(o.api).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores stale turns and snapshots after deletion, including markers received on reconnect", () => {
    const o = owner();
    o.onMessage({ type: "conversationDeleted", cid: "c1" });
    o.addTurns({ cid: "c1", lang: "es", open: true, turns: [{ id: "late", side: "customer" }] });
    o.onMessage({ type: "hello", convos: [{ id: "c1" }, { id: "c2" }], deletedConvos: ["c2"] });
    expect(o.get()).toEqual({ active: null, convos: [] });
    expect(o.voice.say).not.toHaveBeenCalled();
  });

  it("starts a fresh face-to-face chat if another owner deletes the active one", async () => {
    const o = owner();
    o.api.mockImplementation(async (_url: string, req: any) => ({ cid: req.body.cid, lang: "en", open: true,
      turns: [{ id: req.body.text, side: "customer", src: req.body.text, out: req.body.text }] }));
    o.faceToFace();
    const send = (o.bindHold.mock.calls[0] as any)[1].onBlob;
    await send("First question");
    const old = (o.api.mock.calls[0] as any)[1].body.cid;
    o.onMessage({ type: "conversationDeleted", cid: old });
    await send("New question");
    const next = (o.api.mock.calls[1] as any)[1].body.cid;
    expect(next).not.toBe(old);
    expect(o.get().convos.some((c: any) => c.id === old)).toBe(false);
    expect(o.get().convos.some((c: any) => c.id === next)).toBe(true);
  });

  it.each(["reconnect", "410"])("recovers a face-to-face chat after %s without replaying the old question", async (how) => {
    const o = owner();
    o.api.mockImplementation(async (_url: string, req: any) => ({ cid: req.body.cid, lang: "en", open: true,
      turns: [{ id: req.body.text, side: "customer", src: req.body.text, out: req.body.text }] }));
    o.faceToFace();
    const send = (o.bindHold.mock.calls[0] as any)[1].onBlob;
    await send("Old question");
    const old = (o.api.mock.calls[0] as any)[1].body.cid;
    if (how === "reconnect") o.onMessage({ type: "hello", convos: [], deletedConvos: [old] });
    else {
      o.api.mockRejectedValueOnce({ status: 410, data: { deleted: true } });
      await send("Deleted-ID question");
    }
    expect(text(o.modal())).not.toContain("Old question");
    expect(o.toast).not.toHaveBeenCalled();
    await send("Fresh question");
    const last = (o.api.mock.calls.at(-1) as any)[1].body;
    expect(last.cid).not.toBe(old);
    expect(last.text).toBe("Fresh question");
    expect(o.api).toHaveBeenCalledTimes(how === "reconnect" ? 2 : 3);
  });

  it("ignores late face-to-face responses after deletion without replaying the new chat's audio", async () => {
    const o = owner(); let finish!: (m: any) => void;
    o.api.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    o.faceToFace();
    const mic = (o.bindHold.mock.calls[0] as any)[1];
    const old = mic.onStart(), pending = mic.onBlob("Old", old);
    o.onMessage({ type: "conversationDeleted", cid: old });
    const next = mic.onStart();
    o.addTurns({ cid: next, lang: "en", open: false, turns: [{ id: "new", side: "eco", src: "New answer" }] });
    finish({ cid: old, turns: [{ id: "old", side: "eco", src: "Old answer" }] });
    await pending;
    expect(o.voice.say).not.toHaveBeenCalled();
    expect(o.get().convos.some((c: any) => c.id === old)).toBe(false);
  });

  it.each(["selection", "deletion", "reconnect"])("retains the owner's recording destination through %s", (change) => {
    const o = owner(); o.bindOwnerMic({});
    const mic = (o.bindHold.mock.calls[0] as any)[1];
    const intended = mic.onStart();
    if (change === "selection") all(o.listEl).filter((n) => n.tag === "button.convo-item")[1].onclick();
    else if (change === "deletion") o.onMessage({ type: "conversationDeleted", cid: intended });
    else o.onMessage({ type: "hello", convos: [o.get().convos[1]], deletedConvos: [intended] });
    expect(o.get().active).toBe("c2");
    mic.onBlob("Recorded for c1", intended);
    if (change === "selection") expect(o.sendOwner).toHaveBeenCalledExactlyOnceWith("c1", "Recorded for c1");
    else expect(o.sendOwner).not.toHaveBeenCalled();
  });

  it.each([0, 1])("discards a face-to-face recording from before deletion (speaker %s)", async (speaker) => {
    const o = owner(); o.faceToFace();
    const mic = (o.bindHold.mock.calls[speaker] as any)[1];
    const target = mic.onStart();
    o.onMessage({ type: "conversationDeleted", cid: target });
    await mic.onBlob("Old recording", target);
    expect(o.api).not.toHaveBeenCalled();
    expect(o.sendOwner).not.toHaveBeenCalled();
  });
});

describe("hold-to-talk recording destination", () => {
  function microphone() {
    const p = page("public/js/mic.js", ["bindHold"]);
    const handlers = new Map<string, (e?: any) => any>();
    const classes = new Set<string>();
    const btn = { style: { setProperty: vi.fn() }, classList: {
      add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c),
    }, addEventListener: (name: string, f: any) => handlers.set(name, f) };
    const starts: { resolve: (r: any) => void; reject: (e: unknown) => void; onLevel: (l: number) => void }[] = [];
    const holdMic = vi.fn(({ onLevel }) => new Promise((resolve, reject) => starts.push({ resolve, reject, onLevel })));
    const bind = new Function("holdMic", "navigator", "addEventListener", `${p.code}; return bindHold;`)(holdMic, {}, (name: string, f: any) => handlers.set(name, f));
    let target = "A";
    const onBlob = vi.fn(), onError = vi.fn();
    bind(btn, { onStart: () => target, onBlob, onError, lang: () => "en" });
    return { starts, classes, onBlob, onError, btn, target: (cid: string) => { target = cid; },
      press: () => handlers.get("pointerdown")!(), release: () => handlers.get("pointerup")!(), cancel: () => handlers.get("pointercancel")!() };
  }

  it.each(["release", "cancel"])("stops A's stale startup after %s without replacing B or sending A's audio", async (action) => {
    const m = microphone(), a = m.press();
    await m[action as "release" | "cancel"]();
    m.target("B"); const b = m.press();
    const stopB = vi.fn(async () => "For B"), stopA = vi.fn(async () => "Stale A audio");
    m.starts[1].resolve({ stop: stopB }); await b;
    m.starts[1].onLevel(0.8);
    m.starts[0].resolve({ stop: stopA }); await a;
    m.starts[0].onLevel(0); // stale recorder cleanup must not reset B's meter
    expect(m.btn.style.setProperty).toHaveBeenLastCalledWith("--level", "0.80");
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).not.toHaveBeenCalled();
    expect(m.onBlob).not.toHaveBeenCalled();
    expect(m.classes.has("on")).toBe(true);
    await m.release(); await m.release();
    expect(stopB).toHaveBeenCalledTimes(1);
    expect(m.onBlob).toHaveBeenCalledExactlyOnceWith("For B", "B");
    expect(m.onError).not.toHaveBeenCalled();
    expect(m.classes.has("on")).toBe(false);
  });

  it("ignores A's late startup rejection while B is recording", async () => {
    const m = microphone(), a = m.press(); await m.cancel();
    m.target("B"); const b = m.press();
    const stopB = vi.fn(async () => "For B");
    m.starts[1].resolve({ stop: stopB }); await b;
    m.starts[0].reject(new Error("Old permission failure")); await a;
    expect(m.classes.has("on")).toBe(true);
    expect(m.onError).not.toHaveBeenCalled();
    await m.release();
    expect(stopB).toHaveBeenCalledTimes(1);
    expect(m.onBlob).toHaveBeenCalledExactlyOnceWith("For B", "B");
  });

  it("cleans up every stale recorder in rapid press/release/press sequences", async () => {
    const m = microphone(), a = m.press(); await m.release();
    m.target("B"); const b = m.press(); await m.release();
    m.target("C"); const c = m.press();
    const stops = ["A", "B", "C"].map((cid) => vi.fn(async () => cid));
    m.starts[2].resolve({ stop: stops[2] }); await c;
    m.starts[1].resolve({ stop: stops[1] }); await b;
    m.starts[0].resolve({ stop: stops[0] }); await a;
    expect(m.onBlob).not.toHaveBeenCalled();
    await m.release();
    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
    expect(m.onBlob).toHaveBeenCalledExactlyOnceWith("C", "C");
  });

  it("discards cancellation audio and stops an already-started recorder exactly once", async () => {
    const m = microphone(), pending = m.press();
    const stop = vi.fn(async () => "Cancelled audio");
    m.starts[0].resolve({ stop }); await pending;
    await m.cancel(); await m.cancel(); await m.release();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(m.onBlob).not.toHaveBeenCalled();
    expect(m.classes.has("on")).toBe(false);
  });

  it("handles a stale recorder's cleanup rejection without affecting B", async () => {
    const m = microphone(), a = m.press(); await m.release();
    m.target("B"); const b = m.press();
    const stopA = vi.fn(async () => { throw new Error("Old stop failed"); });
    m.starts[0].resolve({ stop: stopA }); await a;
    m.starts[1].resolve({ stop: async () => "For B" }); await b;
    await m.release();
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(m.onError).not.toHaveBeenCalled();
    expect(m.onBlob).toHaveBeenCalledExactlyOnceWith("For B", "B");
  });

  it("reports a current startup failure and permits a fresh recording", async () => {
    const m = microphone(), a = m.press(), error = new Error("Microphone blocked");
    m.starts[0].reject(error); await a;
    expect(m.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(m.classes.has("on")).toBe(false);
    m.target("B"); const b = m.press();
    m.starts[1].resolve({ stop: async () => "For B" }); await b; await m.release();
    expect(m.onBlob).toHaveBeenCalledExactlyOnceWith("For B", "B");
  });

  it("snapshots the destination before startup and retains it while finalization overlaps a new recording", async () => {
    const p = page("public/js/mic.js", ["bindHold"]);
    const handlers = new Map<string, (e?: any) => any>();
    const btn = { style: { setProperty: vi.fn() }, classList: { add: vi.fn(), remove: vi.fn(), contains: () => false },
      addEventListener: (name: string, f: any) => handlers.set(name, f) };
    let finish!: (text: string) => void, target = "c1";
    const holdMic = vi.fn().mockResolvedValueOnce({ stop: () => new Promise((r) => { finish = r; }) })
      .mockResolvedValueOnce({ stop: async () => "Second" });
    const bind = new Function("holdMic", "navigator", "addEventListener", `${p.code}; return bindHold;`)(holdMic, {}, (name: string, f: any) => handlers.set(name, f));
    const onBlob = vi.fn();
    bind(btn, { onStart: () => target, onBlob, lang: () => "en" });
    const starting = handlers.get("pointerdown")!(); target = "c2"; await starting;
    const stopping = handlers.get("pointerup")!();
    await handlers.get("pointerdown")!();
    await handlers.get("pointerup")!();
    finish("First"); await stopping;
    expect(onBlob.mock.calls).toEqual([["Second", "c2"], ["First", "c1"]]);
  });
});

describe("deletion request cancellation transport", () => {
  it("passes the deletion AbortSignal to fetch without changing authorization or the body", async () => {
    const p = page("public/js/eco.js", ["api"]);
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    const api = new Function("fetch", `${p.code}; return api;`)(fetch);
    const controller = new AbortController();
    await api("/api/rooms/counter/test/shop/convo", { method: "DELETE", key: "owner-key", body: { cid: "c1" }, signal: controller.signal });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/rooms/counter/test/shop/convo", {
      method: "DELETE", signal: controller.signal,
      headers: { "x-key": "owner-key", "content-type": "application/json" }, body: '{"cid":"c1"}',
    });
  });
});

function customer() {
  const p = page("public/js/pages/customer.js", ["merge", "send", "resetConversation", "connectCustomer"]);
  const connections: { callback: (m: any) => void; close: ReturnType<typeof vi.fn>; cid: string }[] = [];
  const bindings = {
    connect: (_id: string, params: { cid: string }, callback: (m: any) => void) => {
      const c = { callback, cid: params.cid, close: vi.fn() }; connections.push(c); return c;
    },
    store: vi.fn(), draw: vi.fn(), input: { value: "draft" }, voice: { say: vi.fn() }, toast: vi.fn(), T: (s: string) => s,
    api: vi.fn(async (..._args: any[]) => ({})),
  };
  const app = new Function(...Object.keys(bindings), `const id='counter/test/shop', lang='es'; let cid='old', live=null, turns=[{id:'old-turn'}], open=true, sendError=null;
    ${p.code}; connectCustomer(); return {send,merge,get:()=>({cid,turns,open,sendError})};`)(...Object.values(bindings));
  return { ...app, ...bindings, connections };
}

describe("connected customer deletion lifecycle", () => {
  it.each(["event", "hello"])("clears a deleted chat via %s and reconnects with a fresh stored ID", (kind) => {
    const c = customer(), old = c.connections[0];
    old.callback(kind === "event" ? { type: "conversationDeleted", cid: "old" } : { type: "hello", deleted: true });
    expect(c.get().cid).not.toBe("old");
    expect(c.get()).toMatchObject({ turns: [], open: false });
    expect(c.store).toHaveBeenCalledWith("eco:cid:counter/test/shop", c.get().cid);
    expect(old.close).toHaveBeenCalledTimes(1);
    expect(c.connections[1].cid).toBe(c.get().cid);
    old.callback({ type: "turns", cid: "old", turns: [{ id: "late" }] });
    c.merge({ cid: "old", turns: [{ id: "late-http" }] });
    expect(c.get().turns).toEqual([]);
  });

  it("recovers from a deleted-ID HTTP response without retrying the deleted question", async () => {
    const c = customer();
    c.api.mockRejectedValueOnce({ status: 410, data: { deleted: true } });
    await c.send("Question");
    expect(c.get().cid).not.toBe("old");
    expect(c.get().turns).toEqual([]);
    expect(c.api).toHaveBeenCalledTimes(1);
    expect(c.toast).not.toHaveBeenCalled();
  });

  it("ignores a failed request from before deletion without restoring the old draft", async () => {
    const c = customer(); let reject!: (e: unknown) => void;
    c.api.mockImplementationOnce(() => new Promise((_r, r) => { reject = r; }));
    const pending = c.send("Old question");
    c.connections[0].callback({ type: "conversationDeleted", cid: "old" });
    reject({ status: 503 }); await pending;
    expect(c.input.value).toBe(""); expect(c.get().turns).toEqual([]);
    expect(c.toast).not.toHaveBeenCalled();
  });
});
