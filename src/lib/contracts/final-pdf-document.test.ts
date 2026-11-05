import { describe, expect, it } from "vitest";
import type { ContractDocumentContent } from "./blocks";
import { renderFinalPdfContractDocument } from "./final-pdf-document";

describe("final contract PDF document markup", () => {
  it("renders every frozen block from the same model and safely escapes tenant content", () => {
    const content: ContractDocumentContent = {
      version: 1,
      title: "قرارداد <script>alert(1)</script>",
      headerText: "سرصفحه {{party}}",
      footerText: "پاورقی & شرایط",
      values: { party: "<طرف>", show: "بله", amount: "۱۰۰ تومان" },
      fields: [],
      blocks: [
        { id: "h1", type: "heading", text: "عنوان {{party}}" },
        { id: "p1", type: "paragraph", text: "متن <b>امن</b>" },
        {
          id: "c1",
          type: "conditional",
          condition: { fieldKey: "show", operator: "is_checked", value: "" },
          text: "بند مشروط",
        },
        {
          id: "s1",
          type: "schedule",
          caption: "اقساط",
          startDate: "2026-01-31",
          intervalMonths: 1,
          count: 2,
          amountText: "{{amount}}",
        },
        { id: "a1", type: "article", title: "مادهٔ اول", text: "متن ماده" },
        {
          id: "l1",
          type: "bullets",
          items: ["نکتهٔ اول", "نکتهٔ {{missing}}"],
        },
        { id: "l2", type: "numbered", items: ["گام اول"] },
        {
          id: "t1",
          type: "table",
          caption: "مشخصات",
          columns: ["نام"],
          rows: [["{{party}}"]],
        },
        { id: "d1", type: "divider" },
        { id: "b1", type: "page_break" },
        {
          id: "sig1",
          type: "signature",
          slotId: "employer",
          label: "امضای {{party}}",
          caption: "نام و تاریخ",
        },
      ],
    };
    const html = renderFinalPdfContractDocument(content, {
      employer: {
        fullName: "<script>نام</script>",
        signedAt: "۱۴۰۵/۰۱/۱۱",
        drawnImage: "data:image/png;base64,AAEC",
      },
    });

    expect(html).toContain(
      'aria-label="قرارداد &lt;script&gt;alert(1)&lt;/script&gt;"',
    );
    expect(html).toContain("سرصفحه &lt;طرف&gt;");
    expect(html).toContain("متن &lt;b&gt;امن&lt;/b&gt;");
    expect(html).toContain("بند مشروط");
    expect(html).toContain("۱۰۰ تومان");
    expect(html).toContain("مادهٔ اول");
    expect(html).toContain("نکتهٔ ");
    expect(html).not.toContain("{{missing}}");
    expect(html).toContain("۱۴۰۴");
    expect(html).toContain("مشخصات");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("data:image/png;base64,AAEC");
    expect(html).toContain("&lt;script&gt;نام&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("پاورقی &amp; شرایط");
  });

  it("omits unchecked conditional content and rejects non-data signature images", () => {
    const content: ContractDocumentContent = {
      version: 1,
      title: "قرارداد",
      headerText: "",
      footerText: "",
      values: { checked: "خیر" },
      fields: [],
      blocks: [
        {
          id: "c1",
          type: "conditional",
          condition: { fieldKey: "checked", operator: "is_checked", value: "" },
          text: "این بند نمایش داده نشود",
        },
        {
          id: "sig1",
          type: "signature",
          slotId: "signer",
          label: "امضا",
          caption: "نام",
        },
      ],
    };
    const html = renderFinalPdfContractDocument(content, {
      signer: {
        fullName: "سام",
        signedAt: "امروز",
        drawnImage: "https://attacker.example/pixel.png",
      },
    });
    expect(html).not.toContain("این بند نمایش داده نشود");
    expect(html).not.toContain("attacker.example");
    expect(html).toContain("سام");
  });
});
