import { h, langName } from "/js/eco.js";

const DECK_LANGS = ["en", "it", "es", "fr", "de", "pt", "hi", "zh", "ja", "ar"];

/** Speaker preview: rows to translate vs keep, and the deck's source language. No translation calls. */
export function deckPreviewPanel(pages, { deckLang, onLang, onChange }) {
  const langSel = h("select", { "aria-label": "Deck language" },
    ...DECK_LANGS.map((l) => h("option", { value: l }, langName(l, "en"))));
  langSel.value = deckLang || "en";
  langSel.onchange = () => onLang(langSel.value);

  const body = h("div.stack", { style: { marginTop: "12px" } });
  const draw = () => {
    body.replaceChildren(...pages.flatMap((p) => {
      if (!p.rows?.length) return [];
      return [
        h("p.small.muted", { style: { marginTop: "8px" } }, `Slide ${p.n}`),
        ...p.rows.map((row, i) =>
          h("label.row", { style: { alignItems: "flex-start", gap: "10px", marginBottom: "6px" } },
            h("input", {
              type: "checkbox",
              checked: row.kept,
              onchange: (e) => {
                row.kept = e.target.checked;
                onChange(pages);
              },
            }),
            h("span", {}, h("span.small.muted", {}, row.kept ? "Keep · " : ""), row.text),
          ),
        ),
      ];
    }));
    if (!body.childNodes.length) body.replaceChildren(h("p.small.muted", {}, "No text rows on this PDF — picture-only pages need nothing marked."));
  };
  draw();

  return h("div", { style: { marginTop: "16px" } },
    h("label.field", {}, "Deck language", langSel),
    h("p.tiny.muted", {}, "Every row is translated unless you check Keep (for quotations). Preview uses no translation call."),
    body,
  );
}
