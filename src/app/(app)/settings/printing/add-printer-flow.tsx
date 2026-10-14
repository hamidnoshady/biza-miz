"use client";

/**
 * «افزودن چاپگر» — a three-step connection wizard, one question at a time:
 *
 *   ۱. چاپگر کجاست؟  — this Windows computer, or the local network. Those are
 *      the only two hardware connection types the product exposes; USB
 *      printers install in Windows and appear in the first choice.
 *   ۲. انتخاب چاپگر  — Windows: the connector lists the installed queues.
 *      Network: the connector sweeps the local subnets (advanced manual IP
 *      only when discovery comes up empty). Both need the connector, and the
 *      flow installs it with one click when it is missing.
 *   ۳. این چاپگر چه کاری انجام می‌دهد؟ — business-level questions only:
 *      name, purpose, paper, cash drawer, default. A test print happens
 *      before/during save so a wrong pairing is caught here, not at the till.
 *
 * The same dialog edits an existing printer (it opens straight at step 3 with
 * a «تغییر اتصال» escape hatch) and reconnects legacy rows (it opens at step
 * 1). It is reused verbatim by the first-run setup wizard.
 */
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2Icon, MonitorIcon, NetworkIcon, PrinterIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, InfoBox, api, errorMessage, inputClass } from "@/app/dashboard/ui";
import {
  connectorHealth,
  discoverNetworkPrinters,
  kickDrawer,
  listWindowsPrinters,
  probePrinterTarget,
  testPrintDraft,
  type DiscoveredPrinter,
  type WindowsPrinter,
} from "@/lib/printing/client";
import { printerErrorMessage, type PrinterErrorCode } from "@/lib/printing/errors";
import {
  isValidIpv4,
  normalizeStoredConnection,
  printerTargetOf,
  type PrinterPurpose,
  type PrinterTarget,
} from "@/lib/printing/types";
import { PAPERS_FOR_PURPOSE, printerClassFor } from "@/lib/printing/routing";
import { PAPERS, type PaperKey } from "@/lib/print-template";
import type { PrinterRow } from "./use-printing";
import { ConnectorInstallCard, type ConnectorState } from "./connector-status";

/**
 * Check the connector while a dialog step is open. `force` clears the
 * client's short unreachable-backoff so the check fires immediately after
 * the operator clicks «بررسی دوباره» post-install.
 */
function useConnectorGate(active: boolean) {
  const [state, setState] = useState<ConnectorState>("checking");
  const [error, setError] = useState<PrinterErrorCode | null>(null);

  const recheck = useCallback(async () => {
    setState("checking");
    setError(null);
    const result = await connectorHealth({ force: true });
    if (result.ok) {
      setState("ready");
    } else {
      setError(result.error ?? "connector_not_installed");
      setState("down");
    }
  }, []);

  useEffect(() => {
    if (active) void recheck();
  }, [active, recheck]);

  return { state, error, recheck };
}

type Step = "where" | "windows" | "network" | "config";

/** The four things a printer can be for — the same vocabulary the rules use. */
const PURPOSE_CHOICES: { key: PrinterPurpose; title: string; description: string }[] = [
  { key: "receipt", title: "رسید مشتری", description: "چاپ فیش فروش در صندوق" },
  { key: "kitchen", title: "بلیت آشپزخانه", description: "چاپ سفارش برای آشپزخانه" },
  { key: "document", title: "فاکتور (A4/A5)", description: "چاپ فاکتور رسمی روی چاپگر صفحه‌ای ویندوز" },
  { key: "label", title: "برچسب", description: "چاپ برچسب قیمت و بارکد" },
];

const DEFAULT_LABELS: Record<PrinterPurpose, string> = {
  receipt: "چاپگر پیش‌فرض رسید",
  kitchen: "چاپگر پیش‌فرض آشپزخانه",
  document: "چاپگر پیش‌فرض فاکتور",
  label: "چاپگر پیش‌فرض برچسب",
};

interface ConfigDraft {
  name: string;
  kind: PrinterPurpose;
  paper: PaperKey;
  openDrawer: boolean;
  isDefault: boolean;
  isActive: boolean;
}

