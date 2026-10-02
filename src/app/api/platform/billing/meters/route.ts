import { NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { METER_CATALOGUE } from "@/lib/billing/catalog/meters";
import { query } from "@/lib/db";

/** The meter catalogue plus the open price version for each meter. */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("billing.manage");
  if (error) return error;
  const { rows } = await query<{
    target_key: string;
    version: number;
    unit_amount_rial: string;
    unit_size: string;
    unit: string;
    effective_from: string;
  }>(
    `SELECT target_key, version, unit_amount_rial, unit_size, unit, effective_from
       FROM billing_price_versions
      WHERE target_type = 'meter' AND effective_until IS NULL`,
  );
  const open = new Map(rows.map((row) => [row.target_key, row]));
  return NextResponse.json({
    meters: METER_CATALOGUE.map((meter) => {
      const price = open.get(meter.key);
      return {
        ...meter,
        price: price
          ? {
              version: price.version,
              unitAmountRial: Number(price.unit_amount_rial),
              unitSize: Number(price.unit_size ?? 1),
              unit: price.unit,
              effectiveFrom: price.effective_from,
            }
          : null,
      };
    }),
  });
});
