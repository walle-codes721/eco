// Allergy and diet questions. A wrong "yes, it's safe" can hurt someone, so these never rest on the AI alone:
// the owner's own allergen text is always what Eco reads, a fixed line is always added by the program, and the owner is told.
import { tokensOf, type Chunk } from "./retrieve";

// Word starts, so "nut" finds "nuts" but not "minute". Over-matching (nutella, eggplant) is on the safe side.
const LATIN = [
  "allerg", "alerg", "gluten", "glúten", "glutin", "celiac", "coeliac", "celiaco", "celíaco", "zöliak", "zoliak",
  "nut", "peanut", "nüsse", "nuss", "erdnuss", "noci", "nocciol", "arachid", "cacahuete", "cacahuate", "cacahuète", "frutos secos", "fruits à coque", "noix",
  "amendoim", "nozes", "castanha", "lactose", "lattosio", "lactosa", "laktose", "dairy", "vegan", "vegetar", "halal", "kosher",
  "intoler", "unverträglich", "unvertraglich", "intolér", "sesame", "sesamo", "sésamo", "shellfish", "crostacei", "marisco", "crustac", "egg", "uova", "huevo", "soy", "soia", "soja",
  "diet", "dieta", "dietetic", "régime", "traces of", "tracce", "trazas",
  // The rest of the EU's 14 allergens, in the main languages: celery, mustard, sulphites, lupin, molluscs, fish, dairy.
  "celery", "sedano", "apio", "céleri", "celeri", "sellerie", "mustard", "senape", "mostaza", "moutarde", "senf", "sulphite", "sulfite", "solfiti", "sulfito",
  "lupin", "lupini", "altramuz", "mollus", "molusc", "weichtier", "fish", "pesce", "pescado", "poisson", "fisch", "latticini", "lácteos", "lacteos", "laitier", "milchprodukt",
  // How people ask about ingredients.
  "contains", "ingredient", "free from", "free of", "made with",
];
const OTHER = [
  "एलर्जी", "ग्लूटेन", "मूंगफली", "लैक्टोज", "शाकाहारी", "वीगन", "असहिष्णु", // Hindi
  "过敏", "麸质", "坚果", "花生", "乳糖", "素食", "纯素", // Chinese
  "アレルギー", "グルテン", "ナッツ", "ピーナッツ", "乳糖", "ベジタリアン", "ビーガン", // Japanese
  "알레르기", "글루텐", "견과", "땅콩", "유당", "채식", "비건", // Korean
  "حساسية", "الغلوتين", "مكسرات", "فول سوداني", "اللاكتوز", "نباتي", "حلال", // Arabic
  "аллерг", "глютен", "орех", "арахис", "лактоз", "веган", "вегетариан", "непереносим", // Russian
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TERMS = new RegExp(`(?<![\\p{L}\\p{N}])(?:${LATIN.map(esc).join("|")})|(?:${OTHER.map(esc).join("|")})`, "iu");
const TAGS = /allerg|alerg|dietar|dieta|diet|ingredien|ingredient/i;

const norm = (s: string) => String(s ?? "").normalize("NFC").toLowerCase();

/** Does this question, in any of the languages customers use, ask about allergies, ingredients or diet? */
export const isAllergyQuestion = (text: string): boolean => TERMS.test(norm(text));

/** Does the owner's list say anything about allergens or diet? */
export const hasAllergenInfo = (chunks: Chunk[]): boolean => chunks.some((c) => TAGS.test(c.tag) || TERMS.test(norm(c.text)));

/**
 * The owner's own allergen and diet text, tagged sections first, then any other chunk that mentions allergens,
 * at most `budget` tokens. This is what Eco must read for an allergy question, however the question was worded.
 */
export function allergenChunks(chunks: Chunk[], budget = 1000): Chunk[] {
  const tagged = chunks.filter((c) => TAGS.test(c.tag));
  const mentioned = chunks.filter((c) => !TAGS.test(c.tag) && TERMS.test(norm(c.text)));
  const out: Chunk[] = [];
  let used = 0;
  for (const c of [...tagged, ...mentioned]) {
    const cost = tokensOf(c.text);
    if (used + cost > budget) continue;
    out.push(c);
    used += cost;
  }
  return out;
}

/** What the AI reads for an allergy question: the owner's allergen text first, then the usual picks, within `budget` tokens. */
export function allergyContext(chunks: Chunk[], picked: Chunk[], budget = 1800): Chunk[] {
  const key = (c: Chunk) => `${c.tag}|${c.text.slice(0, 60)}`; // selectContext may hand back a shortened copy of a chunk
  const out = allergenChunks(chunks, Math.floor(budget * 0.6));
  const seen = new Set(out.map(key));
  let used = out.reduce((n, c) => n + tokensOf(c.text), 0);
  for (const c of picked) {
    const cost = tokensOf(c.text);
    if (seen.has(key(c)) || used + cost > budget) continue;
    out.push(c);
    seen.add(key(c));
    used += cost;
  }
  return out;
}

// Fixed lines, written by us, never by the model. Languages the customer page offers; English for anything else.
const CONFIRM: Record<string, string> = {
  en: "Please confirm with the staff.", it: "Conferma con il personale.", es: "Por favor, confírmalo con el personal.",
  fr: "Veuillez le confirmer auprès du personnel.", de: "Bitte bestätige das beim Personal.", pt: "Por favor, confirme com a equipa.",
  hi: "कृपया स्टाफ़ से पुष्टि करें।", zh: "请向工作人员确认。", ja: "スタッフにご確認ください。", ko: "직원에게 확인해 주세요.",
  ar: "يرجى التأكد من الموظفين.", ru: "Пожалуйста, уточните у персонала.",
};
const NO_INFO: Record<string, string> = {
  en: "I don't have allergen information. Please ask the staff.", it: "Non ho informazioni sugli allergeni. Chiedi al personale.",
  es: "No tengo información sobre alérgenos. Pregunta al personal.", fr: "Je n'ai pas d'informations sur les allergènes. Demandez au personnel.",
  de: "Ich habe keine Informationen zu Allergenen. Bitte frag das Personal.", pt: "Não tenho informações sobre alergénios. Pergunte à equipa.",
  hi: "मेरे पास एलर्जन की जानकारी नहीं है। कृपया स्टाफ़ से पूछें।", zh: "我没有过敏原信息。请询问工作人员。", ja: "アレルゲン情報がありません。スタッフにお尋ねください。",
  ko: "알레르기 유발 성분 정보가 없습니다. 직원에게 문의해 주세요.", ar: "ليست لدي معلومات عن مسببات الحساسية. يرجى سؤال الموظفين.", ru: "У меня нет информации об аллергенах. Спросите у персонала.",
};
const code = (lang: string) => String(lang ?? "").toLowerCase().slice(0, 2);

/** "Please confirm with the staff." in the customer's language. */
export const staffLine = (lang: string): string => CONFIRM[code(lang)] ?? CONFIRM.en;
/** "I don't have allergen information. Please ask the staff." in the customer's language. */
export const noAllergenInfo = (lang: string): string => NO_INFO[code(lang)] ?? NO_INFO.en;

/** The answer followed by the fixed confirm line, once. */
export function withStaffLine(answer: string, lang: string): string {
  const line = staffLine(lang);
  const text = String(answer ?? "").trim();
  return text.includes(line) ? text : `${text}${text && !/[.!?。！？।]$/.test(text) ? "." : ""} ${line}`.trim();
}
