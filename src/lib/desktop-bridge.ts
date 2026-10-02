/**
 * The one shape `window.businessSuiteDesktop` has — exposed by
 * `electron/preload.js`, present only inside the packaged Windows desktop
 * app. Every browser surface that reaches into it (Local Devices, the
 * printing client) imports this type instead of re-declaring its own partial
 * `declare global` for the same global, which is what used to make two
 * files disagree about the shape of one bridge.
 */
import type { PrinterTarget } from "./printing/types";

export interface DesktopLanInterface {
  name: string;
  address: string;
  netmask: string;
  mac: string;
}

export interface DesktopGatewayStatus {
  supported: boolean;
  enabled: boolean;
  running: boolean;
  computerName: string;
  interfaces: DesktopLanInterface[];
  selectedAddress: string | null;
  port: number;
  url: string | null;
  caDownloadUrl: string | null;
  onboardingPort: number;
  onboardingScope: "ca-certificate-only";
  onboardingDownloads: number;
  lastOnboardingDownloadAt: string | null;
  tlsDiagnostics: { count: number; last: { code: string; message: string; at: string } | null };
  addressActive: boolean;
  certificate: {
    exists: boolean;
    fingerprint?: string;
    caFingerprint?: string;
    expiresAt?: string;
  };
  firewall: { supported: boolean; installed: boolean; error?: string };
  clients: Array<{ address: string; kind: string; lastSeenAt: string }>;
  logPath: string;
}

export interface DesktopWindowsPrinter {
  name: string;
  driver?: string | null;
  isDefault: boolean;
  likelyThermal: boolean;
}

export interface DesktopDiscoveredPrinter {
  ip: string;
  port: number;
  latencyMs: number;
}

/**
 * Direct native printing — Section 7 of the desktop audit: the desktop app
 * talks to `winspool.drv` and raw TCP sockets from its own process
 * (`electron/native-printing.js`), so it never needs the browser/cloud
 * product's separate loopback "print connector".
 */
export interface DesktopPrintingBridge {
  listWindowsPrinters(): Promise<{ ok: boolean; printers?: DesktopWindowsPrinter[]; error?: string; detail?: string }>;
  discoverNetworkPrinters(): Promise<{ ok: boolean; printers?: DesktopDiscoveredPrinter[]; error?: string; detail?: string }>;
  probe(target: PrinterTarget): Promise<{ ok: boolean; reachable?: boolean; detail?: string; error?: string }>;
  sendRaw(target: PrinterTarget, dataBase64: string): Promise<{ ok: boolean; error?: string; detail?: string }>;
  /** Silent page print of a PNG through the Windows driver. Absent on older desktop builds. */
  sendPage?(printerName: string, dataBase64: string): Promise<{ ok: boolean; error?: string; detail?: string }>;
}

export interface DesktopFolderSpaceCheck {
  ok: boolean;
  freeBytes?: number;
  totalBytes?: number;
  freeLabel?: string;
  totalLabel?: string;
  sufficient?: boolean;
  recommended?: boolean;
  checkedPath?: string;
  error?: string;
  detail?: string;
}

export interface DesktopFolderAccessCheck {
  ok: boolean;
  error?: string;
  detail?: string;
}

export interface DesktopFolderCheckResult {
  ok: boolean;
  path?: string;
  error?: string;
  space?: DesktopFolderSpaceCheck;
  access?: DesktopFolderAccessCheck;
}

export type DesktopStorageKind = "database" | "attachments" | "images" | "reports" | "backups" | "printerConfig";

/**
 * First-run/settings local storage folder checks — Section 3 of the desktop
 * audit: disk-space + a real write/read/delete round trip for a candidate
 * data folder, run from the main process (`electron/local-storage.js`)
 * before Postgres/attachments/backups are pointed at it.
 */
export interface DesktopStorageBridge {
  suggestDefaultRoot(): Promise<string>;
  defaultLayout(root: string): Promise<Record<DesktopStorageKind, string> | null>;
  checkFolder(path: string): Promise<DesktopFolderCheckResult>;
}

export type DesktopUpdateStateName =
  | "checking" | "no_update" | "update_available" | "downloading" | "paused"
  | "verifying" | "ready_to_install" | "backup_in_progress" | "installing"
  | "restarting" | "verifying_health" | "success" | "failed" | "recovery_required";

export interface DesktopUpdateState {
  state: DesktopUpdateStateName;
  installedVersion: string;
  target: {
    id?: string;
    version: string;
    buildCommit: string;
    buildId: string;
    channel: "stable" | "beta" | "internal";
    releasedAt: string;
    minimumSupportedVersion: string | null;
    mandatory: boolean;
    installer: { url: string; sha256: string; size: number; signatureRequired: true; expectedPublisher: string | null };
    database: { migrationVersion: number | null; minimumSchemaVersion: number | null; maximumSchemaVersion: number | null; backupRequired: true };
    releaseNotes: string[];
    recovery: { knownGoodVersion: string | null; notes: string | null };
  } | null;
  progress: { received: number; total: number; percent: number } | null;
  installerPath: string | null;
  backupPath: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  checkedAt: string | null;
  updatedAt: string;
  policy: { automaticChecks: boolean; backgroundDownload: boolean; automaticInstall: false; channel: "stable" | "beta" | "internal" };
  installOnNextRestart: boolean;
  previousVersion: string | null;
}

export interface DesktopUpdateBridge {
  status(): Promise<DesktopUpdateState>;
  configure(policy: Partial<DesktopUpdateState["policy"]>): Promise<DesktopUpdateState>;
  check(manifest: DesktopUpdateState["target"]): Promise<DesktopUpdateState>;
  download(): Promise<DesktopUpdateState>;
  pause(): Promise<DesktopUpdateState>;
  cancel(): Promise<DesktopUpdateState>;
  selectOfflinePackage(): Promise<DesktopUpdateState>;
  installNow(): Promise<DesktopUpdateState>;
  installOnNextRestart(): Promise<DesktopUpdateState>;
  showBackup(): Promise<string | null>;
  onState(callback: (state: DesktopUpdateState) => void): () => void;
}

export interface DesktopBridge {
  isDesktop: true;
  /** Opens a native "choose a folder" dialog; `title` customizes the dialog heading. */
  pickFolder(title?: string): Promise<string | null>;
  /** Phase 46: the shell renders cloud screens in a hardened <webview> (electron/cloud-pane.js). */
  embedsCloud?: true;
  /** Present since the local-storage wizard shipped; optional so older builds still type-check. */
  storage?: DesktopStorageBridge;
  localGateway: {
    status(): Promise<DesktopGatewayStatus>;
    enable(address: string): Promise<DesktopGatewayStatus>;
    disable(): Promise<DesktopGatewayStatus>;
    installFirewallRule(): Promise<DesktopGatewayStatus>;
    removeFirewallRule(): Promise<DesktopGatewayStatus>;
    regenerateCertificate(): Promise<DesktopGatewayStatus>;
    showCaCertificate(): Promise<string>;
    openLogs(): Promise<string>;
  };
  /** Desktop Update Engine; optional while an older shell serves a newer web runtime. */
  update?: DesktopUpdateBridge;
  /** Present since the native-printing bridge shipped; optional so older builds still type-check. */
  printing?: DesktopPrintingBridge;
}

declare global {
  interface Window {
    businessSuiteDesktop?: DesktopBridge;
  }
}
