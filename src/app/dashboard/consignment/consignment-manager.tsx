"use client";

/**
 * GH #1567 Phase 6D — «کالای امانی»: goods a fashion shop holds and sells for
 * their owner under a contract. The owner keeps title until the sale; at the
 * till the shop posts only its own commission (4700) and owes the owner's share
 * (2110), with no COGS. Receipts and returns to the owner move quantity only.
 *
 * The page creates contracts (owner-price or commission terms per variant),
 * receives and hands back goods, pays the owner down to the outstanding
 * payable, and closes a contract once nothing of it is left on the shelf.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { HandshakeIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useMoney } from "@/components/money/money-context";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { allowedActions, type ContractStatus, type ConsignmentTerms } from "@/lib/fashion-consignment";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "../data-table";
import { IndustryManagerShell } from "../industry-manager-shell";
import { JalaliDatePicker } from "../jalali-date-picker";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "../page-chrome";
import { api, ErrorBox, InfoBox } from "../ui";

export interface ContractLine {
  id: string; itemId: string; name: string; sku: string | null; attributes: string; terms: ConsignmentTerms;
  ownerUnitPriceRial: number | null; commissionBp: number | null; retailPriceRial: number | null;
  received: number; sold: number; customerReturned: number; voided: number; returnedToOwner: number; onHand: number;
  shareSoldRial: number; shareReturnedRial: number; shareVoidedRial: number; commissionRial: number;
}

export interface Contract {
  id: string; reference: string; consignorId: string; consignorName: string; startsOn: string; expiresOn: string | null;
  notes: string | null; status: ContractStatus; version: number; settledRial: number; outstandingRial: number; onHand: number;
  lines: ContractLine[];
}

interface Movement {
  id: string; kind: string; itemName: string | null; quantity: number | null; ownerShareRial: number | null;
  commissionRial: number | null; amountRial: number | null; note: string | null; actorName: string | null; at: string;
}

interface Consignor { id: string; name: string; phone: string | null }
interface Style { id: string; name: string; sku: string | null }
interface Cell { itemId: string; name: string; sku: string | null; attributes: Record<string, string>; onHand: string; unitPriceRial: number | null }

type ApiError = { error?: string; message?: string };

const STATUS: Record<ContractStatus, { label: string; tone: "positive" | "active" | "neutral" }> = {
  open: { label: "باز", tone: "positive" },
  expired: { label: "منقضی", tone: "active" },
  closed: { label: "بسته", tone: "neutral" },
};

const MOVEMENT: Record<string, string> = {
  receive: "دریافت از امانت‌گذار",
  sale: "فروش",
  customer_return: "برگشت از مشتری",
  void: "ابطال فروش",
  return_to_owner: "برگشت به امانت‌گذار",
  settlement: "تسویه با امانت‌گذار",
  close: "بستن قرارداد",
};

const fa = (value: string | number) => toPersianDigits(String(value));
const failure = (data: ApiError) => data.message ?? "درخواست انجام نشد؛ دوباره تلاش کنید.";
const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

/** Whole, non-negative integers only (Persian or Latin digits); null when invalid. */
export function parseWhole(raw: string, max = 100_000): number | null {
  const text = toLatinDigits(raw).trim();
  if (!/^\d{1,9}$/.test(text)) return null;
  const n = Number(text);
  return n <= max ? n : null;
}

/** A commission percentage such as «۲۵» or «12.5» → basis points; null when out of 0–100. */
export function percentToBp(raw: string): number | null {
  const text = toLatinDigits(raw).trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null;
  const bp = Math.round(Number(text) * 100);
  return bp <= 10_000 ? bp : null;
}

type Tab = "contracts" | "owners";

export function ConsignmentManager({ canEdit, canSettle }: { canEdit: boolean; canSettle: boolean }) {
  const tabs = useMemo(() => [
    { key: "contracts" as const, label: "قراردادها" },
    { key: "owners" as const, label: "امانت‌گذاران" },
  ], []);
  const [tab, setTab] = useState<Tab>("contracts");
  return (
    <IndustryManagerShell idPrefix="consignment" navLabel="بخش‌های کالای امانی" tabs={tabs} activeTab={tab} onTabChange={setTab} error="">
      {tab === "contracts" ? <ContractsSection canEdit={canEdit} canSettle={canSettle} /> : <OwnersSection canEdit={canEdit} />}
    </IndustryManagerShell>
  );
}

