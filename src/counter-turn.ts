// Runtime validation: a TypeScript type alone cannot validate provider JSON.
export type CustomerTurn = {
  src: string; lang: string; to_owner: string;
  answer: { covered: boolean; text: string; text_owner: string; cite: string };
};

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === "string" && !!v.trim();

export function customerTurn(value: unknown): CustomerTurn | null {
  if (!object(value) || !nonempty(value.src) || !nonempty(value.to_owner) || typeof value.lang !== "string") return null;
  const a = value.answer;
  if (!object(a) || typeof a.covered !== "boolean" || typeof a.text !== "string" || typeof a.text_owner !== "string" || typeof a.cite !== "string") return null;
  const text = a.text.trim(), text_owner = a.text_owner.trim(), cite = a.cite.trim();
  // A covered answer requires both audiences' text and a source tag. Uncovered
  // means deliberately empty, not a malformed or contradictory answer object.
  if (a.covered ? !text || !text_owner || !cite : !!text || !!text_owner || !!cite) return null;
  return { src: value.src.trim(), lang: value.lang, to_owner: value.to_owner.trim(), answer: { covered: a.covered, text, text_owner, cite } };
}

export function ownerTurn(value: unknown): { src: string; out: string } | null {
  if (!object(value) || !nonempty(value.src) || !nonempty(value.out)) return null;
  return { src: value.src.trim(), out: value.out.trim() };
}
