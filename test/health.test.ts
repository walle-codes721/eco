import { describe, expect, it } from "vitest";
import { adviceLine, cleanEmergencyNumber, emergencyLine, healthRule, HEALTH_KINDS, isHealthKind, sensitiveKind } from "../src/health";

const langs = ["en", "it", "es", "fr", "de", "pt", "hi", "zh", "ja", "ko", "ar", "ru"];

describe("health shop types", () => {
  it("knows the three kinds and nothing else", () => {
    expect([...HEALTH_KINDS]).toEqual(["pharmacy", "clinic", "hospital"]);
    for (const k of HEALTH_KINDS) expect(isHealthKind(k)).toBe(true);
    for (const k of ["restaurant", "shop", "service", "other", "", undefined, null, "Pharmacy"]) expect(isHealthKind(k)).toBe(false);
  });
});

describe("emergency wording", () => {
  it.each([
    ["I have chest pain", "English"],
    ["He is not breathing, please help", "English"],
    ["I think she took an overdose", "English"],
    ["Is there an ambulance?", "English"],
    ["Ho dolore al petto", "Italian"],
    ["No puedo respirar", "Spanish"],
    ["Il ne respire pas", "French"],
    ["Das ist ein Notfall", "German"],
    ["Ele está inconsciente", "Portuguese"],
    ["मेरे पिता बेहोश हो गए", "Hindi"],
    ["他昏迷了", "Chinese"],
    ["息ができません", "Japanese"],
    ["숨을 못 쉬어요", "Korean"],
    ["هناك نزيف", "Arabic"],
    ["Он без сознания", "Russian"],
  ])("%s (%s) is an emergency", (q) => expect(sensitiveKind(q)).toBe("emergency"));
});

describe("medical-advice wording", () => {
  it.each([
    ["What dose should I take?", "English"],
    ["Can I take ibuprofen with my blood pressure pills?", "English"],
    ["I have a headache, what is good for it?", "English"],
    ["I'm pregnant, is it safe?", "English"],
    ["Is 500 mg twice a day too much?", "English"],
    ["Does it have side effects?", "English"],
    ["Qual è il dosaggio per un bambino?", "Italian"],
    ["¿Cuántas pastillas debo tomar?", "Spanish"],
    ["Quels sont les effets secondaires ?", "French"],
    ["Ich habe Fieber", "German"],
    ["Posso tomar com leite?", "Portuguese"],
    ["इसकी खुराक कितनी है?", "Hindi"],
    ["有什么副作用？", "Chinese"],
    ["副作用はありますか", "Japanese"],
    ["임신 중에 먹어도 되나요?", "Korean"],
    ["ما هي الجرعة؟", "Arabic"],
    ["Какая дозировка?", "Russian"],
  ])("%s (%s) is a request for medical advice", (q) => expect(sensitiveKind(q)).toBe("advice"));
});

describe("ordinary front-desk questions are left alone", () => {
  it.each([
    "What are your opening hours?",
    "Where is the entrance?",
    "Do you sell painkillers?",
    "Do you sell bandages?",
    "Can I pay by card?",
    "Do you take insurance?",
    "Do I need an appointment?",
    "How much is a blood pressure check?",
    "Which languages do the staff speak?",
    "Is there a pharmacist who speaks Hindi?",
    "Where can I park my bike?",
    "Quali sono gli orari di apertura?",
    "¿Dónde está la farmacia?",
    "क्या आप आज खुले हैं?",
    "你们几点关门？",
    "",
  ])("%j", (q) => expect(sensitiveKind(q)).toBeNull());

  it("is not fooled by upper case", () => expect(sensitiveKind("CHEST PAIN")).toBe("emergency"));
});

describe("an emergency wins over a medical-advice question", () => {
  it("in one message", () => expect(sensitiveKind("I have chest pain, what dose should I take?")).toBe("emergency"));
});

describe("the emergency number", () => {
  it("defaults to 112 when empty or unusable", () => {
    for (const bad of ["", "   ", "abc", "1", undefined, null, 5]) expect(cleanEmergencyNumber(bad)).toBe("112");
  });
  it("keeps a real number and strips everything else", () => {
    expect(cleanEmergencyNumber(" 118 ")).toBe("118");
    expect(cleanEmergencyNumber("+39 06 1234")).toBe("+39 06 1234");
    expect(cleanEmergencyNumber("<script>112</script>")).toBe("112");
    expect(cleanEmergencyNumber("9".repeat(40))).toHaveLength(16);
  });
});

describe("the fixed lines", () => {
  it("emergency lines exist in every language, contain the number and differ from English", () => {
    for (const kind of HEALTH_KINDS) for (const l of langs) {
      const line = emergencyLine(l, kind, "118");
      expect(line).toContain("118");
      expect(line).not.toContain("{n}");
      if (l !== "en") expect(line).not.toBe(emergencyLine("en", kind, "118"));
    }
  });
  it("the hospital line also points to the emergency department", () => {
    for (const l of langs) expect(emergencyLine(l, "hospital", "112")).not.toBe(emergencyLine(l, "clinic", "112"));
    expect(emergencyLine("en", "hospital")).toContain("emergency department");
    expect(emergencyLine("en", "pharmacy")).not.toContain("emergency department");
  });
  it("advice lines send the customer to the right person for each kind", () => {
    expect(adviceLine("en", "pharmacy")).toContain("pharmacist");
    expect(adviceLine("en", "clinic")).toContain("doctor");
    expect(adviceLine("en", "hospital")).toContain("nurse");
    for (const l of langs) {
      const [a, b, c] = HEALTH_KINDS.map((k) => adviceLine(l, k));
      expect(new Set([a, b, c]).size).toBe(3);
      if (l !== "en") for (const k of HEALTH_KINDS) expect(adviceLine(l, k)).not.toBe(adviceLine("en", k));
    }
  });
  it("fall back to English for an unknown language, accept region codes, and use 112 by default", () => {
    expect(adviceLine("xx", "clinic")).toBe(adviceLine("en", "clinic"));
    expect(adviceLine("it-IT", "clinic")).toBe(adviceLine("it", "clinic"));
    expect(emergencyLine("", "clinic")).toBe("If this is an emergency, call 112 now.");
  });
});

describe("what a health shop must say", () => {
  it("gives the emergency line, with the shop's number, in the customer's language", () => {
    expect(healthRule("Ho dolore al petto", "clinic", "it", "118")).toEqual({ kind: "emergency", line: "Se è un'emergenza, chiama subito il 118." });
  });
  it("gives the advice line for the kind of shop", () => {
    expect(healthRule("What dose should I take?", "pharmacy", "en")).toEqual({ kind: "advice", line: "I can't give medical advice. Please ask the pharmacist." });
    expect(healthRule("What dose should I take?", "hospital", "en")?.line).toContain("nurse");
  });
  it("says nothing for an ordinary question", () => {
    expect(healthRule("What are your opening hours?", "pharmacy", "en")).toBeNull();
  });
});
