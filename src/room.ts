// One Durable Object per room: state, WebSocket fan-out, and every call the room makes.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { tf, isLive } from "./tf";
import { MODELS, utterancePrompt, answerPrompt, customerTurnPrompt, ownerTurnPrompt } from "./prompts";
import { bestSentence, chunkPages, normalize, selectContext, terms, type Chunk } from "./retrieve";
import { voiceFor } from "./voice";
import { DEMO_SLIDES, DEMO_TALK, DEMO_SHOP, DEMO_CONVOS } from "./fixtures/demo";

type Status = "lobby" | "live" | "ended";

export interface Meta {
  id: string;
  mode: "stage" | "counter";
  title: string;
  speaker: string;
  hostKey: string;
  langs: string[]; // stage: target languages
  created: number;
  status: Status;
  startedAt: number | null;
  endedAt: number | null;
  slide: number;
  demo: boolean;
  bizType: string; // counter
  ownerLang: string; // counter
}
export interface Line { seq: number; t: number; at: number; slide: number; src: string; out: Record<string, string>; flags: string[]; ms: number; live: boolean; audio?: Record<string, string> }
export interface Question { id: string; t: number; at: number; slide: number; lang: string; text: string; q_en: string; covered: boolean; answer: string; cite: string; answeredAt: number | null }
export interface Turn { id: string; t: number; side: "customer" | "owner" | "eco"; lang: string; src: string; out: string; cite?: string; live: boolean }
export interface Convo { id: string; lang: string; started: number; open: boolean; turns: Turn[] }
type Answer = { covered: boolean; answer: string; cite: string; q_en: string };
type CustomerTurn = { src: string; lang: string; to_owner: string; answer: { covered: boolean; text: string; text_owner: string; cite: string } };

const DEMOS: Record<string, "stage" | "counter"> = { demo: "stage", gelato: "counter" };
const LIMITS = { ask: [3, 10], voice: [4, 40], turn: [8, 60] } as const; // per visitor per hour: [demo, normal]

