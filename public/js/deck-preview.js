import { h, langName } from "/js/eco.js";
import { renderPage } from "/js/slides.js";
import { deckSlideNumbers, stepDeckSlide, findDeckPage } from "/js/deck-preview-nav.js";

export { deckSlideNumbers, stepDeckSlide, findDeckPage };

const DECK_LANGS = ["en", "it", "es", "fr", "de", "pt", "hi", "zh", "ja", "ar"];

function deckLangSelect(deckLang, onLang) {
  const langSel = h("select", { "aria-label": "Deck language" },
    ...DECK_LANGS.map((l) => h("option", { value: l }, langName(l, "en"))));
  langSel.value = deckLang || "en";
  langSel.onchange = () => onLang(langSel.value);
  return h("label.field", {}, "Deck language", langSel);
}

function rowList(page, pages, onChange) {
  if (!page.rows?.length) return h("p.small.muted", { style: { margin: "8px 0 0" } }, "No text rows");
  return h("div.stack", { style: { marginTop: "8px", maxHeight: "220px", overflow: "auto" } },
    ...page.rows.map((row) =>
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
  );
}

/**
 * Modal carousel: one slide image and that slide's rows. Arrow keys move between slides.
 * With `confirmLabel`, resolves true/false when the user confirms or cancels.
 */
export function openDeckRowCarousel(pdf, pages, { deckLang, onLang, onChange, startSlide = 1, confirmLabel = null }) {
  const numbers = deckSlideNumbers(pages);
  let current = numbers.includes(startSlide) ? startSlide : numbers[0] ?? 1;
  const slideNums = deckSlideNumbers(pages);

  const canvasSlot = h("div", { style: { background: "var(--faint)", borderRadius: "8px", overflow: "hidden", minHeight: "120px" } });
  const counter = h("p.small.muted", { style: { margin: "8px 0 0" } });
  const rowsSlot = h("div");
  const prevBtn = h("button.btn.sm", { type: "button", "aria-label": "Previous slide" }, "←");
  const nextBtn = h("button.btn.sm", { type: "button", "aria-label": "Next slide" }, "→");

  const redraw = async () => {
    counter.textContent = `Slide ${current} of ${numbers.length}`;
    canvasSlot.replaceChildren();
    if (pdf) canvasSlot.append(await renderPage(pdf, current, 420));
    rowsSlot.replaceChildren(rowList(findDeckPage(pages, current), pages, onChange));
  };

  const go = (delta) => {
    current = stepDeckSlide(slideNums, current, delta);
    redraw();
  };
  prevBtn.onclick = () => go(-1);
  nextBtn.onclick = () => go(1);

  return new Promise((resolve) => {
    const close = (ok) => {
      backdrop.remove();
      resolve(ok);
    };
    const card = h("div.card", {
      style: { maxWidth: "720px", width: "100%", maxHeight: "90vh", overflow: "auto", padding: "20px" },
      tabindex: "-1",
      onkeydown: (e) => {
        if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
        else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
        else if (e.key === "Escape") close(false);
      },
    },
    h("h3", { style: { margin: "0 0 4px" } }, "Preview slide rows"),
    h("p.small.muted", {}, "Check Keep for quotations. Arrow keys move between slides."),
    deckLangSelect(deckLang, onLang),
    h("div.row", { style: { gap: "8px", marginTop: "12px", alignItems: "center" } }, prevBtn, counter, nextBtn),
    canvasSlot,
    rowsSlot,
    h("div.row", { style: { marginTop: "16px", justifyContent: "flex-end", gap: "8px" } },
      h("button.btn", { type: "button", onclick: () => close(false) }, confirmLabel ? "Cancel" : "Done"),
      ...(confirmLabel ? [h("button.btn.primary", { type: "button", onclick: () => close(true) }, confirmLabel)] : []),
    ),
    );
    const backdrop = h("div", {
      style: { position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 50, display: "grid", placeItems: "center", padding: "20px" },
      onclick: (e) => e.target === backdrop && close(false),
    }, card);
    document.body.append(backdrop);
    card.focus();
    redraw();
  });
}

/** Inline hint under thumbnails; deck language + open carousel on thumb click. */
export function deckPreviewSetup(thumbsEl, pdf, pages, { deckLang, onLang, onChange }) {
  const wrap = h("div", { style: { marginTop: "16px" } },
    deckLangSelect(deckLang, onLang),
    h("p.tiny.muted", {}, "Click a slide above to review its rows. Keep marks quotations; preview uses no translation call."),
  );
  for (let n = 1; n <= thumbsEl.children.length; n++) {
    const slot = thumbsEl.children[n - 1];
    slot.style.cursor = "pointer";
    slot.title = `Review rows on slide ${n}`;
    slot.onclick = () => openDeckRowCarousel(pdf, pages, { deckLang, onLang, onChange, startSlide: n });
  }
  return wrap;
}
