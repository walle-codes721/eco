// One WebSocket per page with reconnect. onStatus gets "connecting" | "open" | "offline".
export function connect(id, params, onMsg, onStatus = () => {}) {
  let ws, ping, retry, tries = 0, closed = false;
  const qs = new URLSearchParams(params).toString();
  const open = () => {
    if (closed || ws?.readyState < 2) return;
    clearTimeout(retry);
    onStatus("connecting");
    const socket = ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/rooms/${id}/ws?${qs}`);
    socket.onopen = () => {
      if (closed || socket !== ws) return;
      tries = 0;
      onStatus("open");
      clearInterval(ping);
      ping = setInterval(() => socket.readyState === 1 && socket.send('{"type":"ping"}'), 25000);
    };
    socket.onmessage = (e) => {
      if (closed || socket !== ws) return;
      try { onMsg(JSON.parse(e.data)); } catch (err) { console.error(err); }
    };
    socket.onclose = () => {
      if (closed || socket !== ws) return;
      clearInterval(ping);
      onStatus("offline");
      clearTimeout(retry);
      retry = setTimeout(open, Math.min(8000, 500 * 2 ** tries++));
    };
  };
  open();
  const online = () => ws?.readyState > 1 && open();
  addEventListener("online", online);
  return {
    send: (msg) => !closed && ws?.readyState === 1 && ws.send(JSON.stringify(msg)),
    close: () => {
      if (closed) return;
      closed = true;
      clearTimeout(retry);
      clearInterval(ping);
      removeEventListener("online", online);
      ws?.close();
    },
  };
}
