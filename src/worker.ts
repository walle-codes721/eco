import type { Env } from "./env";
import { tf } from "./tf";
import { MODELS, extractPrompt } from "./prompts";
import { authRoute, sessionSub } from "./auth";
import { NAME, slugify } from "./names";
import { SAMPLE_TEXT, savedKey, sampleObjectKey, parseVoiceUpload, deleteStoredSample, loadStoredSample } from "./voice";

export { Room } from "./room";
export { Budget } from "./budget";
export { Account } from "./account";

const N = "[a-z0-9][a-z0-9-]{1,46}"; // a user, talk or shop name in a URL
const ROOM = new RegExp(`^(stage|counter)/${N}/${N}$`);

/** URL path → static page. Order matters: "new" before "{user}". */
const PAGES: [RegExp, string][] = [
  [/^\/me$/, "/me"],
  [/^\/stage\/new$/, "/stage-new"],
  [/^\/counter\/new$/, "/counter-new"],
  [new RegExp(`^/stage/${N}/${N}/speak$`), "/presenter"],
  [new RegExp(`^/stage/${N}/${N}/screen$`), "/screen"],
  [new RegExp(`^/stage/${N}/${N}/card$`), "/stage-card"],
  [new RegExp(`^/stage/${N}/${N}/join$`), "/join"],
  [new RegExp(`^/stage/${N}/${N}$`), "/listener"],
  [new RegExp(`^/counter/${N}/${N}/owner$`), "/owner"],
  [new RegExp(`^/counter/${N}/${N}/card$`), "/counter-card"],
  [new RegExp(`^/counter/${N}/${N}/sticker$`), "/sticker"],
  [new RegExp(`^/counter/${N}/${N}$`), "/customer"],
];

/** Links printed before the rename keep working for the two demo rooms. */
export const OLD: Record<string, string> = {
  "/s/demo": "/stage/eco/demo/speak", "/s/demo/screen": "/stage/eco/demo/screen", "/s/demo/card": "/stage/eco/demo/card", "/r/demo": "/stage/eco/demo",
  "/o/gelato": "/counter/eco/gelato/owner", "/o/gelato/card": "/counter/eco/gelato/card", "/o/gelato/sticker": "/counter/eco/gelato/sticker", "/c/gelato": "/counter/eco/gelato",
  "/s/new": "/stage/new", "/o/new": "/counter/new",
};

const SECURITY = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://lh3.googleusercontent.com; " +
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
    if (path.startsWith("/auth/")) return secure((await authRoute(req, env, url, path)) ?? new Response("Not found", { status: 404 }));
    if (OLD[path]) return Response.redirect(new URL(OLD[path], url).toString(), 301);

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

  const sub = await sessionSub(req, env);
  const account = (key: string) => env.ACCOUNT.get(env.ACCOUNT.idFromName(key));

  if (path === "/api/me") {
    if (!sub) return json({ user: null, signin: !!env.GOOGLE_CLIENT_ID });
    if (req.method === "POST") {
      const { name } = (await req.json().catch(() => ({}))) as { name?: string };
      const r = await account(`u:${sub}`).rename(String(name ?? "").toLowerCase());
      return json(r, r.ok ? 200 : 400);
    }
    const user = await account(`u:${sub}`).me();
    const hasVoice = !!(await loadStoredSample(env.FILES, savedKey(sub)));
    return json({ user: user && { ...user, voice: hasVoice, sampleText: SAMPLE_TEXT } });
  }

  // Your saved voice: recorded once with consent, used by every talk created with "Your saved voice".
  if (path === "/api/me/voice") {
    if (!sub) return json({ error: "Sign in first" }, 401);
    if (req.method === "GET") {
      const stored = await loadStoredSample(env.FILES, savedKey(sub));
      return stored
        ? new Response(stored.bytes, { headers: { "content-type": stored.mime, "cache-control": "private, no-store" } })
        : json({ error: "No saved voice" }, 404);
    }
    if (req.method === "DELETE") {
      await deleteStoredSample(env.FILES, savedKey(sub));
      return json({ ok: true });
    }
    if (req.method === "PUT") {
      if (req.headers.get("x-consent") !== "yes") return json({ error: "Consent needed" }, 400);
      const parsed = parseVoiceUpload(req.headers.get("content-type") ?? "", await req.arrayBuffer());
      if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
      const prefix = savedKey(sub);
      await deleteStoredSample(env.FILES, prefix);
      await env.FILES.put(sampleObjectKey(prefix, parsed.ext), parsed.bytes, { httpMetadata: { contentType: parsed.mime } });
      return json({ ok: true });
    }
  }

  if (path === "/api/rooms" && req.method === "POST") {
    const body = await req.text();
    if (body.length > 400_000) return json({ error: "Too large" }, 413);
    const b = JSON.parse(body || "{}");
    const kind = b.mode === "counter" ? "counter" : "stage";
    const me = sub ? await account(`u:${sub}`).me() : null;
    for (let i = 0; i < 5; i++) {
      // Signed in: /stage/{you}/{talk}, saved to your account. Guest: /stage/guest-xxxx/{talk}, host key only.
      const user = me?.handle ?? `guest-${crypto.randomUUID().slice(0, 6)}`;
      const slug = me ? await account(`u:${sub}`).addRoom(kind, String(b.slug ?? ""), String(b.title ?? "")) : slugify(String(b.slug || b.title || "")).slice(0, 36).replace(/-+$/, "") || kind;
      const id = `${kind}/${user}/${NAME.test(slug) ? slug : `${kind}-1`}`;
      const res = await room(env, id, "init", new Request("https://room/init", { method: "POST", body }), ip, sub);
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

  const m = path.match(/^\/api\/rooms\/(.+)\/([a-z]+)$/);
  if (m && ROOM.test(m[1])) {
    const inner = new Request(`https://room/${m[2]}${url.search}`, req);
    return room(env, m[1], m[2], inner, ip, sub);
  }
  return json({ error: "Not found" }, 404);
}

function room(env: Env, id: string, _action: string, req: Request, ip: string, sub: string | null): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.set("x-room", id);
  headers.set("x-ip", ip);
  headers.set("x-user", sub ?? ""); // always overwritten: a browser can't claim to be someone
  return env.ROOM.get(env.ROOM.idFromName(id)).fetch(new Request(req, { headers }));
}
