export type FinancialStatementMatch = "matched" | "pending" | "unmatched";
export const MAX_FINANCIAL_STATEMENT_EXPORT_ENTRIES = 10_000;

export const FINANCIAL_STATEMENT_MATCH_LABELS: Record<FinancialStatementMatch, string> = {
  matched: "تطبیق‌شده",
  pending: "در حال تطبیق",
  unmatched: "تطبیق‌نشده",
};
