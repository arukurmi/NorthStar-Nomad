import { db } from "../db.js";
import type { AiFeature, ProviderId } from "./provider.js";

export interface UsageEvent {
  userId: number;
  feature: AiFeature;
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
}

export interface UsageSummaryRow {
  feature: AiFeature;
  calls: number;
  cachedCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageTotals {
  calls: number;
  cachedCalls: number;
  inputTokens: number;
  outputTokens: number;
}

const insertUsage = db.prepare(`
  INSERT INTO ai_usage
    (user_id, feature, provider, model, input_tokens, output_tokens, cached)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

/**
 * A cache hit is still a row, with cached = 1 and zero tokens. That is what
 * makes the saving visible: `calls` counts every request the user made, and
 * `cachedCalls` shows how many of them cost nothing.
 */
export function recordUsage(e: UsageEvent): void {
  insertUsage.run(
    e.userId,
    e.feature,
    e.provider,
    e.model,
    e.inputTokens,
    e.outputTokens,
    e.cached ? 1 : 0,
  );
}

const selectSummary = db.prepare(`
  SELECT feature,
         COUNT(*)                              AS calls,
         SUM(cached)                           AS cachedCalls,
         COALESCE(SUM(input_tokens),  0)       AS inputTokens,
         COALESCE(SUM(output_tokens), 0)       AS outputTokens
  FROM ai_usage
  WHERE user_id = ?
  GROUP BY feature
  ORDER BY feature
`);

export function usageSummary(userId: number): UsageSummaryRow[] {
  return selectSummary.all(userId) as UsageSummaryRow[];
}

/** A fold over the summary rather than a second query — same numbers, one scan. */
export function usageTotals(rows: UsageSummaryRow[]): UsageTotals {
  return rows.reduce<UsageTotals>(
    (totals, row) => ({
      calls: totals.calls + row.calls,
      cachedCalls: totals.cachedCalls + row.cachedCalls,
      inputTokens: totals.inputTokens + row.inputTokens,
      outputTokens: totals.outputTokens + row.outputTokens,
    }),
    { calls: 0, cachedCalls: 0, inputTokens: 0, outputTokens: 0 },
  );
}
