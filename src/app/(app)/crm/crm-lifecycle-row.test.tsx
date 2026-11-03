import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LIFECYCLE_ORDER, LIFECYCLE_STAGES } from "@/lib/crm-scoring";
import { CrmLifecycleRow } from "./crm-lifecycle-row";

describe("CRM RFM lifecycle Persian typography", () => {
  it("keeps every stage label free of kashida and Arabic Yeh/Kaf substitutions", () => {
    expect(LIFECYCLE_STAGES.potential_loyalist.label).toBe("در آستانهٔ وفاداری");
    for (const stage of LIFECYCLE_ORDER) {
      const label = LIFECYCLE_STAGES[stage].label;
      expect(label).not.toMatch(/[\u0640\u064a\u0643\u200e\u200f]/u);
      expect(label).toBe(label.trim());
    }
  });

  it("renders the title and recommendation in separate blocks with isolated money", () => {
    const html = renderToStaticMarkup(
      createElement(CrmLifecycleRow, {
        stage: "potential_loyalist",
        count: 22,
        amountLabel: "۶۳٬۵۶۳٬۸۲۴ تومان",
      }),
    );
    expect(html).toMatch(/<strong[^>]*>در آستانهٔ وفاداری<\/strong>/u);
    expect(html).toMatch(/<p[^>]*>عضویت در باشگاه مشتریان را پیشنهاد بده؛ یک قدم تا وفاداری فاصله دارند\.<\/p>/u);
    expect(html).toContain("۲۲ نفر");
    expect(html).toContain('<bdi dir="auto">۶۳٬۵۶۳٬۸۲۴ تومان</bdi>');
    expect(html).not.toContain("ـ");
  });

  it("renders all lifecycle titles without collapsing them into the action sentence", () => {
    for (const stage of LIFECYCLE_ORDER) {
      const html = renderToStaticMarkup(
        createElement(CrmLifecycleRow, { stage, count: 1, amountLabel: "۰ تومان" }),
      );
      expect(html).toContain(`>${LIFECYCLE_STAGES[stage].label}</strong>`);
      expect(html).toContain(`>${LIFECYCLE_STAGES[stage].action}</p>`);
    }
  });
});