function ContractsSection({ canEdit, canSettle }: { canEdit: boolean; canSettle: boolean }) {
  const money = useMoney();
  const [contracts, setContracts] = useState<Contract[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await api<{ contracts?: Contract[] } & ApiError>("/api/consignment-contracts");
    if (!res.ok) setError(failure(res.data));
    setContracts(res.data.contracts ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <SectionCard
      title="قراردادهای امانی"
      description="کالای امانی تا لحظهٔ فروش مال امانت‌گذار است: در فروش، سهم او بدهی فروشگاه (۲۱۱۰) و فقط کارمزد فروشگاه درآمد (۴۷۰۰) ثبت می‌شود و بهای تمام‌شده‌ای ندارد."
      actions={canEdit ? <Button onClick={() => setCreating(true)}><PlusIcon aria-hidden="true" className="size-4" />قرارداد تازه</Button> : null}
    >
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {contracts === null ? <SectionCardSkeleton /> : contracts.length === 0 ? (
        <EmptyState title="قرارداد امانی‌ای نیست" icon={HandshakeIcon}>برای فروش کالای تولیدی یا طراح دیگری با کارمزد، یک قرارداد بسازید.</EmptyState>
      ) : (
        <DataTable caption="قراردادهای امانی">
          <DataTableHead><Th>شماره</Th><Th>امانت‌گذار</Th><Th>مهلت</Th><Th>موجودی امانی</Th><Th>بدهی به امانت‌گذار</Th><Th>وضعیت</Th><Th>جزئیات</Th></DataTableHead>
          <DataTableBody>
            {contracts.map((c) => (
              <DataTableRow key={c.id}>
                <Td>{fa(c.reference)}</Td>
                <Td>{c.consignorName}</Td>
                <Td>{c.expiresOn ? formatJalali(`${c.expiresOn}T12:00:00Z`) : "بدون مهلت"}</Td>
                <Td>{fa(c.onHand)}</Td>
                <Td>{money.format(c.outstandingRial)}</Td>
                <Td><StatusBadge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</StatusBadge></Td>
                <Td><Button size="sm" variant="outline" onClick={() => setOpenId(c.id)} aria-label={`مشاهده جزئیات قرارداد ${c.reference}`}>مشاهده</Button></Td>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
      <Sheet open={creating} onOpenChange={setCreating}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle>قرارداد امانی تازه</SheetTitle>
            <SheetDescription>برای هر تنوع یکی از دو شرط را بگذارید: قیمت توافقی امانت‌گذار، یا درصد کارمزد فروشگاه.</SheetDescription>
          </SheetHeader>
          {creating ? <ContractForm onSaved={() => { setCreating(false); void load(); }} /> : null}
        </SheetContent>
      </Sheet>
      <Sheet open={openId !== null} onOpenChange={(open) => { if (!open) setOpenId(null); }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-4xl">
          <SheetHeader>
            <SheetTitle>جزئیات قرارداد امانی</SheetTitle>
            <SheetDescription>دریافت و برگشت کالا فقط تعداد را جابه‌جا می‌کند؛ تسویه از صندوق یا بانک بدهی ۲۱۱۰ را کم می‌کند.</SheetDescription>
          </SheetHeader>
          {openId ? <ContractDetail id={openId} canEdit={canEdit} canSettle={canSettle} onChanged={() => void load()} /> : null}
        </SheetContent>
      </Sheet>
    </SectionCard>
  );
}

interface DraftLine {
  itemId: string; label: string; terms: ConsignmentTerms; ownerPrice: string; commission: string; retailPrice: string;
}

export function ContractForm({ onSaved }: { onSaved: () => void }) {
  const money = useMoney();
  const [reference, setReference] = useState("");
  const [consignorId, setConsignorId] = useState("");
  const [consignors, setConsignors] = useState<Consignor[] | null>(null);
  const [startsOn, setStartsOn] = useState(new Date().toISOString().slice(0, 10));
  const [expiresOn, setExpiresOn] = useState("");
  const [notes, setNotes] = useState("");
  const [styles, setStyles] = useState<Style[] | null>(null);
  const [styleId, setStyleId] = useState("");
  const [cells, setCells] = useState<Cell[] | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<{ consignors?: Consignor[] }>("/api/consignment-contracts/consignors").then((res) => setConsignors(res.data.consignors ?? []));
    void api<{ styles?: Style[] }>("/api/size-packs/matrix").then((res) => setStyles(res.data.styles ?? []));
  }, []);
  useEffect(() => {
    if (!styleId) { setCells(null); return; }
    void api<{ cells?: Cell[] } & ApiError>(`/api/size-packs/matrix?styleId=${styleId}`).then((res) => {
      if (!res.ok) { setError(failure(res.data)); return; }
      setCells(res.data.cells ?? []);
    });
  }, [styleId]);

  function addCell(cell: Cell) {
    if (lines.some((l) => l.itemId === cell.itemId)) return;
    const attrs = Object.values(cell.attributes).join(" / ");
    setLines((list) => [...list, {
      itemId: cell.itemId, label: attrs ? `${cell.name} (${attrs})` : cell.name, terms: "commission",
      ownerPrice: "", commission: "", retailPrice: cell.unitPriceRial ? money.formatText(String(cell.unitPriceRial), { withUnit: false }) : "",
    }]);
  }

  function update(itemId: string, patch: Partial<DraftLine>) {
    setLines((list) => list.map((l) => (l.itemId === itemId ? { ...l, ...patch } : l)));
  }

  function rial(raw: string): number | null {
    if (!raw.trim()) return null;
    try { return money.parse(raw); } catch { return Number.NaN; }
  }

  async function save() {
    setError("");
    if (!reference.trim() || !consignorId || lines.length === 0) { setError("شمارهٔ قرارداد، امانت‌گذار و دست‌کم یک تنوع لازم است."); return; }
    const payload = [];
    for (const l of lines) {
      const ownerUnitPriceRial = l.terms === "owner_price" ? rial(l.ownerPrice) : null;
      const commissionBp = l.terms === "commission" ? percentToBp(l.commission) : null;
      const retailPriceRial = rial(l.retailPrice);
      if (l.terms === "owner_price" && (ownerUnitPriceRial === null || Number.isNaN(ownerUnitPriceRial))) { setError(`قیمت توافقی «${l.label}» را وارد کنید.`); return; }
      if (l.terms === "commission" && commissionBp === null) { setError(`درصد کارمزد «${l.label}» باید بین ۰ تا ۱۰۰ باشد.`); return; }
      if (Number.isNaN(retailPriceRial)) { setError(`قیمت فروش «${l.label}» معتبر نیست.`); return; }
      payload.push({ itemId: l.itemId, terms: l.terms, ownerUnitPriceRial, commissionBp, retailPriceRial });
    }
    setBusy(true);
    const res = await api<ApiError>("/api/consignment-contracts", {
      method: "POST",
      body: JSON.stringify({ reference: reference.trim(), consignorId, startsOn, expiresOn: expiresOn || null, notes: notes.trim() || null, lines: payload }),
    });
    setBusy(false);
    if (!res.ok) { setError(failure(res.data)); return; }
    onSaved();
  }

  return (
    <div className="space-y-5 px-4 pb-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="consignment-reference">شمارهٔ قرارداد</Label>
          <Input id="consignment-reference" value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>امانت‌گذار</Label>
          <SearchableSelect ariaLabel="امانت‌گذار" value={consignorId} onChange={setConsignorId} loading={consignors === null}
            options={(consignors ?? []).map((c) => ({ value: c.id, label: c.phone ? `${c.name} (${fa(c.phone)})` : c.name }))} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="consignment-starts">تاریخ شروع</Label>
          <JalaliDatePicker id="consignment-starts" value={startsOn} onChange={setStartsOn} clearable={false} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="consignment-expires">پایان مهلت (اختیاری)</Label>
          <JalaliDatePicker id="consignment-expires" value={expiresOn} onChange={setExpiresOn} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="consignment-notes">یادداشت (اختیاری)</Label>
        <Input id="consignment-notes" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <section aria-labelledby="consignment-pick" className="space-y-3">
        <h3 id="consignment-pick" className="font-medium">افزودن تنوع‌ها</h3>
        <SearchableSelect ariaLabel="مدل" value={styleId} onChange={setStyleId} loading={styles === null}
          options={(styles ?? []).map((s) => ({ value: s.id, label: s.sku ? `${s.name} (${s.sku})` : s.name }))} />
        {styleId && !cells ? <SectionCardSkeleton rows={2} /> : null}
        {cells ? (
          cells.length === 0 ? <InfoBox>این مدل تنوع قابل فروشی ندارد.</InfoBox> : (
            <div className="flex flex-wrap gap-2">
              {cells.map((cell) => {
                const label = Object.values(cell.attributes).join(" / ") || cell.name;
                const owned = Number(cell.onHand) > 0;
                return (
                  <Button key={cell.itemId} size="sm" variant="outline" disabled={owned || lines.some((l) => l.itemId === cell.itemId)}
                    title={owned ? "این تنوع موجودی متعلق به فروشگاه دارد" : undefined} onClick={() => addCell(cell)}>
                    <PlusIcon aria-hidden="true" className="size-3.5" />{label}
                  </Button>
                );
              })}
            </div>
          )
        ) : null}
        <p className="text-xs text-muted-foreground">تنوعی که موجودی متعلق به فروشگاه دارد امانی نمی‌شود تا دو نوع کالا در یک ردیف انبار مخلوط نشوند.</p>
      </section>

      <section aria-labelledby="consignment-lines" className="space-y-2">
        <h3 id="consignment-lines" className="font-medium">شرایط هر تنوع</h3>
        {lines.length === 0 ? <InfoBox>هنوز تنوعی اضافه نشده است.</InfoBox> : (
          <DataTable caption="شرایط تنوع‌های قرارداد">
            <DataTableHead><Th>تنوع</Th><Th>شرط</Th><Th>قیمت توافقی / درصد کارمزد</Th><Th>قیمت فروش ({money.unitLabel})</Th><Th>حذف</Th></DataTableHead>
            <DataTableBody>
              {lines.map((l) => (
                <DataTableRow key={l.itemId}>
                  <Td>{l.label}</Td>
                  <Td>
                    <SearchableSelect ariaLabel={`شرط ${l.label}`} value={l.terms} onChange={(v) => update(l.itemId, { terms: v as ConsignmentTerms })}
                      options={[{ value: "commission", label: "درصد کارمزد" }, { value: "owner_price", label: "قیمت توافقی امانت‌گذار" }]} />
                  </Td>
                  <Td>
                    {l.terms === "owner_price" ? (
                      <Input aria-label={`قیمت توافقی ${l.label}`} inputMode="numeric" className="w-32" value={l.ownerPrice}
                        onChange={(e) => update(l.itemId, { ownerPrice: e.target.value })} />
                    ) : (
                      <Input aria-label={`درصد کارمزد ${l.label}`} inputMode="decimal" className="w-20" value={l.commission}
                        onChange={(e) => update(l.itemId, { commission: e.target.value })} />
                    )}
                  </Td>
                  <Td>
                    <Input aria-label={`قیمت فروش ${l.label}`} inputMode="numeric" className="w-32" value={l.retailPrice}
                      onChange={(e) => update(l.itemId, { retailPrice: e.target.value })} />
                  </Td>
                  <Td>
                    <Button variant="ghost" size="icon" aria-label={`حذف ${l.label}`} onClick={() => setLines((list) => list.filter((x) => x.itemId !== l.itemId))}>
                      <Trash2Icon aria-hidden="true" className="size-4" />
                    </Button>
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </section>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <Button onClick={save} disabled={busy}>ثبت قرارداد</Button>
    </div>
  );
}

export function ContractDetail({ id, canEdit, canSettle, onChanged }: { id: string; canEdit: boolean; canSettle: boolean; onChanged: () => void }) {
  const money = useMoney();
  const [data, setData] = useState<{ contract: Contract; movements: Movement[] } | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "bank">("cash");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{ contract?: Contract; movements?: Movement[] } & ApiError>(`/api/consignment-contracts/${id}`);
    if (!res.ok || !res.data.contract) { setError(failure(res.data)); return; }
    setData({ contract: res.data.contract, movements: res.data.movements ?? [] });
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  if (!data) return error ? <ErrorBox>{error}</ErrorBox> : <SectionCardSkeleton rows={4} />;
  const { contract, movements } = data;
  const allowed = new Set(allowedActions(contract.status));

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const res = await api<ApiError>(`/api/consignment-contracts/${id}`, { method: "POST", body: JSON.stringify(body) });
    setBusy(false);
    if (!res.ok) { setError(failure(res.data)); return false; }
    setQuantities({});
    setAmount("");
    await load();
    onChanged();
    return true;
  }

  function moveLines(): { lineId: string; quantity: number }[] | null {
    const out: { lineId: string; quantity: number }[] = [];
    for (const [lineId, raw] of Object.entries(quantities)) {
      if (!raw.trim()) continue;
      const q = parseWhole(raw);
      if (!q) { setError("تعداد باید عدد صحیح مثبت باشد."); return null; }
      out.push({ lineId, quantity: q });
    }
    if (out.length === 0) { setError("دست‌کم برای یک ردیف تعداد وارد کنید."); return null; }
    return out;
  }

  function move(action: "receive" | "return_to_owner") {
    const lines = moveLines();
    if (lines) void act({ action, idempotencyKey: newKey(), expectedVersion: contract.version, note: null, lines });
  }

  function settle() {
    let value: number;
    try { value = money.parse(amount); } catch { setError("مبلغ معتبر نیست."); return; }
    if (!(value > 0)) { setError("مبلغ معتبر نیست."); return; }
    void act({ action: "settle", idempotencyKey: newKey(), amountRial: value, method, note: null });
  }

  const canMove = canEdit && (allowed.has("receive") || allowed.has("return_to_owner"));

  return (
    <div className="space-y-5 px-4 pb-6">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4" aria-label="خلاصهٔ قرارداد">
        <div><dt className="text-muted-foreground">قرارداد</dt><dd className="font-semibold">{fa(contract.reference)} — {contract.consignorName}</dd></div>
        <div><dt className="text-muted-foreground">وضعیت</dt><dd><StatusBadge tone={STATUS[contract.status].tone}>{STATUS[contract.status].label}</StatusBadge></dd></div>
        <div><dt className="text-muted-foreground">موجودی امانی</dt><dd className="font-semibold">{fa(contract.onHand)}</dd></div>
        <div><dt className="text-muted-foreground">بدهی به امانت‌گذار</dt><dd className="font-semibold">{money.format(contract.outstandingRial)}</dd></div>
      </dl>
      {contract.status === "expired" ? <InfoBox>مهلت قرارداد تمام شده است: فروش و دریافت تازه ممکن نیست؛ کالای مانده را برگردانید و تسویه کنید.</InfoBox> : null}

      <DataTable caption="ردیف‌های قرارداد">
        <DataTableHead>
          <Th>تنوع</Th><Th>شرط</Th><Th>دریافتی</Th><Th>فروش خالص</Th><Th>برگشت به امانت‌گذار</Th><Th>موجودی</Th><Th>سهم امانت‌گذار</Th><Th>کارمزد</Th>
          {canMove ? <Th>تعداد</Th> : null}
        </DataTableHead>
        <DataTableBody>
          {contract.lines.map((l) => {
            const label = l.attributes ? `${l.name} (${l.attributes})` : l.name;
            return (
              <DataTableRow key={l.id}>
                <Td>{label}</Td>
                <Td>{l.terms === "owner_price" ? `قیمت توافقی ${money.format(l.ownerUnitPriceRial ?? 0)}` : `کارمزد ${fa((l.commissionBp ?? 0) / 100)}٪`}</Td>
                <Td>{fa(l.received)}</Td>
                <Td>{fa(l.sold - l.customerReturned - l.voided)}</Td>
                <Td>{fa(l.returnedToOwner)}</Td>
                <Td>{fa(l.onHand)}</Td>
                <Td>{money.format(l.shareSoldRial - l.shareReturnedRial - l.shareVoidedRial)}</Td>
                <Td>{money.format(l.commissionRial)}</Td>
                {canMove ? (
                  <Td>
                    <Input aria-label={`تعداد ${label}`} inputMode="numeric" className="w-20" value={quantities[l.id] ?? ""}
                      onChange={(e) => setQuantities((q) => ({ ...q, [l.id]: e.target.value }))} />
                  </Td>
                ) : null}
              </DataTableRow>
            );
          })}
        </DataTableBody>
      </DataTable>

      {canMove ? (
        <div className="flex flex-wrap gap-2">
          {allowed.has("receive") ? <Button disabled={busy} onClick={() => move("receive")}>دریافت از امانت‌گذار</Button> : null}
          {allowed.has("return_to_owner") ? <Button variant="outline" disabled={busy} onClick={() => move("return_to_owner")}>برگشت به امانت‌گذار</Button> : null}
          {allowed.has("close") ? (
            <Button variant="ghost" disabled={busy || contract.onHand > 0} title={contract.onHand > 0 ? "پیش از بستن، کالای مانده را برگردانید" : undefined}
              onClick={() => void act({ action: "close", expectedVersion: contract.version })}>بستن قرارداد</Button>
          ) : null}
        </div>
      ) : null}

      {canSettle && contract.outstandingRial > 0 ? (
        <section aria-labelledby="consignment-settle" className="space-y-2">
          <h3 id="consignment-settle" className="font-medium">تسویه با امانت‌گذار</h3>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="consignment-amount">مبلغ ({money.unitLabel})</Label>
              <Input id="consignment-amount" inputMode="numeric" className="w-40" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="w-40 space-y-1.5">
              <Label>از</Label>
              <SearchableSelect ariaLabel="روش پرداخت" value={method} onChange={(v) => setMethod(v === "bank" ? "bank" : "cash")}
                options={[{ value: "cash", label: "صندوق" }, { value: "bank", label: "بانک" }]} />
            </div>
            <Button disabled={busy} onClick={settle}>ثبت پرداخت</Button>
          </div>
        </section>
      ) : null}
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <section aria-labelledby="consignment-history" className="space-y-2">
        <h3 id="consignment-history" className="font-medium">گردش قرارداد</h3>
        {movements.length === 0 ? <InfoBox>هنوز گردشی ثبت نشده است.</InfoBox> : (
          <DataTable caption="گردش قرارداد امانی">
            <DataTableHead><Th>زمان</Th><Th>رویداد</Th><Th>تنوع</Th><Th>تعداد</Th><Th>مبلغ</Th><Th>کاربر</Th></DataTableHead>
            <DataTableBody>
              {movements.map((m) => (
                <DataTableRow key={m.id}>
                  <Td>{formatJalali(m.at, { withTime: true })}</Td>
                  <Td>{MOVEMENT[m.kind] ?? m.kind}</Td>
                  <Td>{m.itemName ?? "—"}</Td>
                  <Td>{m.quantity != null ? fa(m.quantity) : "—"}</Td>
                  <Td>{m.amountRial != null ? money.format(m.amountRial) : m.ownerShareRial != null ? `سهم ${money.format(m.ownerShareRial)}` : "—"}</Td>
                  <Td>{m.actorName ?? "—"}</Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </section>
    </div>
  );
}

function OwnersSection({ canEdit }: { canEdit: boolean }) {
  const [owners, setOwners] = useState<Consignor[] | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const res = await api<{ consignors?: Consignor[] } & ApiError>("/api/consignment-contracts/consignors");
    if (!res.ok) setError(failure(res.data));
    setOwners(res.data.consignors ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function add() {
    if (!name.trim()) { setError("نام امانت‌گذار لازم است."); return; }
    setBusy(true);
    setError("");
    const res = await api<ApiError>("/api/consignment-contracts/consignors", {
      method: "POST", body: JSON.stringify({ name: name.trim(), phone: phone.trim() || null, notes: null }),
    });
    setBusy(false);
    if (!res.ok) { setError(failure(res.data)); return; }
    setName("");
    setPhone("");
    void load();
  }

  return (
    <SectionCard title="امانت‌گذاران" description="تولیدی‌ها، طراحان یا اشخاصی که کالایشان را برای فروش به فروشگاه می‌سپارند.">
      {canEdit ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="consignor-name">نام</Label>
            <Input id="consignor-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="consignor-phone">تلفن (اختیاری)</Label>
            <Input id="consignor-phone" dir="ltr" value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <Button disabled={busy} onClick={() => void add()}><PlusIcon aria-hidden="true" className="size-4" />افزودن</Button>
        </div>
      ) : null}
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {owners === null ? <SectionCardSkeleton /> : owners.length === 0 ? (
        <EmptyState title="امانت‌گذاری ثبت نشده" icon={HandshakeIcon}>پیش از ساخت قرارداد، امانت‌گذار را اضافه کنید.</EmptyState>
      ) : (
        <DataTable caption="امانت‌گذاران">
          <DataTableHead><Th>نام</Th><Th>تلفن</Th></DataTableHead>
          <DataTableBody>
            {owners.map((o) => (
              <DataTableRow key={o.id}><Td>{o.name}</Td><Td>{o.phone ? <span dir="ltr">{fa(o.phone)}</span> : "—"}</Td></DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
    </SectionCard>
  );
}
