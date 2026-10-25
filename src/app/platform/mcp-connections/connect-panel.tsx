"use client";

/**
 * Issue #1126 §A — «اتصال دستیار هوش مصنوعی»: the Superadmin MCP endpoint's
 * client connection guide.
 *
 * Two panels:
 *
 *   * `PlatformMcpConnectPanel` — the permanent guide. Canonical endpoint,
 *     ready-to-copy configs with placeholders (never a recoverable token),
 *     and a paste-to-test action with explicit failure feedback.
 *   * `PlatformMcpIssuancePanel` — rendered only in the one-time issuance
 *     context, while the fresh token is still in memory. Fully populated
 *     configs plus a test-this-token action, with the secret-handling
 *     warning beside them. Dismissing drops every derived string with it:
 *     the token lives in React state only — never browser storage, never a URL,
 *     never a log, never an HTML attribute.
 */
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, Button, Card, InfoBox, fmtDate, inputClass } from "../ui";
import {
  PLATFORM_MCP_CODEX_ENV_VAR,
  PLATFORM_MCP_ENDPOINT_FALLBACK,
  PLATFORM_MCP_PATH,
  PLATFORM_MCP_SERVER_NAME,
  buildPlatformMcpClaudeDesktopConfig,
  buildPlatformMcpCodexConfig,
  buildPlatformMcpCodexExport,
  buildPlatformMcpDirectHttpConfig,
  classifyPlatformMcpTokenInput,
  shellString,
} from "@/lib/mcp/platform-client-config";
import { platformCapabilityLabel, POWERFUL_PLATFORM_CAPABILITIES } from "./capability-labels";

/* ------------------------------------------------------------------------- */
/* Small building blocks                                                     */
/* ------------------------------------------------------------------------- */

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API unavailable (non-secure context, denied permission):
    // one legacy fallback, then an honest failure the caller reports.
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="ghost"
        onClick={() => {
          void copyText(text).then((ok) => {
            setState(ok ? "ok" : "fail");
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setState("idle"), 4000);
          });
        }}
      >
        {label}
      </Button>
      <span aria-live="polite" className="text-xs text-muted-foreground">
        {state === "ok" ? "کپی شد ✓" : state === "fail" ? "کپی نشد؛ دستی کپی کنید." : ""}
      </span>
    </span>
  );
}

type CodeLanguage = "json" | "toml" | "shell";

/**
 * Minimal tokenizer highlighting — keys, strings, numbers, comments — built
 * as React nodes, never HTML strings, so generated configs cannot inject
 * markup no matter what an endpoint or token contains.
 */
