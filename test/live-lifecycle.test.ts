import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain browser module
import { connect } from "../public/js/live.js";

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (e: { data: string }) => void;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.onclose?.(); });
  constructor(readonly url: string) { Socket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
}
let online: Set<() => void>;
beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  online = new Set();
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", { protocol: "https:", host: "eco.test" });
  vi.stubGlobal("addEventListener", (_name: string, f: () => void) => online.add(f));
  vi.stubGlobal("removeEventListener", (_name: string, f: () => void) => online.delete(f));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Counter connection disposal and reconnection", () => {
  it.each(["connected", "retry-pending"])("never reopens an explicitly closed %s connection", (state) => {
    const receive = vi.fn(), status = vi.fn();
    const live = connect("counter/test/shop", { role: "customer", cid: "old" }, receive, status);
    const socket = Socket.instances[0], queuedOnline = [...online][0];
    socket.open();
    if (state === "retry-pending") socket.close();
    live.close(); live.close();
    const statusCount = status.mock.calls.length;
    expect(online.size).toBe(0);
    queuedOnline(); // even an event queued before listener removal must do nothing
    socket.onopen?.(); socket.onmessage?.({ data: '{"type":"turns"}' });
    live.send({ type: "ping" });
    vi.advanceTimersByTime(60000);
    expect(Socket.instances).toHaveLength(1);
    expect(receive).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(statusCount);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues automatic retries and delivery for an active conversation", () => {
    const receive = vi.fn(), status = vi.fn();
    const live = connect("counter/test/shop", { cid: "active" }, receive, status);
    Socket.instances[0].close();
    vi.advanceTimersByTime(500);
    expect(Socket.instances).toHaveLength(2);
    Socket.instances[1].close();
    vi.advanceTimersByTime(999);
    expect(Socket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    const current = Socket.instances[2];
    current.open();
    current.onmessage?.({ data: '{"type":"hello"}' });
    expect(receive).toHaveBeenCalledExactlyOnceWith({ type: "hello" });
    vi.advanceTimersByTime(25000);
    expect(current.send).toHaveBeenCalledExactlyOnceWith('{"type":"ping"}');
    current.close();
    vi.advanceTimersByTime(500); // backoff resets after a successful open
    expect(Socket.instances).toHaveLength(4);
    live.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deduplicates online events and scheduled retries and ignores replaced sockets", () => {
    const receive = vi.fn();
    const live = connect("counter/test/shop", {}, receive);
    const old = Socket.instances[0]; old.open(); old.close();
    const onOnline = [...online][0]; onOnline(); onOnline();
    expect(Socket.instances).toHaveLength(2);
    const current = Socket.instances[1]; current.open();
    old.onclose?.(); old.onopen?.(); old.onmessage?.({ data: '{"type":"old"}' });
    vi.advanceTimersByTime(25000);
    expect(Socket.instances).toHaveLength(2);
    expect(receive).not.toHaveBeenCalled();
    expect(current.send).toHaveBeenCalledExactlyOnceWith('{"type":"ping"}');
    expect(vi.getTimerCount()).toBe(1);
    live.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows a replacement customer connection to reconnect after the deleted one closes", () => {
    const old = connect("counter/test/shop", { cid: "deleted" }, vi.fn());
    old.close();
    const next = connect("counter/test/shop", { cid: "fresh" }, vi.fn());
    Socket.instances[1].close();
    for (const f of online) f();
    vi.advanceTimersByTime(1000);
    expect(Socket.instances).toHaveLength(3);
    expect(Socket.instances[2].url).toContain("cid=fresh");
    expect(online.size).toBe(1);
    next.close();
  });
});
