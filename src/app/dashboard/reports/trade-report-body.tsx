"use client";
import {
  BrandSalesView,
  ConsignorStatementsView,
  DeadStockView,
  LayawayBookView,
  LowStockView,
  NearExpiryView,
  RepairsView,
  VariantSalesView,
  WarrantyRegisterView,
  WeightReconciliationView,
  type BrandSalesReport,
  type ConsignorStatementsReport,
  type DeadStockReport,
  type LayawayBookReport,
  type LowStockReport,
  type NearExpiryReport,
  type RepairsReport,
  type VariantSalesReport,
  type WarrantyReport,
  type WeightReconciliationReport,
} from "./trade-report-views";
import {
  VehicleInventoryView,
  VehicleReservationsView,
  VehicleSalesView,
  type VehicleInventoryReportPayload,
  type VehicleReservationsReportPayload,
  type VehicleSalesReportPayload,
} from "./automotive-report-views";
import { EmptyState } from "../page-chrome";
import type { ReportShape } from "./standard-report-config";
type ReportPayload = Record<string, unknown>;

export function TradeReportBody({ shape, payload }: { shape: ReportShape; payload: ReportPayload }) {
  switch (shape) {
    case "weight_reconciliation":
      return <WeightReconciliationView report={payload as unknown as WeightReconciliationReport} />;
    case "consignor_statements":
      return <ConsignorStatementsView report={payload as unknown as ConsignorStatementsReport} />;
    case "layaway_book":
      return <LayawayBookView report={payload as unknown as LayawayBookReport} />;
    case "warranty":
      return <WarrantyRegisterView report={payload as unknown as WarrantyReport} />;
    case "repairs":
      return <RepairsView report={payload as unknown as RepairsReport} />;
    case "variant_sales":
      return <VariantSalesView report={payload as unknown as VariantSalesReport} />;
    case "brand_sales":
      return <BrandSalesView report={payload as unknown as BrandSalesReport} />;
    case "near_expiry":
      return <NearExpiryView report={payload as unknown as NearExpiryReport} />;
    case "low_stock":
      return <LowStockView report={payload as unknown as LowStockReport} />;
    case "dead_stock":
      return <DeadStockView report={payload as unknown as DeadStockReport} />;
    // Issue #839 §14 — the dealership's own payloads.
    case "vehicle_inventory":
      return <VehicleInventoryView report={payload as unknown as VehicleInventoryReportPayload} />;
    case "vehicle_sales":
      return <VehicleSalesView report={payload as unknown as VehicleSalesReportPayload} />;
    case "vehicle_reservations":
      return <VehicleReservationsView report={payload as unknown as VehicleReservationsReportPayload} />;
    default:
      return <EmptyState>نمایش این گزارش پشتیبانی نمی‌شود.</EmptyState>;
  }
}
