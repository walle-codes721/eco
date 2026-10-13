import type { Env } from "./env";
import { tf } from "./tf";
import { MODELS, extractPrompt } from "./prompts";

export { Room } from "./room";
export { Budget } from "./budget";

const ID = /^[a-z0-9]{3,12}$/;
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => ALPHABET[b % ALPHABET.length]).join("");

/** URL path → static page. Order matters: "new" before "{id}". */
const PAGES: [RegExp, string][] = [
  [/^\/s\/new$/, "/stage-new"],
  [/^\/s\/([a-z0-9]+)\/screen$/, "/screen"],
  [/^\/s\/([a-z0-9]+)\/card$/, "/stage-card"],
  [/^\/s\/([a-z0-9]+)$/, "/presenter"],
  [/^\/r\/([a-z0-9]+)$/, "/listener"],
  [/^\/o\/new$/, "/counter-new"],
  [/^\/o\/([a-z0-9]+)\/card$/, "/counter-card"],
  [/^\/o\/([a-z0-9]+)\/sticker$/, "/sticker"],
  [/^\/o\/([a-z0-9]+)$/, "/owner"],
  [/^\/c\/([a-z0-9]+)$/, "/customer"],
];

const SECURITY = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "media-src 'self' blob: data:; connect-src 'self' wss: ws:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "microphone=(self), camera=(self)",
};

function secure(res: Response): Response {
  if (res.status === 101) return res;
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY)) r.headers.set(k, v);
  return r;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    const ip = req.headers.get("cf-connecting-ip") ?? "local";

    if (path.startsWith("/api/")) return secure(await api(req, env, url, path, ip));

    for (const [re, page] of PAGES) {
      if (re.test(path)) {
        const res = await env.ASSETS.fetch(new Request(new URL(page, url), req));
        return secure(res);
      }
    }
    return secure(await env.ASSETS.fetch(req));
  },
} satisfies ExportedHandler<Env>;

async function api(req: Request, env: Env, url: URL, path: string, ip: string): Promise<Response> {
  const budget = () => env.BUDGET.get(env.BUDGET.idFromName("global"));

  if (path === "/api/rooms" && req.method === "POST") {
    const body = await req.text();
    if (body.length > 400_000) return json({ error: "Too large" }, 413);
    for (let i = 0; i < 5; i++) {
      const id = newId();
      const res = await room(env, id, "init", new Request("https://room/init", { method: "POST", body }), ip);
      if (res.status !== 409) return res;
    }
    return json({ error: "Try again" }, 503);
  }

  if (path === "/api/extract" && req.method === "POST") {
    const { image } = (await req.json()) as { image?: string };
    if (!image?.startsWith("data:image/") || image.length > 3_000_000) return json({ error: "Send a JPEG or PNG under 2 MB" }, 400);
    const r = await tf<{ text: string }>(env, "extract", MODELS.vision, extractPrompt(image), {
      pub: true,
      mock: () => ({
        text: "SAMPLE (mock mode: no photo was read)\nEspresso — €1.20\nCappuccino — €1.80 — contains milk\nCornetto — €1.50 — contains gluten, eggs, milk",
      }),
    });
    return r.data === null ? json({ error: "busy", fallback: r.fallback }, 503) : json({ text: r.data.text, live: r.live });
  }

  if (path === "/api/stats" && req.method === "GET") return json(await budget().stats());

  if (path.startsWith("/api/admin/")) {
    if (!env.ADMIN_KEY || req.headers.get("x-admin-key") !== env.ADMIN_KEY) return json({ error: "Not allowed" }, 403);
    if (path === "/api/admin/calls") return new Response(await budget().log(), { headers: { "content-type": "application/x-ndjson" } });
    if (path === "/api/admin/reset" && req.method === "POST") return (await budget().reset(), json({ ok: true }));
  }

  const m = path.match(/^\/api\/rooms\/([a-z0-9]+)\/([a-z]+)$/);
  if (m && ID.test(m[1])) {
    const inner = new Request(`https://room/${m[2]}${url.search}`, req);
    return room(env, m[1], m[2], inner, ip);
  }
  return json({ error: "Not found" }, 404);
}

function room(env: Env, id: string, _action: string, req: Request, ip: string): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.set("x-room", id);
  headers.set("x-ip", ip);
  return env.ROOM.get(env.ROOM.idFromName(id)).fetch(new Request(req, { headers }));
}
