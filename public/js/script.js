// Teleprompter script: split the speaker's text into short phrases, and read text out of a .docx.
// No imports, so vitest can load it directly.

/**
 * Phrases of about 5–10 words. A line break always ends a phrase (headings, paragraphs); inside a line,
 * cut at sentence ends first, then at , ; : — –, else hard at 8 words. Lines with no words ("---") are dropped.
 */
export function splitScript(text) {
  const seg = new Intl.Segmenter("en", { granularity: "sentence" });
  const n = (p) => p.split(" ").length;
  return String(text ?? "").split(/\n/).filter((l) => /[\p{L}\p{N}]/u.test(l)).flatMap((l) => {
    const out = [];
    for (const { segment } of seg.segment(l.replace(/\s+/g, " "))) {
      let words = segment.split(" ").filter(Boolean);
      while (words.length > 10) {
        let cut = 8;
        for (let i = 9; i >= 4; i--) if (/[,;:—–]$/.test(words[i])) { cut = i + 1; break; }
        out.push(words.slice(0, cut).join(" "));
        words = words.slice(cut);
      }
      if (words.length) out.push(words.join(" "));
    }
    // Join 1–2 word scraps ("Thanks.", "So,") to a neighbour on the same line, when that stays readable.
    return out.reduce((acc, p) => {
      const last = acc[acc.length - 1];
      if (last && (n(p) < 3 || n(last) < 3) && n(last) + n(p) <= 12) acc[acc.length - 1] = `${last} ${p}`;
      else acc.push(p);
      return acc;
    }, []);
  });
}

/** Plain text of a .docx: finds word/document.xml in the zip, inflates it natively, one line per paragraph. */
export async function docxText(buf) {
  const b = new Uint8Array(buf);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = b.length - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("Not a .docx file");
  for (let p = v.getUint32(e + 16, true), left = v.getUint16(e + 10, true); left--; ) {
    const nameLen = v.getUint16(p + 28, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    if (name === "word/document.xml") {
      const local = v.getUint32(p + 42, true);
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      let data = b.subarray(start, start + v.getUint32(p + 20, true));
      if (v.getUint16(p + 10, true) === 8) {
        data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      }
      const ent = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      return new TextDecoder().decode(data).split("</w:p>")
        .map((para) => [...para.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(""))
        .map((t) => t.replace(/&(amp|lt|gt|quot|apos);/g, (_, k) => ent[k]))
        .filter((t) => t.trim())
        .join("\n");
    }
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  throw new Error("No text found in that .docx");
}
