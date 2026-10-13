// One global limiter for every live call (CLAUDE.md rules 11, 12, 20, 21). Mock calls never reach it.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

import { admit, PRICE, type Kind, type Denied } from "./limits";
export type { Kind, Denied };

export interface CallRecord {
  kind: Kind;
  model: string;
  ms: number;
  status: number;
  tin: number;
  tout: number;
  pub: boolean;
}

export class Budget extends DurableObject<Env> {
  private window: number[] = [];
  private inflight = 0;
  private fails = 0;
  private tripped = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS calls (t INTEGER, kind TEXT, model TEXT, ms INTEGER, status INTEGER, tin INTEGER, tout INTEGER, pub INTEGER)",
    );
    ctx.blockConcurrencyWhile(async () => {
      this.tripped = (await ctx.storage.get<boolean>("tripped")) ?? false;
    });
  }

  private count(sinceMs: number, pubOnly = false): number {
    const q = pubOnly ? "SELECT COUNT(*) AS n FROM calls WHERE t >= ? AND pub = 1" : "SELECT COUNT(*) AS n FROM calls WHERE t >= ?";
    return this.ctx.storage.sql.exec<{ n: number }>(q, sinceMs).one().n;
  }

  private dayStart(): number {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  /** Waits up to `waitMs` for a slot. Translation waits; questions don't. */
  async acquire(kind: Kind, pub: boolean, waitMs = 0): Promise<{ ok: true } | { ok: false; reason: Denied }> {
    const until = Date.now() + waitMs;
    for (;;) {
      const now = Date.now();
      this.window = this.window.filter((t) => now - t < 60_000);
      const reason = admit(
        {
          today: this.count(this.dayStart()),
          max: Number(this.env.ECO_MAX_CALLS ?? 50),
          window: this.window.length,
          inflight: this.inflight,
          tripped: this.tripped,
          pubHour: pub ? this.count(now - 3_600_000, true) : 0,
          pubMax: Number(this.env.ECO_PUBLIC_HOURLY ?? 30),
        },
        kind,
        pub,
      );
      if (!reason) {
        this.window.push(now);
        this.inflight++;
        return { ok: true };
      }
      if ((reason !== "busy" && reason !== "rpm") || Date.now() + 250 > until) return { ok: false, reason };
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async finish(rec: CallRecord): Promise<void> {
    this.inflight = Math.max(0, this.inflight - 1);
    this.ctx.storage.sql.exec(
      "INSERT INTO calls VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      Date.now(), rec.kind, rec.model, rec.ms, rec.status, rec.tin, rec.tout, rec.pub ? 1 : 0,
    );
    this.fails = rec.status === 200 ? 0 : this.fails + 1;
    if (this.fails >= 3) {
      this.tripped = true; // rule 21: stop after 3 failures in a row
      await this.ctx.storage.put("tripped", true);
    }
  }

  async stats() {
    const since = this.dayStart();
    const rows = this.ctx.storage.sql
      .exec<{ kind: string; model: string; ms: number; tin: number; tout: number; status: number }>(
        "SELECT kind, model, ms, tin, tout, status FROM calls WHERE t >= ?",
        since,
      )
      .toArray();
    const ok = rows.filter((r) => r.status === 200);
    const p50 = (k: string) => {
      const v = ok.filter((r) => r.kind === k).map((r) => r.ms).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    };
    const points = ok.reduce((s, r) => {
      const [pi, po] = PRICE[r.model] ?? [0, 0];
      return s + (r.tin * pi + r.tout * po) / 1e6;
    }, 0);
    return {
      live: this.env.ECO_LIVE === "1",
      today: rows.length,
      max: Number(this.env.ECO_MAX_CALLS ?? 50),
      tripped: this.tripped,
      p50: { utterance: p50("utterance"), ask: p50("ask"), turn: p50("turn") },
      tokens: { in: ok.reduce((s, r) => s + r.tin, 0), out: ok.reduce((s, r) => s + r.tout, 0) },
      points: Math.round(points * 1e4) / 1e4,
    };
  }

  async log(): Promise<string> {
    return this.ctx.storage.sql
      .exec("SELECT * FROM calls ORDER BY t")
      .toArray()
      .map((r) => JSON.stringify(r))
      .join("\n");
  }

  async reset(): Promise<void> {
    this.tripped = false;
    this.fails = 0;
    await this.ctx.storage.put("tripped", false);
  }
}
