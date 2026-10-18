import { describe, expect, it } from "vitest";
import { allowFetch, dropRepeatedBlocks, dropRepeatedItems, dropRepeats, htmlToText, MAX_CHARS, MAX_PARTS, readPage, splitText, validateUrl } from "../src/webpage";
import { allergenChunks, allergyContext, hasAllergenInfo, isWebsite } from "../src/safety";
import { chunkPages } from "../src/retrieve";

const page = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });
const fetcher = (responses: Response[]) => {
  const seen: string[] = [];
  const fn = (async (url: string) => {
    seen.push(String(url));
    return responses.shift() ?? new Response("", { status: 500 });
  }) as unknown as typeof fetch;
  return { fn, seen };
};
const LONG = "<p>Gelateria Luna is open every day from 10 to 22. We serve pistachio, hazelnut and lemon gelato.</p>";

describe("validateUrl", () => {
  it.each([
    ["luna.it", "https://luna.it/"],
    ["  https://www.luna.it/menu#top ", "https://www.luna.it/menu"],
    ["http://luna.it:80/x", "http://luna.it/x"],
  ])("accepts %s", (input, out) => {
    const r = validateUrl(input);
    expect(r.ok && r.url.toString()).toBe(out);
  });

  it.each([
    "", "   ", "localhost", "http://localhost:8787", "127.0.0.1", "http://10.0.0.5/admin", "192.168.1.1", "http://169.254.169.254/latest",
    "http://[::1]/", "http://2130706433/", "http://0x7f000001/", "http://printer.local/", "http://db.internal/", "intranet",
    "ftp://luna.it", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@luna.it", "https://luna.it:8443", "not a url at all",
  ])("refuses %j without throwing", (input) => {
    const r = validateUrl(input);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.length).toBeGreaterThan(5);
  });
});

describe("htmlToText", () => {
  it("drops scripts, styles, menus and markup, and keeps one line per block", () => {
    const { title, text } = htmlToText(
      `<html><head><title>Luna &amp; Co</title><style>p{}</style></head><body><nav>Home | About</nav><script>alert(1)</script>
       <h1>Menu</h1><table><tr><td>Espresso</td><td>&euro;1.20</td></tr></table><ul><li>Cappuccino</li><li>Cornetto</li></ul><!-- hidden --></body></html>`,
    );
    expect(title).toBe("Luna & Co");
    expect(text).toContain("Espresso | €1.20");
    expect(text).toContain("Cappuccino\nCornetto");
    expect(text).not.toMatch(/alert|Home|hidden|<|p\{\}/);
  });
  it("drops skip links and a lone Close, but keeps repeated allergen lines", () => {
    const { text } = htmlToText("<a>Skip to content</a><div>Skip to footer</div><button>Close</button><p>Coppa A</p><p>• Allergeni: latte</p><p>Coppa B</p><p>• Allergeni: latte</p>");
    expect(text).toBe("Coppa A\n• Allergeni: latte\nCoppa B\n• Allergeni: latte");
  });
  it("decodes numeric entities and never throws on junk", () => {
    expect(htmlToText("<p>caff&#232; &#x20AC;2 &#99999999;</p>").text).toBe("caffè €2");
    expect(() => htmlToText("<<<>>><p<b>")).not.toThrow();
  });
});

