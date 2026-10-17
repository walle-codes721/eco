# Translate a slide when it is reached

The room knows its languages when the deck is uploaded, so every page could be translated then. A slide is translated the first time it becomes the current slide, and the next slide with it. Listeners see the original page until that call returns, and they keep the original if the call fails. The room stores the result for every listener. Mock mode makes no call.

Translating the whole deck at upload would spend one call per page, including pages the speaker never shows, against the shared daily ceiling.
