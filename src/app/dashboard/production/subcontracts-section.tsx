"use client";

/**
 * GH #1567 Phase 6.3 — subcontracted stages inside the production order sheet.
 *
 * A stage (usually sewing) goes to an outside workshop: pick one of the
 * branch's suppliers and the agreed price per accepted piece, have it approved
 * (it commits a payable, so it needs «تأیید سند حسابداری»), send the pieces
 * and the fabric, then record each delivery as accepted / back for rework /
 * scrapped / missing. Accepted pieces move on to the next stage and the
 * supplier's account is credited; it is paid like any supplier, from
 * «پرداخت به تأمین‌کننده». Every button is one server action on the order
 * (same lock and idempotency key as the rest of the sheet).
 */
import { useState } from "react";
import { HandshakeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useMoney } from "@/components/money/money-context";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import type { ProductionOrderStatus } from "@/lib/fashion-production";
import type { SubcontractStatus } from "@/lib/fashion-production-subcontract";
import { EmptyState, StatusBadge } from "../page-chrome";

export interface Subcontract {
  id: string; reference: string; supplierId: string; supplierName: string; stageCode: string; ratePerUnitRial: number;
  status: SubcontractStatus; approvedByName: string | null;
  sentQuantity: string; acceptedQuantity: string; scrappedQuantity: string; shortageQuantity: string; reworkQuantity: string;
  heldQuantity: string; accruedRial: number; chargebackRial: number; disputeNote: string | null;
  custody: { materialItemId: string; name: string; unit: string | null; sentQuantity: string; returnedQuantity: string;
    consumedQuantity: string; lostQuantity: string; heldQuantity: string }[];
}

export const SUBCONTRACT_ACTION_LABELS: Record<string, string> = {
  subcontract_create: "تعیین پیمانکار", subcontract_approve: "تأیید قرارداد پیمانکار", subcontract_send: "ارسال به پیمانکار",
  subcontract_receive: "تحویل و بازرسی کار پیمانکار", subcontract_return_materials: "برگشت مواد از پیمانکار",
  subcontract_dispute: "ثبت اختلاف با پیمانکار", subcontract_resolve: "حل اختلاف با پیمانکار",
  subcontract_close: "بستن قرارداد پیمانکار", subcontract_cancel: "لغو قرارداد پیمانکار",
};

export const SUBCONTRACT_STATUS_LABELS: Record<SubcontractStatus, string> = {
  draft: "در انتظار تأیید", approved: "فعال", disputed: "در اختلاف", closed: "بسته", cancelled: "لغوشده",
};

const STATUS_TONE: Record<SubcontractStatus, "active" | "positive" | "neutral" | "danger"> = {
  draft: "neutral", approved: "active", disputed: "danger", closed: "positive", cancelled: "neutral",
};

const fa = (value: string | number) => toPersianDigits(String(value));

/** Accepts Persian or Latin digits; blank → null; otherwise canonical text or undefined when invalid. */
function optionalQuantity(raw: string): string | null | undefined {
  const text = toLatinDigits(raw).replace(/[٫,]/g, ".").trim();
  if (!text) return null;
  return /^\d+(\.\d{1,9})?$/.test(text) && Number(text) > 0 ? text : undefined;
}

interface Props {
  subcontracts: Subcontract[];
  suppliers: { id: string; name: string }[];
  stages: { code: string; label: string }[];
  materials: { materialItemId: string; name: string; unit: string | null }[];
  orderStatus: ProductionOrderStatus;
  canAct: boolean;
  canApprove: boolean;
  busy: boolean;
  onAct: (body: Record<string, unknown>) => Promise<boolean>;
  onError: (message: string) => void;
}

