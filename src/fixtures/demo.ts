// Demo rooms for the public URL. SAMPLE content written by hand until the Saturday take
// replaces DEMO_TALK with recorded MiMo output (same shape).

export const DEMO_SLIDES: { tag: string; text: string }[] = [
  { tag: "slide 1", text: "Eco. Your voice. Their language.\nEco translates the room, answers from the source, and tells the person in charge what nobody understood." },
  { tag: "slide 2", text: "The problem\nOne person speaks one language; the room speaks five. Listeners miss things and can't ask. The speaker never learns which slide lost the room. Interpreters are paid per language per day; translation devices cost $389–699 each." },
  { tag: "slide 3", text: "Room 1: Stage\nListeners scan a QR code and follow the talk live in Italian, Spanish or Hindi on their own phone. No app, no account. They can ask the talk: answers come only from the slides and the speaker's words, with the slide cited. Every question lands on the speaker's board." },
  { tag: "slide 4", text: "Room 2: Counter\nA QR sticker at a shop counter. Tourists talk or type in their language; the owner reads and hears Italian. Eco answers from the shop's own menu and policies and never invents a price or an allergen. The owner gets a weekly card of what customers asked." },
  { tag: "slide 5", text: "How it works\nEco runs on AMD Token Factory, which serves open models on AMD GPUs through an OpenAI-compatible API. MiMo-V2.6-Flash takes the audio of each phrase and returns the transcript and every translation in one call. Gemma-4-31B-IT answers questions from the source. Retrieval is local keyword search and costs zero tokens. AMD's open GPU software stack is called ROCm." },
  { tag: "slide 6", text: "Answers only from the source\nIf the slides don't say it, Eco says it is not covered and sends the question to the speaker, who can answer out loud. Every answer cites its slide." },
  { tag: "slide 7", text: "Cost\nOne call per phrase covers every listener, so cost grows with the number of languages, not with the size of the audience. Calls, tokens and latency are measured live on the speaker's screen." },
  { tag: "slide 8", text: "Who pays\nUniversities teaching international students, conferences and trade fairs, and independent shops in tourist streets. They pay for the cards: what nobody understood, and what customers asked." },
];

