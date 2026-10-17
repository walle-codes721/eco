import { describe, expect, it } from "vitest";
import { allergenChunks, hasAllergenInfo, isAllergyQuestion, noAllergenInfo, staffLine, withStaffLine } from "../src/safety";
import { chunkPages, tokensOf } from "../src/retrieve";
import { DEMO_SHOP } from "../src/fixtures/demo";

const shop = chunkPages(DEMO_SHOP.sources);

describe("allergy and diet questions", () => {
  it.each([
    ["Is the pistachio gelato safe for a nut allergy?", "English"],
    ["Do you have gluten free options?", "English"],
    ["I am coeliac, can I eat this?", "English"],
    ["Is it vegan?", "English"],
    ["Ci sono noci o arachidi?", "Italian"],
    ["Il gelato è senza glutine? Sono celiaco.", "Italian"],
    ["Soy intolerante a la lactosa", "Spanish"],
    ["¿Tiene frutos secos?", "Spanish"],
    ["Avez-vous quelque chose sans gluten ? J'ai une allergie.", "French"],
    ["Ich habe eine Nussallergie", "German"],
    ["Tem amendoim?", "Portuguese"],
    ["क्या इसमें मूंगफली है?", "Hindi"],
    ["这个有花生吗？", "Chinese"],
    ["ナッツアレルギーがあります", "Japanese"],
    ["견과류 알레르기가 있어요", "Korean"],
    ["هل يحتوي على مكسرات؟", "Arabic"],
    ["Есть ли здесь орехи?", "Russian"],
    ["Is the lemon sorbet free from celery?", "English, EU allergen"],
    ["Does it contain mustard or sulphites?", "English, EU allergens"],
    ["Ci sono solfiti o senape?", "Italian, EU allergens"],
    ["¿Lleva marisco?", "Spanish, EU allergen"],
    ["Is this made with fish?", "English, EU allergen"],
    ["What are the ingredients?", "English, ingredients"],
  ])("recognises %s (%s)", (q) => expect(isAllergyQuestion(q)).toBe(true));

  it.each([
    "What time do you close?",
    "How much is a cappuccino?",
    "Can I pay by card?",
    "Do you take Apple Pay?",
    "Quanto costa un cono medio?",
    "A che ora chiudete? Ho solo un minute",
    "क्या आप आज खुले हैं?",
    "",
  ])("leaves %j alone", (q) => expect(isAllergyQuestion(q)).toBe(false));

  it("is not fooled by upper case", () => expect(isAllergyQuestion("ALLERGIES?")).toBe(true));
});

describe("the owner's allergen information", () => {
  it("is found in the demo shop, including a menu line that says gluten-free", () => {
    expect(hasAllergenInfo(shop)).toBe(true);
  });
  it("is found from a section name alone", () => {
    expect(hasAllergenInfo([{ tag: "allergeni", title: "x", text: "Vedi il foglio." }])).toBe(true);
  });
  it("is absent from a list that never mentions it", () => {
    const plain = chunkPages([{ tag: "menu", text: "Espresso €1.20\nCappuccino €1.80" }, { tag: "hours", text: "Open 7:00 to 19:00" }]);
    expect(hasAllergenInfo(plain)).toBe(false);
    expect(allergenChunks(plain)).toEqual([]);
  });
  it("puts the section named allergens first, then other chunks that mention allergens", () => {
    const out = allergenChunks(shop);
    expect(out[0].tag).toBe("allergens");
    expect(out.map((c) => c.tag)).toContain("menu"); // it says "contains nuts and milk"
    expect(out.map((c) => c.tag)).toContain("prices"); // it offers a "Gluten-free cone on request"
    expect(out.map((c) => c.tag)).not.toContain("hours"); // nothing about allergens or diet
  });
  it("never goes over its token budget", () => {
    const big = chunkPages([
      { tag: "allergens", text: "Nuts and gluten. ".repeat(300) },
      { tag: "menu", text: "Contains nuts. ".repeat(300) },
    ]);
    const out = allergenChunks(big, 600);
    expect(out.reduce((n, c) => n + tokensOf(c.text), 0)).toBeLessThanOrEqual(600);
  });
});

describe("the fixed lines", () => {
  const langs = ["en", "it", "es", "fr", "de", "pt", "hi", "zh", "ja", "ko", "ar", "ru"];
  it("exist in every language the customer page offers, and differ from English", () => {
    for (const l of langs) {
      expect(staffLine(l).length).toBeGreaterThan(5);
      expect(noAllergenInfo(l).length).toBeGreaterThan(5);
      if (l !== "en") {
        expect(staffLine(l)).not.toBe(staffLine("en"));
        expect(noAllergenInfo(l)).not.toBe(noAllergenInfo("en"));
      }
    }
  });
  it("fall back to English for an unknown language, and accept region codes", () => {
    expect(staffLine("xx")).toBe(staffLine("en"));
    expect(staffLine("it-IT")).toBe(staffLine("it"));
    expect(noAllergenInfo("")).toBe(noAllergenInfo("en"));
  });
  it("are added to an answer once, with correct punctuation", () => {
    const a = withStaffLine("Nuts are used in our kitchen", "en");
    expect(a).toBe(`Nuts are used in our kitchen. ${staffLine("en")}`);
    expect(withStaffLine(a, "en")).toBe(a);
    expect(withStaffLine("Le noci sono usate qui.", "it")).toBe(`Le noci sono usate qui. ${staffLine("it")}`);
    expect(withStaffLine("", "en")).toBe(staffLine("en"));
  });
});
