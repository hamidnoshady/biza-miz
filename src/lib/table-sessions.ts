export type TableStatus = "free" | "seated" | "reserved" | "bill_requested" | "cleaning" | "out_of_service";

export const TABLE_STATUSES: readonly TableStatus[] = [
  "free",
  "seated",
  "reserved",
  "bill_requested",
  "cleaning",
  "out_of_service",
] as const;

export function isValidTableStatus(value: unknown): value is TableStatus {
  return typeof value === "string" && (TABLE_STATUSES as readonly string[]).includes(value);
}

export const TABLE_TRANSITIONS: Record<TableStatus, TableStatus[]> = {
  free: ["seated", "reserved", "cleaning", "out_of_service"],
  reserved: ["seated", "free", "cleaning", "out_of_service"],
  seated: ["bill_requested", "cleaning", "free", "out_of_service"],
  bill_requested: ["cleaning", "free", "seated", "out_of_service"],
  cleaning: ["free", "seated", "out_of_service"],
  out_of_service: ["free", "cleaning", "seated"],
};

export function canTransitionTable(from: TableStatus, to: TableStatus): boolean {
  if (!isValidTableStatus(from) || !isValidTableStatus(to)) return false;
  return from === to || (TABLE_TRANSITIONS[from] ?? []).includes(to);
}

export const TABLE_STATUS_LABELS: Record<TableStatus, string> = {
  free: "آزاد",
  seated: "مشغول",
  reserved: "رزرو شده",
  bill_requested: "درخواست صورت‌حساب",
  cleaning: "در حال نظافت",
  out_of_service: "خارج از سرویس",
};

export function evenSplit(total: number, parts: number): number[] {
  const n = Math.max(1, Math.floor(parts));
  const t = Math.max(0, Math.round(total));
  const base = Math.floor(t / n);
  const rem = t - base * n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(base + (i < rem ? 1 : 0));
  return out;
}
