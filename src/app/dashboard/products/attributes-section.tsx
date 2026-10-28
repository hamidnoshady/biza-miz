"use client";

/**
 * «ویژگی محصول» — branch-scoped attribute definitions. Existing variant rows
 * keep their historical name/value snapshots when a definition changes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  MoreVerticalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { toPersianDigits } from "@/lib/digits";
import {
  ATTRIBUTE_OPTIONS_MAX_COUNT,
  ATTRIBUTE_OPTION_MAX_LENGTH,
  attributeComparisonKey,
  normalizeAttributeText,
  parseAttributeDefinitionInput,
} from "@/lib/product-attributes";
import type { AttributeDefinition } from "@/lib/product-attributes-service";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { cardClass, EmptyState, SectionCardSkeleton } from "../page-chrome";

type View = { mode: "list" } | { mode: "form"; definition: AttributeDefinition | null };
type LoadState = "loading" | "ready" | "error";
type StatusFilter = "all" | "active" | "inactive";

type AttributeResponse = {
  definitions?: AttributeDefinition[];
  definition?: AttributeDefinition;
  error?: string;
  current?: AttributeDefinition;
  usageCount?: number;
};

export function AttributesSection({ canEdit }: { canEdit: boolean }) {
  const [definitions, setDefinitions] = useState<AttributeDefinition[] | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<View>({ mode: "list" });
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<AttributeDefinition | null>(null);
  const [mutating, setMutating] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const loadSequence = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  const mutationLock = useRef(false);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    setLoadState("loading");
    setLoadError("");
    const result = await api<AttributeResponse>("/api/products/attributes", { signal: controller.signal });
    if (result.aborted || sequence !== loadSequence.current) return false;
    loadAbort.current = null;
    if (!result.ok || !Array.isArray(result.data.definitions)) {
      setLoadState("error");
      setLoadError(result.data.error === "forbidden"
        ? "دسترسی مشاهدهٔ ویژگی‌های محصول ندارید."
        : "ویژگی‌های محصول بارگیری نشد؛ اتصال را بررسی و دوباره تلاش کنید.");
      return false;
    }
    setDefinitions(result.data.definitions);
    setLoadState("ready");
    setLoadError("");
    return true;
  }, []);

  useEffect(() => {
    void load();
    return () => {
      loadSequence.current += 1;
      loadAbort.current?.abort();
    };
  }, [load]);

  const visibleDefinitions = useMemo(() => {
    const needle = attributeComparisonKey(search);
    return (definitions ?? []).filter((definition) => {
      if (statusFilter === "active" && !definition.isActive) return false;
      if (statusFilter === "inactive" && definition.isActive) return false;
      return !needle || attributeComparisonKey(definition.name).includes(needle);
    });
  }, [definitions, search, statusFilter]);

  async function remove(definition: AttributeDefinition) {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setMutating(true);
    setError("");
    setNotice("");
    const result = await api<AttributeResponse>(`/api/products/attributes/${definition.id}`, { method: "DELETE" });
    mutationLock.current = false;
    setMutating(false);
    if (!result.ok) {
      if (result.data.error === "in_use") {
        const count = Number(result.data.usageCount ?? definition.usageCount);
        setError(`ویژگی «${definition.name}» در ${toPersianDigits(count)} تنوع استفاده شده است؛ آن را غیرفعال کنید تا مقدارهای ثبت‌شده حفظ شوند.`);
      } else if (result.data.error === "network_error") {
        setError("ارتباط قطع شد؛ وضعیت حذف مشخص نیست. فهرست را تازه‌سازی کنید و دوباره بررسی کنید.");
      } else {
        setError("ویژگی حذف نشد. فهرست را تازه‌سازی کنید و دوباره تلاش کنید.");
      }
      setPendingDelete(null);
      return;
    }
    setPendingDelete(null);
    setNotice(`ویژگی «${definition.name}» حذف شد.`);
    await load();
  }

  if (view.mode === "form") {
    return (
      <AttributeForm
        definition={view.definition}
        onDone={(message) => {
          setView({ mode: "list" });
          setNotice(message);
          setError("");
          void load();
        }}
        onBack={() => setView({ mode: "list" })}
      />
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      {notice ? <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-100">{notice}</p> : null}
      <ErrorBox>{error}</ErrorBox>

      {loadState === "loading" && definitions === null ? <SectionCardSkeleton rows={3} /> : null}

      {loadState === "error" && definitions === null ? (
        <section role="alert" className={`${cardClass} flex flex-wrap items-center justify-between gap-3 p-4`}>
          <p className="text-sm text-destructive">{loadError}</p>
          <Button type="button" variant="outline" onClick={() => void load()}>
            تلاش دوباره
          </Button>
        </section>
      ) : null}

      {definitions !== null ? (
        <div className="min-w-0 space-y-4">
          {loadError ? (
            <section role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
              <p>{loadError}</p>
              <Button type="button" variant="outline" size="sm" disabled={loadState === "loading"} onClick={() => void load()}>
                تلاش دوباره
              </Button>
            </section>
          ) : null}
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div data-tour-id="attributes.filters" className="grid min-w-0 flex-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Field label="جست‌وجوی ویژگی">
                <input className={inputClass} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="مثلاً رنگ" />
              </Field>
              <Field label="وضعیت">
                <select className={inputClass} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                  <option value="all">همه</option>
                  <option value="active">فعال</option>
                  <option value="inactive">غیرفعال</option>
                </select>
              </Field>
            </div>
            <p className="shrink-0 text-xs text-muted-foreground">
              {toPersianDigits(visibleDefinitions.length)} ویژگی
            </p>
          </div>

          {visibleDefinitions.length === 0 ? (
            <EmptyState>
              {definitions.length === 0
                ? "هنوز ویژگی‌ای تعریف نشده است."
                : "ویژگی‌ای با این جست‌وجو و فیلتر پیدا نشد."}
            </EmptyState>
          ) : (
            <div data-tour-id="attributes.cards" className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {visibleDefinitions.map((definition, index) => (
                <section key={definition.id} className={`${cardClass} relative min-w-0 p-4`}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="rounded-lg bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-950 dark:bg-amber-500/20 dark:text-amber-200">
                      {toPersianDigits(index + 1)}
                    </span>
                    {canEdit ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button type="button" variant="ghost" size="sm" className="size-8 p-0" disabled={mutating} aria-label={`منوی ${definition.name}`}>
                            <MoreVerticalIcon aria-hidden="true" className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          <DropdownMenuItem disabled={mutating} onClick={() => setView({ mode: "form", definition })}>
                            <PencilIcon aria-hidden="true" className="size-4" />
                            ویرایش
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={mutating}
                            className="text-rose-600 dark:text-rose-400"
                            onClick={() => setPendingDelete(definition)}
                          >
                            <Trash2Icon aria-hidden="true" className="size-4" />
                            حذف ویژگی
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                  <h3 className="mt-3 break-words font-semibold text-foreground">{definition.name}</h3>
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {definition.options.length > 0 ? definition.options.join("، ") : "مقدار آزاد؛ گزینهٔ ازپیش‌تعریف‌شده ندارد"}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {definition.usageCount > 0
                      ? `استفاده در ${toPersianDigits(definition.usageCount)} تنوع`
                      : "هنوز در تنوعی استفاده نشده است"}
                  </p>
                  {!definition.isActive ? <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">غیرفعال</p> : null}
                </section>
              ))}
              {canEdit ? (
                <button
                  type="button"
                  data-tour-id="attributes.add"
                  onClick={() => setView({ mode: "form", definition: null })}
                  disabled={mutating}
                  className="flex min-h-40 min-w-0 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border text-sm font-medium text-foreground/70 transition-colors hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:border-amber-500/40 dark:hover:bg-amber-500/10 dark:hover:text-amber-300"
                >
                  <PlusIcon aria-hidden="true" className="size-5" />
                  افزودن ویژگی
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open && !mutating) setPendingDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>حذف ویژگی «{pendingDelete?.name ?? ""}»؟</DialogTitle>
            <DialogDescription>
              {pendingDelete && pendingDelete.usageCount > 0
                ? `این ویژگی در ${toPersianDigits(pendingDelete.usageCount)} تنوع استفاده شده است. مقدارهای ثبت‌شده تاریخی باقی می‌مانند؛ برای جلوگیری از استفادهٔ تازه، ویژگی را ویرایش و غیرفعال کنید.`
                : "حذف فقط برای ویژگیِ استفاده‌نشده مجاز است. مقدارهای تاریخیِ تنوع‌ها پس از ثبت، بازنویسی نمی‌شوند."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={mutating}>انصراف</Button>
            </DialogClose>
            {pendingDelete && pendingDelete.usageCount > 0 ? (
              <Button
                type="button"
                onClick={() => {
                  const definition = pendingDelete;
                  setPendingDelete(null);
                  setView({ mode: "form", definition });
                }}
                disabled={mutating}
              >
                ویرایش و غیرفعال‌سازی
              </Button>
            ) : (
              <Button type="button" variant="destructive" disabled={mutating} onClick={() => { if (pendingDelete) void remove(pendingDelete); }}>
                {mutating ? "در حال حذف…" : "حذف ویژگی"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AttributeForm({
  definition,
  onDone,
  onBack,
}: {
  definition: AttributeDefinition | null;
  onDone: (message: string) => void;
  onBack: () => void;
}) {
  const [baseDefinition, setBaseDefinition] = useState(definition);
  const [name, setName] = useState(definition?.name ?? "");
  const [options, setOptions] = useState<string[]>(definition?.options ?? []);
  const [newOption, setNewOption] = useState("");
  const [isActive, setIsActive] = useState(definition?.isActive ?? true);
  const [version, setVersion] = useState(definition?.version ?? 1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issues, setIssues] = useState<{ field: string; message: string }[]>([]);
  const [conflict, setConflict] = useState<AttributeDefinition | null>(null);
  const [savingLock, setSavingLock] = useState(false);

  const dirty = useMemo(() => {
    if (!baseDefinition) return name !== "" || options.length > 0 || !isActive;
    return name !== baseDefinition.name ||
      JSON.stringify(options) !== JSON.stringify(baseDefinition.options) ||
      isActive !== baseDefinition.isActive;
  }, [baseDefinition, isActive, name, options]);

  function back() {
    if (dirty && !window.confirm("تغییرهای ذخیره‌نشده کنار گذاشته می‌شوند. ادامه می‌دهید؟")) return;
    onBack();
  }

  function addOption() {
    const value = normalizeAttributeText(newOption);
    if (!value) return;
    if (options.length >= ATTRIBUTE_OPTIONS_MAX_COUNT) {
      setError(`هر ویژگی حداکثر ${toPersianDigits(ATTRIBUTE_OPTIONS_MAX_COUNT)} مقدار می‌پذیرد.`);
      return;
    }
    if (Array.from(value).length > ATTRIBUTE_OPTION_MAX_LENGTH) {
      setError(`هر مقدار حداکثر ${toPersianDigits(ATTRIBUTE_OPTION_MAX_LENGTH)} نویسه است.`);
      return;
    }
    if (options.some((option) => attributeComparisonKey(option) === attributeComparisonKey(value))) {
      setError(`مقدار «${value}» تکراری است.`);
      return;
    }
    setOptions((current) => [...current, value]);
    setNewOption("");
    setError("");
    setIssues([]);
  }

  function resolveConflict(mode: "reload" | "merge") {
    if (!conflict) return;
    if (mode === "reload") {
      setName(conflict.name);
      setOptions([...conflict.options]);
      setIsActive(conflict.isActive);
    } else {
      const original = baseDefinition;
      setName(original && name !== original.name ? name : conflict.name);
      setOptions(original && JSON.stringify(options) !== JSON.stringify(original.options) ? options : [...conflict.options]);
      setIsActive(original && isActive !== original.isActive ? isActive : conflict.isActive);
    }
    setBaseDefinition(conflict);
    setVersion(conflict.version);
    setConflict(null);
    setError("");
    setIssues([]);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || savingLock) return;
    setSavingLock(true);
    const pending = normalizeAttributeText(newOption);
    const proposedOptions = pending ? [...options, pending] : options;
    const raw = {
      name,
      options: proposedOptions,
      isActive,
      ...(definition ? { version } : {}),
    };
    const parsed = parseAttributeDefinitionInput(raw, definition ? "patch" : "create");
    if (!parsed.ok) {
      setIssues(parsed.issues);
      setError(parsed.issues[0]?.message ?? "اطلاعات ویژگی معتبر نیست.");
      setSavingLock(false);
      return;
    }

    setBusy(true);
    setError("");
    setIssues([]);
    const payload = { ...parsed.data, ...(definition ? { version } : {}) };
    const result = await api<AttributeResponse>(
      definition ? `/api/products/attributes/${definition.id}` : "/api/products/attributes",
      { method: definition ? "PATCH" : "POST", body: JSON.stringify(payload) },
    );
    setBusy(false);
    setSavingLock(false);
    if (!result.ok) {
      if (result.data.error === "validation_failed" && Array.isArray((result.data as { issues?: unknown }).issues)) {
        const serverIssues = (result.data as { issues: { field: string; message: string }[] }).issues;
        setIssues(serverIssues);
        setError(serverIssues[0]?.message ?? "اطلاعات ویژگی معتبر نیست.");
      } else if (result.data.error === "duplicate_name") {
        setIssues([{ field: "name", message: "ویژگی‌ای با نام یکسان یا املای معادل در این شعبه وجود دارد." }]);
        setError("نام ویژگی تکراری است.");
      } else if (result.data.error === "edit_conflict" && result.data.current) {
        setConflict(result.data.current);
      } else if (result.data.error === "network_error") {
        setError("ارتباط قطع شد؛ پیش‌نویس فرم حفظ شده است. دوباره تلاش کنید.");
      } else {
        setError("ذخیره نشد؛ فرم حفظ شده است. وضعیت شعبه و اتصال را بررسی کنید.");
      }
      return;
    }
    const saved = result.data.definition;
    setNewOption("");
    onDone(saved ? `ویژگی «${saved.name}» ذخیره شد.` : "ویژگی ذخیره شد.");
  }

  function fieldIssue(field: string): string | undefined {
    return issues.find((issue) => issue.field === field)?.message;
  }

  return (
    <div className="min-w-0 space-y-4">
      <div aria-live="assertive"><ErrorBox>{error}</ErrorBox></div>
      {conflict ? (
        <section role="alert" className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          <p>این ویژگی هم‌زمان در شعبه ویرایش شده است. نسخهٔ شما هنوز ذخیره نشده است.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => resolveConflict("reload")}>
              نسخهٔ شعبه را بارگذاری کنید
            </Button>
            <Button type="button" size="sm" onClick={() => resolveConflict("merge")}>
              ادغام تغییرهای من با نسخهٔ جدید
            </Button>
          </div>
        </section>
      ) : null}
      <section className={`${cardClass} p-4 sm:p-5`}>
        <div className="flex items-center justify-between gap-2 border-b border-border/80 pb-3">
          <h2 className="font-semibold text-foreground">{definition ? `ویرایش ویژگی «${definition.name}»` : "ویژگی تازه"}</h2>
          <Button type="button" variant="ghost" size="sm" onClick={back} disabled={busy}>بازگشت</Button>
        </div>
        <form onSubmit={submit} className="mt-4 grid min-w-0 gap-4 lg:grid-cols-3">
          <Field label="عنوان ویژگی *">
            <input
              className={inputClass}
              value={name}
              onChange={(event) => { setName(event.target.value); setError(""); }}
              placeholder="رنگ"
              maxLength={100}
              required
              aria-invalid={Boolean(fieldIssue("name"))}
            />
            {fieldIssue("name") ? <p className="mt-1 text-xs text-destructive">{fieldIssue("name")}</p> : null}
          </Field>
          <div className="min-w-0">
            <span className="mb-1 block text-sm font-medium text-foreground">مقادیر مجاز</span>
            <ul className="max-h-56 min-w-0 space-y-1 overflow-y-auto rounded-lg border border-border/80 p-2">
              {options.map((option, index) => (
                <li key={`${index}-${option}`} className="flex min-w-0 items-center gap-1">
                  <input
                    className={`${inputClass} min-w-0 flex-1`}
                    value={option}
                    onChange={(event) => setOptions((current) => current.map((value, position) => position === index ? event.target.value : value))}
                    maxLength={ATTRIBUTE_OPTION_MAX_LENGTH}
                    aria-label={`مقدار ${toPersianDigits(index + 1)}`}
                    aria-invalid={Boolean(fieldIssue(`options.${index}`))}
                  />
                  <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" disabled={busy || index === 0} aria-label={`انتقال مقدار ${toPersianDigits(index + 1)} به بالا`} onClick={() => setOptions((current) => moveOption(current, index, index - 1))}>
                    <ArrowUpIcon aria-hidden="true" className="size-4" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" disabled={busy || index === options.length - 1} aria-label={`انتقال مقدار ${toPersianDigits(index + 1)} به پایین`} onClick={() => setOptions((current) => moveOption(current, index, index + 1))}>
                    <ArrowDownIcon aria-hidden="true" className="size-4" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-rose-600 dark:text-rose-400" disabled={busy} aria-label={`حذف مقدار ${option}`} onClick={() => setOptions((current) => current.filter((_, position) => position !== index))}>
                    <XIcon aria-hidden="true" className="size-4" />
                  </Button>
                  {fieldIssue(`options.${index}`) ? <span className="sr-only">{fieldIssue(`options.${index}`)}</span> : null}
                </li>
              ))}
              {options.length === 0 ? <li className="px-2 py-2 text-xs text-muted-foreground">مقدار ثابتی تعریف نشده؛ در تنوع، مقدار آزاد وارد می‌شود.</li> : null}
            </ul>
            {fieldIssue("options") ? <p className="mt-1 text-xs text-destructive">{fieldIssue("options")}</p> : null}
            {issues.filter((issue) => issue.field.startsWith("options.")).map((issue) => <p key={issue.field} className="mt-1 text-xs text-destructive">{issue.message}</p>)}
          </div>
          <div className="min-w-0 space-y-4">
            <Field label="افزودن مقدار (اختیاری)">
              <input
                className={inputClass}
                value={newOption}
                onChange={(event) => { setNewOption(event.target.value); setError(""); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addOption();
                  }
                }}
                placeholder="عسلی"
                maxLength={ATTRIBUTE_OPTION_MAX_LENGTH}
                aria-describedby="attribute-options-hint"
              />
            </Field>
            <p id="attribute-options-hint" className="-mt-3 text-xs text-muted-foreground">Enter مقدار را اضافه می‌کند؛ اگر متن در کادر بماند، هنگام ذخیره هم ثبت می‌شود.</p>
            <Button type="button" variant="outline" size="sm" className="w-full" onClick={addOption} disabled={busy || options.length >= ATTRIBUTE_OPTIONS_MAX_COUNT}>
              اضافه کردن مقدار
            </Button>
            <div className="flex items-center justify-between gap-2 rounded-xl bg-muted/60 px-3 py-2">
              <span className="text-sm text-foreground">وضعیت ویژگی</span>
              <span className="flex items-center gap-2">
                <span className={`text-xs ${isActive ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>{isActive ? "فعال" : "غیرفعال"}</span>
                <Switch checked={isActive} onCheckedChange={setIsActive} disabled={busy} aria-label="وضعیت ویژگی" />
              </span>
            </div>
          </div>
          <div className="lg:col-span-3">
            <Button type="submit" disabled={busy || savingLock} size="lg" className="px-6 font-semibold">
              {busy ? "در حال ذخیره…" : definition ? "ذخیرهٔ تغییرها" : "ثبت ویژگی"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

function moveOption(options: string[], from: number, to: number): string[] {
  if (to < 0 || to >= options.length || from === to) return options;
  const next = [...options];
  const [value] = next.splice(from, 1);
  next.splice(to, 0, value);
  return next;
}