const EMPTY_CONFIG: ConfigDraft = {
  name: "",
  kind: "receipt",
  paper: "thermal80",
  openDrawer: false,
  isDefault: false,
  isActive: true,
};

/**
 * A printer's purpose and paper as the wizard edits them. Purpose and paper
 * come from the row's own columns (`kind`, `paper`) — not from the
 * `connection` jsonb, which from this migration on carries the hardware
 * target and nothing else.
 */
function configOf(printer: PrinterRow): ConfigDraft {
  const kind: PrinterPurpose = printer.kind;
  const allowed = PAPERS_FOR_PURPOSE[kind];
  const stored = typeof printer.paper === "string" && storedPaper(printer.paper) ? (printer.paper as PaperKey) : null;
  return {
    name: printer.name,
    kind,
    paper: stored && allowed.includes(stored) ? stored : allowed[0],
    openDrawer: printer.supports_drawer === true,
    isDefault: printer.is_default === true,
    isActive: printer.is_active,
  };
}

function storedPaper(value: string): value is PaperKey {
  return value in PAPERS;
}

export function AddPrinterDialog({
  open,
  onOpenChange,
  editing = null,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A saved printer being edited/reconnected; null for a new pairing. */
  editing?: PrinterRow | null;
  onSaved: () => Promise<void> | void;
}) {
  const [step, setStep] = useState<Step>("where");
  const [target, setTarget] = useState<PrinterTarget | null>(null);
  const [config, setConfig] = useState<ConfigDraft>(EMPTY_CONFIG);
  const [error, setError] = useState("");
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "failed"; message?: string }>({ state: "idle" });
  const [saving, setSaving] = useState(false);

  // Legacy rows open at step 1: they must be re-paired, not edited in place.
  const reconnecting = editing ? normalizeStoredConnection(editing.connection).needsReconnect === true : false;

  useEffect(() => {
    if (!open) return;
    setError("");
    setTest({ state: "idle" });
    if (editing && !reconnecting) {
      setTarget(printerTargetOf(editing.connection));
      setConfig(configOf(editing));
      setStep("config");
    } else {
      setTarget(null);
      setConfig(EMPTY_CONFIG);
      setStep("where");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id]);

  function pick(next: PrinterTarget, name: string) {
    setTarget(next);
    setConfig((prev) => ({ ...prev, name: prev.name || name }));
    setTest({ state: "idle" });
    setStep("config");
  }

  async function runTest(): Promise<boolean> {
    if (!target) return false;
    setTest({ state: "testing" });
    const result = await testPrintDraft(target, config.kind, config.paper);
    if (result.ok) {
      setTest({ state: "ok" });
      return true;
    }
    setTest({ state: "failed", message: printerErrorMessage(result.error) });
    return false;
  }

  async function save(skipTest = false) {
    if (!target) return;
    setError("");
    if (!config.name.trim()) {
      setError("نام چاپگر را وارد کنید.");
      return;
    }
    setSaving(true);
    // Tested before or during save: a wrong pairing surfaces here, in the
    // wizard — never for the first time at the counter with a customer.
    let testedOk = test.state === "ok";
    if (!testedOk && !skipTest) {
      testedOk = await runTest();
      if (!testedOk) {
        setSaving(false);
        return;
      }
    }
    const body = JSON.stringify({
      name: config.name.trim(),
      kind: config.kind,
      connection: target,
      paper: config.paper,
      openDrawer: config.openDrawer,
      isDefault: config.isDefault,
      isActive: config.isActive,
    });
    const { ok, data } = editing
      ? await api<{ error?: string }>(`/api/settings/printers/${editing.id}`, { method: "PATCH", body })
      : await api<{ error?: string }>("/api/settings/printers", { method: "POST", body });
    setSaving(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    onOpenChange(false);
    await onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PrinterIcon className="size-5 text-primary" aria-hidden="true" />
            {editing ? (reconnecting ? "اتصال دوبارهٔ چاپگر" : "ویرایش چاپگر") : "افزودن چاپگر"}
          </DialogTitle>
          <DialogDescription>
            {step === "where"
              ? "ابتدا محل چاپگر را انتخاب کنید."
              : step === "config"
                ? "چاپگر انتخاب شد؛ حالا مشخص کنید چه کاری انجام می‌دهد."
                : "چاپگر خود را از فهرست انتخاب کنید."}
          </DialogDescription>
        </DialogHeader>

        <ErrorBox>{error}</ErrorBox>
        {reconnecting && step !== "config" ? (
          <InfoBox>این چاپگر باید دوباره متصل شود؛ اتصال جدید را از ابتدا انتخاب کنید تا تنظیمات آن حفظ شود.</InfoBox>
        ) : null}

        {step === "where" ? <WhereStep onChoose={setStep} /> : null}
        {step === "windows" ? <WindowsStep onPicked={pick} onBack={() => setStep("where")} /> : null}
        {step === "network" ? <NetworkStep onPicked={pick} onBack={() => setStep("where")} /> : null}
        {step === "config" ? (
          <ConfigStep
            config={config}
            onChange={setConfig}
            target={target}
            test={test}
            onTest={() => void runTest()}
            onRetarget={() => setStep("where")}
            editing={editing}
            saving={saving}
            onSave={(skipTest) => void save(skipTest)}
            onError={setError}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/* ───────────────────────── step 1 — where ───────────────────────── */

function WhereStep({ onChoose }: { onChoose: (step: "windows" | "network") => void }) {
  const choices = [
    {
      key: "windows" as const,
      icon: MonitorIcon,
      title: "چاپگر ویندوز",
      description: "روی همین کامپیوتر نصب است (مثل چاپگرهای USB) — پیشنهادی برای چاپگر رسید",
    },
    {
      key: "network" as const,
      icon: NetworkIcon,
      title: "چاپگر شبکه",
      description: "با کابل شبکه یا وای‌فای به شبکه وصل است",
    },
  ];
  return (
    <div className="space-y-3">
      <RadioGroup value="" onValueChange={(value) => onChoose(value as "windows" | "network")}>
        {choices.map((choice) => (
          <label
            key={choice.key}
            htmlFor={`add-printer-${choice.key}`}
            className="flex min-h-20 cursor-pointer items-start gap-3 rounded-xl border border-border/80 bg-card p-4 transition-colors hover:bg-muted"
          >
            <RadioGroupItem id={`add-printer-${choice.key}`} value={choice.key} className="mt-0.5" />
            <choice.icon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-foreground">{choice.title}</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">{choice.description}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
    </div>
  );
}

/* ───────────────────── connector-backed steps ───────────────────── */

function WindowsStep({ onPicked, onBack }: { onPicked: (target: PrinterTarget, name: string) => void; onBack: () => void }) {
  const gate = useConnectorGate(true);
  const [printers, setPrinters] = useState<WindowsPrinter[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    const result = await listWindowsPrinters();
    if (!result.ok) {
      setError(printerErrorMessage(result.error));
      return;
    }
    setPrinters(result.data?.printers ?? []);
  }, []);

  useEffect(() => {
    if (gate.state === "ready") void load();
  }, [gate.state, load]);

  return (
    <div className="space-y-4">
      {gate.state === "checking" ? <LoadingSkeleton rows={3} label="در حال بررسی اتصال این کامپیوتر" /> : null}
      {gate.state === "down" ? <ConnectorInstallCard error={gate.error} onRecheck={() => void gate.recheck()} rechecking={false} /> : null}
      {gate.state === "ready" ? (
        <>
          <InfoBox>این کامپیوتر متصل است ✓</InfoBox>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-foreground">انتخاب چاپگر</h3>
            <ErrorBox>{error}</ErrorBox>
            {printers === null ? (
              <LoadingSkeleton rows={3} label="در حال خواندن چاپگرهای ویندوز" />
            ) : printers.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                چاپگری روی این ویندوز نصب نشده است. چاپگر را ابتدا در «Printers &amp; scanners» ویندوز نصب کنید.
              </p>
            ) : (
              <RadioGroup value="" onValueChange={(name) => {
                const printer = printers.find((p) => p.name === name);
                if (printer) onPicked({ type: "windows", systemName: printer.name }, printer.name);
              }}>
                <ul className="space-y-2">
                  {printers.map((printer) => (
                    <li key={printer.name}>
                      <label
                        htmlFor={`windows-printer-${printer.name}`}
                        className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/80 bg-card p-3 transition-colors hover:bg-muted"
                      >
                        <RadioGroupItem id={`windows-printer-${printer.name}`} value={printer.name} className="mt-0.5" />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-foreground" dir="auto">
                            {printer.name}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {printer.likelyThermal ? "چاپگر حرارتی" : "چاپگر ویندوزی"}
                            {printer.isDefault ? " • پیش‌فرض ویندوز" : ""}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </RadioGroup>
            )}
          </div>
        </>
      ) : null}
      <Button type="button" variant="ghost" size="sm" onClick={onBack}>
        بازگشت
      </Button>
    </div>
  );
}

function NetworkStep({ onPicked, onBack }: { onPicked: (target: PrinterTarget, name: string) => void; onBack: () => void }) {
  const gate = useConnectorGate(true);
  const [printers, setPrinters] = useState<DiscoveredPrinter[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [showManual, setShowManual] = useState(false);

  const scan = useCallback(async () => {
    setScanning(true);
    setError("");
    const result = await discoverNetworkPrinters();
    setScanning(false);
    if (!result.ok) {
      setError(printerErrorMessage(result.error));
      return;
    }
    setPrinters(result.data?.printers ?? []);
  }, []);

  useEffect(() => {
    if (gate.state === "ready" && printers === null && !scanning) void scan();
  }, [gate.state, printers, scanning, scan]);

  return (
    <div className="space-y-4">
      {gate.state === "checking" ? <LoadingSkeleton rows={3} label="در حال بررسی اتصال این کامپیوتر" /> : null}
      {gate.state === "down" ? <ConnectorInstallCard error={gate.error} onRecheck={() => void gate.recheck()} rechecking={false} /> : null}
      {gate.state === "ready" ? (
        <>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-foreground">انتخاب چاپگر</h3>
            <ErrorBox>{error}</ErrorBox>
            {scanning || printers === null ? (
              <LoadingSkeleton rows={3} label="در حال جست‌وجوی چاپگرهای شبکه" />
            ) : printers.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                چاپگری روی شبکه پیدا نشد.
              </p>
            ) : (
              <RadioGroup
                value=""
                onValueChange={(ip) => {
                  const printer = printers.find((p) => p.ip === ip);
                  if (printer) onPicked({ type: "network", ip: printer.ip, port: printer.port }, `چاپگر ${printer.ip}`);
                }}
              >
                <ul className="space-y-2">
                  {printers.map((printer) => (
                    <li key={printer.ip}>
                      <label
                        htmlFor={`network-printer-${printer.ip}`}
                        className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/80 bg-card p-3 transition-colors hover:bg-muted"
                      >
                        <RadioGroupItem id={`network-printer-${printer.ip}`} value={printer.ip} className="mt-0.5" />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-foreground" dir="ltr">
                            {printer.ip}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">چاپگر شبکه • آنلاین</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </RadioGroup>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={() => void scan()} disabled={scanning}>
              <RefreshCwIcon aria-hidden="true" />
              {scanning ? "در حال جست‌وجو…" : "جست‌وجوی دوباره"}
            </Button>
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => setShowManual((prev) => !prev)}>
              چاپگرتان پیدا نشد؟
            </button>
          </div>
          {showManual ? <ManualNetworkForm onPicked={onPicked} /> : null}
        </>
      ) : null}
      <Button type="button" variant="ghost" size="sm" onClick={onBack}>
        بازگشت
      </Button>
    </div>
  );
}

/** Advanced connection — manual entry only appears when discovery fails. */
function ManualNetworkForm({ onPicked }: { onPicked: (target: PrinterTarget, name: string) => void }) {
  const [ip, setIp] = useState("");
  const [port, setPort] = useState("9100");
  const [probing, setProbing] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function testConnection() {
    const address = ip.trim();
    const portNumber = Number(port) || 9100;
    if (!isValidIpv4(address)) {
      setResult({ ok: false, message: "نشانی IP معتبر نیست؛ مانند 192.168.1.50 وارد کنید." });
      return;
    }
    setProbing(true);
    setResult(null);
    const probe = await probePrinterTarget({ type: "network", ip: address, port: portNumber });
    setProbing(false);
    if (probe.ok && probe.data?.reachable) {
      setResult({ ok: true, message: "اتصال برقرار است." });
      return;
    }
    setResult({ ok: false, message: printerErrorMessage("network_unreachable") });
  }

  return (
    <div className="space-y-3 rounded-xl border border-border/80 p-3">
      <h4 className="text-sm font-semibold text-foreground">اتصال پیشرفته</h4>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="نشانی IP">
          <input
            className={inputClass}
            dir="ltr"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder="192.168.1.50"
          />
        </Field>
        <Field label="پورت" hint="پیش‌فرض ۹۱۰۰ است و معمولاً نباید تغییر کند.">
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            grouping={false}
            allowNegative={false}
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => void testConnection()} disabled={probing}>
          <SearchIcon aria-hidden="true" />
          {probing ? "در حال آزمایش…" : "آزمایش اتصال"}
        </Button>
        {result ? (
          <span className={`text-xs ${result.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}>
            {result.message}
          </span>
        ) : null}
      </div>
      {result?.ok ? (
        <Button type="button" size="sm" onClick={() => onPicked({ type: "network", ip: ip.trim(), port: Number(port) || 9100 }, `چاپگر ${ip.trim()}`)}>
          استفاده از این چاپگر
        </Button>
      ) : null}
    </div>
  );
}

/* ───────────────────────── step 3 — config ───────────────────────── */

function ConfigStep({
  config,
  onChange,
  target,
  test,
  onTest,
  onRetarget,
  editing,
  saving,
  onSave,
  onError,
}: {
  config: ConfigDraft;
  onChange: (config: ConfigDraft) => void;
  target: PrinterTarget | null;
  test: { state: "idle" | "testing" | "ok" | "failed"; message?: string };
  onTest: () => void;
  onRetarget: () => void;
  editing: PrinterRow | null;
  saving: boolean;
  onSave: (skipTest: boolean) => void;
  onError: (message: string) => void;
}) {
  const [drawerTesting, setDrawerTesting] = useState(false);
  const kind = config.kind;
  const paperChoices = PAPERS_FOR_PURPOSE[kind];
  const printerClass = printerClassFor(kind, config.paper);
  const drawerCapable = printerClass === "thermal";
  // A cut sheet only prints through a Windows queue: raw TCP page printing
  // would mean speaking a page-description language the connector does not.
  const targetIncompatible = kind === "document" && target?.type === "network";

  function change<K extends keyof ConfigDraft>(key: K, next: ConfigDraft[K]) {
    onChange({ ...config, [key]: next });
  }

  /**
   * Changing the purpose changes which papers are even possible, so the paper
   * follows the purpose: the wizard can never ask someone to save an A4 tray
   * on a receipt printer.
   */
  function choosePurpose(value: string) {
    const next = (PURPOSE_CHOICES.find((choice) => choice.key === value)?.key ?? "receipt") as PrinterPurpose;
    const allowed = PAPERS_FOR_PURPOSE[next];
    onChange({
      ...config,
      kind: next,
      paper: allowed.includes(config.paper) ? config.paper : allowed[0],
      openDrawer: next === "receipt" ? config.openDrawer : false,
    });
  }

  const targetLine = target
    ? target.type === "windows"
      ? `ویندوز • ${target.systemName}`
      : `شبکه • ${target.ip}`
    : "اتصال انتخاب نشده است";

  async function testDrawer() {
    if (!editing) return;
    setDrawerTesting(true);
    const result = await kickDrawer(editing.id);
    setDrawerTesting(false);
    if (!result.ok) onError(printerErrorMessage(result.error));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 bg-muted/40 px-3 py-2">
        <p className="min-w-0 text-sm text-foreground" dir="auto">
          {targetLine}
        </p>
        <button type="button" className="text-xs text-primary hover:underline" onClick={onRetarget}>
          تغییر اتصال
        </button>
      </div>

      <Field label="نام چاپگر">
        <input
          className={inputClass}
          value={config.name}
          onChange={(e) => change("name", e.target.value)}
          placeholder="مثلاً چاپگر اصلی صندوق"
        />
      </Field>

      <Field label="کاربرد این چاپگر">
        <RadioGroup
          value={kind}
          onValueChange={(value) => choosePurpose(value)}
          className="grid gap-2 sm:grid-cols-2"
        >
          {PURPOSE_CHOICES.map((choice) => (
            <label
              key={choice.key}
              htmlFor={`printer-purpose-${choice.key}`}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/80 bg-card p-3 transition-colors hover:bg-muted"
            >
              <RadioGroupItem id={`printer-purpose-${choice.key}`} value={choice.key} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{choice.title}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{choice.description}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </Field>

      <Field label="کاغذ" hint="کاغذی که در این چاپگر گذاشته‌اید؛ عرض رستر و اندازهٔ صفحه از همین تعیین می‌شود.">
        <RadioGroup value={config.paper} onValueChange={(value) => change("paper", value as PaperKey)} className="grid gap-2 sm:grid-cols-2">
          {paperChoices.map((key) => (
            <label
              key={key}
              htmlFor={`printer-paper-${key}`}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/80 bg-card p-3 transition-colors hover:bg-muted"
            >
              <RadioGroupItem id={`printer-paper-${key}`} value={key} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{PAPERS[key].label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{PAPERS[key].hint}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </Field>

      {targetIncompatible ? (
        <ErrorBox>فاکتور روی کاغذ A4/A5 فقط از طریق صف ویندوز چاپ می‌شود؛ برای این کاربرد «چاپگر ویندوز» را انتخاب کنید.</ErrorBox>
      ) : null}

      <div className="flex flex-col gap-3 rounded-xl border border-border/80 p-3">
        {drawerCapable && kind === "receipt" ? (
          <label className="flex items-center justify-between gap-3">
            <span className="text-sm text-foreground">بازکردن کشوی پول پس از چاپ رسید نقدی</span>
            <Switch checked={config.openDrawer} onCheckedChange={(next) => change("openDrawer", next)} />
          </label>
        ) : null}
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm text-foreground">{DEFAULT_LABELS[kind]}</span>
          <Switch checked={config.isDefault} onCheckedChange={(next) => change("isDefault", next)} />
        </label>
        {editing ? (
          <label className="flex items-center justify-between gap-3">
            <span className="text-sm text-foreground">فعال</span>
            <Switch checked={config.isActive} onCheckedChange={(next) => change("isActive", next)} />
          </label>
        ) : null}
      </div>

      <InfoBox>
        ظاهر چاپ در «قالب‌ها» و مسیر چاپ هر سند در «قوانین چاپ» تعیین می‌شود؛ این چاپگر فقط کاغذ و سخت‌افزار را می‌داند.
      </InfoBox>

      <div className="space-y-2 border-t border-border/80 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={onTest} disabled={test.state === "testing"}>
            <PrinterIcon aria-hidden="true" />
            {test.state === "testing" ? "در حال چاپ آزمایشی…" : "چاپ آزمایشی"}
          </Button>
          {editing && kind === "receipt" && drawerCapable ? (
            <Button type="button" variant="outline" onClick={() => void testDrawer()} disabled={drawerTesting}>
              {drawerTesting ? "در حال ارسال فرمان…" : "آزمایش کشوی پول"}
            </Button>
          ) : null}
        </div>
        {test.state === "ok" ? (
          <p className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-300">
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
            چاپ آزمایشی انجام شد؛ اگر کاغذ چاپ نشد، اتصال چاپگر را بررسی کنید.
          </p>
        ) : null}
        {test.state === "failed" ? <ErrorBox>{test.message}</ErrorBox> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border/80 pt-3">
        <Button type="button" onClick={() => onSave(false)} disabled={saving || targetIncompatible}>
          {saving ? "در حال ذخیره…" : test.state === "ok" ? "ذخیرهٔ چاپگر" : "چاپ آزمایشی و ذخیره"}
        </Button>
        {test.state === "failed" ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onSave(true)} disabled={saving}>
            ذخیره بدون آزمایش
          </Button>
        ) : null}
      </div>
    </div>
  );
}