function highlightCode(code: string, language: CodeLanguage): ReactNode[] {
  const nodes: ReactNode[] = [];
  const push = (node: ReactNode) => {
    nodes.push(<Fragment key={nodes.length}>{node}</Fragment>);
  };
  const span = (text: string, className: string) => <span className={className}>{text}</span>;
  const patterns: Record<CodeLanguage, RegExp> = {
    json: /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\b\d[\d.]*(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b|\bnull\b)|([{}[\],:])|(\s+)|(.)/g,
    toml: /(#[^\n]*)|("(?:[^"\\]|\\.)*")|(\[[^\]\n]*\])|(-?\b\d[\d.]*)|(\btrue\b|\bfalse\b)|([=\-,])|(\s+)|(.)/g,
    shell: /(\bexport\b)|([A-Za-z_][A-Za-z0-9_]*)(=)?|("(?:[^"\\]|\\.)*")|(\s+)|(.)/g,
  };
  const pattern = patterns[language];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    const [, a, colon, b, c, d, e, f] = match;
    if (language === "json") {
      const [str, , num, lit, punct, ws, other] = [a, colon, b, c, d, e, f];
      if (str !== undefined) {
        push(span(str, colon !== undefined ? "text-sky-300" : "text-emerald-300"));
        if (colon !== undefined) push(span(colon, "text-zinc-400"));
      } else if (num !== undefined) push(span(num, "text-amber-300"));
      else if (lit !== undefined) push(span(lit, "text-violet-300"));
      else if (punct !== undefined) push(span(punct, "text-zinc-400"));
      else if (ws !== undefined) push(ws);
      else push(span(other, "text-zinc-100"));
    } else if (language === "toml") {
      const [comment, str, table, num, bool, punct, ws, other] = [a, colon, b, c, d, e, f, match[8]];
      if (comment !== undefined) push(span(comment, "text-zinc-500 italic"));
      else if (str !== undefined) push(span(str, "text-emerald-300"));
      else if (table !== undefined) push(span(table, "text-sky-300"));
      else if (num !== undefined) push(span(num, "text-amber-300"));
      else if (bool !== undefined) push(span(bool, "text-violet-300"));
      else if (punct !== undefined) push(span(punct, "text-zinc-400"));
      else if (ws !== undefined) push(ws);
      else push(span(other ?? "", "text-zinc-100"));
    } else {
      const [keyword, name, eq, str, ws, other] = [a, colon, b, c, d, e];
      if (keyword !== undefined) push(span(keyword, "text-violet-300"));
      else if (name !== undefined) {
        push(span(name, "text-amber-300"));
        if (eq !== undefined) push(span(eq, "text-zinc-400"));
      } else if (str !== undefined) push(span(str, "text-emerald-300"));
      else if (ws !== undefined) push(ws);
      else push(span(other ?? "", "text-zinc-100"));
    }
    // A zero-width match would loop forever; the catch-all groups make one
    // impossible, but belt and braces cost nothing here.
    if (match[0] === "") pattern.lastIndex += 1;
  }
  return nodes;
}

function CodeBlock({
  code,
  language,
  caption,
  copyLabel,
}: {
  code: string;
  language: CodeLanguage;
  caption: string;
  copyLabel: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
        <span dir="ltr" className="font-mono text-xs text-zinc-400">
          {caption}
        </span>
        <CopyButton text={code} label={copyLabel} />
      </div>
      <pre dir="ltr" className="overflow-x-auto p-3 text-left font-mono text-xs leading-6 text-zinc-100">
        <code>{highlightCode(code, language)}</code>
      </pre>
    </div>
  );
}

function faDigits(value: number): string {
  return value.toLocaleString("fa-IR");
}

/* ------------------------------------------------------------------------- */
/* Connection test (diagnose first, live wire second)                        */
/* ------------------------------------------------------------------------- */

interface DiagnoseConnection {
  id: string;
  name: string;
  adminName: string;
  adminRole: string;
  capabilities: string[];
  effectiveCapabilities: string[];
  capabilitiesReduced: boolean;
  expiresAt: string | null;
  businessScope: { mode: "all" } | { mode: "list"; count: number };
}

interface DiagnoseResult {
  ok: boolean;
  status: "valid" | "expired" | "revoked" | "admin_inactive" | "unknown" | "wrong_realm" | "malformed";
  connection?: DiagnoseConnection;
  tools?: { name: string; description: string }[];
  toolCount?: number;
}

interface WireTool {
  name: string;
  description?: string;
}

type TestOutcome =
  | {
      kind: "success";
      protocolVersion: string;
      serverName: string;
      tools: WireTool[];
      diagnose: DiagnoseResult | null;
    }
  | {
      kind: "failure";
      reason:
        | "empty"
        | "wrong_realm"
        | "malformed"
        | "rejected"
        | "missing_auth"
        | "rate_limited"
        | "network"
        | "timeout"
        | "transport"
        | "rpc_error";
      detail: string | null;
      diagnose: DiagnoseResult | null;
    };

const WIRE_TIMEOUT_MS = 15_000;
const WIRE_PROTOCOL_VERSION = "2025-06-18";

