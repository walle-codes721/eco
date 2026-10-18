// "Add a website" for a Counter: fetch one public web page once, at setup, and return its readable text.
// No AI call (token rule 5). The owner reviews the text before it becomes part of the list, and Eco never browses at answer time.
// Nothing here throws: every failure is a short message the owner can act on.

export const MAX_BYTES = 1_500_000; // read at most this much of a page
export const MAX_CHARS = 8000; // one source holds at most this much (see Room.init)
export const MAX_PARTS = 6; // a long page becomes up to this many sources, so its tail is not lost
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 4;

type Bad = { ok: false; error: string; status: number };
const bad = (error: string, status = 422): Bad => ({ ok: false, error, status });

/** Only public http(s) pages on a real domain: no addresses, no localhost, no internal names, no logins, no odd ports. */
export function validateUrl(raw: string): { ok: true; url: URL } | Bad {
  let s = String(raw ?? "").trim();
  if (!s) return bad("Paste a website address.", 400);
  if (s.length > 2000) return bad("That address is too long.", 400);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`; // "luna.it/menu" → https://luna.it/menu
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return bad("That doesn't look like a website address.", 400);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return bad("Only web addresses (http or https) can be read.", 400);
  if (url.username || url.password) return bad("Remove the username and password from the address.", 400);
  if (url.port && url.port !== "80" && url.port !== "443") return bad("That address uses an unusual port, which Eco can't read.", 400);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const blocked =
    !host.includes(".") || // localhost, intranet names
    host.includes(":") || // IPv6 literal
    /^[\d.]+$/.test(host) || // IPv4 literal, however it was written (the URL parser normalises these)
    /(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example)$/.test(host);
  if (blocked) return bad("Use your business's public website address (for example luna.it).", 400);
  url.hash = "";
  return { ok: true, url };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", euro: "€", pound: "£", copy: "©", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", egrave: "è", eacute: "é", agrave: "à", ograve: "ò", ugrave: "ù", igrave: "ì" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** Page furniture that says nothing about the business ("Skip to content", a lone "Close"). */
const BOILERPLATE = /^(skip to (main )?(content|footer|navigation|menu)|vai al contenuto|salta al contenuto|close|chiudi)$/i;

/** A price line ("€ 8,00", "€ 3,50 / 5,00", "8,00 €"): the line before it is an item's name. */
const PRICE = /^[€$£]\s?\d|^\d+[.,]\d{2}\s?[€$£]/;

const squash = (l: string) => l.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** Same text, ignoring case and punctuation, or one contains the other (a copy that only adds or drops a label or a full stop). */
const covers = (a: string, b: string) => {
  const x = squash(a), y = squash(b);
  return x === y || (Math.min(x.length, y.length) >= 8 && (x.includes(y) || y.includes(x)));
};
/** A short label such as "Bar" or "Pasticceria": no digits, no bullet, no price. */
const isHeading = (l: string) => l.length <= 32 && !/\d/.test(l) && !/^[•\-–*]/.test(l) && !PRICE.test(l);

/** Removes an item (a name, then a price line, then its description and allergens) that a page lists a second time.
 *  A later copy goes only when the first copy already says everything it says, so a copy worded a little differently leaves
 *  no stray lines behind, while a copy with more detail (ingredients, a different price) is kept whole.
 *  Short labels at its end ("Pasticceria", "Bar") go with it if they were already seen or the page repeats them;
 *  one met for the first time stays. A body made only of short lines is never read as labels: it is the description. */
export function dropRepeatedItems(lines: string[]): string[] {
  const starts: number[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (PRICE.test(lines[i]) || !PRICE.test(lines[i + 1])) continue;
    // A name on two lines ("Latte macchiato/" then "Maxi", or "…/Mandarino" then "/Arancia").
    const two = i > 0 && !PRICE.test(lines[i - 1]) && (lines[i - 1].endsWith("/") || lines[i].startsWith("/")) && starts.at(-1) !== i - 1;
    starts.push(two ? i - 1 : i);
  }
  if (!starts.length) return lines;
  const times = new Map<string, number>();
  for (const l of lines) times.set(l, (times.get(l) ?? 0) + 1);
  const out = lines.slice(0, starts[0]);
  const seen = new Set(out);
  const first = new Map<string, string[]>(); // "name price" → the first copy's description lines
  starts.forEach((from, n) => {
    const item = lines.slice(from, starts[n + 1] ?? lines.length);
    const price = item.findIndex((l) => PRICE.test(l));
    const key = squash(item.slice(0, price + 1).join(" "));
    const body = item.slice(price + 1);
    let end = body.length;
    while (end > 0 && isHeading(body[end - 1])) end--;
    if (end === 0) end = body.length; // nothing but short lines: that is a description, not labels
    const main = body.slice(0, end);
    const labels = body.slice(end);
    const earlier = first.get(key);
    if (earlier && main.every((l) => earlier.some((e) => covers(e, l))) && labels.every((l) => seen.has(l) || (times.get(l) ?? 0) >= 2)) {
      for (const l of labels) if (!seen.has(l)) (out.push(l), seen.add(l)); // a label met for the first time inside the copy
      return;
    }
    if (!earlier) first.set(key, body);
    for (const l of item) (out.push(l), seen.add(l));
  });
  return out;
}

/** Removes a block of `min` or more lines that repeats an earlier block exactly (pages often list a section twice).
 *  Lines that merely recur, such as the same allergen line under different items, stay: only a whole repeated run goes.
 *  A copy that differs somewhere keeps its differing lines, so a conflict (another price) is still visible to the owner. */
export function dropRepeatedBlocks(lines: string[], min = 4): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>(); // `min` lines in a row → where they start in `out`
  let i = 0;
  while (i < lines.length) {
    const at = i + min <= lines.length ? seen.get(lines.slice(i, i + min).join("\n")) : undefined;
    if (at !== undefined) {
      let k = min;
      while (i + k < lines.length && at + k < out.length && lines[i + k] === out[at + k]) k++;
      if (i + k < lines.length && PRICE.test(lines[i + k])) k--; // the copy differs at a price: keep that item's name with it
      i += k;
      continue;
    }
    out.push(lines[i++]);
    if (out.length >= min) {
      const key = out.slice(-min).join("\n");
      if (!seen.has(key)) seen.set(key, out.length - min);
    }
  }
  return out;
}

/** Takes out what a page says twice. A priced menu is read item by item. Other pages lose a run of lines that repeats exactly.
 *  The two are not combined: two different items can share identical description lines, and a line-run pass would strip one of them. */
export function dropRepeats(lines: string[]): string[] {
  const priced = lines.some((l, i) => i + 1 < lines.length && !PRICE.test(l) && PRICE.test(lines[i + 1]));
  return priced ? dropRepeatedItems(lines) : dropRepeatedBlocks(lines);
}

/** Splits text into pieces of at most `max` characters at line breaks. When a piece has to end in the middle of an item
 *  (a name and price, then its description and allergens), the whole item moves to the next piece.
 *  A single line longer than `max` is split at a space. */
export function splitText(text: string, max = MAX_CHARS): string[] {
  const parts: string[] = [];
  let cur: string[] = [];
  let size = 0;
  const flush = (line: string | null) => {
    // The current item starts at the last line whose next line is a price; keep it together, unless that is most of the piece.
    let carry = 0;
    for (let p = cur.length - 1; line !== null && p >= 1; p--) { // line === null: the end of the text, write everything out
      if (PRICE.test(p + 1 < cur.length ? cur[p + 1] : line)) {
        if (p * 2 >= cur.length) carry = cur.length - p;
        break;
      }
    }
    const keep = cur.slice(0, cur.length - carry).join("\n").trim();
    if (keep) parts.push(keep);
    cur = cur.slice(cur.length - carry);
    size = cur.join("\n").length;
  };
  for (let line of text.split("\n")) {
    while (line.length > max) {
      const cut = line.lastIndexOf(" ", max);
      const at = cut > max / 2 ? cut : max;
      flush(null);
      cur = [line.slice(0, at).trim()];
      flush(null);
      line = line.slice(at).trim();
    }
    if (cur.length && size + 1 + line.length > max) flush(line);
    cur.push(line);
    size += (size ? 1 : 0) + line.length;
  }
  flush(null);
  return parts;
}

/** Readable text of an HTML page: no scripts, styles, menus or markup, one line per block, cells joined with " | ". */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim()).slice(0, 120);
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|form|select|button|object|embed|canvas)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/(td|th)\s*>/gi, " | ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/?(p|div|li|ul|ol|tr|table|h[1-6]|section|article|header|footer|main|aside|dl|dt|dd|figure|figcaption|blockquote|address|pre)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  s = decode(s);
  const lines: string[] = [];
  for (const raw of s.split("\n")) {
    const line = raw.replace(/[\s ]+/g, " ").replace(/^[|\s]+|[|\s]+$/g, "").replace(/(\|\s*){2,}/g, "| ").trim();
    if (BOILERPLATE.test(line)) continue;
    if (line && line !== lines.at(-1)) lines.push(line);
  }
  return { title, text: dropRepeats(lines).join("\n") };
}

export type Page = { ok: true; parts: string[]; title: string; host: string; truncated: boolean };

/** Reads a body up to `max` bytes, then stops; cancelling the stream drops the rest. */
async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; capped: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(await res.arrayBuffer()).slice(0, max), capped: false };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  let capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.byteLength;
    if (n >= max) {
      capped = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(n, max));
  let at = 0;
  for (const p of parts) {
    const take = Math.min(p.byteLength, bytes.byteLength - at);
    if (take <= 0) break;
    bytes.set(p.subarray(0, take), at);
    at += take;
  }
  return { bytes, capped };
}

/** Fetch one page and return its text. Redirects are followed by hand so every hop is checked like the first address. */
export async function readPage(raw: string, doFetch: typeof fetch = fetch): Promise<Page | Bad> {
  const first = validateUrl(raw);
  if (!first.ok) return first;
  let url = first.url;
  try {
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await doFetch(url.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": "EcoBot/1.0 (+https://eco.linolabs.co)", accept: "text/html,application/xhtml+xml,text/plain;q=0.8", "accept-language": "en,it;q=0.8,*;q=0.5" },
      });
      if (res.status < 300 || res.status >= 400) break;
      const next = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!next || hop === MAX_REDIRECTS) return bad("That website sends visitors around in circles, so Eco can't read it.");
      let target: URL;
      try {
        target = new URL(next, url);
      } catch {
        return bad("That website redirects somewhere Eco can't read.");
      }
      const check = validateUrl(target.toString());
      if (!check.ok) return bad("That website redirects somewhere Eco can't read.");
      url = check.url;
      res = null;
    }
    if (!res) return bad("Eco couldn't read that website.");
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      await res.body?.cancel().catch(() => {});
      return bad("That website doesn't let Eco read it. Paste the text, take a photo or upload a file instead.");
    }
    if (res.status === 404 || res.status === 410) {
      await res.body?.cancel().catch(() => {});
      return bad("That page wasn't found. Check the address.");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return bad("That website isn't answering right now. Try again later.");
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type && !/^(text\/html|application\/xhtml\+xml|text\/plain)/.test(type)) {
      await res.body?.cancel().catch(() => {});
      return bad("That link isn't a web page (it may be a PDF or an image). Upload the file or take a photo instead.");
    }
    const { bytes, capped } = await readCapped(res, MAX_BYTES);
    // Header charset first, then <meta>, then UTF-8. An unknown name falls back to UTF-8 instead of failing.
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2000));
    const charset = type.match(/charset=["']?([\w-]+)/)?.[1] ?? head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? "utf-8";
    let html: string;
    try {
      html = new TextDecoder(charset).decode(bytes);
    } catch {
      html = new TextDecoder("utf-8").decode(bytes);
    }
    const plain = type.startsWith("text/plain");
    const { title, text } = plain ? { title: "", text: dropRepeats(html.replace(/\r/g, "").trim().split("\n")).join("\n") } : htmlToText(html);
    if (text.length < 60) {
      return bad("Eco found almost no text on that page. It may load its content with JavaScript. Try the menu page, or paste the text, take a photo or upload a file.");
    }
    const all = splitText(text);
    return { ok: true, parts: all.slice(0, MAX_PARTS), title, host: url.hostname.replace(/^www\./, ""), truncated: capped || all.length > MAX_PARTS };
  } catch (e) {
    const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
    return bad(timedOut ? "That website took too long to answer. Try again, or paste the text instead." : "Eco couldn't reach that website. Check the address, or paste the text instead.");
  }
}

/** Best-effort limit per visitor: an isolate keeps its own count, which is enough to stop the endpoint being used as a free page fetcher. */
const WINDOW_MS = 3_600_000;
const PER_HOUR = 20;
const hits = new Map<string, number[]>();
export function allowFetch(ip: string, now = Date.now()): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= PER_HOUR) {
    hits.set(ip, recent);
    return false;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  return true;
}
