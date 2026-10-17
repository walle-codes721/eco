# Store the rows the speaker previewed

The speaker marks kept rows while uploading the deck, and a slide is translated later, when it is reached. The room stores that preview: each row's words and box, and which rows are kept. The translation call uses exactly those rows, omitting the kept ones. The listener paints the stored result and does not group the PDF again.

Grouping again on each phone would be free of stored boxes, and a different grouping could translate a row the speaker had kept, or keep one they had not.