class WireError extends Error {
  constructor(
    public reason: Extract<TestOutcome, { kind: "failure" }>["reason"],
    public detail: string | null = null,
  ) {
    super(reason);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function wireRpc(
  token: string,
  method: "initialize" | "tools/list",
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(PLATFORM_MCP_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: method === "initialize" ? 1 : 2, method, params }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new WireError("timeout");
    }
    throw new WireError("network");
  }
  // The route answers 401 only when NO bearer arrived — with one sent, that
  // means a proxy/CDN stripped the Authorization header on the way.
  if (response.status === 401) throw new WireError("missing_auth");
  if (response.status === 429) throw new WireError("rate_limited");
  if (response.status === 404 || response.status === 405 || !response.ok) {
    throw new WireError("transport", `HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(await response.text()) as unknown;
  } catch {
    // HTML login page, proxy error page, CDN block — anything but JSON-RPC.
    throw new WireError("transport", "non-json");
  }
  if (!isRecord(body)) throw new WireError("transport", "non-json");
  if (isRecord(body.error)) {
    const code = body.error.code;
    const message = typeof body.error.message === "string" ? body.error.message : "";
    if (code === -32004) throw new WireError("rejected");
    throw new WireError("rpc_error", message || `code ${String(code)}`);
  }
  if (!isRecord(body.result)) throw new WireError("transport", "non-json");
  return body.result;
}

export function usePlatformMcpTest() {
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);

  const runTest = useCallback(async (rawToken: string) => {
    const classification = classifyPlatformMcpTokenInput(rawToken);
    if (classification === "empty") {
      setOutcome({ kind: "failure", reason: "empty", detail: null, diagnose: null });
      return;
    }
    if (classification === "tenant_realm" || classification === "malformed") {
      // Decided locally, no network: the shape alone proves it cannot work.
      setOutcome({
        kind: "failure",
        reason: classification === "tenant_realm" ? "wrong_realm" : "malformed",
        detail: null,
        diagnose: null,
      });
      return;
    }
    const token = rawToken.trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WIRE_TIMEOUT_MS);
    setTesting(true);
    setOutcome(null);
    try {
      // First the precise, session-authenticated diagnosis; then — only for a
      // token that should work — the live wire handshake an external client
      // performs (initialize + tools/list).
      const diagnosed = await api<DiagnoseResult>("/api/platform/mcp-connections/test", {
        method: "POST",
        body: JSON.stringify({ token }),
        signal: controller.signal,
      });
      if (!diagnosed.ok) {
        if (diagnosed.aborted) {
          setOutcome({ kind: "failure", reason: "timeout", detail: null, diagnose: null });
          return;
        }
        // The diagnosis itself is unreachable (session/network/route) — fall
        // through to the wire test rather than failing on the helper.
        await runWireOnly(token, controller.signal, null, setOutcome);
        return;
      }
      if (!diagnosed.data.ok || diagnosed.data.status !== "valid") {
        setOutcome({ kind: "failure", reason: "rejected", detail: null, diagnose: diagnosed.data });
        return;
      }
      await runWireOnly(token, controller.signal, diagnosed.data, setOutcome);
    } finally {
      clearTimeout(timer);
      setTesting(false);
    }
  }, []);

  const clear = useCallback(() => setOutcome(null), []);

  return { testing, outcome, runTest, clear };
}

async function runWireOnly(
  token: string,
  signal: AbortSignal,
  diagnose: DiagnoseResult | null,
  setOutcome: (outcome: TestOutcome) => void,
): Promise<void> {
  try {
    const initialized = await wireRpc(
      token,
      "initialize",
      {
        protocolVersion: WIRE_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "biza-miz-console", version: "1" },
      },
      signal,
    );
    const listed = await wireRpc(token, "tools/list", {}, signal);
    const tools = Array.isArray(listed.tools)
      ? (listed.tools as unknown[]).filter(isRecord).map((tool) => ({
          name: String(tool.name ?? "?"),
          description: typeof tool.description === "string" ? tool.description : undefined,
        }))
      : [];
    const serverInfo = isRecord(initialized.serverInfo) ? initialized.serverInfo : {};
    setOutcome({
      kind: "success",
      protocolVersion:
        typeof initialized.protocolVersion === "string" ? initialized.protocolVersion : WIRE_PROTOCOL_VERSION,
      serverName: typeof serverInfo.name === "string" ? serverInfo.name : PLATFORM_MCP_PATH,
      tools,
      diagnose,
    });
  } catch (error) {
    if (error instanceof WireError) {
      setOutcome({ kind: "failure", reason: error.reason, detail: error.detail, diagnose });
    } else {
      setOutcome({ kind: "failure", reason: "network", detail: null, diagnose });
    }
  }
}

const DIAGNOSE_STATUS_TEXT: Record<DiagnoseResult["status"], string> = {
  valid: "معتبر",
  expired: "اعتبار این توکن تمام شده است.",
  revoked: "این توکن باطل شده است.",
  admin_inactive: "حساب مدیری که این توکن را ساخته غیرفعال است و توکن کار نمی‌کند.",
  unknown: "این توکن در سکو شناخته نشد — اشتباه کپی شده یا هرگز صادر نشده است.",
  wrong_realm: "این یک توکن کسب‌وکار است، نه توکن سکو.",
  malformed: "این متن شکل یک توکن سکو را ندارد.",
};

function TestOutcomeView({ outcome }: { outcome: TestOutcome }) {
  if (outcome.kind === "success") {
    const connection = outcome.diagnose?.connection;
    const ineffective =
      connection?.capabilities.filter((cap) => !connection.effectiveCapabilities.includes(cap)) ?? [];
    return (
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm">
        <p className="font-semibold text-emerald-800 dark:text-emerald-200">
          اتصال موفق — سرور پاسخ داد و {faDigits(outcome.tools.length)} ابزار در دسترس است.
        </p>
        <p dir="ltr" className="mt-1 text-left font-mono text-xs text-muted-foreground">
          {outcome.serverName} · {outcome.protocolVersion}
        </p>
        {connection ? (
          <div className="mt-3 space-y-2 text-xs">
            <p>
              <span className="text-muted-foreground">اتصال: </span>
              <span className="font-medium">{connection.name}</span>
              <span className="text-muted-foreground">
                {" "}
                — {connection.adminName} ({connection.adminRole})
              </span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              {connection.effectiveCapabilities.map((cap) => (
                <span key={cap} className="rounded bg-muted px-2 py-0.5">
                  {platformCapabilityLabel(cap)}
                </span>
              ))}
            </div>
            {connection.capabilitiesReduced ? (
              <p className="leading-5 text-amber-700 dark:text-amber-300">
                نقش فعلی مدیر صادرکننده، {faDigits(ineffective.length)} توانایی از این توکن را پوشش
                نمی‌دهد ({ineffective.map(platformCapabilityLabel).join("، ")})؛ ابزارهای متناظر در
                فهرست بالا نیستند.
              </p>
            ) : null}
            <p className="text-muted-foreground">
              دامنه: {connection.businessScope.mode === "all" ? "کل سکو" : `${faDigits(connection.businessScope.count)} کسب‌وکار`}
              {" · "}انقضا: {connection.expiresAt ? fmtDate(connection.expiresAt) : "ندارد"}
            </p>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            جزئیات توکن در دسترس نیست (تشخیص سمت سرور پاسخ نداد)؛ فهرست ابزارها از خودِ سرور خوانده
            شده و معتبر است.
          </p>
        )}
        {outcome.tools.length > 0 ? (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              فهرست ابزارها ({faDigits(outcome.tools.length)})
            </summary>
            <ul className="mt-2 space-y-1">
              {outcome.tools.map((tool) => (
                <li key={tool.name}>
                  <code dir="ltr" className="font-mono">
                    {tool.name}
                  </code>
                  {tool.description ? <span className="text-muted-foreground"> — {tool.description}</span> : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    );
  }

  const diagnoseStatus = outcome.diagnose?.status;
  const headline =
    outcome.reason === "empty"
      ? "برای آزمایش، یک توکن بچسبانید."
      : outcome.reason === "wrong_realm"
        ? "این یک توکن کسب‌وکار (posmcp_) است، نه توکن سکو — روی این سرور کار نمی‌کند."
        : outcome.reason === "malformed"
          ? "این متن شکل یک توکن سکو (pospmcp_…) را ندارد."
          : outcome.reason === "rejected"
            ? (diagnoseStatus ? DIAGNOSE_STATUS_TEXT[diagnoseStatus] : "توکن پذیرفته نشد.")
            : outcome.reason === "missing_auth"
              ? "سرور درخواستی بدون توکن دریافت کرد — چیزی بین مرورگر و سرور (پراکسی/CDN) سرآیند Authorization را حذف می‌کند."
              : outcome.reason === "rate_limited"
                ? "درخواست‌ها بیش از حد مجاز است؛ کمی بعد دوباره تلاش کنید."
                : outcome.reason === "network"
                  ? "ارتباط با سرور برقرار نشد — شبکه، DNS یا پراکسی را بررسی کنید."
                  : outcome.reason === "timeout"
                    ? "سرور در زمان مقرر پاسخ نداد."
                    : outcome.reason === "rpc_error"
                      ? `سرور خطا برگرداند${outcome.detail ? `: ${outcome.detail}` : "."}`
                      : "پاسخ، JSON-RPC نبود — مسیر یا میزبان نادرست است، یا پراکسی/CDN پاسخ دیگری می‌دهد.";

  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm">
      <p className="font-semibold text-destructive">آزمایش ناموفق بود.</p>
      <p className="mt-1 leading-6">{headline}</p>
      {outcome.reason === "wrong_realm" ? (
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          توکن‌های کسب‌وکار فقط روی نشانی MCP همان کسب‌وکار کار می‌کنند (صفحهٔ اتصال‌ها در تنظیمات
          کسب‌وکار). برای این سرور، یک توکن <code dir="ltr">pospmcp_</code> از همین صفحه بسازید.
        </p>
      ) : null}
      {outcome.reason === "rejected" &&
      (diagnoseStatus === "revoked" || diagnoseStatus === "expired" || diagnoseStatus === "unknown") ? (
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          راه‌حل: توکن تازه‌ای بسازید و تنظیمات کلاینت را با آن به‌روز کنید. توکن قبلی روی نخستین
          فراخوانی بعدی قطع می‌شود.
        </p>
      ) : null}
      {outcome.reason === "transport" && outcome.detail ? (
        <p dir="ltr" className="mt-1 text-left font-mono text-xs text-muted-foreground">
          {outcome.detail === "non-json" ? "non-JSON response" : outcome.detail}
        </p>
      ) : null}
      {outcome.diagnose?.connection ? (
        <p className="mt-2 text-xs text-muted-foreground">
          اتصال: {outcome.diagnose.connection.name} — {outcome.diagnose.connection.adminName} (
          {outcome.diagnose.connection.adminRole})
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Endpoint warnings                                                         */
/* ------------------------------------------------------------------------- */

const ENDPOINT_WARNING_TEXT: Record<string, string> = {
  tenant_host: "درخواست از نشانی یک کسب‌وکار آمده است؛ نشانی نمایشی به خاستگاه مدیریتی سکو اصلاح شد.",
  non_admin_host: "درخواست از خاستگاه غیرمدیریتی آمده است؛ نشانی نمایشی به خاستگاه مدیریتی سکو اصلاح شد.",
  unknown_host: "خاستگاه درخواست زیر دامنهٔ سکو نیست؛ نشانی نمایشی به خاستگاه مدیریتی سکو اصلاح شد.",
  loopback: "این نشانی حلقهٔ محلی (توسعه) است و برای کلاینت واقعی کاربرد ندارد.",
  insecure_http: "این نشانی بدون TLS است؛ پراکسی باید طرح https را اعلام کند.",
  unconfigured: "نشانی سرور مشخص نیست؛ قالب زیر را با نشانی واقعی سکو جایگزین کنید.",
};

function EndpointWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="space-y-2">
      {warnings.map((warning) => (
        <InfoBox key={warning}>{ENDPOINT_WARNING_TEXT[warning] ?? warning}</InfoBox>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Permanent guide                                                           */
/* ------------------------------------------------------------------------- */

export function PlatformMcpConnectPanel({
  endpoint,
  endpointWarnings,
}: {
  endpoint: string;
  endpointWarnings: string[];
}) {
  const displayEndpoint = endpoint || PLATFORM_MCP_ENDPOINT_FALLBACK;
  const { testing, outcome, runTest, clear } = usePlatformMcpTest();
  const [probe, setProbe] = useState("");

  return (
    <Card title="اتصال دستیار هوش مصنوعی">
      <EndpointWarnings warnings={endpointWarnings} />
      <p className="mb-3 text-xs leading-6 text-muted-foreground">
        یک دستیار خارجی (Claude Code، Claude Desktop، Codex یا هر کلاینت MCP روی HTTP) را با همین
        نشانی و یک توکن <code dir="ltr">pospmcp_</code> به سکو وصل کنید. این اتصال فقط با توکن ثابت
        کار می‌کند و ورود OAuth ندارد — برخلاف اتصال‌های کسب‌وکار، چیزی برای «ورود» نیست؛ توکن در
        سرآیند <code dir="ltr">Authorization</code> فرستاده می‌شود.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <code
          dir="ltr"
          className="min-w-0 flex-1 select-all break-all rounded-lg bg-muted p-2 text-left font-mono text-xs"
        >
          {displayEndpoint}
        </code>
        <CopyButton text={displayEndpoint} label="کپی نشانی" />
      </div>

      <h3 className="mb-2 mt-6 text-sm font-semibold">HTTP مستقیم — Claude Code و کلاینت‌های مشابه</h3>
      <p className="mb-2 text-xs leading-6 text-muted-foreground">
        برای کلاینت‌هایی که اتصال HTTP را مستقیم با سرآیند دلخواه می‌پذیرند؛ در Claude Code در فایل{" "}
        <code dir="ltr">.mcp.json</code>:
      </p>
      <CodeBlock
        code={buildPlatformMcpDirectHttpConfig(displayEndpoint)}
        language="json"
        caption=".mcp.json"
        copyLabel="کپی تنظیمات"
      />

      <h3 className="mb-2 mt-6 text-sm font-semibold">Claude Desktop با mcp-remote</h3>
      <p className="mb-2 text-xs leading-6 text-muted-foreground">
        برنامهٔ دسکتاپ Claude در فایل <code dir="ltr">claude_desktop_config.json</code> فقط سرورهایی
        با <code dir="ltr">command</code> را می‌پذیرد و نمونهٔ HTTP مستقیم را «نامعتبر» رد می‌کند؛ پس
        از پل <code dir="ltr">mcp-remote</code> استفاده کنید (Node.js لازم است):
      </p>
      <CodeBlock
        code={buildPlatformMcpClaudeDesktopConfig(displayEndpoint)}
        language="json"
        caption="claude_desktop_config.json"
        copyLabel="کپی تنظیمات"
      />

      <h3 className="mb-2 mt-6 text-sm font-semibold">Codex</h3>
      <p className="mb-2 text-xs leading-6 text-muted-foreground">
        Codex تنظیمات را از فایل TOML می‌خواند، نه JSON: جدول زیر را در{" "}
        <code dir="ltr">~/.codex/config.toml</code> (یا <code dir="ltr">.codex/config.toml</code> یک
        پروژهٔ مورداعتماد) بگذارید. توکن در فایل نیست؛ Codex آن را هنگام اتصال از متغیر محیطی
        می‌خواند:
      </p>
      <CodeBlock
        code={buildPlatformMcpCodexConfig(displayEndpoint)}
        language="toml"
        caption="config.toml"
        copyLabel="کپی تنظیمات"
      />
      <p className="mb-2 mt-4 text-xs leading-6 text-muted-foreground">
        سپس توکن را در همان محیط صادر کنید و Codex را دوباره راه بیندازید؛ با{" "}
        <code dir="ltr">codex mcp list</code> بررسی کنید که سرور بالا آمده باشد:
      </p>
      <CodeBlock
        code={buildPlatformMcpCodexExport()}
        language="shell"
        caption="shell"
        copyLabel="کپی دستور"
      />
      <p className="mb-2 mt-4 text-xs leading-6 text-muted-foreground">
        یا همین را با یک دستور ثبت کنید (معادل جدول بالا):
      </p>
      <CodeBlock
        code={`codex mcp add ${PLATFORM_MCP_SERVER_NAME} --url ${shellString(displayEndpoint)} --bearer-token-env-var ${PLATFORM_MCP_CODEX_ENV_VAR}`}
        language="shell"
        caption="shell"
        copyLabel="کپی دستور"
      />

      <h3 className="mb-2 mt-6 text-sm font-semibold">سایر کلاینت‌ها و محدودیت‌های انتقال</h3>
      <p className="mb-2 text-xs leading-6 text-muted-foreground">
        هر کلاینتی که MCP روی «HTTP قابل‌استریم» با سرآیند <code dir="ltr">Authorization</code> صحبت
        می‌کند، با فرستادن JSON-RPC (<code dir="ltr">POST</code>) به همین نشانی کار می‌کند. این سرور
        فقط همین انتقال را می‌فهمد: SSE قدیمی و stdio مستقیم پشتیبانی نمی‌شود، و هر نمونه‌ای که
        کلاینت شما نمی‌شناسد (مثلاً JSON در Codex) باید به قالب خودِ آن کلاینت برگردد — قالب‌ها
        جهان‌شمول نیستند.
      </p>

      <h3 className="mb-2 mt-6 text-sm font-semibold">آزمایش اتصال</h3>
      <p className="mb-2 text-xs leading-6 text-muted-foreground">
        یک توکن را بچسبانید تا هم اعتبار آن بررسی شود، هم همان دست‌دادن واقعی کلاینت (
        <code dir="ltr">initialize</code> و <code dir="ltr">tools/list</code>) اجرا شود. توکن فقط برای
        همین آزمایش فرستاده می‌شود و جایی ذخیره نمی‌شود.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="password"
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          className={`${inputClass} font-mono text-left`}
          placeholder="pospmcp_…"
          aria-label="توکن برای آزمایش اتصال"
          value={probe}
          onChange={(event) => setProbe(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void runTest(probe);
          }}
        />
        <div className="flex gap-2">
          <Button disabled={testing} onClick={() => void runTest(probe)}>
            {testing ? "در حال آزمایش…" : "آزمایش اتصال"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setProbe("");
              clear();
            }}
          >
            پاک‌کردن
          </Button>
        </div>
      </div>
      {outcome ? (
        <div className="mt-3">
          <TestOutcomeView outcome={outcome} />
        </div>
      ) : null}

      <h3 className="mb-2 mt-6 text-sm font-semibold">نگهداری و ایمنی</h3>
      <ul className="list-disc space-y-1 pr-5 text-xs leading-6 text-muted-foreground">
        <li>
          توکن فقط یک‌بار، هنگام ساخت، دیده می‌شود و قابل بازیابی نیست. اگر گم شد، اتصال را باطل
          کنید، توکن تازه بسازید و تنظیمات کلاینت را به‌روز کنید.
        </li>
        <li>
          ابزارهایی که یک کلاینت می‌بیند، تقاطع «توانایی‌های توکن» و «نقش فعلی مدیر صادرکننده» است؛
          کم‌شدن نقش، توکن را هم کم‌قدرت می‌کند. فهرست کامل ابزارها در بخش «ابزارها» پایین صفحه است،
          اما هیچ توکنی بیشتر از سهم خودش نمی‌بیند.
        </li>
        <li>
          توکن‌هایی با دامنهٔ «کل سکو» یا توانایی‌های مدیریتی/مالی/مخرب (مثل{" "}
          {[...POWERFUL_PLATFORM_CAPABILITIES].slice(0, 4).map(platformCapabilityLabel).join("، ")} و
          مانند آن‌ها) قدرتمندند: برای هر کلاینت یک اتصال جدا با کمترین توانایی لازم بسازید.
        </li>
        <li>
          توکن را در نشانی (URL)، لاگ، یا پیامک/ایمیل نگذارید؛ فقط در سرآیند{" "}
          <code dir="ltr">Authorization</code> یا متغیر محیطی کلاینت.
        </li>
      </ul>
    </Card>
  );
}

/* ------------------------------------------------------------------------- */
/* One-time issuance                                                         */
/* ------------------------------------------------------------------------- */

export function PlatformMcpIssuancePanel({
  token,
  endpoint,
  onDismiss,
}: {
  token: string;
  endpoint: string;
  onDismiss: () => void;
}) {
  const displayEndpoint = endpoint || PLATFORM_MCP_ENDPOINT_FALLBACK;
  const { testing, outcome, runTest } = usePlatformMcpTest();

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-500/40 dark:bg-amber-500/15">
      <p className="font-semibold text-amber-900 dark:text-amber-200">
        توکن فقط همین‌بار دیده می‌شود — آن را در جای امنی ذخیره کنید؛ دوباره نمایش داده نمی‌شود.
      </p>
      <code
        dir="ltr"
        className="mt-2 block select-all break-all rounded-lg bg-white/70 p-2 text-left font-mono text-amber-900 dark:text-amber-200"
      >
        {token}
      </code>
      <div className="mt-2 flex flex-wrap gap-2">
        <CopyButton text={token} label="کپی توکن" />
        <Button disabled={testing} onClick={() => void runTest(token)}>
          {testing ? "در حال آزمایش…" : "آزمایش همین توکن"}
        </Button>
        <Button variant="ghost" onClick={onDismiss}>
          بستن
        </Button>
      </div>
      {outcome ? (
        <div className="mt-3">
          <TestOutcomeView outcome={outcome} />
        </div>
      ) : null}

      <p className="mt-4 font-semibold text-amber-900 dark:text-amber-200">
        پیکربندی آماده با همین توکن — فقط همین‌بار
      </p>
      <p className="mt-1 text-xs leading-5 text-amber-800 dark:text-amber-300">
        این متن‌ها حاوی توکن محرمانه‌اند؛ فقط در فایل تنظیمات کلاینت خودتان بچسبانید و آن‌ها را
        هم‌رسانی نکنید. اگر توکن لو رفت، اتصال را از فهرست پایین باطل کنید و توکن تازه بسازید.
      </p>
      <div className="mt-3 space-y-3">
        <CodeBlock
          code={buildPlatformMcpDirectHttpConfig(displayEndpoint, { token })}
          language="json"
          caption=".mcp.json (HTTP direct)"
          copyLabel="کپی"
        />
        <CodeBlock
          code={buildPlatformMcpClaudeDesktopConfig(displayEndpoint, { token })}
          language="json"
          caption="claude_desktop_config.json (mcp-remote)"
          copyLabel="کپی"
        />
        <CodeBlock
          code={buildPlatformMcpCodexExport({ token })}
          language="shell"
          caption="Codex env export"
          copyLabel="کپی"
        />
      </div>
    </div>
  );
}