const json = (data: unknown, status = 200) => Response.json(data, { status });
const uid = () => crypto.randomUUID().slice(0, 8);

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class Room extends DurableObject<Env> {
  meta: Meta | null = null;
  pages: { tag: string; text: string }[] = [];
  chunks: Chunk[] = [];
  lines: Line[] = [];
  questions: Question[] = [];
  convos: Convo[] = [];
  cache: Record<string, Answer> = {};
  peak = 0;
  private visitors = new Map<string, number>();
  private mockI = 0;
  private replayI = 0;
  private replayPausedUntil = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const s = await ctx.storage.get(["meta", "pages", "chunks", "lines", "questions", "convos", "cache", "peak"]);
      this.meta = (s.get("meta") as Meta) ?? null;
      this.pages = (s.get("pages") as typeof this.pages) ?? [];
      this.chunks = (s.get("chunks") as Chunk[]) ?? [];
      this.lines = (s.get("lines") as Line[]) ?? [];
      this.questions = (s.get("questions") as Question[]) ?? [];
      this.convos = (s.get("convos") as Convo[]) ?? [];
      this.cache = (s.get("cache") as Record<string, Answer>) ?? {};
      this.peak = (s.get("peak") as number) ?? 0;
    });
  }

  private save(...keys: ("meta" | "pages" | "chunks" | "lines" | "questions" | "convos" | "cache" | "peak")[]) {
    const entries: Record<string, unknown> = {};
    for (const k of keys) entries[k] = this[k];
    return this.ctx.storage.put(entries);
  }

  // ---------- creation ----------

  async init(id: string, body: any): Promise<{ id: string; hostKey: string } | null> {
    if (this.meta) return null;
    const mode = body.mode === "counter" ? "counter" : "stage";
    const s = (v: unknown, n: number) => String(v ?? "").slice(0, n).trim();
    this.meta = {
      id,
      mode,
      title: s(body.title, 120) || (mode === "stage" ? "Untitled talk" : "My business"),
      speaker: s(body.speaker, 80),
      hostKey: crypto.randomUUID().replaceAll("-", ""),
      langs: (Array.isArray(body.langs) ? body.langs : ["it", "es", "hi"]).map((l: string) => s(l, 5)).slice(0, 3),
      created: Date.now(),
      status: "lobby",
      startedAt: null,
      endedAt: null,
      slide: 1,
      demo: !!body.demo,
      bizType: s(body.bizType, 30) || "shop",
      ownerLang: s(body.ownerLang, 5) || "it",
    };
    const pages: { tag: string; text: string }[] = (Array.isArray(body.pages) ? body.pages : [])
      .slice(0, 200)
      .map((p: any) => ({ tag: s(p.tag, 40), text: s(p.text, 8000) }))
      .filter((p: { text: string }) => p.text);
    if (body.notes) pages.push({ tag: "notes", text: s(body.notes, 20000) });
    this.pages = pages;
    this.chunks = chunkPages(pages);
    await this.save("meta", "pages", "chunks");
    return { id, hostKey: this.meta.hostKey };
  }

  private async ensureDemo(id: string) {
    if (this.meta || !DEMOS[id]) return;
    if (DEMOS[id] === "stage") {
      await this.init(id, { mode: "stage", title: "Eco: one engine, two rooms", speaker: "Seb", langs: ["it", "es", "hi"], pages: DEMO_SLIDES, demo: true });
    } else {
      await this.init(id, { mode: "counter", title: DEMO_SHOP.name, bizType: DEMO_SHOP.type, ownerLang: DEMO_SHOP.ownerLang, pages: DEMO_SHOP.sources, demo: true });
      const t0 = Date.now() - 20 * 60_000;
      this.convos = DEMO_CONVOS.map((c, i) => {
        const t = t0 + i * 6 * 60_000;
        const turns: Turn[] = [{ id: uid(), t, side: "customer", lang: c.lang, src: c.customer, out: c.to_owner, live: false }];
        if (c.answer.covered) turns.push({ id: uid(), t: t + 2500, side: "eco", lang: c.lang, src: c.answer.text, out: c.answer.text_owner, cite: c.answer.cite, live: false });
        return { id: `seed${i}`, lang: c.lang, started: t, open: !c.answer.covered, turns };
      });
      await this.save("convos");
    }
  }

  publicMeta() {
    const m = this.meta!;
    return {
      id: m.id, mode: m.mode, title: m.title, speaker: m.speaker, langs: m.langs, status: m.status,
      startedAt: m.startedAt, endedAt: m.endedAt, slide: m.slide, demo: m.demo, bizType: m.bizType, ownerLang: m.ownerLang,
      live: isLive(this.env),
      slides: m.mode === "stage" ? this.pages.filter((p) => p.tag !== "notes") : [],
    };
  }

  // ---------- HTTP ----------

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const id = req.headers.get("x-room") ?? "";
    const action = url.pathname.slice(1);
    if (action === "init") {
      const made = await this.init(id, await req.json());
      return made ? json(made) : json({ error: "exists" }, 409);
    }
    await this.ensureDemo(id);
    if (!this.meta) return json({ error: "Room not found" }, 404);

    const m = this.meta;
    const isHost = req.headers.get("x-key") === m.hostKey || url.searchParams.get("key") === m.hostKey;
    const ip = req.headers.get("x-ip") ?? "?";

    switch (`${req.method} ${action}`) {
      case "GET meta":
        return json({ ...this.publicMeta(), host: isHost });
      case "GET ws":
        return this.openSocket(url, isHost);
      case "GET transcript":
        return json({ meta: this.publicMeta(), lines: this.lines });
      case "POST utterance": {
        if (!isHost && !(m.demo && this.allow(ip, "voice"))) return json({ error: "Not allowed" }, 403);
        return this.utterance(req, m.demo && !isHost);
      }
      case "POST ask":
        return this.ask(await req.json(), ip);
      case "POST turn":
        return this.turn(req, isHost, ip);
      case "GET board":
        return isHost || m.demo ? json(this.board()) : json({ error: "Not allowed" }, 403);
      case "GET card":
        return isHost || m.demo ? json(m.mode === "stage" ? this.stageCard() : this.counterCard()) : json({ error: "Not allowed" }, 403);
      case "GET convos":
        return isHost || m.demo ? json({ convos: this.convos }) : json({ error: "Not allowed" }, 403);
    }
    if (!isHost) return json({ error: "Not allowed" }, 403);
    const body: any = await req.json().catch(() => ({}));
    switch (`${req.method} ${action}`) {
      case "POST slide": {
        m.slide = Math.max(1, Math.min(Number(body.n) || 1, Math.max(1, this.pages.length)));
        await this.save("meta");
        this.send(["listener", "screen", "host"], { type: "slide", n: m.slide });
        return json({ slide: m.slide });
      }
      case "POST status":
        return json(await this.setStatus(body.status));
      case "POST answered": {
        const qids: string[] = Array.isArray(body.qids) ? body.qids : [];
        const at = this.elapsed();
        for (const q of this.questions) if (qids.includes(q.id)) q.answeredAt = at;
        await this.save("questions");
        this.send(["listener"], { type: "answered", qids, at });
        this.pushBoard();
        return json({ ok: true });
      }
      case "POST sources": {
        if (m.mode !== "counter") break;
        this.pages = (Array.isArray(body.pages) ? body.pages : []).map((p: any) => ({ tag: String(p.tag).slice(0, 40), text: String(p.text).slice(0, 8000) }));
        this.chunks = chunkPages(this.pages);
        await this.save("pages", "chunks");
        return json({ ok: true, chunks: this.chunks.length });
      }
    }
    return json({ error: "Unknown action" }, 404);
  }

  /** Per-visitor hourly limits; cached and mock-free paths don't call this. */
  private allow(ip: string, kind: keyof typeof LIMITS): boolean {
    const key = `${ip}:${kind}:${Math.floor(Date.now() / 3_600_000)}`;
    const n = this.visitors.get(key) ?? 0;
    if (n >= LIMITS[kind][this.meta!.demo ? 0 : 1]) return false;
    this.visitors.set(key, n + 1);
    if (this.visitors.size > 5000) this.visitors.clear();
    return true;
  }

  private elapsed(): number {
    const m = this.meta!;
    return m.startedAt ? Math.round((Date.now() - m.startedAt) / 1000) : 0;
  }

  private async setStatus(status: Status) {
    const m = this.meta!;
    if (!["lobby", "live", "ended"].includes(status)) return { status: m.status };
    m.status = status;
    if (status === "live" && !m.startedAt) m.startedAt = Date.now();
    if (status === "ended") m.endedAt = Date.now();
    if (status === "live") m.endedAt = null;
    await this.save("meta");
    this.send(["listener", "screen", "host"], { type: "status", status, startedAt: m.startedAt, endedAt: m.endedAt });
    return { status };
  }

  // ---------- WebSockets (hibernation API) ----------

  private openSocket(url: URL, isHost: boolean): Response {
    const role = url.searchParams.get("role") ?? "listener";
    if ((role === "host" || role === "owner") && !isHost && !this.meta!.demo) return json({ error: "Not allowed" }, 403);
    const lang = (url.searchParams.get("lang") ?? "en").slice(0, 5);
    const cid = (url.searchParams.get("cid") ?? "").slice(0, 40);
    const pair = new WebSocketPair();
    const tags = [role, `lang:${lang}`, ...(cid ? [`c:${cid}`] : [])];
    this.ctx.acceptWebSocket(pair[1], tags);
    pair[1].serializeAttachment({ role, lang, cid });

    const m = this.meta!;
    const hello: Record<string, unknown> = { type: "hello", meta: this.publicMeta() };
    // 50 = the client's line buffer (public/js/pages/listener.js); the two must stay in lockstep,
    // otherwise a late joiner can't scroll back through everything a long-time listener has.
    if (m.mode === "stage") hello.lines = this.lines.slice(-50);
    if (role === "host") hello.board = this.board();
    if (role === "owner") hello.convos = this.convos;
    if (role === "customer") hello.convo = this.convos.find((c) => c.id === cid) ?? null;
    pair[1].send(JSON.stringify(hello));

    if (role === "listener") this.presence();
    if (m.demo && m.mode === "stage") this.ctx.storage.getAlarm().then((a) => { if (!a) this.ctx.storage.setAlarm(Date.now() + 1500); });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (typeof msg !== "string") return;
    let d: any;
    try {
      d = JSON.parse(msg);
    } catch {
      return;
    }
    if (d.type === "ping") ws.send('{"type":"pong"}');
    if (d.type === "lang" && typeof d.lang === "string") {
      ws.serializeAttachment({ ...ws.deserializeAttachment(), lang: d.lang.slice(0, 5) });
      this.presence();
    }
  }

  async webSocketClose(ws: WebSocket) {
    if (ws.deserializeAttachment()?.role === "listener") this.presence();
  }

  private send(roles: string[], msg: unknown, extraTags: string[] = []) {
    const s = JSON.stringify(msg);
    for (const tag of [...roles, ...extraTags])
      for (const ws of this.ctx.getWebSockets(tag)) {
        try {
          ws.send(s);
        } catch {}
      }
  }

  private listenerLangs(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const ws of this.ctx.getWebSockets("listener")) {
      const l = ws.deserializeAttachment()?.lang ?? "en";
      out[l] = (out[l] ?? 0) + 1;
    }
    return out;
  }

  private presence() {
    const n = this.ctx.getWebSockets("listener").length;
    if (n > this.peak) {
      this.peak = n;
      this.save("peak");
    }
    this.pushBoard();
  }

  private pushBoard() {
    if (this.ctx.getWebSockets("host").length) this.send(["host"], { type: "board", board: this.board() });
  }

  // ---------- Stage ----------

  private async utterance(req: Request, tryVoice: boolean): Promise<Response> {
    const m = this.meta!;
    if (m.status === "ended") return json({ error: "Talk ended" }, 409);
    const buf = await req.arrayBuffer();
    if (buf.byteLength < 1000 || buf.byteLength > 800_000) return json({ error: "Bad audio" }, 413);
    const t0 = Date.now();
    if (tryVoice) this.replayPausedUntil = Date.now() + 45_000;

    const prev = this.lines.slice(-2).map((l) => l.src);
    const r = await tf(this.env, "utterance", MODELS.audio, utterancePrompt(b64(buf), m.langs, prev), {
      pub: m.demo,
      mock: () => {
        const d = DEMO_TALK[this.mockI++ % DEMO_TALK.length];
        return { src: d.src, out: Object.fromEntries(m.langs.map((l) => [l, d.out[l] ?? d.src])), flags: [] as string[] };
      },
    });
    if (r.data === null) {
      this.send(["host"], { type: "notice", level: "warn", text: `Translation paused (${r.fallback}).` });
      return json({ fallback: r.fallback }, 503);
    }
    if (!r.data.src?.trim()) return json({ empty: true });
    if (m.status === "lobby") await this.setStatus("live");
    const line = await this.addLine({ src: r.data.src, out: r.data.out ?? {}, flags: r.data.flags ?? [], ms: Date.now() - t0, live: r.live });
    return json({ line });
  }

  private async addLine(p: Pick<Line, "src" | "out" | "flags" | "ms" | "live">): Promise<Line> {
    const line: Line = { seq: (this.lines.at(-1)?.seq ?? 0) + 1, t: Date.now(), at: this.elapsed(), slide: this.meta!.slide, ...p };
    const audio = await voiceFor(this.env, line.out);
    if (audio) line.audio = audio;
    this.lines.push(line);
    if (this.lines.length > 600) this.lines.splice(0, this.lines.length - 600);
    await this.save("lines");
    this.send(["listener", "screen", "host"], { type: "line", line });
    return line;
  }

  /** Deck chunks plus what the speaker has said so far, ~150 words per transcript chunk. */
  private sourceChunks(): Chunk[] {
    const said: Chunk[] = [];
    let buf: Line[] = [];
    const flush = () => {
      if (!buf.length) return;
      const at = buf[0].at;
      said.push({ tag: `said at ${Math.floor(at / 60)}:${String(at % 60).padStart(2, "0")}`, title: `Slide ${buf[0].slide}`, text: buf.map((l) => l.src).join(" ") });
      buf = [];
    };
    for (const l of this.lines) {
      buf.push(l);
      if (buf.reduce((n, x) => n + x.src.split(" ").length, 0) > 150) flush();
    }
    flush();
    return [...this.chunks, ...said];
  }

  private async ask(body: any, ip: string): Promise<Response> {
    const m = this.meta!;
    const text = String(body.text ?? "").trim().slice(0, 300);
    const lang = String(body.lang ?? "en").slice(0, 5);
    if (!text) return json({ error: "Empty question" }, 400);
    const key = `${normalize(text)}|${lang}`;
    let a = this.cache[key];
    let fromCache = !!a;
    if (!a) {
      if (!this.allow(ip, "ask")) return json({ error: "limit" }, 429);
      const chunks = m.mode === "stage" ? this.sourceChunks() : this.chunks;
      const { picked, best } = selectContext(chunks, text);
      const r = await tf<Answer>(this.env, "ask", MODELS.answer, answerPrompt(picked, text, lang), {
        pub: m.demo,
        mock: () => {
          const b = bestSentence(text, best);
          return { covered: b.covered, answer: b.text, cite: b.cite, q_en: text };
        },
      });
      if (r.data === null) return json({ error: "busy", fallback: r.fallback }, 503);
      const tags = new Set(chunks.map((c) => c.tag));
      const cite = tags.has(r.data.cite) ? r.data.cite : r.data.covered ? best?.tag ?? "" : "";
      a = { covered: !!r.data.covered && !!r.data.answer, answer: String(r.data.answer ?? ""), cite, q_en: String(r.data.q_en || text) };
      this.cache[key] = a;
      fromCache = false;
    }
    const q: Question = { id: uid(), t: Date.now(), at: this.elapsed(), slide: m.slide, lang, text, q_en: a.q_en, covered: a.covered, answer: a.answer, cite: a.cite, answeredAt: null };
    this.questions.push(q);
    await this.save("questions", "cache");
    this.pushBoard();
    return json({ id: q.id, covered: q.covered, answer: q.answer, cite: q.cite, cached: fromCache });
  }

  board() {
    const qs = this.questions;
    const topics = new Map<string, { topic: string; title: string; count: number; sample: string }>();
    for (const q of qs.filter((q) => q.covered)) {
      const t = topics.get(q.cite) ?? { topic: q.cite, title: this.chunks.find((c) => c.tag === q.cite)?.title ?? q.cite, count: 0, sample: "" };
      t.count++;
      t.sample = q.q_en;
      topics.set(q.cite, t);
    }
    const queue = new Map<string, { qids: string[]; q: string; count: number; langs: string[]; answeredAt: number | null }>();
    for (const q of qs.filter((q) => !q.covered)) {
      const k = normalize(q.q_en);
      const g = queue.get(k) ?? { qids: [], q: q.q_en, count: 0, langs: [], answeredAt: null };
      g.qids.push(q.id);
      g.count++;
      if (!g.langs.includes(q.lang)) g.langs.push(q.lang);
      g.answeredAt = q.answeredAt;
      queue.set(k, g);
    }
    const bySlide: Record<number, number> = {};
    for (const q of qs) bySlide[q.slide] = (bySlide[q.slide] ?? 0) + 1;
    const qLangs: Record<string, number> = {};
    for (const q of qs) qLangs[q.lang] = (qLangs[q.lang] ?? 0) + 1;
    const live = this.lines.filter((l) => l.live).map((l) => l.ms).sort((a, b) => a - b);
    return {
      listeners: this.listenerLangs(),
      peak: this.peak,
      questions: qs.length,
      topics: [...topics.values()].sort((a, b) => b.count - a.count).slice(0, 5),
      queue: [...queue.values()].sort((a, b) => Number(!!a.answeredAt) - Number(!!b.answeredAt) || b.count - a.count),
      bySlide,
      qLangs,
      lines: this.lines.length,
      p50: live.length ? live[Math.floor(live.length / 2)] : null,
    };
  }

  stageCard() {
    const m = this.meta!;
    const b = this.board();
    const worst = Object.entries(b.bySlide).sort((a, c) => c[1] - a[1])[0];
    return {
      title: m.title, speaker: m.speaker, langs: m.langs,
      duration: m.startedAt ? Math.round(((m.endedAt ?? Date.now()) - m.startedAt) / 1000) : 0,
      peak: this.peak, lines: this.lines.length, liveLines: this.lines.filter((l) => l.live).length,
      questions: b.questions, qLangs: b.qLangs, topics: b.topics,
      worstSlide: worst ? { slide: Number(worst[0]), count: worst[1], title: this.pages[Number(worst[0]) - 1]?.text.split("\n")[0] ?? "" } : null,
      unanswered: b.queue.filter((g) => !g.answeredAt).map((g) => ({ q: g.q, count: g.count })),
      p50: b.p50,
    };
  }

  // Replay for the public demo talk: plays the fixture with real gaps while anyone is watching.
  async alarm() {
    const m = this.meta;
    if (!m?.demo || m.mode !== "stage") return;
    const watching = this.ctx.getWebSockets("listener").length + this.ctx.getWebSockets("screen").length + this.ctx.getWebSockets("host").length;
    if (!watching) return; // next connection restarts it
    if (Date.now() < this.replayPausedUntil) return void this.ctx.storage.setAlarm(this.replayPausedUntil);
    // Start of a loop (or the object was evicted mid-loop): start clean so old and new lines never mix.
    if (this.replayI >= DEMO_TALK.length || (this.replayI === 0 && this.lines.length)) {
      this.replayI = 0;
      this.lines = [];
      this.questions = this.questions.slice(-30);
      m.startedAt = Date.now();
      m.slide = 1;
      await this.save("lines", "meta", "questions");
      this.send(["listener", "screen", "host"], { type: "reset", meta: this.publicMeta() });
      return void this.ctx.storage.setAlarm(Date.now() + 3000);
    }
    const d = DEMO_TALK[this.replayI++];
    if (m.status !== "live") await this.setStatus("live");
    if (d.slide !== m.slide) {
      m.slide = d.slide;
      await this.save("meta");
      this.send(["listener", "screen", "host"], { type: "slide", n: d.slide });
    }
    await this.addLine({ src: d.src, out: d.out, flags: [], ms: 0, live: false });
    const next = DEMO_TALK[this.replayI];
    await this.ctx.storage.setAlarm(Date.now() + (next ? next.delay : 9000));
  }

  // ---------- Counter ----------

  private async turn(req: Request, isHost: boolean, ip: string): Promise<Response> {
    const m = this.meta!;
    if (m.mode !== "counter") return json({ error: "Not a counter" }, 400);
    const audio = req.headers.get("content-type")?.startsWith("audio/");
    const body: any = audio ? {} : await req.json();
    const side = (audio ? req.headers.get("x-side") : body.side) === "owner" ? "owner" : "customer";
    const cid = String((audio ? req.headers.get("x-cid") : body.cid) ?? "").slice(0, 40);
    const hint = String((audio ? req.headers.get("x-lang") : body.lang) ?? "en").slice(0, 5);
    const text = audio ? "" : String(body.text ?? "").trim().slice(0, 500);
    const wav = audio ? await req.arrayBuffer() : null;
    if (!cid || (!text && !wav)) return json({ error: "Empty" }, 400);
    if (wav && (wav.byteLength < 1000 || wav.byteLength > 800_000)) return json({ error: "Bad audio" }, 413);
    if (side === "owner" && !isHost && !m.demo) return json({ error: "Not allowed" }, 403);
    if (!isHost && !this.allow(ip, "turn")) return json({ error: "limit" }, 429);

    let convo = this.convos.find((c) => c.id === cid);
    if (!convo) {
      if (side === "owner") return json({ error: "No conversation" }, 404);
      convo = { id: cid, lang: hint, started: Date.now(), open: false, turns: [] };
      this.convos.push(convo);
      if (this.convos.length > 300) this.convos.shift();
    }
    const input = wav ? { wavB64: b64(wav) } : { text };
    const added: Turn[] = [];

    if (side === "customer") {
      const { picked } = selectContext(this.chunks, text);
      const r = await tf<CustomerTurn>(this.env, "turn", MODELS.audio, customerTurnPrompt({ name: m.title, type: m.bizType, ownerLang: m.ownerLang }, picked, input), {
        pub: m.demo,
        mock: () => {
          const seed = text ? DEMO_CONVOS.find((c) => normalize(c.customer) === normalize(text)) : DEMO_CONVOS[this.mockI++ % DEMO_CONVOS.length];
          if (seed) return { src: seed.customer, lang: seed.lang, to_owner: seed.to_owner, answer: seed.answer };
          const b = bestSentence(text, selectContext(this.chunks, text).best);
          return { src: text, lang: hint, to_owner: text, answer: { covered: b.covered, text: b.text, text_owner: b.text, cite: b.cite } };
        },
      });
      if (r.data === null) return json({ error: "busy", fallback: r.fallback }, 503);
      const d = r.data;
      if (d.lang) convo.lang = d.lang.slice(0, 5);
      added.push({ id: uid(), t: Date.now(), side: "customer", lang: convo.lang, src: d.src, out: d.to_owner, live: r.live });
      const covered = !!d.answer?.covered && !!d.answer.text;
      if (covered) added.push({ id: uid(), t: Date.now(), side: "eco", lang: convo.lang, src: d.answer.text, out: d.answer.text_owner || d.answer.text, cite: d.answer.cite, live: r.live });
      convo.open = !covered;
    } else {
      const r = await tf<{ src: string; out: string }>(this.env, "turn", MODELS.audio, ownerTurnPrompt(m.ownerLang, convo.lang, input), {
        pub: m.demo,
        mock: () => ({ src: text || "(audio)", out: text || "(audio)" }),
      });
      if (r.data === null) return json({ error: "busy", fallback: r.fallback }, 503);
      added.push({ id: uid(), t: Date.now(), side: "owner", lang: m.ownerLang, src: r.data.src, out: r.data.out, live: r.live });
      convo.open = false;
    }
    convo.turns.push(...added);
    await this.save("convos");
    const msg = { type: "turns", cid, lang: convo.lang, open: convo.open, turns: added };
    this.send(["owner"], msg, [`c:${cid}`]);
    return json(msg);
  }

  counterCard() {
    const m = this.meta!;
    const langs: Record<string, number> = {};
    const topics: Record<string, number> = {};
    const missing: Record<string, number> = {};
    const unanswered: string[] = [];
    const known = new Set(terms(this.chunks.map((c) => c.text).join(" "))); // words the info already covers
    for (const c of this.convos) {
      langs[c.lang] = (langs[c.lang] ?? 0) + 1;
      c.turns.forEach((t, i) => {
        if (t.side !== "customer") return;
        const next = c.turns[i + 1];
        if (next?.side === "eco" && next.cite) topics[next.cite] = (topics[next.cite] ?? 0) + 1;
        else if (!next) {
          unanswered.push(t.out);
          for (const w of terms(t.out).filter((w) => w.length > 3 && !known.has(w))) missing[w] = (missing[w] ?? 0) + 1;
        }
      });
    }
    const gap = Object.entries(missing).sort((a, b) => b[1] - a[1])[0];
    return {
      title: m.title, bizType: m.bizType, ownerLang: m.ownerLang,
      conversations: this.convos.length,
      langs,
      topics: Object.entries(topics).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([topic, count]) => ({ topic, count })),
      unanswered: unanswered.slice(-10),
      suggestion: gap ? { word: gap[0], count: gap[1] } : null,
    };
  }
}