/** [slide, delay before this line in ms, src, it, es, hi] */
const T: [number, number, string, string, string, string][] = [
  [1, 2500, "Hi everyone, I'm Seb, and this is Eco.", "Ciao a tutti, sono Seb e questo è Eco.", "Hola a todos, soy Seb y esto es Eco.", "सभी को नमस्ते, मैं सेब हूँ और यह है इको।"],
  [1, 5000, "Right now I'm speaking English, but many of you are reading me in Italian, Spanish or Hindi.", "In questo momento parlo inglese, ma molti di voi mi stanno leggendo in italiano, spagnolo o hindi.", "Ahora mismo hablo en inglés, pero muchos de ustedes me están leyendo en italiano, español o hindi.", "अभी मैं अंग्रेज़ी में बोल रहा हूँ, लेकिन आप में से कई लोग मुझे इतालवी, स्पेनिश या हिंदी में पढ़ रहे हैं।"],
  [2, 7000, "When one person speaks one language to a room that speaks five, two things go wrong.", "Quando una persona parla una lingua a una sala che ne parla cinque, due cose vanno storte.", "Cuando una persona habla un idioma a una sala que habla cinco, dos cosas salen mal.", "जब एक व्यक्ति एक भाषा में ऐसे कमरे से बात करता है जहाँ पाँच भाषाएँ बोली जाती हैं, तो दो चीज़ें गलत होती हैं।"],
  [2, 6500, "The listener misses things and can't ask. And the speaker never finds out which slide lost the room.", "Chi ascolta si perde dei pezzi e non può chiedere. E chi parla non scopre mai quale slide ha perso la sala.", "Quien escucha se pierde cosas y no puede preguntar. Y quien habla nunca descubre qué diapositiva perdió a la sala.", "सुनने वाला बातें चूक जाता है और पूछ नहीं पाता। और वक्ता को कभी पता नहीं चलता कि किस स्लाइड पर कमरा उससे छूट गया।"],
  [3, 7500, "So Eco has two rooms. The first is the stage: you scan a QR code and follow the talk in your language.", "Per questo Eco ha due stanze. La prima è il palco: scansioni un codice QR e segui il talk nella tua lingua.", "Por eso Eco tiene dos salas. La primera es el escenario: escaneas un código QR y sigues la charla en tu idioma.", "इसलिए इको के दो कमरे हैं। पहला है मंच: आप एक QR कोड स्कैन करते हैं और अपनी भाषा में टॉक को फ़ॉलो करते हैं।"],
  [3, 7000, "If you don't understand something, you ask the talk from your phone, and the answer comes only from my slides.", "Se non capisci qualcosa, chiedi al talk dal telefono, e la risposta arriva solo dalle mie slide.", "Si no entiendes algo, le preguntas a la charla desde tu teléfono, y la respuesta sale solo de mis diapositivas.", "अगर आपको कुछ समझ नहीं आता, तो आप अपने फ़ोन से टॉक से पूछते हैं, और जवाब सिर्फ़ मेरी स्लाइड्स से आता है।"],
  [4, 7500, "The second room is the counter. A sticker at a shop, and a tourist talks to the owner in their own language.", "La seconda stanza è il bancone. Un adesivo in un negozio, e un turista parla con il titolare nella propria lingua.", "La segunda sala es el mostrador. Una pegatina en una tienda, y un turista habla con el dueño en su propio idioma.", "दूसरा कमरा है काउंटर। दुकान पर एक स्टिकर, और एक पर्यटक अपनी भाषा में मालिक से बात करता है।"],
  [4, 6000, "Eco answers from the shop's own menu, and it never invents a price or an allergen.", "Eco risponde dal menu del negozio e non inventa mai un prezzo o un allergene.", "Eco responde con el menú de la propia tienda y nunca se inventa un precio ni un alérgeno.", "इको दुकान के अपने मेन्यू से जवाब देता है, और कभी कोई कीमत या एलर्जेन नहीं गढ़ता।"],
  [5, 6500, "Under the hood, every phrase I say is one call to MiMo on AMD Token Factory.", "Dietro le quinte, ogni frase che dico è una sola chiamata a MiMo su AMD Token Factory.", "Por dentro, cada frase que digo es una sola llamada a MiMo en AMD Token Factory.", "अंदर से देखें तो, मेरा हर वाक्य AMD Token Factory पर MiMo को एक ही कॉल है।"],
  [5, 5500, "Audio goes in, and the transcript plus every language comes back together.", "Entra l'audio, ed escono insieme la trascrizione e tutte le lingue.", "Entra el audio y vuelven juntas la transcripción y todas las lenguas.", "ऑडियो अंदर जाता है, और ट्रांसक्रिप्ट के साथ हर भाषा एक साथ वापस आती है।"],
  [6, 6500, "Gemma answers your questions, and if my slides don't say it, Eco says so and sends the question to me.", "Gemma risponde alle vostre domande e, se le mie slide non lo dicono, Eco lo dice e manda la domanda a me.", "Gemma responde a sus preguntas y, si mis diapositivas no lo dicen, Eco lo dice y me envía la pregunta a mí.", "Gemma आपके सवालों के जवाब देता है, और अगर मेरी स्लाइड्स में वह बात नहीं है, तो इको यह बता देता है और सवाल मुझे भेज देता है।"],
  [7, 7500, "One call covers every listener, so the cost grows with languages, not with the size of the room.", "Una chiamata copre tutti gli ascoltatori, quindi il costo cresce con le lingue, non con la grandezza della sala.", "Una llamada cubre a todos los oyentes, así que el coste crece con los idiomas, no con el tamaño de la sala.", "एक कॉल हर श्रोता के लिए काफ़ी है, इसलिए लागत भाषाओं के साथ बढ़ती है, कमरे के आकार के साथ नहीं।"],
  [8, 7000, "Universities, conferences and shops in tourist streets pay for the cards: what nobody understood.", "Università, conferenze e negozi nelle vie turistiche pagano per le schede: ciò che nessuno ha capito.", "Universidades, congresos y tiendas en calles turísticas pagan por las fichas: lo que nadie entendió.", "विश्वविद्यालय, सम्मेलन और पर्यटक इलाकों की दुकानें उन कार्ड्स के लिए भुगतान करते हैं: जो किसी को समझ नहीं आया।"],
  [1, 7000, "Eco. Your voice, their language. Grazie.", "Eco. La tua voce, la loro lingua. Grazie.", "Eco. Tu voz, su idioma. Grazie.", "इको। आपकी आवाज़, उनकी भाषा। ग्रात्सिए।"],
];

