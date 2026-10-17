// Opt-in, numeric diagnostics only: no prompts, speech, keys or extra requests.
export interface TranslationTiming {
  budgetMs: number;
  retryMs: number;
  accountingMs: number;
  attempts: { model: string; status: number; ms: number }[];
}

export const translationTiming = (): TranslationTiming => ({ budgetMs: 0, retryMs: 0, accountingMs: 0, attempts: [] });

export function timingHeader(timing: TranslationTiming, serverMs: number): string {
  const aiMs = timing.attempts.reduce((sum, attempt) => sum + attempt.ms, 0);
  const durations = { budget: timing.budgetMs, ai: aiMs, retry: timing.retryMs, accounting: timing.accountingMs,
    processing: Math.max(0, serverMs - timing.budgetMs - aiMs - timing.retryMs - timing.accountingMs), server: serverMs };
  return [...Object.entries(durations).map(([name, ms]) => `${name};dur=${Math.max(0, ms)}`),
    ...timing.attempts.map((a, i) => `attempt_${i + 1};dur=${Math.max(0, a.ms)};desc="${a.model.replace(/[^a-zA-Z0-9.-]/g, "")} HTTP ${a.status}"`)].join(", ");
}