describe("readPage", () => {
  it("returns the text, title and a clean host", async () => {
    const { fn, seen } = fetcher([page(`<title>Luna</title>${LONG}`)]);
    const r = await readPage("https://www.luna.it/menu", fn);
    expect(r.ok && r.host).toBe("luna.it");
    expect(r.ok && r.parts.join("\n")).toContain("open every day");
    expect(r.ok && r.truncated).toBe(false);
    expect(seen).toEqual(["https://www.luna.it/menu"]);
  });

  it("follows a redirect but checks every hop", async () => {
    const ok = fetcher([new Response(null, { status: 301, headers: { location: "/menu" } }), page(LONG)]);
    expect((await readPage("luna.it", ok.fn)).ok).toBe(true);
    expect(ok.seen[1]).toBe("https://luna.it/menu");

    const evil = fetcher([new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }), page(LONG)]);
    const r = await readPage("luna.it", evil.fn);
    expect(r.ok).toBe(false);
    expect(evil.seen).toHaveLength(1); // never asked for the internal address
  });

  it("gives up on redirect loops", async () => {
    const loop = fetcher(Array.from({ length: 8 }, () => new Response(null, { status: 302, headers: { location: "https://luna.it/" } })));
    expect((await readPage("luna.it", loop.fn)).ok).toBe(false);
  });

  it("splits a long page into several sources at line breaks, so no item is cut in half", async () => {
    const items = Array.from({ length: 600 }, (_, i) => `<p>Coppa numero ${i} € ${i % 20},00 gelato alla crema</p>`).join("");
    const r = await readPage("luna.it", fetcher([page(items)]).fn);
    expect(r.ok && r.parts.length).toBeGreaterThan(1);
    expect(r.ok && r.truncated).toBe(false);
    if (!r.ok) throw new Error("expected a page");
    for (const p of r.parts) {
      expect(p.length).toBeLessThanOrEqual(MAX_CHARS);
      expect(p.split("\n").every((l) => /^Coppa numero \d+ € \d+,00 gelato alla crema$/.test(l))).toBe(true); // whole lines only
    }
    expect(r.parts.join("\n").split("\n")).toHaveLength(600); // nothing lost
  });

  it("stops at a few parts for a huge page and says so", async () => {
    const r = await readPage("luna.it", fetcher([page(`<p>${"gelato al pistacchio ".repeat(9000)}</p>`)]).fn);
    expect(r.ok && r.parts.length).toBe(MAX_PARTS);
    expect(r.ok && r.truncated).toBe(true);
  });

  it.each([
    ["JavaScript-only page", page("<div id=root></div><script>render()</script>"), /JavaScript/],
    ["403", new Response("no", { status: 403 }), /doesn't let Eco/],
    ["404", new Response("no", { status: 404 }), /wasn't found/],
    ["500", new Response("no", { status: 500 }), /isn't answering/],
    ["PDF", new Response("%PDF", { headers: { "content-type": "application/pdf" } }), /PDF or an image/],
    ["image", new Response("x", { headers: { "content-type": "image/png" } }), /PDF or an image/],
  ])("explains a %s instead of failing", async (_n, res, msg) => {
    const r = await readPage("luna.it", fetcher([res]).fn);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(msg);
  });

  it("turns a network error or timeout into a message, never an exception", async () => {
    const boom = (async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
    const slow = (async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as unknown as typeof fetch;
    expect((await readPage("luna.it", boom))).toMatchObject({ ok: false });
    expect(await readPage("luna.it", slow)).toMatchObject({ ok: false, error: expect.stringMatching(/too long/) });
  });

  it("reads plain text and non-UTF-8 pages", async () => {
    const txt = await readPage("luna.it/menu.txt", fetcher([new Response("Espresso 1.20 euro. Cappuccino 1.80 euro. Open every day from 10 to 22.", { headers: { "content-type": "text/plain" } })]).fn);
    expect(txt.ok && txt.parts[0]).toContain("Espresso");
    const bytes = new Uint8Array([...new TextEncoder().encode("<p>Caff"), 0xe8, ...new TextEncoder().encode(" e cornetto, aperto tutti i giorni dalle 10 alle 22 per voi.</p>")]);
    const lat = await readPage("luna.it", fetcher([new Response(bytes, { headers: { "content-type": "text/html; charset=iso-8859-1" } })]).fn);
    expect(lat.ok && lat.parts[0]).toContain("Caffè");
    const bogus = await readPage("luna.it", fetcher([new Response(LONG, { headers: { "content-type": "text/html; charset=no-such-charset" } })]).fn);
    expect(bogus.ok).toBe(true);
  });
});

describe("splitText", () => {
  it("keeps short text whole, splits at lines, and splits one huge line at a space", () => {
    expect(splitText("a\nb\nc", 100)).toEqual(["a\nb\nc"]);
    expect(splitText("aaaa\nbbbb\ncccc", 9)).toEqual(["aaaa\nbbbb", "cccc"]);
    const huge = splitText("word ".repeat(50).trim(), 40);
    expect(huge.every((p) => p.length <= 40 && !p.startsWith("ord"))).toBe(true);
    expect(huge.join(" ")).toBe("word ".repeat(50).trim());
    expect(splitText("x".repeat(25), 10).join("")).toBe("x".repeat(25)); // no spaces: hard split, nothing lost
    expect(splitText("")).toEqual([]);
  });
});

describe("dropRepeatedBlocks", () => {
  const A = ["Bar", "Drink, juice & coffee", "1/2 Acqua", "€ 2,50", "Caffè espresso", "€ 2,50"];
  it("removes a block that repeats exactly, keeps the first copy", () => {
    expect(dropRepeatedBlocks([...A, "Toast", "€ 5,00", ...A, "Birra", "€ 6,00"])).toEqual([...A, "Toast", "€ 5,00", "Birra", "€ 6,00"]);
    expect(dropRepeatedBlocks([...A, ...A, ...A])).toEqual(A);
  });
  it("keeps lines that merely recur, such as the same allergen line under different items", () => {
    const menu = ["Coppa A", "€ 14,00", "• Allergeni: latte", "Coppa B", "€ 15,00", "• Allergeni: latte", "Coppa C", "€ 16,00", "• Allergeni: latte"];
    expect(dropRepeatedBlocks(menu)).toEqual(menu);
  });
  it("keeps what differs in a second copy, so a conflicting price stays visible", () => {
    const one = ["Coppa Spagnola", "€ 14,00", "Gelato alla crema con amarene", "• Allergeni: uova", "Affogato", "€ 12,00"];
    const two = ["Coppa Spagnola", "€ 13,00", "Gelato alla crema con amarene", "• Allergeni: uova", "Affogato", "€ 12,00"];
    const out = dropRepeatedBlocks([...one, "Torta", "€ 7,00", ...two]);
    expect(out).toContain("€ 14,00");
    expect(out).toContain("€ 13,00");
    for (const price of ["€ 14,00", "€ 13,00"]) expect(out[out.indexOf(price) - 1]).toBe("Coppa Spagnola"); // a price never loses its item
  });
  it("leaves short and empty input alone", () => {
    expect(dropRepeatedBlocks([])).toEqual([]);
    expect(dropRepeatedBlocks(["a", "b", "a", "b"])).toEqual(["a", "b", "a", "b"]);
  });
});

describe("dropRepeatedItems", () => {
  const ALL = ["• Allergeni: Uova", "- Cereali contenenti glutine - Latte"];
  it("drops a later copy worded a little differently, leaving no stray lines", () => {
    const one = ["Coppa Caramello", "€ 14,00", "Gelato al gusto di crema", "Aromatisiertes Eis: Fior di Latte und Schokoladencreme, bunt mit Karamell", ...ALL];
    const two = ["Coppa Caramello", "€ 14,00", "Gelato al gusto di crema", "Fior di Latte und Schokoladencreme, bunt mit Karamell.", ...ALL];
    expect(dropRepeatedItems([...one, "Coppa Estate", "€ 16,00", "Gelato esotico", ...two])).toEqual([...one, "Coppa Estate", "€ 16,00", "Gelato esotico"]);
  });
  it("keeps a later copy that adds detail, such as ingredients", () => {
    const list = ["Mojito", "€ 12,00", "Negroni", "€ 12,00"];
    const detail = ["Mojito", "€ 12,00", "Rum bianco, succo di lime, soda", "Negroni", "€ 12,00", "Campari, Gin, Martini Rosso"];
    expect(dropRepeatedItems([...list, "Cocktails", ...detail])).toEqual([...list, "Cocktails", ...detail]);
  });
  it("keeps both when the price differs, each whole", () => {
    const a = ["Coppa Spagnola", "€ 14,00", "Gelato alla crema con amarene", ...ALL];
    const b = ["Coppa Spagnola", "€ 13,00", "Gelato alla crema con amarene", ...ALL];
    expect(dropRepeatedItems([...a, "Torta", "€ 7,00", ...b])).toEqual([...a, "Torta", "€ 7,00", ...b]);
  });
  it("drops labels that go with a removed item, but keeps one the page uses again", () => {
    const one = ["Banana Split", "€ 17,00", "Banana split", ...ALL, "Bar"];
    const dup = ["Banana Split", "€ 17,00", "Banana split", ...ALL, "Bar", "Drink, juice & coffee"];
    const page = [...one, "Acqua", "€ 2,50", ...dup, "Birra", "€ 6,00", "Drink, juice & coffee"];
    expect(dropRepeatedItems(page)).toEqual([...one, "Acqua", "€ 2,50", "Drink, juice & coffee", "Birra", "€ 6,00", "Drink, juice & coffee"]);
  });
  it("keeps the whole copy when it ends in a short line that is new, instead of leaving that line behind", () => {
    const one = ["Banana Split", "€ 17,00", "Banana split", ...ALL];
    const dup = ["Banana Split", "€ 17,00", "Banana split", ...ALL, "With fresh cream"];
    const page = [...one, "Acqua", "€ 2,50", ...dup];
    expect(dropRepeatedItems(page)).toEqual(page);
  });
  it("never reads an ingredient line as a label: the second Mojito keeps its ingredients", () => {
    const page = ["Mojito", "€ 12,00", "Negroni", "€ 12,00", "Mojito", "€ 12,00", "Rum bianco, succo di lime", "Negroni", "€ 12,00", "Campari, Gin"];
    expect(dropRepeatedItems(page)).toEqual(page);
  });
  it("understands a name on two lines", () => {
    const a = ["Latte macchiato/", "Maxi", "€ 4,00 / 5,50", "Latté"];
    expect(dropRepeatedItems([...a, "Toast", "€ 5,00", ...a])).toEqual([...a, "Toast", "€ 5,00"]);
  });
  it("leaves a page with no prices alone", () => {
    const text = ["We are open daily", "Come visit us", "We are open daily"];
    expect(dropRepeatedItems(text)).toEqual(text);
    expect(dropRepeatedItems([])).toEqual([]);
  });
});

describe("dropRepeats", () => {
  it("keeps the description of an item whose description is word for word another item's", () => {
    const body = ["Crema caffè.", "Coffee cream.", "Kaffeesahne.", "• Allergeni: latte"];
    const page = ["Caffè Shakerato", "€ 7,00", ...body, "Crema Caffè", "€ 6,00", ...body, "Toast", "€ 5,00"];
    expect(dropRepeats(page)).toEqual(page);
  });
  it("still removes an exact repeat on a page without prices", () => {
    const part = ["Come and visit us", "We are open every day", "Closed on Sunday", "Call 123"];
    expect(dropRepeats([...part, "More about us", ...part])).toEqual([...part, "More about us"]);
  });
  it("loses no item's details when a page lists a whole menu twice, a little differently", () => {
    const menu = (spagnola: string, extra: string) => ["Coppa Spagnola", spagnola, "Gelato alla crema", "• Allergeni: uova", "Mojito", "€ 12,00", extra, "Toast", "€ 5,00", "Ham"];
    const out = dropRepeats([...menu("€ 14,00", ""), "Bar", ...menu("€ 13,00", "Rum bianco, lime")].filter(Boolean));
    for (const need of ["€ 14,00", "€ 13,00", "Rum bianco, lime"]) expect(out).toContain(need);
    expect(out.filter((l) => l === "Toast")).toHaveLength(1);
  });
});

describe("splitText keeps an item together", () => {
  const item = (n: number) => [`Coppa ${n}`, `€ ${n},00`, `Gelato alla crema numero ${n}`, `• Allergeni: latte ${n}`];
  it("never starts a piece with an item's price, description or allergens, wherever the cut falls", () => {
    for (let max = 80; max < 200; max += 7) {
      const text = Array.from({ length: 30 }, (_, i) => item(i + 1).join("\n")).join("\n");
      const parts = splitText(text, max);
      expect(parts.length).toBeGreaterThan(2);
      for (const p of parts) {
        expect(p.length).toBeLessThanOrEqual(max);
        expect(p.split("\n")[0]).toMatch(/^Coppa \d+$/);
      }
      expect(parts.join("\n")).toBe(text); // nothing lost, nothing added
    }
  });
  it("still splits where there are no prices to go by", () => {
    expect(splitText("aaaa\nbbbb\ncccc", 9)).toEqual(["aaaa\nbbbb", "cccc"]);
  });
  it("does not loop or drop text when one item is bigger than the piece", () => {
    const big = ["Menu", "€ 5,00", ..."x".repeat(30).split("")].join("\n");
    expect(splitText(big, 20).join("\n").replace(/\n/g, "")).toBe(big.replace(/\n/g, ""));
  });
});

describe("allowFetch", () => {
  it("allows 20 reads an hour per visitor, then stops, then recovers", () => {
    const t = 1_000_000;
    for (let i = 0; i < 20; i++) expect(allowFetch("1.2.3.4", t + i)).toBe(true);
    expect(allowFetch("1.2.3.4", t + 21)).toBe(false);
    expect(allowFetch("5.6.7.8", t + 21)).toBe(true);
    expect(allowFetch("1.2.3.4", t + 3_700_000)).toBe(true);
  });
});

describe("website text is never trusted for allergies", () => {
  const owner = [{ tag: "menu", text: "Pistachio gelato €2.50" }];
  const site = [{ tag: "website luna.it", text: "Our pistachio gelato is gluten free and nut free. Allergens: none." }];

  it("does not count as the owner's allergen info", () => {
    const web = chunkPages(site);
    expect(isWebsite(web[0])).toBe(true);
    expect(hasAllergenInfo(web)).toBe(false);
    expect(allergenChunks(web)).toEqual([]);
    expect(hasAllergenInfo(chunkPages([...owner, ...site]))).toBe(false);
  });

  it("is kept out of what the AI reads for an allergy question, but the owner's own text is kept", () => {
    const all = chunkPages([...owner, { tag: "allergens", text: "Pistachio gelato contains nuts and milk." }, ...site]);
    const ctx = allergyContext(all, all);
    expect(ctx.some(isWebsite)).toBe(false);
    expect(ctx.some((c) => c.tag === "allergens")).toBe(true);
  });

  it("counts again once the owner has checked it and renamed the tag", () => {
    expect(hasAllergenInfo(chunkPages([{ tag: "allergens", text: site[0].text }]))).toBe(true);
  });
});
