"use client";
/** Presentation only. Read-only consumers must not open tenant-authenticated drill-downs. */
import { ProfitAndLossView, BalanceSheetView, CashFlowView, FoodCostVarianceView,
  type ProfitAndLoss, type BalanceSheet, type CashFlow, type FoodCostVariance, type Comparison,
} from "./ledger-report-view";
import { TradeReportBody } from "./trade-report-body";
import type { ReportShape } from "./standard-report-config";
export function StructuredReportBody({ shape, payload, dateFrom, dateTo, readOnly = false }: {
  shape: ReportShape; payload: Record<string, unknown>; dateFrom?: string; dateTo?: string; readOnly?: boolean;
}) {
  switch (shape) {
    case "profit_and_loss": return <ProfitAndLossView readOnly={readOnly} report={payload as unknown as ProfitAndLoss | Comparison<ProfitAndLoss>} dateFrom={dateFrom} dateTo={dateTo} />;
    case "balance_sheet": return <BalanceSheetView readOnly={readOnly} report={payload as unknown as BalanceSheet | Comparison<BalanceSheet>} dateTo={dateTo} />;
    case "cash_flow": return <CashFlowView report={payload as unknown as CashFlow | Comparison<CashFlow>} />;
    case "food_cost_variance": return <FoodCostVarianceView report={payload as unknown as FoodCostVariance} />;
    default: return <TradeReportBody shape={shape} payload={payload} />;
  }
}
