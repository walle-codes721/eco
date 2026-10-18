# Repaint slides from the PDF text layer

A listener sees the speaker's designed slide with only the written words changed into their language. Those words and the boxes they sit in come from the PDF text layer pdf.js already reads on upload. Fragments that share a baseline are one row, and the row is what a translation call returns — one string per row per language — because translating each fragment on its own breaks word order. Image-only pages have no rows, so they stay as designed; what the picture says still belongs in Notes.

We considered OCR, which would guess boxes the PDF already knows and add a dependency the Worker cannot host, and a plain text card, which is how a room with no PDF already works and which drops the pictures and the layout.
