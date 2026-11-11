"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { WeightBarcodeTemplate } from "@/lib/weight-barcode-templates-service";
import { api } from "../ui";
import { SectionCardSkeleton } from "../page-chrome";
import { BarcodeTemplatesSection } from "./barcode-templates-section";

/** Keep existing scale patterns reachable without advertising weight encoding
 * as a capability of all trades. Never infer support from barcode capability. */
export function LegacyWeightPatterns({ canEdit }: { canEdit: boolean }) {
  const [state, setState] = useState<"loading" | "error" | "empty" | "available">("loading");
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    setState("loading");
    const { ok, data } = await api<{ templates?: WeightBarcodeTemplate[] }>("/api/products/barcode-templates");
    setState(!ok || !Array.isArray(data.templates) ? "error" : data.templates.length ? "available" : "empty");
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (state === "loading") return <SectionCardSkeleton />;
  if (state === "empty") return null;
  if (state === "error") return <div role="alert" className="text-sm">بررسی الگوهای وزنی قبلی انجام نشد. <Button type="button" variant="outline" size="sm" onClick={() => void load()}>تلاش دوباره</Button></div>;
  return (
    <section className="space-y-3" aria-label="الگوهای وزنی قبلی">
      <p className="text-sm text-muted-foreground">این شعبه الگوهای بارکد وزنی قبلی دارد. این الگوها برای ترازو هستند و قالب چاپ برچسب کالا نیستند.</p>
      <Button type="button" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "بستن الگوهای وزنی قبلی" : "مدیریت الگوهای وزنی قبلی"}
      </Button>
      {open ? <BarcodeTemplatesSection canEdit={canEdit} /> : null}
    </section>
  );
}
