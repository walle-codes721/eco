import { h, langName } from "/js/eco.js";
import { renderPage } from "/js/slides.js";
import { rowRectOnCanvas } from "/js/slide-repaint.js";
import { deckSlideNumbers, stepDeckSlide, findDeckPage, arrowDelta } from "/js/deck-preview-nav.js";

export { deckSlideNumbers, stepDeckSlide, findDeckPage, arrowDelta };

const DECK_LANGS = ["en", "it", "es", "fr", "de", "pt", "hi", "zh", "ja", "ar"];

function deckLangSelect(deckLang, onLang) {
  const langSel = h("select", { "aria-label": "Deck language" },
    ...DECK_LANGS.map((l) => h("option", { value: l }, langName(l, "en"))));
  langSel.value = deckLang || "en";
  langSel.onchange = () => onLang(langSel.value);
  return h("label.field", {}, "Deck language", langSel);
}

const plainButton = { background: "none", border: "0", padding: "0", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer" };

/**
 * Modal carousel: one slide image and that slide's rows only. ←/→ move between slides, clicking a row
 * outlines it on the slide, and a slide can be set to stay untranslated. With `confirmLabel` it resolves
 * true/false on confirm/cancel (the replace flow); otherwise it just closes. `withLang` adds the deck language.
 */
export function openDeckRowCarousel(pdf, pages, { deckLang, onLang, onChange, startSlide = 1, confirmLabel = null, withLang = false }) {
  const numbers = deckSlideNumbers(pages);
  if (!numbers.length) return Promise.resolve(false);
  let current = numbers.includes(startSlide) ? startSlide : numbers[0];
  let picked = -1; // row outlined on the slide
  let drawId = 0; // a newer redraw makes an older one stop before it touches the dialog
  const opener = document.activeElement;

  const overlay = h("div", { style: { position: "absolute", border: "2px solid var(--accent, #e5484d)", background: "rgba(229,72,77,.18)", borderRadius: "2px", pointerEvents: "none", display: "none" } });
  const stage = h("div", { style: { position: "relative", background: "var(--faint)", borderRadius: "8px", overflow: "hidden", minHeight: "120px" } });
  const counter = h("p.small.muted", { style: { margin: 0, flex: 1, textAlign: "center" } });
  const rowsSlot = h("div");
  const skipSlot = h("div");
  const prevBtn = h("button.btn.sm", { type: "button", "aria-label": "Previous slide" }, "←");
  const nextBtn = h("button.btn.sm", { type: "button", "aria-label": "Next slide" }, "→");

  const showPicked = () => {
    const canvas = stage.querySelector("canvas");
    const row = findDeckPage(pages, current).rows[picked];
    if (!canvas || !row?.box) { overlay.style.display = "none"; return; }
    const r = rowRectOnCanvas(row.box, { pageW: canvas._pdfBaseW, pageH: canvas._pdfBaseH, canvasW: canvas.width, canvasH: canvas.height });
    Object.assign(overlay.style, {
      display: "block",
      left: `${(r.x / canvas.width) * 100}%`, top: `${(r.y / canvas.height) * 100}%`,
      width: `${(r.w / canvas.width) * 100}%`, height: `${(r.h / canvas.height) * 100}%`,
    });
  };

  const drawRows = () => {
    const page = findDeckPage(pages, current);
    const real = pages.find((p) => p.n === current);
    skipSlot.replaceChildren(real
      ? h("label.row", { style: { gap: "10px", alignItems: "center", marginTop: "12px" } },
        h("input", {
          type: "checkbox",
          checked: !!real.skip,
          onchange: (e) => {
            if (e.target.checked) real.skip = true;
            else delete real.skip;
            onChange(pages);
            picked = -1;
            drawRows();
            showPicked();
          },
        }),
        h("span", {}, "Don't translate this slide"))
      : "");
    if (real?.skip) {
      rowsSlot.replaceChildren(h("p.small.muted", { style: { margin: "8px 0 0" } }, "Listeners see this slide as designed. Nothing on it is translated."));
      return;
    }
    if (!page.rows?.length) {
      rowsSlot.replaceChildren(h("p.small.muted", { style: { margin: "8px 0 0" } }, "No text rows"));
      return;
    }
    rowsSlot.replaceChildren(h("div.stack", { style: { marginTop: "8px", maxHeight: "220px", overflow: "auto" } },
      ...page.rows.map((row, i) =>
        h("div.row", { style: { alignItems: "flex-start", gap: "10px", marginBottom: "6px", fontWeight: i === picked ? 600 : 400 } },
          h("input", {
            type: "checkbox",
            "aria-label": "Keep this row as printed",
            checked: row.kept,
            onchange: (e) => {
              row.kept = e.target.checked;
              onChange(pages);
              drawRows();
            },
          }),
          h("button", {
            type: "button",
            style: plainButton,
            title: "Show this row on the slide",
            onclick: () => { picked = picked === i ? -1 : i; drawRows(); showPicked(); },
          }, h("span.small.muted", {}, row.kept ? "Keep · " : ""), row.text),
        ),
      ),
    ));
  };

  const redraw = async () => {
    const mine = ++drawId;
    const i = numbers.indexOf(current);
    counter.textContent = `Slide ${current} of ${numbers.length}`;
    prevBtn.disabled = i <= 0;
    nextBtn.disabled = i >= numbers.length - 1;
    picked = -1;
    overlay.style.display = "none";
    drawRows();
    if (!pdf) return;
    const cssW = Math.min(720, Math.max(320, stage.clientWidth || 0));
    const canvas = await renderPage(pdf, current, cssW || 680);
    if (mine !== drawId) return;
    stage.replaceChildren(canvas, overlay);
  };

  const go = (delta) => {
    const next = stepDeckSlide(numbers, current, delta);
    if (next === current) return;
    current = next;
    redraw();
  };
  prevBtn.onclick = () => go(-1);
  nextBtn.onclick = () => go(1);

  return new Promise((resolve) => {
    const close = (ok) => {
      backdrop.remove();
      opener?.focus?.();
      resolve(ok);
    };
    const card = h("div.card", {
      style: { maxWidth: "720px", width: "100%", maxHeight: "90vh", overflow: "auto", padding: "20px" },
      tabindex: "-1",
      onkeydown: (e) => {
        if (e.key === "Escape") return close(false);
        const d = arrowDelta(e.key, e.target.tagName, e.target.type);
        if (d) { e.preventDefault(); go(d); }
      },
    },
    h("h3", { style: { margin: "0 0 4px" } }, "Review slide rows"),
    h("p.small.muted", {}, "Arrow keys move between slides. Click a row to see it on the slide. Check Keep for quotations."),
    ...(withLang ? [deckLangSelect(deckLang, onLang)] : []),
    h("div.row", { style: { gap: "8px", marginTop: "12px", alignItems: "center" } }, prevBtn, counter, nextBtn),
    h("div", { style: { marginTop: "8px" } }, stage),
    skipSlot,
    rowsSlot,
    h("div.row", { style: { marginTop: "16px", justifyContent: "flex-end", gap: "8px" } },
      h("button.btn", { type: "button", onclick: () => close(false) }, confirmLabel ? "Cancel" : "Done"),
      ...(confirmLabel ? [h("button.btn.primary", { type: "button", onclick: () => close(true) }, confirmLabel)] : []),
    ),
    );
    const backdrop = h("div", {
      role: "dialog", "aria-modal": "true", "aria-label": "Review slide rows",
      style: { position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 50, display: "grid", placeItems: "center", padding: "20px" },
      onclick: (e) => e.target === backdrop && close(false),
    }, card);
    document.body.append(backdrop);
    card.focus();
    redraw();
  });
}

/**
 * Upload page: the deck language, a button that opens the carousel at slide 1 (every slide is reachable
 * with the arrow keys, even past the thumbnails), and each thumbnail opens the carousel at its slide.
 */
export function deckPreviewSetup(thumbsEl, pdf, pages, { getDeckLang, onLang, onChange }) {
  const open = (startSlide) => openDeckRowCarousel(pdf, pages, { onChange, startSlide });
  for (let n = 1; n <= thumbsEl.children.length; n++) {
    const slot = thumbsEl.children[n - 1];
    Object.assign(slot, { title: `Review rows on slide ${n}`, tabIndex: 0 });
    slot.setAttribute("role", "button");
    slot.style.cursor = "pointer";
    slot.onclick = () => open(n);
    slot.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open(n));
  }
  return h("div", { style: { marginTop: "16px" } },
    deckLangSelect(getDeckLang(), onLang),
    h("div.row", { style: { marginTop: "12px" } }, h("button.btn.sm", { type: "button", onclick: () => open(1) }, "Review rows slide by slide")),
    h("p.tiny.muted", {}, "Click a slide to review its rows. Keep marks quotations; a slide can also stay untranslated. Preview uses no translation call."),
  );
}
