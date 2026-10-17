// Health shops (pharmacy, clinic, hospital front desk). Eco is a front-desk interpreter here, never a medical helper.
// Emergency and medical-advice questions get a fixed line written by us, never an answer from the model.
// Everything else is answered from the owner's own list, like any other shop.

export type HealthKind = "pharmacy" | "clinic" | "hospital";
export const HEALTH_KINDS: readonly HealthKind[] = ["pharmacy", "clinic", "hospital"];
export const isHealthKind = (type: unknown): type is HealthKind => HEALTH_KINDS.includes(type as HealthKind);

// Word starts for Latin scripts, plain substrings for the others. Over-matching is on the safe side:
// an extra "ask the pharmacist" costs a moment, a missed emergency can cost much more.
const EMERGENCY_LATIN = [
  "emergenc", "ambulance", "chest pain", "can't breathe", "cannot breathe", "can not breathe", "difficulty breathing", "trouble breathing", "not breathing", "overdos", "bleeding",
  "unconscious", "passed out", "fainted", "heart attack", "stroke", "seizure", "suicid", "poison", "choking", "anaphyla", "severe pain", "swollen throat",
  "emergenza", "ambulanza", "dolore al petto", "non riesco a respirare", "non respira", "sanguina", "emorragia", "svenut", "infarto", "ictus", "convulsion", "avvelen", "soffoc", "pronto soccorso",
  "emergencia", "dolor de pecho", "no puedo respirar", "no respira", "sobredosis", "sangrado", "hemorragia", "inconsciente", "desmay", "convulsi", "envenen", "ahog", "anafil", "urgencias",
  "urgence", "douleur dans la poitrine", "douleur thoracique", "n'arrive pas à respirer", "ne respire pas", "saignement", "hémorragie", "inconscient", "crise cardiaque", "avc", "empoisonn", "étouff",
  "notfall", "krankenwagen", "rettungswagen", "brustschmerz", "keine luft", "kann nicht atmen", "überdosis", "uberdosis", "blutung", "bewusstlos", "herzinfarkt", "schlaganfall", "krampfanfall", "vergift", "ersticken",
  "emergência", "emergencia", "ambulância", "dor no peito", "não consigo respirar", "nao consigo respirar", "não respira", "sangramento", "desmai", "enfarte", "engasg", "envenen",
];
const EMERGENCY_OTHER = [
  "आपातकाल", "एम्बुलेंस", "सीने में दर्द", "सांस नहीं", "साँस नहीं", "ओवरडोज", "खून बह", "बेहोश", "दिल का दौरा", "लकवा", "दौरा पड़", "आत्महत्या", "जहर", "दम घुट",
  "紧急", "急救", "救护车", "胸痛", "无法呼吸", "不能呼吸", "出血", "昏迷", "心脏病发作", "中风", "抽搐", "自杀", "中毒", "窒息", "过敏性休克",
  "緊急", "救急車", "胸が痛", "息ができ", "呼吸できな", "過剰摂取", "意識がな", "心臓発作", "脳卒中", "けいれん", "自殺", "窒息", "アナフィラキシー",
  "응급", "구급차", "가슴이 아", "숨을 못", "숨이 안", "과다 복용", "출혈", "의식이 없", "심장마비", "뇌졸중", "경련", "자살", "질식", "아나필락시스",
  "طوارئ", "إسعاف", "ألم في الصدر", "لا أستطيع التنفس", "لا يتنفس", "جرعة زائدة", "نزيف", "فاقد الوعي", "نوبة قلبية", "سكتة", "انتحار", "تسمم", "اختناق",
  "скорая", "скорую", "экстренн", "боль в груди", "не могу дышать", "не дышит", "передозировк", "кровотечение", "без сознания", "сердечный приступ", "инсульт", "судорог", "суицид", "отравлен", "задыха", "анафилакс",
];
const ADVICE_LATIN = [
  "dosage", "dose", "how many tablets", "how many pills", "how many capsules", "how much should i take", "what should i take", "side effect", "interaction", "can i take", "should i take", "is it safe to take",
  "pregnan", "breastfeed", "symptom", "fever", "rash", "headache", "stomach ache", "toothache", "it hurts", "hurts", "my pain", "diagnos", "infection", "antibiotic", "prescribe", "vomit", "diarrh", "cough", "wound", "burn", "medicine for", "treat",
  "dosaggio", "quante compresse", "quante pastiglie", "quanto devo prendere", "effetti collaterali", "interazion", "posso prendere", "devo prendere", "incinta", "gravidanza", "allatt", "sintom", "febbre", "eruzione", "mal di", "dolore", "infezione", "diarrea", "tosse", "ferita", "ustione",
  "dosis", "cuántas pastillas", "cuantas pastillas", "cuánto debo tomar", "cuanto debo tomar", "efectos secundarios", "interacci", "puedo tomar", "debo tomar", "embarazada", "embarazo", "lactancia", "síntoma", "sintoma", "fiebre", "erupción", "dolor", "me duele", "diagnós", "infección", "antibiót", "vómit", "tengo tos", "herida", "quemadura",
  "dosage", "combien de comprimés", "combien dois-je prendre", "effets secondaires", "puis-je prendre", "dois-je prendre", "enceinte", "grossesse", "allaitement", "symptôme", "fièvre", "éruption", "douleur", "j'ai mal", "diagnostic", "antibiotique", "vomi", "diarrhée", "toux", "blessure", "brûlure",
  "dosierung", "wie viele tabletten", "wie viel soll ich nehmen", "nebenwirkung", "wechselwirkung", "kann ich nehmen", "soll ich nehmen", "schwanger", "stillen", "fieber", "ausschlag", "schmerz", "infektion", "antibiotik", "erbrechen", "durchfall", "husten", "wunde", "verbrennung",
  "dosagem", "quantos comprimidos", "quanto devo tomar", "efeitos secundários", "efeitos colaterais", "interaç", "posso tomar", "devo tomar", "grávida", "gravidez", "amament", "febre", "erupção", "dor ", "diagnóstic", "infeção", "infecção", "antibiótic", "vómit", "vômit", "diarreia", "tosse", "ferida", "queimadura",
];
const ADVICE_OTHER = [
  "खुराक", "कितनी गोली", "कितनी दवा", "साइड इफेक्ट", "दुष्प्रभाव", "ले सकता", "ले सकती", "गर्भवती", "गर्भावस्था", "स्तनपान", "लक्षण", "बुखार", "दाने", "दर्द", "निदान", "संक्रमण", "एंटीबायोटिक", "उल्टी", "दस्त", "खांसी", "घाव", "जलन",
  "剂量", "几片", "吃多少", "副作用", "相互作用", "可以吃", "能吃吗", "怀孕", "哺乳", "症状", "发烧", "皮疹", "疼", "诊断", "感染", "抗生素", "呕吐", "腹泻", "咳嗽", "伤口", "烧伤",
  "用量", "何錠", "どのくらい飲", "副作用", "飲み合わせ", "飲んでもいい", "妊娠", "授乳", "症状", "発疹", "痛い", "痛み", "診断", "感染", "抗生物質", "嘔吐", "下痢", "咳", "やけど",
  "복용량", "몇 알", "얼마나 먹", "부작용", "상호작용", "먹어도", "임신", "수유", "증상", "발진", "아프", "통증", "진단", "감염", "항생제", "구토", "설사", "기침", "화상",
  "جرعة", "كم حبة", "كم أتناول", "آثار جانبية", "هل يمكنني تناول", "حامل", "رضاعة", "أعراض", "حمى", "طفح", "ألم", "تشخيص", "عدوى", "مضاد حيوي", "قيء", "إسهال", "سعال", "جرح", "حرق",
  "дозировк", "доза", "сколько таблеток", "сколько принимать", "побочн", "взаимодейств", "можно ли принимать", "беремен", "кормлен", "симптом", "температур", "сыпь", "боль", "болит", "диагноз", "инфекц", "антибиотик", "рвота", "понос", "кашель", "ожог",
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const build = (latin: string[], other: string[], raw: string[] = []) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...latin.map(esc), ...raw].join("|")})|(?:${other.map(esc).join("|")})`, "iu");
const EMERGENCY = build(EMERGENCY_LATIN, EMERGENCY_OTHER);
// "pain" but not "painkiller", which is a product question; "5 mg", "10ml" and "500 mcg" count as a dose.
const ADVICE = build(ADVICE_LATIN, ADVICE_OTHER, ["pain(?!kill|relief)", "ache(?!s? and prices)"]);
const DOSE = /\d\s*(?:mg|ml|mcg|µg|iu)(?![\p{L}])/iu;

const norm = (s: string) => String(s ?? "").normalize("NFC").toLowerCase();

export type Sensitive = "emergency" | "advice" | null;

/** Emergency wording wins over advice wording; anything else is an ordinary question. */
export function sensitiveKind(text: string): Sensitive {
  const t = norm(text);
  if (EMERGENCY.test(t)) return "emergency";
  if (ADVICE.test(t) || DOSE.test(t)) return "advice";
  return null;
}

// Fixed lines, written by us. {n} is the local emergency number. Languages the customer page offers; English for others.
type Lines = Record<string, string>;
const EMERGENCY_LINE: Lines = {
  en: "If this is an emergency, call {n} now.", it: "Se è un'emergenza, chiama subito il {n}.", es: "Si es una emergencia, llama ahora al {n}.",
  fr: "En cas d'urgence, appelez le {n} immédiatement.", de: "Bei einem Notfall rufen Sie sofort die {n} an.", pt: "Se for uma emergência, ligue já para o {n}.",
  hi: "अगर यह आपातकाल है, तो अभी {n} पर कॉल करें।", zh: "如果是紧急情况，请立即拨打 {n}。", ja: "緊急の場合は、今すぐ {n} に電話してください。",
  ko: "응급 상황이면 지금 바로 {n}에 전화하세요.", ar: "إذا كانت حالة طارئة، اتصل بالرقم {n} الآن.", ru: "Если это экстренный случай, немедленно звоните по номеру {n}.",
};
const EMERGENCY_HOSPITAL_LINE: Lines = {
  en: "If this is an emergency, call {n} now or go to the emergency department.", it: "Se è un'emergenza, chiama subito il {n} o vai al pronto soccorso.",
  es: "Si es una emergencia, llama ahora al {n} o ve a urgencias.", fr: "En cas d'urgence, appelez le {n} immédiatement ou rendez-vous aux urgences.",
  de: "Bei einem Notfall rufen Sie sofort die {n} an oder gehen Sie in die Notaufnahme.", pt: "Se for uma emergência, ligue já para o {n} ou vá às urgências.",
  hi: "अगर यह आपातकाल है, तो अभी {n} पर कॉल करें या आपातकालीन विभाग में जाएँ।", zh: "如果是紧急情况，请立即拨打 {n} 或前往急诊科。", ja: "緊急の場合は、今すぐ {n} に電話するか、救急外来へ行ってください。",
  ko: "응급 상황이면 지금 바로 {n}에 전화하거나 응급실로 가세요.", ar: "إذا كانت حالة طارئة، اتصل بالرقم {n} الآن أو توجه إلى قسم الطوارئ.", ru: "Если это экстренный случай, немедленно звоните по номеру {n} или обратитесь в приёмное отделение.",
};
const ADVICE_LINE: Record<HealthKind, Lines> = {
  pharmacy: {
    en: "I can't give medical advice. Please ask the pharmacist.", it: "Non posso dare consigli medici. Chiedi al farmacista.", es: "No puedo dar consejos médicos. Pregunta al farmacéutico.",
    fr: "Je ne peux pas donner de conseils médicaux. Demandez au pharmacien.", de: "Ich kann keine medizinische Beratung geben. Bitte fragen Sie den Apotheker.", pt: "Não posso dar conselhos médicos. Pergunte ao farmacêutico.",
    hi: "मैं चिकित्सा सलाह नहीं दे सकता। कृपया फ़ार्मासिस्ट से पूछें।", zh: "我不能提供医疗建议。请咨询药剂师。", ja: "医療上のアドバイスはできません。薬剤師にご相談ください。",
    ko: "저는 의학적 조언을 드릴 수 없습니다. 약사에게 문의해 주세요.", ar: "لا أستطيع تقديم نصيحة طبية. يرجى سؤال الصيدلي.", ru: "Я не могу давать медицинские советы. Пожалуйста, спросите фармацевта.",
  },
  clinic: {
    en: "I can't give medical advice. Please ask the doctor.", it: "Non posso dare consigli medici. Chiedi al medico.", es: "No puedo dar consejos médicos. Pregunta al médico.",
    fr: "Je ne peux pas donner de conseils médicaux. Demandez au médecin.", de: "Ich kann keine medizinische Beratung geben. Bitte fragen Sie den Arzt.", pt: "Não posso dar conselhos médicos. Pergunte ao médico.",
    hi: "मैं चिकित्सा सलाह नहीं दे सकता। कृपया डॉक्टर से पूछें।", zh: "我不能提供医疗建议。请咨询医生。", ja: "医療上のアドバイスはできません。医師にご相談ください。",
    ko: "저는 의학적 조언을 드릴 수 없습니다. 의사에게 문의해 주세요.", ar: "لا أستطيع تقديم نصيحة طبية. يرجى سؤال الطبيب.", ru: "Я не могу давать медицинские советы. Пожалуйста, спросите врача.",
  },
  hospital: {
    en: "I can't give medical advice. Please ask the staff or a nurse.", it: "Non posso dare consigli medici. Chiedi al personale o a un infermiere.", es: "No puedo dar consejos médicos. Pregunta al personal o a una enfermera.",
    fr: "Je ne peux pas donner de conseils médicaux. Demandez au personnel ou à une infirmière.", de: "Ich kann keine medizinische Beratung geben. Bitte fragen Sie das Personal oder eine Pflegekraft.", pt: "Não posso dar conselhos médicos. Pergunte à equipa ou a um enfermeiro.",
    hi: "मैं चिकित्सा सलाह नहीं दे सकता। कृपया स्टाफ़ या नर्स से पूछें।", zh: "我不能提供医疗建议。请询问工作人员或护士。", ja: "医療上のアドバイスはできません。スタッフまたは看護師にお尋ねください。",
    ko: "저는 의학적 조언을 드릴 수 없습니다. 직원이나 간호사에게 문의해 주세요.", ar: "لا أستطيع تقديم نصيحة طبية. يرجى سؤال الموظفين أو الممرضة.", ru: "Я не могу давать медицинские советы. Пожалуйста, спросите персонал или медсестру.",
  },
};
const code = (lang: string) => String(lang ?? "").toLowerCase().slice(0, 2);

/** Digits, spaces, plus, dash and brackets only, at most 16 characters; the EU-wide 112 when empty or unusable. */
export function cleanEmergencyNumber(raw: unknown): string {
  const s = String(raw ?? "").replace(/[^\d+\-() ]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
  return /\d{2,}/.test(s) ? s : "112";
}

export const emergencyLine = (lang: string, kind: HealthKind, number?: unknown): string =>
  (kind === "hospital" ? EMERGENCY_HOSPITAL_LINE : EMERGENCY_LINE)[code(lang)]?.replace("{n}", cleanEmergencyNumber(number)) ??
  (kind === "hospital" ? EMERGENCY_HOSPITAL_LINE : EMERGENCY_LINE).en.replace("{n}", cleanEmergencyNumber(number));
export const adviceLine = (lang: string, kind: HealthKind): string => ADVICE_LINE[kind][code(lang)] ?? ADVICE_LINE[kind].en;

/** What a health shop must say for this question, in the customer's language, or null for an ordinary question. */
export function healthRule(text: string, kind: HealthKind, lang: string, number?: unknown): { kind: "emergency" | "advice"; line: string } | null {
  const s = sensitiveKind(text);
  if (s === "emergency") return { kind: "emergency", line: emergencyLine(lang, kind, number) };
  if (s === "advice") return { kind: "advice", line: adviceLine(lang, kind) };
  return null;
}
