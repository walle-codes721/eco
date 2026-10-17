// One Durable Object per signed-in user ("u:{google sub}") and one per claimed name ("h:{name}").
// The name DO makes claiming atomic: two people can never get the same /stage/{name}.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { NAME, nameOk, slugify } from "./names";

export interface Profile { name: string; email: string; picture: string }
export interface RoomRef { kind: "stage" | "counter"; slug: string; title: string; created: number }

export class Account extends DurableObject<Env> {
  private ns(key: string) {
    return this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(key));
  }

  // ----- on "h:{name}" -----
  async claim(sub: string): Promise<boolean> {
    const owner = await this.ctx.storage.get<string>("owner");
    if (owner && owner !== sub) return false;
    await this.ctx.storage.put("owner", sub);
    return true;
  }
  async release(sub: string) {
    if ((await this.ctx.storage.get<string>("owner")) === sub) await this.ctx.storage.delete("owner");
  }

  // ----- on "u:{sub}" -----
  async login(sub: string, profile: Profile): Promise<string> {
    await this.ctx.storage.put({ sub, profile });
    const had = await this.ctx.storage.get<string>("handle");
    if (had) return had;
    const base = slugify(profile.name || profile.email.split("@")[0]).slice(0, 30) || "speaker";
    for (let i = 0; i < 50; i++) {
      const n = i ? `${base}-${i + 1}` : base;
      if (nameOk(n) && (await this.ns(`h:${n}`).claim(sub))) return (await this.ctx.storage.put("handle", n), n);
    }
    const n = `${base}-${crypto.randomUUID().slice(0, 6)}`;
    await this.ns(`h:${n}`).claim(sub);
    await this.ctx.storage.put("handle", n);
    return n;
  }

  async me() {
    const s = await this.ctx.storage.get(["handle", "profile", "rooms", "hackathon"]);
    if (!s.get("handle")) return null;
    return {
      handle: s.get("handle") as string, ...(s.get("profile") as Profile), rooms: ((s.get("rooms") as RoomRef[]) ?? []).slice().reverse(),
      hackathon: (s.get("hackathon") as boolean | undefined) ?? true, // HACKATHON mode: on unless the speaker turned it off
    };
  }

  async setHackathon(on: boolean) {
    await this.ctx.storage.put("hackathon", on);
    return { ok: true, hackathon: on };
  }

  /** Change your name. Only before your first talk or shop, so no printed QR code ever breaks. */
  async rename(next: string): Promise<{ ok: boolean; error?: string }> {
    const s = await this.ctx.storage.get(["sub", "handle", "rooms"]);
    const sub = s.get("sub") as string;
    if (((s.get("rooms") as RoomRef[]) ?? []).length) return { ok: false, error: "Your name is fixed once you have a talk or a shop." };
    if (!nameOk(next)) return { ok: false, error: "Use 3-40 lowercase letters, numbers or dashes." };
    if (!(await this.ns(`h:${next}`).claim(sub))) return { ok: false, error: "That name is taken." };
    const old = s.get("handle") as string;
    if (old && old !== next) await this.ns(`h:${old}`).release(sub);
    await this.ctx.storage.put("handle", next);
    return { ok: true };
  }

  /** Reserve a talk or shop name under this user; adds -2, -3… if it's taken. */
  async addRoom(kind: RoomRef["kind"], want: string, title: string): Promise<string> {
    const rooms = (await this.ctx.storage.get<RoomRef[]>("rooms")) ?? [];
    const s = slugify(want) || slugify(title);
    const base = NAME.test(s) ? s.slice(0, 36) : `${kind}-${crypto.randomUUID().slice(0, 4)}`;
    let slug = base;
    for (let i = 2; rooms.some((r) => r.kind === kind && r.slug === slug); i++) slug = `${base}-${i}`;
    rooms.push({ kind, slug, title, created: Date.now() });
    await this.ctx.storage.put("rooms", rooms);
    return slug;
  }

  async dropRoom(kind: RoomRef["kind"], slug: string) {
    const rooms = (await this.ctx.storage.get<RoomRef[]>("rooms")) ?? [];
    await this.ctx.storage.put("rooms", rooms.filter((r) => !(r.kind === kind && r.slug === slug)));
  }
}