export function SubcontractsSection(props: Props) {
  const { subcontracts, suppliers, stages, canAct, busy, onAct, onError } = props;
  const money = useMoney();
  const [supplierId, setSupplierId] = useState("");
  const [stage, setStage] = useState(stages.find((s) => s.code === "sew")?.code ?? stages[0]?.code ?? "");
  const [rate, setRate] = useState("");

  async function create() {
    if (!supplierId || !stage) { onError("پیمانکار و مرحله را انتخاب کنید."); return; }
    let ratePerUnitRial = 0;
    if (rate.trim()) {
      try { ratePerUnitRial = money.parse(rate); } catch { onError("اجرت هر عدد معتبر نیست."); return; }
    }
    if (await onAct({ action: "subcontract_create", supplierId, stage, ratePerUnitRial })) { setSupplierId(""); setRate(""); }
  }

  return (
    <section aria-labelledby="po-subcontracts" className="space-y-3">
      <h3 id="po-subcontracts" className="font-medium">پیمانکاران</h3>
      {subcontracts.length === 0 ? (
        <EmptyState title="مرحله‌ای به پیمانکار سپرده نشده" icon={HandshakeIcon}>
          اگر دوخت یا مرحلهٔ دیگری بیرون از کارگاه انجام می‌شود، پیمانکار را از فهرست تأمین‌کنندگان همین شعبه انتخاب کنید.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {subcontracts.map((s) => (
            <SubcontractCard key={s.id} subcontract={s} {...props} />
          ))}
        </ul>
      )}
      {canAct ? (
        <div className="space-y-2 rounded-lg border border-dashed p-3">
          <p className="text-sm font-medium">سپردن مرحله به پیمانکار</p>
          {suppliers.length === 0 ? (
            <p className="text-sm text-muted-foreground">این شعبه تأمین‌کنندهٔ فعالی ندارد؛ ابتدا پیمانکار را در فهرست تأمین‌کنندگان ثبت کنید.</p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-56 flex-1">
                <SearchableSelect ariaLabel="پیمانکار" placeholder="پیمانکار…" value={supplierId} onChange={setSupplierId}
                  options={suppliers.map((sp) => ({ value: sp.id, label: sp.name }))} />
              </div>
              <div className="min-w-36">
                <SearchableSelect ariaLabel="مرحلهٔ سپرده‌شده" value={stage} onChange={setStage}
                  options={stages.map((st) => ({ value: st.code, label: st.label }))} />
              </div>
              <Input aria-label={`اجرت هر عدد پذیرفته‌شده (${money.unitLabel})`} placeholder={`اجرت هر عدد (${money.unitLabel})`}
                inputMode="numeric" className="max-w-44" value={rate} onChange={(e) => setRate(e.target.value)} />
              <Button variant="outline" disabled={busy} onClick={create}>ثبت پیمانکار</Button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function SubcontractCard({ subcontract: s, stages, materials, canAct, canApprove, busy, onAct, onError }: Props & { subcontract: Subcontract }) {
  const money = useMoney();
  const [sendQty, setSendQty] = useState("");
  const [sendMaterial, setSendMaterial] = useState("");
  const [sendMaterialQty, setSendMaterialQty] = useState("");
  const [accepted, setAccepted] = useState("");
  const [rework, setRework] = useState("");
  const [scrapped, setScrapped] = useState("");
  const [shortage, setShortage] = useState("");
  const [returnMaterial, setReturnMaterial] = useState("");
  const [returnQty, setReturnQty] = useState("");
  const [note, setNote] = useState("");
  const [chargeback, setChargeback] = useState("");
  const [declareLost, setDeclareLost] = useState(false);
  const stageLabel = stages.find((st) => st.code === s.stageCode)?.label ?? s.stageCode;
  const working = s.status === "approved" || s.status === "disputed";
  const can = canAct && (s.status === "draft" || working);
  const custodyHeld = s.custody.filter((c) => Number(c.heldQuantity) > 0);
  const id = s.id;

  function parseChargeback(): number | null | undefined {
    if (!chargeback.trim()) return null;
    try { return money.parse(chargeback); } catch { onError("مبلغ کسر خسارت معتبر نیست."); return undefined; }
  }

  async function send() {
    const quantity = optionalQuantity(sendQty);
    const materialQty = optionalQuantity(sendMaterialQty);
    if (quantity === undefined || materialQty === undefined || (!quantity && !(sendMaterial && materialQty))) {
      onError("تعداد قطعه یا مقدار ماده را درست وارد کنید."); return;
    }
    const body: Record<string, unknown> = { action: "subcontract_send", subcontractId: id, quantity };
    if (sendMaterial && materialQty) body.materials = [{ materialItemId: sendMaterial, quantity: materialQty }];
    if (await onAct(body)) { setSendQty(""); setSendMaterialQty(""); }
  }

  async function receive() {
    const parts = [accepted, rework, scrapped, shortage].map(optionalQuantity);
    if (parts.some((p) => p === undefined) || parts.every((p) => p === null)) { onError("دست‌کم یک تعداد معتبر وارد کنید."); return; }
    const [a, r, sc, sh] = parts;
    if (await onAct({ action: "subcontract_receive", subcontractId: id, accepted: a, rework: r, scrapped: sc, shortage: sh })) {
      setAccepted(""); setRework(""); setScrapped(""); setShortage("");
    }
  }

  async function returnMaterials() {
    const quantity = optionalQuantity(returnQty);
    if (!returnMaterial || !quantity) { onError("ماده و مقدار برگشتی را وارد کنید."); return; }
    if (await onAct({ action: "subcontract_return_materials", subcontractId: id, lines: [{ materialItemId: returnMaterial, quantity }] })) setReturnQty("");
  }

  return (
    <li className="space-y-3 rounded-lg border p-3" aria-label={`قرارداد ${s.reference}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{s.supplierName}</span>
          <span className="text-sm text-muted-foreground">{stageLabel} · {s.reference}</span>
          <StatusBadge tone={STATUS_TONE[s.status]}>{SUBCONTRACT_STATUS_LABELS[s.status]}</StatusBadge>
        </div>
        <span className="text-sm text-muted-foreground">اجرت هر عدد {money.formatText(String(s.ratePerUnitRial))}</span>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4" aria-label={`وضعیت قطعه‌های ${s.reference}`}>
        <div><dt className="text-muted-foreground">ارسال‌شده</dt><dd>{fa(s.sentQuantity)}</dd></div>
        <div><dt className="text-muted-foreground">نزد پیمانکار</dt><dd className="font-semibold">{fa(s.heldQuantity)}</dd></div>
        <div><dt className="text-muted-foreground">پذیرفته</dt><dd>{fa(s.acceptedQuantity)}</dd></div>
        <div><dt className="text-muted-foreground">دوباره‌کاری / ضایع / کسری</dt><dd>{fa(s.reworkQuantity)} / {fa(s.scrappedQuantity)} / {fa(s.shortageQuantity)}</dd></div>
        <div><dt className="text-muted-foreground">بستانکاری پیمانکار</dt><dd>{money.formatText(String(s.accruedRial))}</dd></div>
        <div><dt className="text-muted-foreground">کسر خسارت</dt><dd>{money.formatText(String(s.chargebackRial))}</dd></div>
        {s.approvedByName ? <div><dt className="text-muted-foreground">تأییدکننده</dt><dd>{s.approvedByName}</dd></div> : null}
      </dl>

      {s.custody.length > 0 ? (
        <ul className="space-y-1 text-sm" aria-label={`مواد نزد ${s.supplierName}`}>
          {s.custody.map((c) => (
            <li key={c.materialItemId}>
              {c.name}: ارسال {fa(c.sentQuantity)}، مصرف {fa(c.consumedQuantity)}، برگشت {fa(c.returnedQuantity)}، مفقود {fa(c.lostQuantity)}،
              <span className="font-medium"> نزد پیمانکار {fa(c.heldQuantity)} {c.unit ?? ""}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {s.status === "disputed" && s.disputeNote ? <p className="text-sm text-muted-foreground">اختلاف: {s.disputeNote}</p> : null}

      {can && s.status === "draft" ? (
        <div className="flex flex-wrap items-end gap-2">
          {canApprove
            ? <Button size="sm" disabled={busy} onClick={() => onAct({ action: "subcontract_approve", subcontractId: id })}>تأیید قرارداد</Button>
            : <span className="text-sm text-muted-foreground">تأیید قرارداد به دسترسی «تأیید سند حسابداری» نیاز دارد.</span>}
          <Input aria-label={`دلیل لغو ${s.reference}`} placeholder="دلیل لغو" className="max-w-xs" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      ) : null}

      {can && s.status === "approved" ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">ارسال به پیمانکار</legend>
          <div className="flex flex-wrap items-end gap-2">
            <Input aria-label={`تعداد قطعه برای ارسال به ${s.supplierName}`} placeholder="تعداد قطعه" inputMode="decimal" className="max-w-28"
              value={sendQty} onChange={(e) => setSendQty(e.target.value)} />
            <div className="min-w-44">
              <SearchableSelect ariaLabel="مادهٔ ارسالی" placeholder="ماده (اختیاری)…" value={sendMaterial} onChange={setSendMaterial}
                options={materials.map((m) => ({ value: m.materialItemId, label: m.name }))} />
            </div>
            <Input aria-label="مقدار مادهٔ ارسالی" placeholder="مقدار ماده" inputMode="decimal" className="max-w-28"
              value={sendMaterialQty} onChange={(e) => setSendMaterialQty(e.target.value)} />
            <Button size="sm" disabled={busy} onClick={send}>ارسال</Button>
          </div>
        </fieldset>
      ) : null}

      {can && working && Number(s.heldQuantity) > 0 ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">تحویل و بازرسی</legend>
          <div className="flex flex-wrap items-end gap-2">
            <Input aria-label="پذیرفته" placeholder="پذیرفته" inputMode="decimal" className="max-w-24" value={accepted} onChange={(e) => setAccepted(e.target.value)} />
            <Input aria-label="برگشت برای دوباره‌کاری" placeholder="دوباره‌کاری" inputMode="decimal" className="max-w-24" value={rework} onChange={(e) => setRework(e.target.value)} />
            <Input aria-label="ضایع" placeholder="ضایع" inputMode="decimal" className="max-w-24" value={scrapped} onChange={(e) => setScrapped(e.target.value)} />
            <Input aria-label="کسری (تحویل‌نشده)" placeholder="کسری" inputMode="decimal" className="max-w-24" value={shortage} onChange={(e) => setShortage(e.target.value)} />
            <Button size="sm" disabled={busy} onClick={receive}>ثبت تحویل</Button>
          </div>
          <p className="text-xs text-muted-foreground">قطعهٔ پذیرفته به مرحلهٔ بعد می‌رود و اجرتش به حساب پیمانکار بستانکار می‌شود؛ ضایع و کسری اجرتی ندارند.</p>
        </fieldset>
      ) : null}

      {can && working && custodyHeld.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">برگشت مواد از پیمانکار</legend>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-44">
              <SearchableSelect ariaLabel="مادهٔ برگشتی" placeholder="ماده…" value={returnMaterial} onChange={setReturnMaterial}
                options={custodyHeld.map((c) => ({ value: c.materialItemId, label: `${c.name} (${fa(c.heldQuantity)})` }))} />
            </div>
            <Input aria-label="مقدار برگشتی" placeholder="مقدار" inputMode="decimal" className="max-w-28" value={returnQty} onChange={(e) => setReturnQty(e.target.value)} />
            <Button size="sm" variant="outline" disabled={busy} onClick={returnMaterials}>برگشت به انبار</Button>
          </div>
        </fieldset>
      ) : null}

      {can && working ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{s.status === "disputed" ? "حل اختلاف" : "اختلاف، بستن یا لغو"}</legend>
          <div className="flex flex-wrap items-end gap-2">
            <Input aria-label={`یادداشت برای ${s.reference}`} placeholder="یادداشت / دلیل" className="max-w-xs" value={note} onChange={(e) => setNote(e.target.value)} />
            <Input aria-label={`کسر خسارت (${money.unitLabel})`} placeholder={`کسر خسارت (${money.unitLabel})`} inputMode="numeric" className="max-w-40"
              value={chargeback} onChange={(e) => setChargeback(e.target.value)} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {s.status === "disputed" ? (
              <Button size="sm" disabled={busy || note.trim().length < 3} onClick={async () => {
                const amount = parseChargeback();
                if (amount === undefined) return;
                if (await onAct({ action: "subcontract_resolve", subcontractId: id, note: note.trim(), chargebackRial: amount })) { setNote(""); setChargeback(""); }
              }}>حل اختلاف</Button>
            ) : (
              <>
                <Button size="sm" variant="outline" disabled={busy || note.trim().length < 3}
                  onClick={async () => { if (await onAct({ action: "subcontract_dispute", subcontractId: id, note: note.trim() })) setNote(""); }}>ثبت اختلاف</Button>
                <div className="flex items-center gap-1.5">
                  <Checkbox id={`lost-${id}`} checked={declareLost} onCheckedChange={(v) => setDeclareLost(v === true)} />
                  <Label htmlFor={`lost-${id}`} className="text-sm font-normal">مواد ماندهٔ نزد پیمانکار مفقود اعلام شود</Label>
                </div>
                <Button size="sm" disabled={busy} onClick={async () => {
                  const amount = parseChargeback();
                  if (amount === undefined) return;
                  await onAct({ action: "subcontract_close", subcontractId: id, declareRemainingLost: declareLost, chargebackRial: amount });
                }}>بستن قرارداد</Button>
              </>
            )}
          </div>
        </fieldset>
      ) : null}

      {can && (s.status === "draft" || s.status === "approved") ? (
        <div className="flex flex-wrap items-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy || note.trim().length < 3}
            onClick={() => onAct({ action: "subcontract_cancel", subcontractId: id, reason: note.trim() })}>لغو قرارداد (با دلیل در یادداشت)</Button>
        </div>
      ) : null}
    </li>
  );
}
