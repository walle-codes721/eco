// Google sign-in for speakers and owners. No library: OAuth code flow plus one HMAC-signed cookie.
// Listeners and customers never sign in.
import type { Env } from "./env";

const COOKIE = "eco_s";
const DAYS = 30;
const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return btoa(String.fromCharCode(...sig)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]!);
}

const cookies = (req: Request) => Object.fromEntries((req.headers.get("cookie") ?? "").split(/;\s*/).map((c) => c.split("=").map(decodeURIComponent)));

/** `sub.expiry.signature` → sub, or null if missing, expired or forged. */
export async function signedSub(secret: string, value: string | undefined, now = Date.now()): Promise<string | null> {
  const [sub, exp, sig] = (value ?? "").split(".");
  if (!sub || !exp || !sig || Number(exp) < now) return null;
  return (await hmac(secret, `${sub}.${exp}`)) === sig ? sub : null;
}

export async function signSub(secret: string, sub: string, now = Date.now()): Promise<string> {
  const exp = now + DAYS * 86_400_000;
  return `${sub}.${exp}.${await hmac(secret, `${sub}.${exp}`)}`;
}

export const sessionSub = (req: Request, env: Env) => (env.SESSION_SECRET ? signedSub(env.SESSION_SECRET, cookies(req)[COOKIE]) : Promise.resolve(null));

const cookie = (name: string, value: string, maxAge: number) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const redirect = (to: string, ...setCookies: string[]) => {
  const headers = new Headers({ location: to });
  for (const c of setCookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
};
const safeNext = (n: string | null) => (n && /^\/[a-z0-9/_-]*$/i.test(n) ? n : "/me");

/** /auth/google, /auth/callback, /auth/logout. Returns null for other paths. */
export async function authRoute(req: Request, env: Env, url: URL, path: string): Promise<Response | null> {
  if (path === "/auth/logout") return redirect("/", cookie(COOKIE, "", 0));
  if (path !== "/auth/google" && path !== "/auth/callback") return null;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET) return new Response("Sign-in isn't set up yet.", { status: 503 });
  const redirectUri = `${url.origin}/auth/callback`;

  if (path === "/auth/google") {
    const state = crypto.randomUUID();
    const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile", state, prompt: "select_account" });
    return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, cookie("eco_state", `${state}|${safeNext(url.searchParams.get("next"))}`, 600));
  }

  const [state, next] = (cookies(req).eco_state ?? "").split("|");
  if (!state || state !== url.searchParams.get("state") || !url.searchParams.get("code")) return redirect("/?signin=failed");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ code: url.searchParams.get("code")!, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const tok = (await res.json().catch(() => ({}))) as { id_token?: string };
  if (!res.ok || !tok.id_token) return redirect("/?signin=failed");
  // The id_token came straight from Google over TLS, so OIDC lets us read it without checking the signature.
  const p = JSON.parse(atob(tok.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  if (p.aud !== env.GOOGLE_CLIENT_ID || !p.sub) return redirect("/?signin=failed");
  await env.ACCOUNT.get(env.ACCOUNT.idFromName(`u:${p.sub}`)).login(p.sub, { name: p.name ?? "", email: p.email ?? "", picture: p.picture ?? "" });
  return redirect(safeNext(next), cookie(COOKIE, await signSub(env.SESSION_SECRET, p.sub), DAYS * 86400), cookie("eco_state", "", 0));
}
