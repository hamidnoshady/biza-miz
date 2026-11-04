import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContractDocumentSheet } from "./contract-document-sheet";
import { normalizeContractContent } from "@/lib/contracts/blocks";

const content = normalizeContractContent({
  title: "قرارداد",
  fields: [{ key: "option", label: "نوع", type: "select", required: false, options: ["with", "without"], value: "" }],
  blocks: [{
    id: "conditional1",
    type: "conditional",
    condition: { fieldKey: "option", operator: "equals", value: "with" },
    text: "بند ضمانت اختیاری",
  }],
});

describe("ContractDocumentSheet conditional clauses", () => {
  it("prints a conditional clause only when its frozen value matches", () => {
    const included = renderToStaticMarkup(<ContractDocumentSheet content={content} values={{ option: "with" }} />);
    const omitted = renderToStaticMarkup(<ContractDocumentSheet content={content} values={{ option: "without" }} />);
    expect(included).toContain("بند ضمانت اختیاری");
    expect(omitted).not.toContain("بند ضمانت اختیاری");
  });
});


describe("ContractDocumentSheet repeating schedules", () => {
  it("renders generated due dates and repeats the amount variable per installment", () => {
    const schedule = normalizeContractContent({
      title: "قرارداد",
      fields: [{ key: "amount", label: "مبلغ قسط", type: "money", required: true, options: [], value: "" }],
      blocks: [{
        id: "schedule1", type: "schedule", caption: "سه قسط", startDate: "2024-01-31",
        intervalMonths: 1, count: 3, amountText: "{{amount}}",
      }],
    });
    const html = renderToStaticMarkup(<ContractDocumentSheet content={schedule} values={{ amount: "۱۰۰ تومان" }} />);
    expect(html).toContain("۱۱ بهمن ۱۴۰۲");
    expect(html).toContain("۱۰ اسفند ۱۴۰۲");
    expect(html).toContain("۱۲ فروردین ۱۴۰۳");
    expect(html.match(/۱۰۰ تومان/g)).toHaveLength(3);
  });
});
