// ADR 0006: the preset voice is labelled as synthetic only on lines where its clip exists.
// A line that fell back to the phone voice carries no label.
export function voiceChip(presets, choice, line, lang) {
  if (choice === "speaker" || choice === "phone") return null;
  if (!line.audio?.[`${lang}@${choice}`]) return null;
  return presets?.find((p) => p.id === choice)?.label ?? null;
}
