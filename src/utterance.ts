/** Validate complete phrase JSON. Never salvage fragments or relabel the original as a translation. */
export function phraseEvidence(data: unknown, original: string | undefined, langs: string[]) {
  const obj = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const src = original ?? (typeof obj.src === "string" ? obj.src.trim() : "");
  const translations = obj.out && typeof obj.out === "object" && !Array.isArray(obj.out)
    ? obj.out as Record<string, unknown> : {};
  const out: Record<string, string> = {};
  for (const lang of langs) {
    const text = translations[lang];
    if (typeof text === "string" && text.trim()) out[lang] = text.trim();
  }
  const missing = langs.filter((lang) => !out[lang]);
  const flags = Array.isArray(obj.flags) ? obj.flags.filter((f): f is string => typeof f === "string") : [];
  return { src, out, flags: [...new Set([...flags, ...missing])], incomplete: missing.length > 0 };
}
