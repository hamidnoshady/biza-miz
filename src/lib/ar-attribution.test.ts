import { describe, expect, it } from "vitest";
import { AR_CUSTOMER_ATTRIBUTION_SQL, AR_CUSTOMER_ID_SQL, arCustomerAttributionSql } from "./ar-attribution";

describe("the canonical A/R source relation", () => {
  it("retains unknowns for reports and uses the same source arms for named statements", () => {
    const named = arCustomerAttributionSql("$3::uuid");
    expect(AR_CUSTOMER_ATTRIBUTION_SQL).toBe(arCustomerAttributionSql());
    expect(AR_CUSTOMER_ID_SQL).toBe("ar_source.customer_id");
    expect(AR_CUSTOMER_ATTRIBUTION_SQL).toContain("LEFT JOIN (");
    expect(named).not.toContain("LEFT JOIN (");
    expect(named.match(/customer_id = \$3::uuid/g)).toHaveLength(4);
    expect(named.replaceAll(/ AND \w+\.customer_id = \$3::uuid/g, "").replace("JOIN (", "LEFT JOIN (")).toBe(AR_CUSTOMER_ATTRIBUTION_SQL);
    for (const sql of [named, AR_CUSTOMER_ATTRIBUTION_SQL]) {
      expect(sql).toContain("order_amendments am JOIN orders o ON o.id = am.order_id");
      expect(sql).toContain("r.business_id = $1");
      expect(sql).toContain("ch.business_id = $1");
    }
  });
});
