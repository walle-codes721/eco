// One WebSocket per page with reconnect. onStatus gets "connecting" | "open" | "offline".
export function connect(id, params, onMsg, onStatus = () => {}) {
  let ws, ping, tries = 0, closed = false;
  const qs = new URLSearchParams(params).toString();
  const open = () => {
    onStatus("connecting");
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/rooms/${id}/ws?${qs}`);
    ws.onopen = () => {
      tries = 0;
      onStatus("open");
      ping = setInterval(() => ws.readyState === 1 && ws.send('{"type":"ping"}'), 25000);
    };
    ws.onmessage = (e) => {
      try { onMsg(JSON.parse(e.data)); } catch (err) { console.error(err); }
    };
    ws.onclose = () => {
      clearInterval(ping);
      if (closed) return;
      onStatus("offline");
      setTimeout(open, Math.min(8000, 500 * 2 ** tries++));
    };
  };
  open();
  addEventListener("online", () => ws?.readyState > 1 && open());
  return {
    send: (msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg)),
    close: () => { closed = true; ws?.close(); },
  };
}