/** Two speakers on two devices: the counter slide is presented by the co-speaker. */
export const DEMO_SPEAKERS = ["Seb", "Ritik"];
export const DEMO_TALK = T.map(([slide, delay, src, it, es, hi]) => ({ slide, delay, src, speaker: slide === 4 ? "s1" : "s0", out: { it, es, hi } as Record<string, string> }));

export const DEMO_SHOP = {
  name: "Gelateria Luna",
  type: "restaurant",
  ownerLang: "it",
  sources: [
    { tag: "menu", text: "Gelato flavours, made in house every day.\nPistachio: contains pistachio nuts and milk. Gluten-free.\nHazelnut: contains hazelnuts and milk. Gluten-free.\nDark chocolate sorbet: water based, no milk, vegan. Gluten-free.\nStracciatella: contains milk and soy. Gluten-free.\nLemon sorbet: vegan, gluten-free.\nStrawberry sorbet: vegan, gluten-free.\nTiramisù: contains milk, eggs, coffee and gluten (biscuits)." },
    { tag: "prices", text: "Prices\nCup or cone: small, 2 flavours €3.00; medium, 3 flavours €4.00; large, 4 flavours €5.00.\nWhipped cream +€0.50. Gluten-free cone on request +€0.50.\nTakeaway box: 500 g €12.00, 1 kg €22.00. The insulated bag keeps it cold for about 1 hour." },
    { tag: "allergens", text: "Allergens\nNuts are used in our lab, so traces of nuts are possible in every flavour. Ask staff for the full allergen sheet." },
    { tag: "hours", text: "Hours\nOpen every day 12:00–23:00. Closed on Mondays in November." },
    { tag: "payment", text: "Payment\nCash, cards, Apple Pay and Google Pay. No minimum spend." },
    { tag: "other", text: "Other\nFree tap water. Six tables outside. Customer toilet." },
  ],
};

/** Seeded history so the owner screen isn't empty. */
export const DEMO_CONVOS = [
  {
    lang: "en",
    customer: "Hi! Is the pistachio gluten-free?",
    to_owner: "Ciao! Il pistacchio è senza glutine?",
    answer: { covered: true, text: "Yes, the pistachio gelato is gluten-free. It contains pistachio nuts and milk.", text_owner: "Sì, il gelato al pistacchio è senza glutine. Contiene pistacchio e latte.", cite: "menu" },
  },
  {
    lang: "hi",
    customer: "क्या आप एक किलो का डिब्बा ले जाने के लिए देते हैं?",
    to_owner: "Fate una vaschetta da un chilo da portare via?",
    answer: { covered: true, text: "हाँ, 1 किलो का टेकअवे बॉक्स €22.00 का है। इंसुलेटेड बैग इसे लगभग 1 घंटे तक ठंडा रखता है।", text_owner: "Sì, la vaschetta da 1 kg costa €22,00. La borsa termica la tiene fredda per circa 1 ora.", cite: "prices" },
  },
  {
    lang: "de",
    customer: "Kann ich das Eis im Flugzeug mitnehmen?",
    to_owner: "Posso portare il gelato in aereo?",
    answer: { covered: false, text: "", text_owner: "", cite: "" },
  },
];
