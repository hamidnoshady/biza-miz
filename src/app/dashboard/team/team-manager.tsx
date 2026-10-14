"use client";

/**
 * Phase 13 — the team screen, in companion views (issue #947, TEAM-F08).
 *
 *  1. **اعضا** — the roster: filters, pagination, and one detail surface per member
 *     (overview, access, login/sessions, personnel file, finance, history) whose
 *     actions are the dialogs the API already accepts.
 *  2. **دعوت و شروع کار** — one onboarding entry point with distinct modes: invite a
 *     login user, create PIN staff with an explicit branch policy, or create *only* a
 *     personnel file (no login) in the directory view.
 *  3. **پروندهٔ کارکنان** — the personnel directory (`parties`, scope `team`).
 *  4. **نقش‌ها** — custom roles and their capability summaries.
 *
 * The views are companions rather than one stack because every creation form used to sit
 * under the roster: an owner looking for «which branches does this member hold» scrolled
 * past three forms, and the roster itself had no detail view at all — its actions were a
 * row of buttons whose meanings only made sense one at a time.
 *
 * The member row's actions map one-to-one onto what the API actually accepts
 * (`PATCH /api/team/:id` carries `fullName`, `role`, `permissions`,
 * `locationIds`, `defaultLocationId`, `phone`; `PUT …/credentials` carries
 * `pin`/`password`) — before, the API offered all of it and the screen showed
 * a role-and-toggles editor and nothing else, so a member's name or branches
 * could only be fixed by removing and re-adding the person.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PERMISSIONS, roleBasePermissions } from "@/lib/permissions";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH, isValidPin } from "@/lib/pin-policy";
import { roleLabel } from "@/lib/role-labels";
import {
  ASSIGNABLE_ROLES,
  INVITABLE_ROLES,
  PIN_ROLES,
  loginCredentialModelForRole,
} from "@/lib/roles";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatPhoneDisplay } from "@/lib/phone";
import {
  AccessChangeSummary,
  PermissionEditor,
} from "@/components/team/permission-editor";
import { RolesManager } from "@/components/team/roles-manager";
import { MemberDetailDialog } from "./member-detail-dialog";
import { IamSyncCard } from "@/components/team/iam-sync-card";
import { LocalToHybridGuide } from "@/components/team/local-to-hybrid-guide";
import { SecurityConfirmDialog } from "@/components/auth/security-confirm-dialog";
import { canViewParties, partyScopeFor } from "@/lib/parties-scopes";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { LoadingSkeleton, SectionCard, TabBar, TabPanel } from "../page-chrome";
import { PartiesSection } from "../parties/parties-section";
import {
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  SecondaryButton,
  api,
  errorMessage,
  inputClass,
} from "../ui";


/** ... gone: the label map that used to live here.
 *
 * Issue #854 (P2.3) — this file carried a ~50-entry copy of the permission
 * labels while `permission-registry.ts` carried the same labels *and* the
 * groups, risk levels, dependencies and descriptions. The member editor now
 * renders `PermissionEditor`, which reads the registry, so the copy has no
 * reader — and a second copy of a catalogue is how the two drift.
 */

interface Member {
  id: string;
  role: string;
  customRoleId: string | null;
  customRoleName: string | null;
  fullName: string;
  email: string | null;
  isActive: boolean;
  status: "invited" | "active" | "suspended" | "locked" | "inactive" | "offboarded";
  locationScope: "all" | "selected" | "home" | "none";
  hasPin: boolean;
  hasLogin: boolean;
  /** Phase 42 — the login phone (E.164) and whether the member has proven it with an OTP. */
  phone: string | null;
  phoneVerified: boolean;
  locationIds: string[];
  defaultLocationId: string | null;
  overrides: { granted?: string[]; revoked?: string[] };
  effectivePermissions: string[];
  /**
   * Issue #947 (TEAM-F04/F05) — the personnel file this membership owns, and whether
   * the platform still owes them one. `null` with `personnelFileDrift` false cannot
   * happen: the roster's flag includes «the file is missing», so a chip-less member is
   * one whose file is present and in line. The render below keeps a branch for the
   * impossible pair anyway — the invariant lives in SQL, and TypeScript cannot see it —
   * and it is the honest fallback if that query ever changes.
   */
  personnelFileId: string | null;
  personnelFileDrift: boolean;
  createdAt: string;
}

/** One open drift episode, as `GET /api/team` reports it. */
interface PersonnelFileDrift {
  userId: string;
  fullName: string;
  reason: "file_missing" | "identity_stale";
  lastError: string | null;
  attempts: number;
  lastAttemptAt: string;
}

/** A branch as `/api/team` hands it to the screen — enough to assign people to. */
interface TeamLocation {
  id: string;
  name: string;
  isActive: boolean;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  fullName: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
  /** Issue #854 (P2.11): null means the invitation predates the column. */
  locationScope?: "all" | "selected" | "home" | "none" | null;
  customRoleId?: string | null;
  customRoleName?: string | null;
}

/** One label per branch policy, shared by the invite form and its list. */
const INVITE_SCOPE_LABELS: Record<NonNullable<Invitation["locationScope"]>, string> = {
  all: "همهٔ شعبه‌ها",
  selected: "شعبه‌های انتخابی",
  home: "فقط شعبهٔ اصلی",
  none: "بدون دسترسی شعبه",
};

const INVITATION_STATUS_LABELS: Record<Invitation["status"], string> = {
  pending: "در انتظار",
  accepted: "پذیرفته‌شده",
  revoked: "لغوشده",
  expired: "منقضی",
};

/**
 * One label per membership status — shared by the row's chip and the roster's status
 * filter, so «تعلیق‌شده» means the same thing in both (issue #947, TEAM-F08: this used
 * to be an inline literal at the single point that rendered it).
 */
const MEMBER_STATUS_LABELS: Record<Member["status"], string> = {
  invited: "دعوت‌شده",
  active: "فعال",
  suspended: "تعلیق‌شده",
  locked: "قفل‌شده",
  inactive: "غیرفعال",
  offboarded: "قطع همکاری",
};

/** Which role options the editor offers — every assignable role, labelled once. */
const ROLE_OPTIONS = ASSIGNABLE_ROLES.map((value) => ({ value, label: roleLabel(value) }));

/**
 * Issue #947 (TEAM-F08) — the four companion views of the Team tab.
 *
 * Declared as data so the tab strip, the panel and the tests read one list: a fifth
 * view added by editing two of three places is how a tab that renders nothing appears.
 */
const TEAM_VIEWS = [
  { key: "members", label: "اعضا" },
  { key: "onboarding", label: "دعوت و شروع کار" },
  { key: "files", label: "پروندهٔ کارکنان" },
  { key: "roles", label: "نقش‌ها" },
] as const;
type TeamView = (typeof TEAM_VIEWS)[number]["key"];

/**
 * How many roster cards one page holds.
 *
 * The roster is one `GET /api/team` — the whole business — so paging is client-side and
 * deliberately so: a round trip per page would be a slower way to slice an array that is
 * already in memory, and the filter above it must keep matching across *all* members, not
 * the visible page (filter-then-page is the only order that does not hide a match).
 */
const MEMBER_PAGE_SIZE = 25;

/**
 * How many file candidates the link picker requests per query.
 *
 * The picker is a type-ahead now (issue #947, TEAM-F08), so the page is what fits a
 * dropdown readably rather than the old 200-row cap that silently truncated a larger
 * directory. «چند پرونده پیدا شد» is printed under the field from the route's `total`.
 */
const FILE_LINK_PAGE_SIZE = 25;

/**
 * The modes of the one onboarding entry point (issue #947, TEAM-F08).
 *
 * The third mode is a *statement*, not a form: creating only a personnel file happens in
 * the directory view, and the point of offering it here is that the person adding a
 * colleague learns it exists before they invent an account to get one.
 */
const ONBOARDING_MODES = [
  { key: "invite", label: "ورود با لینک دعوت" },
  { key: "pin", label: "ورود با رمز عددی" },
  { key: "file", label: "فقط پرونده، بدون ورود" },
] as const;

export function TeamManager({
  currentUserId,
  role,
  permissions,
}: {
  currentUserId: string;
  role: string;
  /** The member's effective permission keys — forwarded to the personnel directory. */
  permissions?: readonly string[];
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [locations, setLocations] = useState<TeamLocation[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  /** Issue #947 (TEAM-F05) — the members whose file is still owed, and why. */
  const [personnelDrift, setPersonnelDrift] = useState<PersonnelFileDrift[]>([]);
  /**
   * Issue #947 (TEAM-F08) — narrowing the roster.
   *
   * A business with forty staff scrolled this list to find one person, and the only
   * tool was the browser's own find. The filter is client-side on purpose: the roster is
   * already in memory (one `GET /api/team`), so a round trip per keystroke would be a
   * slower way to search the same array.
   */
  const [memberSearch, setMemberSearch] = useState("");
  /**
   * Issue #947 (TEAM-F07) — connecting a standalone personnel file to an account.
   *
   * The guaranteed direction is «an account creates its file» (the onboarding doors and
   * `ensurePersonnelFileForMembership`), and a file created by hand through the party
   * directory has no account behind it. This is the controlled way to connect the two:
   * the owner picks an *unlinked* Employee file, `PUT /api/parties/:id` validates the
   * target (`employee_link_unknown` / `employee_link_taken`) and audits the change, and
   * the membership→file sync then brings the name, mobile and email over from the
   * account. A second file for the same member is refused by the database, not by this
   * dialog.
   */
  const [fileLinkTarget, setFileLinkTarget] = useState<Member | null>(null);
  const [fileLinkOptions, setFileLinkOptions] = useState<{ value: string; label: string }[]>([]);
  const [fileLinkChoice, setFileLinkChoice] = useState("");
  const [fileLinkBusy, setFileLinkBusy] = useState(false);
  const [fileLinkError, setFileLinkError] = useState("");
  /**
   * Issue #947 (TEAM-F08) — the file picker searches on the server.
   *
   * It used to fetch one page of 200 Employee files and filter them in the browser, which
   * meant a business with more files than that had a picker that could not find the very
   * record the operator was looking at in the directory. The query goes to `?q=` now —
   * the same search the directory uses (`searchParties`), so the two agree about what
   * «پیدا شد» means — and the count under the select says how many matched, because a
   * capped list that says nothing is how a missing file looks like a missing person.
   */
  const [fileLinkQuery, setFileLinkQuery] = useState("");
  const [fileLinkTotal, setFileLinkTotal] = useState(0);
  const [fileLinkLoading, setFileLinkLoading] = useState(false);
  const [memberStatus, setMemberStatus] = useState("");
  /**
   * Issue #947 (TEAM-F08) — which companion view is open, and which page of the roster.
   *
   * `view` starts on the roster because that is what the tab is for; the other three are
   * one press away rather than three cards down. `memberPage` is reset whenever a filter
   * changes: staying on page 3 of a result set that now has one page is the classic way a
   * list looks empty while matching rows exist.
   */
  const [view, setView] = useState<TeamView>("members");
  const [memberPage, setMemberPage] = useState(1);
  /** The member whose detail surface is open (issue #947, TEAM-F08). */
  const [detail, setDetail] = useState<Member | null>(null);
  /**
   * Issue #947 (TEAM-F08) — the one onboarding entry point, and which mode it is in.
   *
   * «Invite a colleague» and «create PIN staff» are different ceremonies with different
   * credentials and different forms, and they were two separate cards here plus a third
   * door in the directory — so an owner who wanted to add somebody had to know *which*
   * door matched the person before they could start. The modes are named for the outcome
   * («ورود با لینک دعوت» / «ورود با رمز عددی» / «فقط پرونده، بدون ورود»), and the third
   * says out loud what it does not create.
   */
  const [onboardingMode, setOnboardingMode] = useState<"invite" | "pin" | "file">("invite");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [deploymentProfile, setDeploymentProfile] = useState<"cloud" | "hybrid" | "local">("cloud");
  /** The member whose full editor dialog is open (name, role, branches, permissions). */
  const [editing, setEditing] = useState<Member | null>(null);
  /** Phase 42 — which member's login-phone editor is open. */
  const [phoneEditing, setPhoneEditing] = useState<Member | null>(null);
  /** Which member's PIN/password reset dialog is open. */
  const [credentialsEditing, setCredentialsEditing] = useState<Member | null>(null);
  /**
   * Issue #854 (P2.26) — suspension and offboarding are destructive security
   * actions; they wait behind a product confirmation that spells out the
   * consequences, instead of a bare `confirm()` whose cancel path is only a
   * reflex check. Only the dialog's confirm path sends the mutation.
   */
  const [pendingSuspend, setPendingSuspend] = useState<Member | null>(null);
  const [pendingOffboard, setPendingOffboard] = useState<Member | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  /**
   * Issue #854 (pass 4, gap 4) — an offboarded member does not «فعال‌سازی»:
   * offboarding severed the identity linkage, revoked the credentials and
   * wiped the branches, so coming back is an explicit ceremony with its own
   * dialog, not the flip of a toggle.
   */
  const [rehiring, setRehiring] = useState<Member | null>(null);

  /**
   * Issue #854 (P2.1/P2.4) — two different questions.
   *
   * `canManage` is membership administration: roles, branches, suspension,
   * credentials, invitations. `canManagePermissions` is the narrower capability
   * of handing out *capabilities*, and it is deliberately not implied by the
   * first. The server enforces both; this screen agrees with it instead of
   * offering controls that come back 403.
   *
   * They are computed before `load` because the loader needs them: see the
   * capability-gated invitations read below (issue #947, TEAM-F06).
   */
  const granted = permissions ?? [];
  const isOwner = role === "owner";
  const canManagePermissions = isOwner || granted.includes(PERMISSIONS.teamPermissionsManage);
  const canManage = isOwner || granted.includes(PERMISSIONS.teamManage);

  const load = useCallback(async () => {
    /**
     * Issue #947 (TEAM-F06) — a read-only visit does not request what it may not read.
     *
     * `GET /api/team` accepts `team.view` OR `team.manage`, but the invitations
     * list requires `team.manage` outright. The loader asked for both, always, and
     * then surfaced the refusal: a member whose whole purpose for opening this tab
     * was to *see* the roster was met with an error about invitations they never
     * asked for, above a roster that had loaded perfectly. A capability the screen
     * knows it lacks is not a failed request — so it is not made.
     */
    const [membersRes, invitesRes] = await Promise.all([
      api<{
        members: Member[];
        locations?: TeamLocation[];
        deploymentProfile?: "cloud" | "hybrid" | "local";
        personnelFileDrift?: PersonnelFileDrift[];
      }>("/api/team"),
      canManage
        ? api<{ invitations: Invitation[] }>("/api/team/invitations")
        : Promise.resolve(null),
    ]);
    if (membersRes.ok) {
      setMembers(membersRes.data.members);
      if (membersRes.data.deploymentProfile) setDeploymentProfile(membersRes.data.deploymentProfile);
      // Branches travel with the members: assigning a person to a place needs
      // the place's name, and a second permission-gated call for a list this
      // screen already owns would only be a way to make it fail separately.
      if (membersRes.data.locations) setLocations(membersRes.data.locations);
      setPersonnelDrift(membersRes.data.personnelFileDrift ?? []);
    } else {
      setError(errorMessage((membersRes.data as { error?: string }).error));
    }
    if (!invitesRes) {
      setInvitations([]);
    } else if (invitesRes.ok) {
      setInvitations(invitesRes.data.invitations);
    } else if (membersRes.ok) {
      /*
       * A refusal here is not the same failure as a broken one. The roster loaded,
       * so the page is usable and the sentence must say exactly that much: the
       * invitations list needs «مدیریت تیم», and the rest of the screen is intact.
       * Anything else (a 500, a dropped connection) keeps the mapped message.
       */
      const code = (invitesRes.data as { error?: string }).error;
      setError(
        invitesRes.status === 403 ||
          code === "forbidden" ||
          code === "permissions_manage_required"
          ? "فهرست دعوت‌ها برای شما قابل مشاهده نیست (دسترسی «مدیریت تیم» لازم است)؛ بقیهٔ این صفحه کامل بارگذاری شده است."
          : errorMessage(code),
      );
    }
    setLoading(false);
  }, [canManage]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mutate(url: string, init: RequestInit) {
    setError("");
    const res = await api<{ error?: string; reason?: string }>(url, init);
    if (!res.ok) {
      setError(res.data.reason || errorMessage(res.data.error));
      return false;
    }
    await load();
    return true;
  }

  const locationName = useMemo(
    () => new Map(locations.map((location) => [location.id, location.name])),
    [locations],
  );

  /** The roster after the search box and the status filter — what the cards render. */
  const visibleMembers = useMemo(() => {
    const needle = memberSearch.trim().toLowerCase();
    return members.filter((member) => {
      if (memberStatus && member.status !== memberStatus) return false;
      if (!needle) return true;
      return [
        member.fullName,
        member.email ?? "",
        member.phone ?? "",
        roleLabel(member.role),
        member.customRoleName ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [members, memberSearch, memberStatus]);
  /**
   * The onboarding modes this member may open.
   *
   * The third mode is offered to everyone: it is a sentence plus a link into a view that
   * gates itself, so hiding it from a read-only visitor would hide the explanation of why
   * no account is being created.
   */
  const onboardingModes = useMemo(
    () => ONBOARDING_MODES.filter((mode) => mode.key !== "pin" || canManage),
    [canManage],
  );

  const memberStatuses = useMemo(
    () => [...new Set(members.map((member) => member.status))],
    [members],
  );

  /**
   * The page of the filtered roster that is on screen, with the numbers the footer shows.
   *
   * `Math.min` on the last page is the clamp that matters: deleting a filter, offboarding
   * the last member of page 3, or reloading after a save can shrink the result set under
   * the current page, and an out-of-range page would render an empty card list with no way
   * back except clearing the filters.
   */
  const memberPages = Math.max(1, Math.ceil(visibleMembers.length / MEMBER_PAGE_SIZE));
  const currentMemberPage = Math.min(memberPage, memberPages);
  const pagedMembers = useMemo(
    () =>
      visibleMembers.slice(
        (currentMemberPage - 1) * MEMBER_PAGE_SIZE,
        currentMemberPage * MEMBER_PAGE_SIZE,
      ),
    [visibleMembers, currentMemberPage],
  );

  /** A filter change puts the reader back on page one — the result set changed. */
  function applyMemberFilter(next: () => void) {
    next();
    setMemberPage(1);
  }

  /**
   * Open the «connect an existing file» dialog.
   *
   * The candidates are this business's Employee files that no account holds yet — the
   * only set that *can* be linked, since a taken one answers `employee_link_taken`. The
   * projection gives us what we need and nothing more (a nameless file cannot exist).
   */
  async function searchFileLinkCandidates(term: string) {
    setFileLinkLoading(true);
    const params = new URLSearchParams({
      role: "Employee",
      includeInactive: "1",
      pageSize: String(FILE_LINK_PAGE_SIZE),
    });
    if (term.trim()) params.set("q", term.trim());
    const res = await api<{
      error?: string;
      total?: number;
      parties?: { id: string; displayName: string; employeeUserId?: string | null; accountingCode?: string | null }[];
    }>(`/api/parties?${params.toString()}`);
    setFileLinkLoading(false);
    if (!res.ok) {
      setFileLinkError(errorMessage(res.data.error));
      setFileLinkOptions([]);
      setFileLinkTotal(0);
      return;
    }
    setFileLinkError("");
    setFileLinkTotal(res.data.total ?? (res.data.parties ?? []).length);
    setFileLinkOptions(
      (res.data.parties ?? [])
        .filter((party) => !party.employeeUserId)
        .map((party) => ({
          value: party.id,
          label: party.accountingCode ? `${party.displayName} — ${party.accountingCode}` : party.displayName,
        })),
    );
  }

  async function openFileLink(member: Member) {
    setFileLinkTarget(member);
    setFileLinkChoice("");
    setFileLinkError("");
    setFileLinkOptions([]);
    setFileLinkQuery("");
    setFileLinkTotal(0);
    await searchFileLinkCandidates("");
  }

  /**
   * Type-ahead over the server, debounced.
   *
   * The debounce is 300 ms because the search is a real query against the directory, not
   * an array filter: one request per keystroke is a request per keystroke in the
   * database's logs and a race between replies that arrive out of order.
   */
  useEffect(() => {
    if (!fileLinkTarget) return;
    const timer = setTimeout(() => void searchFileLinkCandidates(fileLinkQuery), 300);
    return () => clearTimeout(timer);
    // The fetch is re-created per render on purpose (it closes over `api` alone), and
    // depending on it would restart the timer on every keystroke's re-render. The two
    // inputs that matter are the query and the open dialog.
  }, [fileLinkQuery, fileLinkTarget]);

  /**
   * Attach the chosen file to this member.
   *
   * One write, and the server decides: the link is validated against the business and
   * the one-file-per-membership rule, the change is audited, and the file's shared
   * fields are brought over from the account by the route's own sync call. The roster is
   * re-read afterwards, so the card shows the state the server actually holds rather
   * than the one this dialog hoped for.
   */
  async function submitFileLink() {
    if (!fileLinkTarget || !fileLinkChoice) return;
    setFileLinkBusy(true);
    setFileLinkError("");
    const res = await api<{ error?: string; fieldErrors?: Record<string, string> }>(
      `/api/parties/${encodeURIComponent(fileLinkChoice)}`,
      {
        method: "PUT",
        body: JSON.stringify({ roles: ["Employee"], employeeUserId: fileLinkTarget.id }),
      },
    );
    setFileLinkBusy(false);
    if (!res.ok) {
      const fieldError = Object.values(res.data.fieldErrors ?? {})[0];
      setFileLinkError(errorMessage(fieldError ?? res.data.error));
      return;
    }
    setFileLinkTarget(null);
    await load();
  }

  /** Issue #854 (P2.26) — the only paths that send these mutations. */
  async function executeSuspend(member: Member) {
    setPendingSuspend(null);
    setConfirmBusy(true);
    const ok = await mutate(`/api/team/${member.id}`, {
      method: "PATCH",
      body: JSON.stringify({ isActive: false }),
    });
    setConfirmBusy(false);
    if (ok) setError("");
  }

  async function executeOffboard(member: Member) {
    setPendingOffboard(null);
    setConfirmBusy(true);
    const ok = await mutate(`/api/team/${member.id}`, { method: "DELETE" });
    setConfirmBusy(false);
    if (ok) setError("");
  }

  if (loading) return <LoadingSkeleton rows={3} />;

  return (
    <div className="space-y-6">
      <ErrorBox>{error}</ErrorBox>
      <div role="status" className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
        <p className="font-semibold text-foreground">
          {deploymentProfile === "cloud" ? "مدیریت ابری" : deploymentProfile === "hybrid" ? "دسترسی ابری و محدودیت‌های این سایت" : "مدیریت محلی"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {deploymentProfile === "hybrid"
            ? "این سایت در حالت قطع اتصال فقط می‌تواند دسترسی را محدود کند. افزایش سطح دسترسی به تأیید فضای ابری نیاز دارد."
            : deploymentProfile === "local"
              ? "این کسب‌وکار به فضای ابری Eshobe وابسته نیست و مدیریت کاربران به‌صورت محلی انجام می‌شود."
              : "هویت، نقش‌ها، نشست‌ها و دسترسی‌ها از فضای ابری مدیریت می‌شوند."}
        </p>
      </div>

      {/*
        Issue #947 (TEAM-F08) — companion views instead of one stack.

        Every creation form used to sit under the roster: the tab was «اعضا و دسترسی‌ها»,
        and reaching the roles list, the invitations or the personnel directory meant
        scrolling past the others. These are the four jobs this tab does, and they are
        peers — a member of staff, the ceremonies that add one, the file that person has
        in the ledger, and the roles that shape what they may do.
      */}
      <TabBar
        idPrefix="team"
        label="بخش‌های مدیریت تیم"
        tabs={TEAM_VIEWS}
        active={view}
        onChange={setView}
      />

      <TabPanel idPrefix="team" active={view}>
      {view === "members" ? (
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">مدیریت اعضا</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">اعضا و دسترسی‌ها</h2>
          </div>
        }
        description="اعضای کسب‌وکار، نقش‌ها و سطوح دسترسی آن‌ها را در سامانه مدیریت کنید."
      >
        <div className="space-y-3">
          {!canManage ? (
            <InfoBox>
              شما دسترسی «مشاهدهٔ تیم» را دارید؛ تغییر نقش‌ها، شعبه‌ها و اعتبارنامه‌ها به
              «مدیریت تیم» نیاز دارد.
            </InfoBox>
          ) : null}
          {members.length === 0 ? (
            <InfoBox>هنوز عضوی برای این کسب‌وکار ثبت نشده است.</InfoBox>
          ) : null}
          {/* The filters appear only once there is something to filter — a search box
              over an empty roster is furniture. */}
          {members.length > 1 ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1">
                <label className="sr-only" htmlFor="team-member-search">
                  جست‌وجوی عضو
                </label>
                <input
                  id="team-member-search"
                  type="search"
                  className={inputClass}
                  value={memberSearch}
                  onChange={(event) => applyMemberFilter(() => setMemberSearch(event.target.value))}
                  placeholder="جست‌وجوی نام، ایمیل، موبایل یا نقش…"
                />
              </div>
              <div className="w-48">
                <Field label="وضعیت">
                  <SearchableSelect
                    value={memberStatus}
                    onChange={(value) => applyMemberFilter(() => setMemberStatus(value))}
                    options={[
                      { value: "", label: "همهٔ وضعیت‌ها" },
                      ...memberStatuses.map((status) => ({
                        value: status,
                        label: MEMBER_STATUS_LABELS[status],
                      })),
                    ]}
                  />
                </Field>
              </div>
              {memberSearch || memberStatus ? (
                <SecondaryButton
                  onClick={() =>
                    applyMemberFilter(() => {
                      setMemberSearch("");
                      setMemberStatus("");
                    })
                  }
                >
                  پاک‌کردن فیلترها
                </SecondaryButton>
              ) : null}
            </div>
          ) : null}
          {members.length > 0 && visibleMembers.length === 0 ? (
            <InfoBox>
              عضوی با این فیلتر پیدا نشد. فیلترها را پاک کنید یا نام دیگری را جست‌وجو کنید.
            </InfoBox>
          ) : null}
          {pagedMembers.map((member) => (
            <div key={member.id} className="rounded-xl border border-border/80 p-3 sm:p-4 transition-colors hover:bg-muted/60 dark:hover:bg-muted/50">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-foreground">
                    {member.fullName}
                    {member.id === currentUserId && (
                      <span className="ms-2 text-xs font-normal text-muted-foreground">(شما)</span>
                    )}
                    {member.status !== "active" && (
                      <span className="ms-2 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
                        {MEMBER_STATUS_LABELS[member.status]}
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {roleLabel(member.role)}{member.customRoleName ? ` / ${member.customRoleName}` : ""}
                    {member.email ? ` · ${member.email}` : ""}
                    {member.hasPin ? " · ورود با رمز عددی" : ""}
                    {member.locationScope === "all"
                      ? " · همهٔ شعبه‌ها"
                      : member.locationScope === "none"
                        ? " · بدون دسترسی شعبه"
                        : member.locationScope === "home"
                          ? ` · شعبهٔ اصلی: ${locationName.get(member.defaultLocationId ?? "") ?? "—"}`
                          : ` · شعبه‌های انتخابی: ${member.locationIds
                              .map((id) => locationName.get(id) ?? "—")
                              .join("، ") || "هیچ‌کدام"}`}
                  </p>
                  {/*
                    Issue #947 (TEAM-F04/F05) — the guarantee is either true or
                    visibly owed. The person's file is the accounting half of their
                    employment: payroll and مساعده post against it, and until this
                    line existed nothing on the Team screen said whether it was
                    there. A file that could not be written is stated with the
                    reason and the attempt count, and the read that produced this
                    roster already retried it once (`GET /api/team`), so a visible
                    «در انتظار» means the last attempt also failed.
                  */}
                  <p className="mt-1 text-xs">
                    {member.personnelFileId ? (
                      <span className="text-muted-foreground">
                        پروندهٔ پرسنلی: ثبت‌شده
                      </span>
                    ) : member.personnelFileDrift ? (
                      <span className="text-amber-700 dark:text-amber-300">
                        {/* «در انتظار ساخت» was wrong for half the cases the flag now
                            covers: a member whose file exists but no longer carries
                            their name or phone owes a *sync*, not a creation — and the
                            roster cannot tell them apart from the record alone (issue
                            #947, F05: the flag is the debt, which may have no row). */}
                        {personnelDrift.find((row) => row.userId === member.id)?.reason === "identity_stale"
                          ? "پروندهٔ پرسنلی: نیازمند همگام‌سازی"
                          : "پروندهٔ پرسنلی: در انتظار ساخت"}
                        {(() => {
                          const drift = personnelDrift.find((row) => row.userId === member.id);
                          if (!drift) return null;
                          return ` (${drift.reason === "identity_stale" ? "شناسهٔ ناهمخوان" : "پروندهٔ ناقص"}${
                            drift.attempts > 1 ? `، ${toPersianDigits(String(drift.attempts))} تلاش` : ""
                          })`;
                        })()}
                        {" — "}
                        {canManage
                          ? "با تغییر بعدی همین عضو یا اجرای همگام‌سازی پرونده‌ها ترمیم می‌شود."
                          : "به‌زودی خودکار ترمیم می‌شود."}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">پروندهٔ پرسنلی: ندارد</span>
                    )}
                  </p>
                  <p className="mt-1 text-xs">
                    {member.phone ? (
                      <>
                        <span dir="ltr">{toPersianDigits(formatPhoneDisplay(member.phone))}</span>
                        {member.phoneVerified ? (
                          <span className="ms-2 text-emerald-600 dark:text-emerald-400">موبایل تأییدشده</span>
                        ) : (
                          <span className="ms-2 text-amber-600 dark:text-amber-400">
                            تأییدنشده — در اولین ورود با کد پیامکی تأیید می‌شود
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">بدون شمارهٔ موبایل</span>
                    )}
                  </p>
                </div>
                <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
                  {/*
                    Issue #947 (TEAM-F08) — one detail surface per member.

                    The card's actions answer «change this»; they never answered «what is
                    this member, exactly» — which role and capabilities, which branches,
                    which credential, whether the personnel file exists and whether the
                    platform still owes one. That question needed a place, and the row of
                    buttons was standing in for it.
                  */}
                  <SecondaryButton onClick={() => setDetail(member)}>جزئیات</SecondaryButton>
                  {(canManage && (isOwner || member.role !== "owner")) ? <SecondaryButton onClick={() => setEditing(member)}>ویرایش</SecondaryButton> : null}
                  {/*
                    Issue #947 (TEAM-F07) — the other half of the identity story: a
                    standalone personnel file (created in the party directory, no login)
                    can be connected to an account deliberately, instead of the owner
                    deleting it and re-creating the person through onboarding.
                  */}
                  {(canManage && !member.personnelFileId && (isOwner || member.role !== "owner")) ? (
                    <SecondaryButton onClick={() => void openFileLink(member)}>
                      اتصال پروندهٔ پرسنلی
                    </SecondaryButton>
                  ) : null}
                  {(canManage && (isOwner || member.role !== "owner")) ? <SecondaryButton onClick={() => setPhoneEditing(member)}>
                    شمارهٔ موبایل
                  </SecondaryButton> : null}
                  {(canManage && (isOwner || member.role !== "owner")) ? <SecondaryButton onClick={() => setCredentialsEditing(member)}>
                    رمز ورود
                  </SecondaryButton> : null}
                  {/*
                    Issue #854 (pass 4, gap 4) — the actions derive from the
                    lifecycle: an active member suspends, a suspended/inactive
                    one reactivates, and an *offboarded* one comes back only
                    through the rehire ceremony — offboarding removed the
                    identity linkage, the credentials and the branch scope, so
                    a bare «فعال‌سازی» would restore a doorless membership.
                  */}
                  {(canManage && (isOwner || member.role !== "owner") && member.status !== "offboarded") ? <SecondaryButton
                    onClick={() => {
                      // Issue #854 (P2.26) — suspension asks with consequences
                      // spelled out; reactivation is harmless and asks nothing.
                      if (member.isActive) setPendingSuspend(member);
                      else void mutate(`/api/team/${member.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ isActive: true }),
                      });
                    }}
                  >
                    {member.isActive ? "تعلیق" : "فعال‌سازی"}
                  </SecondaryButton> : null}
                  {(canManage && (isOwner || member.role !== "owner") && member.status === "offboarded") ? <SecondaryButton
                    onClick={() => setRehiring(member)}
                  >
                    بازگشت به کار
                  </SecondaryButton> : null}
                  {(canManage && (isOwner || member.role !== "owner") && member.status !== "offboarded") ? <SecondaryButton
                    onClick={() => setPendingOffboard(member)}
                    className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    قطع همکاری
                  </SecondaryButton> : null}
                </div>
              </div>
            </div>
          ))}
          {/*
            Issue #947 (TEAM-F08) — the roster is a page, not the whole business.

            `visibleMembers.length` and the range are stated in Persian digits with the
            total, so «چند نفر هست» is answered by the same line that pages them: before,
            a forty-person business rendered forty cards and the only way to know the
            count was to count.
          */}
          {visibleMembers.length > MEMBER_PAGE_SIZE ? (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <p className="text-xs text-muted-foreground">
                نمایش {toPersianDigits(String((currentMemberPage - 1) * MEMBER_PAGE_SIZE + 1))}
                {" تا "}
                {toPersianDigits(
                  String(Math.min(currentMemberPage * MEMBER_PAGE_SIZE, visibleMembers.length)),
                )}{" "}
                از {toPersianDigits(String(visibleMembers.length))} عضو
              </p>
              <div className="flex gap-2">
                <SecondaryButton
                  onClick={() => setMemberPage(Math.max(1, currentMemberPage - 1))}
                  disabled={currentMemberPage <= 1}
                >
                  صفحهٔ قبل
                </SecondaryButton>
                <SecondaryButton
                  onClick={() => setMemberPage(Math.min(memberPages, currentMemberPage + 1))}
                  disabled={currentMemberPage >= memberPages}
                >
                  صفحهٔ بعد
                </SecondaryButton>
              </div>
            </div>
          ) : null}
        </div>
      </SectionCard>
      ) : null}

      {/*
        Issue #947 (TEAM-F08) — one onboarding entry point, three modes.

        The chooser is a tab strip for the same reason the views are: it is a set of peers
        with one selected, and the roles/arrow-key contract comes from the shared
        component rather than a hand-rolled row of buttons. The mode cards below it render
        the *same* forms as before — the ceremony itself is untouched; what changed is
        that a person adding a colleague starts from «what kind of access», not from
        whichever card they scrolled to first.
      */}
      {view === "onboarding" ? (
        <div className="space-y-4">
          <SectionCard
            title={
              <div>
                <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">شروع کار همکار</p>
                <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">افزودن همکار</h2>
              </div>
            }
            description="یک نقطهٔ شروع برای افزودن همکار؛ بر اساس نوع ورود او حالت را انتخاب کنید."
          >
            <TabBar
              idPrefix="team-onboarding"
              label="حالت افزودن همکار"
              tabs={onboardingModes}
              active={onboardingMode}
              onChange={setOnboardingMode}
            />
            <div className="mt-3 text-sm text-muted-foreground">
              {onboardingMode === "invite" ? (
                <p>
                  برای همکاری که ایمیل دارد و خودش رمز می‌سازد: لینک دعوت یک‌بار ساخته و
                  نمایش داده می‌شود و شما آن را برای او می‌فرستید (ارسال خودکار وجود
                  ندارد). ورود دومرحله‌ای در همان مسیر دعوت اعمال می‌شود.
                </p>
              ) : onboardingMode === "pin" ? (
                <p>
                  برای همکاران صندوق و آشپزخانه که روی دستگاه مشترک با رمز عددی وارد
                  می‌شوند و ایمیل ندارند. دسترسی شعبه در همین فرم و پیش از ساخت حساب
                  انتخاب می‌شود.
                </p>
              ) : (
                <p>
                  برای کسی که فقط پروندهٔ حسابداری/پرسنلی دارد — بدون حساب کاربری و بدون
                  ورود. چنین پرونده‌ای در فهرست «پروندهٔ کارکنان» ساخته می‌شود و در دورهٔ
                  حقوق و دستمزد (که به حساب کاربری متصل است) نمی‌آید؛ اگر بعداً حساب ساختید،
                  می‌توانید همین پرونده را از «جزئیات» عضو به او متصل کنید.
                </p>
              )}
            </div>
            {onboardingMode === "file" ? (
              <div className="mt-4">
                <PrimaryButton onClick={() => setView("files")}>
                  رفتن به پروندهٔ کارکنان
                </PrimaryButton>
              </div>
            ) : null}
          </SectionCard>

          {onboardingMode === "invite" ? (
            <InviteSection
              invitations={invitations}
              locations={locations}
              canManage={canManage}
              canManagePermissions={canManagePermissions}
              canManageOwners={isOwner}
              deploymentProfile={deploymentProfile}
              onChanged={load}
              onError={setError}
            />
          ) : null}
          {onboardingMode === "pin" ? (
            canManage ? (
              <AddStaffSection locations={locations} onChanged={load} onError={setError} />
            ) : (
              <InfoBox>
                ایجاد حساب کارمند با رمز عددی به دسترسی «مدیریت تیم» نیاز دارد؛ با دسترسی
                «مشاهدهٔ تیم» می‌توانید فهرست اعضا و پرونده‌ها را ببینید.
              </InfoBox>
            )
          ) : null}
        </div>
      ) : null}

      {view === "roles" ? (
        <div className="space-y-4">
          <RolesManager
            deploymentProfile={deploymentProfile}
            canManagePermissions={canManagePermissions}
          />
          {deploymentProfile === "local" ? <LocalToHybridGuide members={members} /> : null}
          {deploymentProfile === "hybrid" ? <IamSyncCard /> : null}
        </div>
      ) : null}

      {/*
        Issue #947 (TEAM-F08) — the reading surface, opened from the card. Its buttons
        hand off to the writers below rather than writing anything itself.
      */}
      {detail ? (
        <MemberDetailDialog
          member={detail}
          locationName={(id) => locationName.get(id) ?? null}
          drift={personnelDrift.find((row) => row.userId === detail.id) ?? null}
          isSelf={detail.id === currentUserId}
          canManage={canManage}
          canManageOwners={isOwner}
          permissions={granted}
          onClose={() => setDetail(null)}
          onEdit={() => setEditing(detail)}
          onEditPhone={() => setPhoneEditing(detail)}
          onEditCredentials={() => setCredentialsEditing(detail)}
          onLinkFile={() => void openFileLink(detail)}
          onOpenFiles={() => setView("files")}
          onRehire={() => setRehiring(detail)}
        />
      ) : null}

      {editing ? (
        <MemberEditorDialog
          member={editing}
          locations={locations}
          canManageOwners={isOwner}
          canManagePermissions={canManagePermissions}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}

      {phoneEditing ? (
        <PhoneEditorDialog
          member={phoneEditing}
          onClose={() => setPhoneEditing(null)}
          onSaved={() => {
            setPhoneEditing(null);
            void load();
          }}
        />
      ) : null}

      {credentialsEditing ? (
        <CredentialsEditorDialog
          member={credentialsEditing}
          isSelf={credentialsEditing.id === currentUserId}
          onClose={() => setCredentialsEditing(null)}
          onSaved={() => setCredentialsEditing(null)}
        />
      ) : null}

      {/*
        Personnel as parties (scope `team`): a staff member is a counterparty for
        payroll, advances and the phone number the shift lead calls, and those live on
        `parties` with `employee_user_id` pointing back at the account above. Shown
        here rather than in a screen of its own so the two views of one person cannot
        disagree about the name — and so editing a phone number here is editing it
        everywhere, the POS's customer picker included.

        Issue #854 (pass 4, gap 3) — the directory is `/api/parties`-backed and
        that route enforces `parties.view`, which a team manager's grant need
        not include. The section is hidden rather than rendered into a 403, and
        the permission itself is not widened to avoid the error.
      */}
      {view === "files" ? (
        canViewParties(role, permissions) ? (
        <div>
          <p className="mb-2 text-xs font-semibold text-amber-700 dark:text-amber-300">پروندهٔ کارکنان</p>
          {/*
            Issue #947 (TEAM-F07) — this door creates *only* the accounting record.
            Said out loud here rather than left to be discovered: a file created here has
            no login, and the guaranteed direction is the one above (an account creates
            its file), so connecting an existing file to an account is a deliberate step
            rather than a side effect of saving this form.
          */}
          <p className="mb-2 text-xs text-muted-foreground">
            این بخش فقط پروندهٔ حسابداری و تماس کارکنان را می‌سازد و ویرایش می‌کند — بدون حساب
            کاربری و بدون دسترسی ورود. برای کارمندی که با رمز عددی وارد می‌شود، از «ایجاد حساب
            کارمند با رمز عددی» بالای همین صفحه استفاده کنید.
          </p>
          <PartiesSection scope={partyScopeFor("team")} role={role} permissions={permissions} />
        </div>
        ) : (
          <InfoBox>
            پروندهٔ کارکنان از مسیر «اشخاص» ساخته و ویرایش می‌شود و دسترسی «مشاهدهٔ اشخاص»
            لازم دارد؛ دسترسی «مدیریت تیم» به‌تنهایی این فهرست را باز نمی‌کند.
          </InfoBox>
        )
      ) : null}

      {/* Issue #854 (P2.26) — suspension/offboarding confirmations. */}
      </TabPanel>

      <SecurityConfirmDialog
        open={pendingSuspend !== null}
        title={pendingSuspend ? `تعلیق حساب «${pendingSuspend.fullName}»` : ""}
        description="دسترسی این عضو به سامانه موقتاً قطع می‌شود."
        consequences={[
          "ورود او از همین لحظه قطع می‌شود و نشست‌های باز دیگر کار نمی‌کنند.",
          "سوابق کاری، اسناد و ثبت‌هایی که ساخته دست‌نخورده می‌مانند.",
          "هر زمان می‌توانید با «فعال‌سازی» حساب را بدون از دست رفتن اطلاعات برگردانید.",
        ]}
        confirmLabel="بله، تعلیق شود"
        busy={confirmBusy}
        onOpenChange={(next) => {
          if (!next) setPendingSuspend(null);
        }}
        onConfirm={() => {
          if (pendingSuspend) void executeSuspend(pendingSuspend);
        }}
      />
      <SecurityConfirmDialog
        open={pendingOffboard !== null}
        title={pendingOffboard ? `قطع همکاری «${pendingOffboard.fullName}»` : ""}
        description="همکاری این عضو با کسب‌وکار خاتمه می‌یابد."
        consequences={[
          "دسترسی، نشست‌های فعال و اعتبارنامه‌های ورود او لغو می‌شوند.",
          "اگر ورود دومرحله‌ای یا شمارهٔ ورودی داشته، برای این کسب‌وکار بی‌اثر می‌شوند.",
          "سوابق تاریخی و اسنادی که به نام او ثبت شده حفظ می‌شوند.",
          "بازگشت دوبارهٔ همین شخص با «بازگشت به کار» انجام می‌شود؛ هویت، نقش و دسترسی‌های ذخیره‌شدهٔ همین حساب بازمی‌گردند.",
        ]}
        confirmLabel="بله، قطع همکاری شود"
        busy={confirmBusy}
        onOpenChange={(next) => {
          if (!next) setPendingOffboard(null);
        }}
        onConfirm={() => {
          if (pendingOffboard) void executeOffboard(pendingOffboard);
        }}
      />

      {/*
        Issue #947 (TEAM-F07) — the controlled link flow.

        A dialog rather than a checkbox on the editor: linking is a one-way identity
        decision (one file per member, audited, and the file's name/mobile/email start
        following the account), so it names the file, says what will change, and is the
        only place that writes `employeeUserId` from this screen.
      */}
      <Dialog open={fileLinkTarget !== null} onOpenChange={(next) => (next ? null : setFileLinkTarget(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {fileLinkTarget ? `اتصال پروندهٔ پرسنلی به «${fileLinkTarget.fullName}»` : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              پرونده‌ای که انتخاب می‌کنید به این حساب متصل می‌شود و از این پس نام، موبایل و ایمیل آن از
              حساب کاربری می‌آید. سایر اطلاعات پرونده (نشانی، کد ملی، یادداشت‌ها و اطلاعات حسابداری) دست‌نخورده
              می‌ماند.
            </p>
            <Field
              label="جست‌وجوی پرونده"
              hint="نام یا کد حسابداری کارمند بدون حساب کاربری را بنویسید؛ جست‌وجو روی پرونده‌های همین کسب‌وکار انجام می‌شود."
            >
              <input
                className={inputClass}
                type="search"
                value={fileLinkQuery}
                onChange={(event) => setFileLinkQuery(event.target.value)}
                placeholder="نام یا کد حسابداری…"
              />
            </Field>
            {fileLinkLoading ? (
              // The design system's rule: a loading region reserves its final shape and
              // carries the spoken label on the skeleton, never as a bare sentence.
              <div role="status" aria-label="در حال جست‌وجوی پرونده‌ها">
                <LoadingSkeleton rows={1} />
              </div>
            ) : fileLinkOptions.length > 0 ? (
              <>
                <Field label="پروندهٔ بدون حساب کاربری">
                  <SearchableSelect
                    value={fileLinkChoice}
                    onChange={setFileLinkChoice}
                    options={fileLinkOptions}
                  />
                </Field>
                {fileLinkTotal > fileLinkOptions.length ? (
                  <p className="text-xs text-muted-foreground">
                    {toPersianDigits(String(fileLinkOptions.length))} پرونده از{" "}
                    {toPersianDigits(String(fileLinkTotal))} پروندهٔ یافت‌شده نمایش داده می‌شود؛
                    برای رسیدن به بقیه، جست‌وجو را دقیق‌تر کنید.
                  </p>
                ) : null}
              </>
            ) : (
              <InfoBox>
                {fileLinkQuery.trim()
                  ? "پروندهٔ بدون حساب کاربری با این جست‌وجو پیدا نشد. نام یا کد دیگری را امتحان کنید."
                  : "پروندهٔ پرسنلی بدون حساب کاربری در این کسب‌وکار پیدا نشد. اگر کارمند را از همین صفحه بسازید، پرونده‌اش خودکار ایجاد می‌شود."}
              </InfoBox>
            )}
            <ErrorBox>{fileLinkError}</ErrorBox>
          </div>
          <DialogFooter>
            <SecondaryButton onClick={() => setFileLinkTarget(null)}>انصراف</SecondaryButton>
            <PrimaryButton
              onClick={() => void submitFileLink()}
              disabled={fileLinkBusy || !fileLinkChoice}
            >
              اتصال پرونده
            </PrimaryButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Issue #854 (pass 4, gap 4) — the rehire ceremony. */}
      <RehireDialog
        member={rehiring}
        locations={locations}
        onClose={() => setRehiring(null)}
        onRehired={() => {
          setRehiring(null);
          void load();
        }}
      />
    </div>
  );
}

/** Persian sentences for the refusals the rehire ceremony can answer with. */
const REHIRE_ERROR_MESSAGES: Record<string, string> = {
  not_offboarded: "این عضو در وضعیت «قطع همکاری» نیست؛ فقط اعضای قطع‌همکاری‌شده با این مسیر بازمی‌گردند.",
  reason_required: "برای بازگشت به کار، دلیل این تغییر را بنویسید.",
  reason_too_short: "دلیل نوشته‌شده کوتاه است؛ حداقل ۸ نویسه بنویسید.",
  reason_too_long: "دلیل نوشته‌شده بلند است؛ حداکثر ۵۰۰ نویسه.",
  permissions_manage_required: "بازگشت به کار مجوز «مدیریت دسترسی‌های تیم» لازم دارد.",
  owner_only: "فقط مالک کسب‌وکار می‌تواند مالک را به کار برگرداند.",
  grants_beyond_actor: "نمی‌توانید عضوی را با دسترسی‌هایی که خودتان ندارید به کار برگردانید.",
  self_role_change: "بازگشت به کارِ خودتان مجاز نیست.",
  identity_required: "این عضو ایمیل ثبت‌شده ندارد؛ هویت ورودش قابل بازیابی نیست.",
  identity_not_found: "هویت ورود این عضو در سطح سامانه حذف شده است؛ با پشتیبانی تماس بگیرید.",
  already_a_member: "هویت ورود این عضو همین حالا به عضوی دیگر در این کسب‌وکار متصل است.",
  pin_required: "برای این نقش، رمز عددی فعالی برای بازیابی وجود ندارد؛ رمز عددی تازه‌ای تعیین کنید.",
  invalid_pin: `رمز عددی باید ${toPersianDigits(PIN_MIN_LENGTH)} تا ${toPersianDigits(PIN_MAX_LENGTH)} رقم باشد.`,
  custom_role_not_found: "نقش سفارشی ذخیره‌شدهٔ این عضو دیگر فعال نیست؛ ابتدا نقش او را مشخص کنید.",
  selected_locations_required: "شعبه‌های این عضو را انتخاب کنید.",
  home_location_required: "شعبهٔ اصلی این عضو را انتخاب کنید.",
  member_limit_exceeded: "سقف اعضای این کسب‌وکار پر است؛ ابتدا عضوی را خارج کنید یا سقف را افزایش دهید.",
  cloud_confirmation_required: "این سایت در حالت ترکیبی فقط محدودسازی می‌کند؛ بازگشت به کار باید از فضای ابری انجام شود.",
  unknown_location: "یکی از شعبه‌های انتخاب‌شده در این کسب‌وکار وجود ندارد.",
};

/**
 * Issue #854 (pass 4, gap 4) — the rehire ceremony.
 *
 * Offboarding is deliberately destructive (identity linkage severed, staff
 * credentials revoked, branch assignments wiped, history kept), so the way
 * back is an explicit form rather than a toggle:
 *
 *  - the branch policy is named again — the old assignments are gone;
 *  - a PIN-role member may get a fresh PIN, or leaves the field empty and the
 *    PIN active at offboarding is restored (the server refuses when there is
 *    nothing to restore, rather than activating a doorless member);
 *  - a password-role member's global identity, password and MFA factors come
 *    back with the relink — nothing here can bypass them;
 *  - the re-grant of the stored role and permissions carries a reason, like
 *    every access change.
 */
function RehireDialog({
  member,
  locations,
  onClose,
  onRehired,
}: {
  member: Member | null;
  locations: TeamLocation[];
  onClose: () => void;
  onRehired: () => void;
}) {
  const [scope, setScope] = useState<Member["locationScope"]>("selected");
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [defaultLocationId, setDefaultLocationId] = useState("");
  const [pin, setPin] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const memberId = member?.id ?? null;
  useEffect(() => {
    // A fresh ceremony for each member the dialog opens on.
    setScope("selected");
    setBranchIds([]);
    setDefaultLocationId("");
    setPin("");
    setReason("");
    setError("");
  }, [memberId]);

  if (!member) return null;
  const isOwnerRole = member.role === "owner";
  const isPinMember = PIN_ROLES.includes(member.role as (typeof PIN_ROLES)[number]);

  function toggleBranch(id: string, checked: boolean) {
    setBranchIds((current) => {
      const next = checked ? [...current, id] : current.filter((entry) => entry !== id);
      if (!checked && defaultLocationId === id) setDefaultLocationId("");
      return next;
    });
  }

  function chooseDefaultBranch(id: string) {
    setDefaultLocationId(id);
    if (id) setBranchIds((current) => (current.includes(id) ? current : [...current, id]));
  }

  async function submit() {
    if (!member) return;
    if (reason.trim().length < 8) {
      setError("برای بازگشت به کار، دلیل این تغییر را بنویسید (حداقل ۸ نویسه).");
      return;
    }
    if (!isOwnerRole && scope === "selected" && branchIds.length === 0) {
      setError("شعبه‌های این عضو را انتخاب کنید.");
      return;
    }
    if (!isOwnerRole && scope === "home" && !defaultLocationId) {
      setError("شعبهٔ اصلی این عضو را انتخاب کنید.");
      return;
    }
    if (isPinMember && pin && !isValidPin(pin)) {
      setError(`رمز عددی باید ${toPersianDigits(PIN_MIN_LENGTH)} تا ${toPersianDigits(PIN_MAX_LENGTH)} رقم باشد.`);
      return;
    }
    setBusy(true);
    setError("");
    const res = await api<{ error?: string; reason?: string }>(`/api/team/${member.id}/rehire`, {
      method: "POST",
      body: JSON.stringify({
        reason: reason.trim(),
        locationScope: isOwnerRole ? "all" : scope,
        locationIds: !isOwnerRole && scope === "selected" ? branchIds : [],
        defaultLocationId: !isOwnerRole && scope === "home" ? defaultLocationId : null,
        ...(isPinMember && pin ? { pin } : {}),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const code = res.data.error ?? "";
      setError(res.data.reason || REHIRE_ERROR_MESSAGES[code] || errorMessage(code));
      return;
    }
    onRehired();
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>بازگشت به کار «{member.fullName}»</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            قطع همکاری، هویت ورود، اعتبارنامه‌ها و شعبه‌های این عضو را لغو کرده اما نقش،
            دسترسی‌ها و سوابق او را نگه داشته است. این فرم همهٔ آن‌ها را یک‌جا بازمی‌گرداند.
          </p>
          <ErrorBox>{error}</ErrorBox>

          {isOwnerRole ? (
            <InfoBox>مالک به همهٔ شعبه‌ها دسترسی دارد.</InfoBox>
          ) : (
            <>
              <Field label="دامنهٔ شعبه">
                <SearchableSelect
                  value={scope}
                  onChange={(value) => setScope(value as Member["locationScope"])}
                  options={[
                    { value: "all", label: "همهٔ شعبه‌ها" },
                    { value: "selected", label: "شعبه‌های انتخابی" },
                    { value: "home", label: "فقط شعبهٔ اصلی" },
                  ]}
                />
              </Field>
              {scope === "selected" ? (
                <Field label="شعبه‌ها" hint="شعبه‌هایی که این عضو به آن‌ها دسترسی دارد.">
                  {locations.length === 0 ? (
                    <p className="text-xs text-muted-foreground">شعبه‌ای ثبت نشده است.</p>
                  ) : (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {locations.map((location) => (
                        <label key={location.id} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={branchIds.includes(location.id)}
                            onCheckedChange={(checked) => toggleBranch(location.id, checked === true)}
                          />
                          <span>
                            {location.name}
                            {!location.isActive ? (
                              <span className="ms-1 text-xs text-muted-foreground">(غیرفعال)</span>
                            ) : null}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </Field>
              ) : null}
              {scope === "home" ? (
                <Field label="شعبهٔ اصلی" hint="تنها شعبه‌ای که این عضو به آن دسترسی دارد.">
                  <SearchableSelect
                    value={defaultLocationId}
                    onChange={chooseDefaultBranch}
                    options={[
                      { value: "", label: "— انتخاب نشده —" },
                      ...locations.map((location) => ({ value: location.id, label: location.name })),
                    ]}
                  />
                </Field>
              ) : null}
            </>
          )}

          {isPinMember ? (
            <Field
              label="رمز عددی (اختیاری)"
              hint="خالی بگذارید تا رمز عددیِ زمان قطع همکاری بازیابی شود؛ یا رمز تازه‌ای تعیین کنید."
            >
              <input
                className={`${inputClass} w-48 text-center tracking-[0.25em]`}
                dir="ltr"
                inputMode="numeric"
                maxLength={PIN_MAX_LENGTH}
                value={pin}
                onChange={(e) => setPin(toLatinDigits(e.target.value).replace(/[^0-9]/g, ""))}
                placeholder="----"
              />
            </Field>
          ) : null}

          <Field label="دلیل بازگشت به کار *">
            <textarea
              className={`${inputClass} min-h-20`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="مثلاً: قرارداد دوباره از آبان شروع می‌شود."
            />
          </Field>
        </div>
        <DialogFooter>
          <SecondaryButton onClick={onClose} disabled={busy}>
            انصراف
          </SecondaryButton>
          <PrimaryButton onClick={() => void submit()} disabled={busy}>
            {busy ? "در حال بازگرداندن…" : "بازگشت به کار"}
          </PrimaryButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The full member editor — everything a membership carries that a row of
 * buttons cannot ask for in one line: the name, the role (which re-bases the
 * permission ticks), the branch assignment, the default branch, and the
 * per-permission overrides.
 *
 * The name edit doubles as the repair path for the personnel file: the route
 * keeps the party record named after the member (see `personnel-file.ts`),
 * so «علی رضایی» in the list above and «علی رضایی» in the payroll file stay
 * one person.
 */
function MemberEditorDialog({
  member,
  locations,
  canManageOwners,
  canManagePermissions,
  onClose,
  onSaved,
}: {
  member: Member;
  locations: TeamLocation[];
  canManageOwners: boolean;
  /** Issue #854 (P2.4): whether this actor may hand out capabilities at all. */
  canManagePermissions: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(member.fullName);
  const [role, setRole] = useState(member.role);
  const [customRoleId, setCustomRoleId] = useState(member.customRoleId ?? "");
  const [customRoles, setCustomRoles] = useState<Array<{id:string;name:string;permissions:string[];isActive:boolean}>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set(member.effectivePermissions));
  /** The set as loaded — `AccessChangeSummary` diffs against this, not against the preset. */
  const [initialSelected] = useState<Set<string>>(new Set(member.effectivePermissions));
  const [locationScope, setLocationScope] = useState(member.locationScope);
  const [branchIds, setBranchIds] = useState<string[]>(member.locationIds);
  const [defaultLocationId, setDefaultLocationId] = useState(member.defaultLocationId ?? "");
  const [permissionSearch, setPermissionSearch] = useState("");
  /**
   * Issue #854 (P2.4) — the operator's reason for an access change.
   *
   * The field appears only when this form is actually about to change access:
   * the role, the custom role or the ticks. Asking for a justification while
   * somebody fixes a typo in a name is how a required reason turns into "asdf"
   * typed fifty times a week.
   */
  const [accessReason, setAccessReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void api<{roles:Array<{id:string;name:string;permissions:string[];isActive:boolean}>}>("/api/team/roles").then((res) => { if (res.ok) setCustomRoles(res.data.roles.filter((item) => item.isActive)); }); }, []);

  // Re-base the ticks whenever the role changes, so the boxes always show what
  // that role would actually grant.
  function changeRole(next: string) {
    setRole(next);
    setCustomRoleId("");
    setSelected(new Set(roleBasePermissions(next as never)));
  }

  function toggleBranch(id: string, checked: boolean) {
    setBranchIds((current) => {
      const next = checked ? [...current, id] : current.filter((entry) => entry !== id);
      // Unticking the default branch moves the default back to "none chosen"
      // rather than leaving it pointing at a branch the member no longer has.
      if (!checked && defaultLocationId === id) setDefaultLocationId("");
      return next;
    });
  }

  function chooseDefaultBranch(id: string) {
    setDefaultLocationId(id);
    // The default is one of the assigned branches by definition — tick it
    // rather than storing a default the access rules would ignore.
    if (id) setBranchIds((current) => (current.includes(id) ? current : [...current, id]));
  }

  const customPreset = customRoles.find((item) => item.id === customRoleId)?.permissions;
  const preset = new Set<string>(customPreset ?? roleBasePermissions(role as never));
  const isOwnerRole = role === "owner";
  /**
   * Issue #854 (P1.12) — say what the new role needs *before* the save is
   * refused.
   *
   * The server will not invent a credential on the member's behalf (see
   * `assertRoleTransitionKeepsLoginPath`), so a cross-model role change needs
   * one the member already has: a global identity for a password role, a PIN for
   * a staff role. The refusal is correct either way; the admin should not have
   * to learn it by pressing «ذخیره» and reading an error. This is a warning,
   * never a substitute for the check — the client cannot know what the database
   * will hold at commit time.
   */
  const credentialModelChanges =
    loginCredentialModelForRole(role as never) !==
    loginCredentialModelForRole(member.role as never);
  const missingCredential =
    credentialModelChanges && member.isActive
      ? loginCredentialModelForRole(role as never) === "password" && !member.hasLogin
        ? "این نقش با ایمیل و گذرواژه وارد می‌شود. این عضو هنوز هویت ورود ندارد؛ ابتدا برای او دعوت‌نامه بفرستید یا هویت ورودش را متصل کنید."
        : loginCredentialModelForRole(role as never) === "pin" && !member.hasPin
          ? "این نقش در دستگاه با رمز عددی وارد می‌شود. ابتدا از بخش «ورود و اعتبارنامه» برای این عضو رمز عددی تعیین کنید."
          : ""
      : "";

  async function save() {
    const name = fullName.trim();
    if (!name) {
      setError("نام عضو را بنویسید.");
      return;
    }
    /**
     * Issue #854 (P2.4) — is this save an access change?
     *
     * Compared against what was *loaded*, not against the role preset: the
     * server compares against the stored row, and the two must agree or the
     * form will either demand a reason the server does not want or send one it
     * refuses to accept without.
     */
    const roleChanged = canManagePermissions && role !== member.role;
    const customRoleChanged =
      canManagePermissions && !isOwnerRole && (customRoleId || null) !== (member.customRoleId ?? null);
    const permissionsChanged =
      canManagePermissions &&
      !isOwnerRole &&
      ([...selected].sort().join("\u0000") !== [...initialSelected].sort().join("\u0000"));
    const accessChanged = roleChanged || customRoleChanged || permissionsChanged;
    if (accessChanged && accessReason.trim().length < 8) {
      setError("برای تغییر نقش یا دسترسی‌ها، دلیل این تغییر را بنویسید (حداقل ۸ نویسه).");
      return;
    }

    setBusy(true);
    setError("");
    const granted = [...selected].filter((p) => !preset.has(p)).sort();
    const revoked = [...preset].filter((p) => !selected.has(p)).sort();
    /**
     * Issue #854 (P2.3/P2.4): the permission half of this form is only sent by
     * an actor who holds `team.permissions_manage`. A read-only visit leaves
     * `selected` untouched, so the diff would be empty anyway — but "empty"
     * still means the server has to decide, and a client that posts an empty
     * override set is a client that will one day post a non-empty one.
     */
    const accessFields = canManagePermissions && !isOwnerRole
      ? {
          customRoleId: customRoleId || null,
          permissions: { granted, revoked },
        }
      : {};
    const res = await api<{ error?: string; reason?: string }>(`/api/team/${member.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        fullName: name,
        // Issue #854 (P2.4) — stored with the actor and the change itself.
        ...(accessChanged ? { reason: accessReason.trim() } : {}),
        // The role itself is a capability change (it re-bases the preset), so
        // it travels with the same permission rather than with the name edit.
        ...(canManagePermissions ? { role } : {}),
        ...accessFields,
        locationScope: isOwnerRole ? "all" : locationScope,
        locationIds: locationScope === "selected" ? branchIds : [],
        defaultLocationId: locationScope === "home" ? (defaultLocationId || null) : null,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.data.reason || errorMessage(res.data.error));
      return;
    }
    onSaved();
  }

  return (
    <Sheet open onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent side="left" className="w-full max-w-none overflow-y-auto p-0 sm:max-w-2xl">
        <SheetHeader className="sticky top-0 z-10 border-b bg-background px-5 py-4 text-start">
          <SheetTitle>ویرایش «{member.fullName}»</SheetTitle>
          <nav aria-label="بخش‌های عضو" className="mt-3 flex gap-2 overflow-x-auto pb-1 text-xs">
            <a className="rounded-full bg-muted px-3 py-1.5 focus-visible:ring" href="#member-profile">پروفایل و نقش</a>
            <a className="rounded-full bg-muted px-3 py-1.5 focus-visible:ring" href="#member-branches">شعبه‌ها</a>
            <a className="rounded-full bg-muted px-3 py-1.5 focus-visible:ring" href="#member-access">دسترسی‌ها</a>
          </nav>
        </SheetHeader>
        <div className="space-y-5 px-5 py-4">
        <div id="member-profile" className="scroll-mt-28">
        <ErrorBox>{error}</ErrorBox>
        {missingCredential ? <InfoBox>{missingCredential}</InfoBox> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="نام و نام خانوادگی *">
            <input
              className={inputClass}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </Field>
          <Field label="نقش">
            <SearchableSelect
              value={role}
              onChange={changeRole}
              options={canManageOwners ? ROLE_OPTIONS : ROLE_OPTIONS.filter((option) => option.value !== "owner")}
            />
          </Field>
          <Field label="نقش سفارشی" hint="در صورت انتخاب، الگوی دسترسی نقش سیستمی را جایگزین می‌کند.">
            <SearchableSelect value={customRoleId} disabled={isOwnerRole} onChange={(value) => {
              setCustomRoleId(value);
              const custom = customRoles.find((item) => item.id === value);
              setSelected(new Set(custom?.permissions ?? roleBasePermissions(role as never)));
            }} options={[{value:"",label:"بدون نقش سفارشی"},...customRoles.map((item)=>({value:item.id,label:item.name}))]} />
          </Field>
        </div></div>

        <div id="member-branches" className="scroll-mt-28 space-y-4"><Field label="دامنهٔ شعبه">
          <SearchableSelect
            value={isOwnerRole ? "all" : locationScope}
            onChange={(value) => setLocationScope(value as Member["locationScope"])}
            disabled={isOwnerRole}
            options={[
              { value: "all", label: "همهٔ شعبه‌ها" },
              { value: "selected", label: "شعبه‌های انتخابی" },
              { value: "home", label: "فقط شعبهٔ اصلی" },
              { value: "none", label: "بدون دسترسی شعبه" },
            ]}
          />
        </Field>

        {locationScope === "selected" ? <Field label="شعبه‌ها" hint="فقط شعبه‌های انتخاب‌شده در دسترس خواهند بود.">
          {locations.length === 0 ? (
            <p className="text-xs text-muted-foreground">شعبه‌ای ثبت نشده است.</p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {locations.map((location) => (
                <label key={location.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={branchIds.includes(location.id)}
                    onCheckedChange={(checked) => toggleBranch(location.id, checked === true)}
                  />
                  <span>
                    {location.name}
                    {!location.isActive ? (
                      <span className="ms-1 text-xs text-muted-foreground">(غیرفعال)</span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          )}
        </Field> : null}

        {locationScope === "home" ? <Field label="شعبهٔ اصلی" hint="تنها شعبه‌ای که این عضو به آن دسترسی دارد.">
          <SearchableSelect
            value={defaultLocationId}
            onChange={chooseDefaultBranch}
            options={[
              { value: "", label: "— انتخاب نشده —" },
              ...locations.map((location) => ({ value: location.id, label: location.name })),
            ]}
          />
        </Field> : null}

        </div>
        <div id="member-access" className="scroll-mt-28">
          {/*
            Issue #854 (P2.3/P2.4) — this used to be a second, private copy of the
            permission catalogue: a flat grid of `ALL_PERMISSIONS` with labels from a
            map kept here, no grouping, no risk signal and no provenance. All of that
            already exists in `permission-registry.ts` and is rendered by
            `PermissionEditor`, which is the component `roles-manager.tsx` uses — so
            the same capability is described one way in both places now, and a
            permission added to the registry appears here without this file changing.
          */}
          {isOwnerRole ? (
            <InfoBox>مالک به همهٔ بخش‌ها دسترسی دارد و دسترسی‌هایش قابل محدود کردن نیست.</InfoBox>
          ) : !canManagePermissions ? (
            <InfoBox>
              نمایش دسترسی‌ها در حالت فقط‌خواندنی است. برای تغییر دسترسی‌ها به مجوز
              «مدیریت دسترسی‌ها» نیاز دارید.
              <div className="mt-3">
                <PermissionEditor
                  preset={preset}
                  selected={selected}
                  onChange={() => {}}
                  readOnly
                />
              </div>
            </InfoBox>
          ) : (
            <Field
              label="دسترسی‌ها"
              hint="تیک‌ها نسبت به نقش پایه خوانده می‌شوند: برداشتن تیکِ پیش‌فرض یعنی گرفتن آن دسترسی، و تیکِ اضافه یعنی اعطای آن. وابستگی‌ها خودکار اعمال می‌شوند."
            >
              <PermissionEditor preset={preset} selected={selected} onChange={setSelected} />
              <div className="mt-3">
                <AccessChangeSummary before={initialSelected} after={selected} />
              </div>
              {/*
                Issue #854 (P2.4) — shown exactly when the save would change
                access, so the reason is asked for as part of the change rather
                than refused as a surprise after the button is pressed.
              */}
              {(role !== member.role ||
                (customRoleId || null) !== (member.customRoleId ?? null) ||
                [...selected].sort().join("\u0000") !==
                  [...initialSelected].sort().join("\u0000")) && (
                <div className="mt-3">
                  <Field
                    label="دلیل این تغییر دسترسی"
                    hint="با نام شما و خودِ تغییر در سابقهٔ حسابرسی ثبت می‌شود."
                  >
                    <textarea
                      className={inputClass}
                      value={accessReason}
                      onChange={(e) => setAccessReason(e.target.value)}
                      rows={2}
                      maxLength={500}
                    />
                  </Field>
                </div>
              )}
            </Field>
          )}
        </div></div>
        <SheetFooter className="sticky bottom-0 border-t bg-background px-5 py-4">
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton onClick={save} disabled={busy}>ذخیره</PrimaryButton>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Phase 42 — set or clear one member's login phone.
 *
 * An owner typing a number proves nothing about who holds it, so whatever is
 * saved here lands *unverified* — the member proves it with an OTP at their
 * next door login (or from the security center), and only then does it
 * become usable for the phone login. The hint says so, because an owner who
 * is not told will assume typing the number was the whole job.
 */
function PhoneEditorDialog({
  member,
  onClose,
  onSaved,
}: {
  member: Member;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [phone, setPhone] = useState(member.phone ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    const res = await api<{ error?: string; reason?: string }>(`/api/team/${member.id}`, {
      method: "PATCH",
      body: JSON.stringify({ phone: phone.trim() }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.data.reason || errorMessage(res.data.error));
      return;
    }
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>شمارهٔ موبایل «{member.fullName}»</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>
        <Field
          label="شمارهٔ موبایل ورود"
          hint="با کد پیامکی که در اولین ورود به خود عضو می‌رسد تأیید می‌شود؛ خالی بگذارید تا حذف شود."
        >
          <input
            className={inputClass}
            dir="ltr"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="09121234567"
          />
        </Field>
        <DialogFooter>
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton onClick={save} disabled={busy}>
            ذخیرهٔ شماره
          </PrimaryButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The credential reset — a PIN for the shared-device roles, a password for
 * the email roles, matching `PUT /api/team/:id/credentials` (the owner's
 * force-reset path; a member changing their *own* password must prove the
 * current one, which is the security center's business, not this dialog's).
 *
 * The two are separate buttons and separate requests on purpose: resetting a
 * password changes the person's *platform* login everywhere they are a
 * member, and that deserves its own explicit press rather than riding along
 * with a PIN change.
 */
function CredentialsEditorDialog({
  member,
  isSelf,
  onClose,
}: {
  member: Member;
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isPinMember = member.hasPin || (PIN_ROLES as readonly string[]).includes(member.role);
  const [pin, setPin] = useState("");
  const [resetUrl, setResetUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function resetPin() {
    if (!isValidPin(pin)) {
      setError("رمز عددی باید ۴ تا ۱۲ رقم باشد.");
      return;
    }
    setBusy(true);
    setError("");
    setDone("");
    const res = await api<{ error?: string }>(`/api/team/${member.id}/credentials`, {
      method: "PUT",
      body: JSON.stringify({ pin }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data.error));
      return;
    }
    setPin("");
    setDone("رمز عددی جدید ثبت شد.");
  }

  async function sendPasswordReset() {
    setBusy(true);
    setError("");
    setDone("");
    setResetUrl("");
    const res = await api<{ error?: string; resetUrl?: string }>(
      `/api/team/${member.id}/credentials`,
      {
        method: "PUT",
        body: JSON.stringify({ action: "send_password_reset" }),
      },
    );
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data.error));
      return;
    }
    if (res.data.resetUrl) setResetUrl(res.data.resetUrl);
    setDone("لینک یک‌بارمصرف بازیابی رمز عبور صادر شد تا خود کاربر رمز جدیدش را تعیین کند.");
  }

  async function revokeSessions() {
    setBusy(true);
    setError("");
    setDone("");
    const res = await api<{ error?: string }>(`/api/team/${member.id}/credentials`, {
      method: "PUT",
      body: JSON.stringify({ action: "revoke_sessions" }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data.error));
      return;
    }
    setDone("نشست‌های فعال این عضو در این کسب‌وکار خاتمه یافتند.");
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>اعتبارنامه و نشست‌های «{member.fullName}»</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>
        {done ? <InfoBox>{done}</InfoBox> : null}

        {isPinMember ? (
          <Field
            label={`رمز عددی جدید (${toPersianDigits(PIN_MIN_LENGTH)} تا ${toPersianDigits(PIN_MAX_LENGTH)} رقم)`}
            /* Issue #947 (TEAM-F03) — same wrong claim as the add form's, corrected the
               same way: since #953 a PIN is a personal secret, not an identifier, so
               nothing here may promise it is unique. */
            hint="رمز شخصی همین عضو است؛ در فهرست ورود با نام او پیدا می‌شود."
          >
            <input
              className={`${inputClass} w-48 text-center tracking-[0.25em]`}
              dir="ltr"
              inputMode="numeric"
              maxLength={PIN_MAX_LENGTH}
              value={pin}
              onChange={(e) => setPin(toLatinDigits(e.target.value).replace(/[^0-9]/g, ""))}
            />
          </Field>
        ) : null}

        {member.hasLogin ? (
          isSelf ? (
            <InfoBox>
              برای تغییر رمز عبور خودتان (با تأیید رمز فعلی و مدیریت نشست‌ها) به بخش{" "}
              <Link
                href="/settings/profile"
                className="font-semibold text-primary underline underline-offset-4"
              >
                حساب کاربری من
              </Link>{" "}
              مراجعه کنید.
            </InfoBox>
          ) : (
            <div className="space-y-3 rounded-xl border border-border/80 bg-muted/30 p-3 text-xs">
              <p className="font-semibold text-foreground">بازیابی امن رمز عبور سراسری</p>
              <p className="text-muted-foreground">
                به‌دلایل امنیتی، مدیر کسب‌وکار نمی‌تواند رمز عبور سراسری کاربر دیگری را مستقیماً
                تعیین کند. در صورت فراموشی رمز، لینک یک‌بارمصرف بازیابی صادر کنید تا خود کاربر رمز
                جدیدش را ثبت نماید.
              </p>
              <div className="flex flex-wrap gap-2">
                <SecondaryButton onClick={sendPasswordReset} disabled={busy}>
                  ارسال لینک بازیابی رمز عبور
                </SecondaryButton>
                <SecondaryButton onClick={revokeSessions} disabled={busy}>
                  خاتمه دادن به نشست‌های فعال
                </SecondaryButton>
              </div>
              {resetUrl ? (
                <div className="mt-2 space-y-1">
                  <p className="text-muted-foreground">لینک یک‌بارمصرف بازیابی (معتبر به مدت محدود):</p>
                  <input
                    className={`${inputClass} font-mono text-xs`}
                    dir="ltr"
                    readOnly
                    value={resetUrl}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </div>
              ) : null}
            </div>
          )
        ) : null}

        {!isPinMember && !member.hasLogin ? (
          <InfoBox>این عضو نه رمز عددی دارد و نه ورود ایمیلی؛ ابتدا نقش یا روش ورودش را در ویرایش عضو تعیین کنید.</InfoBox>
        ) : null}

        <DialogFooter>
          <SecondaryButton onClick={onClose}>بستن</SecondaryButton>
          {isPinMember ? (
            <PrimaryButton onClick={resetPin} disabled={busy || !pin}>
              ثبت رمز عددی
            </PrimaryButton>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteSection({
  invitations,
  locations,
  canManage,
  canManagePermissions,
  canManageOwners,
  deploymentProfile,
  onChanged,
  onError,
}: {
  invitations: Invitation[];
  locations: TeamLocation[];
  canManage: boolean;
  canManagePermissions: boolean;
  canManageOwners: boolean;
  deploymentProfile: "cloud" | "hybrid" | "local";
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<string>("manager");
  const [customRoleId, setCustomRoleId] = useState("");
  const [customRoles, setCustomRoles] = useState<Array<{ id: string; name: string }>>([]);
  // Issue #854 (P2.4): the invite's access reason — asked for exactly when the
  // invite grants a custom role, mirroring the server's requirement.
  const [inviteReason, setInviteReason] = useState("");
  const [locationScope, setLocationScope] = useState<"all" | "selected" | "home" | "none">("all");
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [defaultLocationId, setDefaultLocationId] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!canManagePermissions) return;
    void api<{ roles: Array<{ id: string; name: string; isActive: boolean }> }>("/api/team/roles").then(
      (res) => {
        if (res.ok) setCustomRoles(res.data.roles.filter((item) => item.isActive));
      },
    );
  }, [canManagePermissions]);

  /**
   * Issue #854 (P2.11/P2.12) — the invitation carries the branch policy and the
   * custom role, so the form asks for them.
   *
   * Before this, the API validated `locationScope`, `locationIds` and
   * `customRoleId` and the form sent none of the three: every invite landed
   * with the membership defaults, and the only way to give an invitee a
   * restricted branch set or a custom role was to invite them wide and narrow
   * them afterwards — a window in which they had more access than intended.
   *
   * `role` is deliberately still sent alongside a custom role: it is what the
   * membership falls back to if the role is later deleted (`ON DELETE SET
   * NULL`), and the server rejects the escalation either way.
   */
  async function invite() {
    if (customRoleId && inviteReason.trim().length < 8) {
      onError("برای دعوت با نقش اختصاصی، دلیل این دسترسی را بنویسید (حداقل ۸ نویسه).");
      return;
    }
    setBusy(true);
    onError("");
    setLink("");
    const res = await api<{ url?: string; error?: string }>("/api/team/invitations", {
      method: "POST",
      body: JSON.stringify({
        email,
        fullName,
        role,
        ...(canManagePermissions ? { customRoleId: customRoleId || null } : {}),
        // Sent only when the invite actually grants extra access — the same
        // condition the server validates.
        ...(customRoleId ? { reason: inviteReason.trim() } : {}),
        locationScope,
        locationIds: locationScope === "selected" ? branchIds : [],
        defaultLocationId: locationScope === "home" ? defaultLocationId || null : null,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      onError(errorMessage(res.data.error));
      return;
    }
    setLink(res.data.url ?? "");
    setEmail("");
    setFullName("");
    setCustomRoleId("");
    setInviteReason("");
    await onChanged();
  }

  function toggleBranch(id: string, checked: boolean) {
    setBranchIds((current) => {
      const next = checked ? [...current, id] : current.filter((entry) => entry !== id);
      if (!checked && defaultLocationId === id) setDefaultLocationId("");
      return next;
    });
  }

  /** A Hybrid site cannot originate memberships at all (#854 P1.13). */
  const invitesBlocked = deploymentProfile === "hybrid";

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">دعوت و همکاری</p>
          <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">دعوت همکار</h2>
        </div>
      }
      description="همکاران جدید را با ارسال لینک دعوت به سیستم اضافه کنید."
    >
      {invitesBlocked ? (
        <InfoBox>
          این سایت در حالت ابری/محلی است: دعوت اعضا از فضای ابری انجام می‌شود و
          ساخت دعوت روی این سایت ممکن نیست.
        </InfoBox>
      ) : !canManage ? (
        <InfoBox>
          شما دسترسی «مشاهدهٔ تیم» را دارید؛ ساخت یا لغو دعوت به «مدیریت تیم» نیاز دارد.
        </InfoBox>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="نام">
              <input className={inputClass} value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </Field>
            <Field label="ایمیل">
              <input
                className={inputClass}
                dir="ltr"
                value={email}
                type="email"
                autoComplete="email"
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="نقش">
              <SearchableSelect
                value={role}
                onChange={setRole}
                options={INVITABLE_ROLES.filter((r) => canManageOwners || r !== "owner").map((r) => ({ value: r, label: roleLabel(r) }))}
              />
            </Field>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {canManagePermissions ? (
              <Field
                label="نقش اختصاصی (اختیاری)"
                hint="اگر انتخاب شود، دسترسی‌های همین نقش به عضو داده می‌شود."
              >
                <SearchableSelect
                  value={customRoleId}
                  onChange={setCustomRoleId}
                  options={[
                    { value: "", label: "— بدون نقش اختصاصی —" },
                    ...customRoles.map((item) => ({ value: item.id, label: item.name })),
                  ]}
                />
              </Field>
            ) : null}
            {canManagePermissions && customRoleId ? (
              <Field
                label="دلیل این دسترسی"
                hint="با نام دعوت‌کننده در سابقهٔ حسابرسی ثبت می‌شود."
              >
                <textarea
                  className={inputClass}
                  value={inviteReason}
                  onChange={(e) => setInviteReason(e.target.value)}
                  rows={2}
                  maxLength={500}
                />
              </Field>
            ) : null}
            <Field label="دسترسی شعبه" hint="از همان ابتدا محدود دعوت کنید، نه بعد از پذیرش.">
              <SearchableSelect
                value={locationScope}
                onChange={(value) => setLocationScope(value as typeof locationScope)}
                options={[
                  { value: "all", label: "همهٔ شعبه‌ها" },
                  { value: "selected", label: "شعبه‌های انتخابی" },
                  { value: "home", label: "فقط شعبهٔ اصلی" },
                  { value: "none", label: "بدون دسترسی شعبه" },
                ]}
              />
            </Field>
          </div>

          {locationScope === "selected" ? (
            <Field label="شعبه‌ها" hint="فقط شعبه‌های انتخاب‌شده در دسترس خواهند بود.">
              {locations.length === 0 ? (
                <p className="text-xs text-muted-foreground">شعبه‌ای ثبت نشده است.</p>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {locations.map((location) => (
                    <label key={location.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={branchIds.includes(location.id)}
                        onCheckedChange={(checked) => toggleBranch(location.id, checked === true)}
                      />
                      <span>{location.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </Field>
          ) : null}

          {locationScope === "home" ? (
            <Field label="شعبهٔ اصلی" hint="تنها شعبه‌ای که این عضو به آن دسترسی دارد.">
              <SearchableSelect
                value={defaultLocationId}
                onChange={setDefaultLocationId}
                options={[
                  { value: "", label: "— انتخاب نشده —" },
                  ...locations.map((location) => ({ value: location.id, label: location.name })),
                ]}
              />
            </Field>
          ) : null}

          <div className="mt-4">
            <PrimaryButton
              onClick={invite}
              disabled={
                busy ||
                !email ||
                !fullName ||
                (locationScope === "selected" && branchIds.length === 0) ||
                (locationScope === "home" && !defaultLocationId)
              }
            >
              ساخت لینک دعوت
            </PrimaryButton>
          </div>
        </>
      )}

      {link && (
        <div className="mt-4">
          <InfoBox>
            این لینک فقط همین یک‌بار نمایش داده می‌شود. آن را برای همکارتان بفرستید:
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input className={`${inputClass} min-w-0 flex-1`} aria-label="لینک دعوت" dir="ltr" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
              <SecondaryButton onClick={() => void navigator.clipboard.writeText(link)}>کپی لینک</SecondaryButton>
            </div>
          </InfoBox>
        </div>
      )}

      {invitations.length > 0 && (
        <ul className="mt-4 divide-y divide-border/80 text-sm">
          {invitations.map((invitation) => (
            <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span>
                {invitation.fullName} · <span dir="ltr">{invitation.email}</span> ·{" "}
                {invitation.customRoleName ?? roleLabel(invitation.role)} ·{" "}
                <span className="text-muted-foreground">
                  {/* The branch policy travels with the invitation (P2.11). */}
                  {invitation.locationScope
                    ? `${INVITE_SCOPE_LABELS[invitation.locationScope]} · `
                    : ""}
                  {INVITATION_STATUS_LABELS[invitation.status]}
                  {invitation.status === "pending" &&
                    ` تا ${toPersianDigits(formatJalali(new Date(invitation.expiresAt)))}`}
                </span>
              </span>
              {invitation.status === "pending" && canManage && (
                <SecondaryButton
                  onClick={async () => {
                    const result = await api<{ error?: string }>(`/api/team/invitations/${invitation.id}`, { method: "DELETE" });
                    if (!result.ok) {
                      onError(errorMessage(result.data.error));
                      return;
                    }
                    await onChanged();
                  }}
                >
                  لغو
                </SecondaryButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function AddStaffSection({
  locations,
  onChanged,
  onError,
}: {
  locations: TeamLocation[];
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<string>("cashier");
  const [pin, setPin] = useState("");
  // Phase 42 — optional login phone, stored unverified until the member's
  // first OTP proves it (mirrors PhoneEditorDialog above).
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * Issue #947 (TEAM-F03) — the branch policy is a field on this form now.
   *
   * It always was a field on the *server* (`locationScope`, migration 0170), and
   * this form never sent it. `createMembership` then fell back — `ELSE 'all'` in
   * the INSERT — so every PIN member created from this screen silently got every
   * branch of the business, with no `user_locations` row to show it: a cashier
   * hired for one till held branch-wide access, and the owner who wanted to
   * restrict them had to notice afterwards and edit the member. The default below
   * is deliberately *not* a hidden constant: with one branch there is nothing to
   * decide (the two answers are the same), and with more than one the form starts
   * undecided and the button waits.
   */
  const activeLocations = locations.filter((location) => location.isActive);
  const [locationScope, setLocationScope] = useState<string>(
    activeLocations.length <= 1 ? "all" : "",
  );
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [defaultLocationId, setDefaultLocationId] = useState("");

  /** The policy is complete when the chosen scope has what it needs. */
  const scopeComplete =
    locationScope === "all" ||
    locationScope === "none" ||
    (locationScope === "selected" && branchIds.length > 0) ||
    (locationScope === "home" && Boolean(defaultLocationId));

  /**
   * Switching the role empties the PIN and the phone: a PIN is per-role
   * length-wise identical but per-member unique, and a number typed for one
   * person must not silently ride along into another's account. (Before, the
   * PIN typed for a cashier stayed in the box while the owner picked
   * «آشپزخانه», and if they did not notice, the kitchen member was created
   * with the cashier's intended PIN.)
   */
  function changeRole(next: string) {
    if (next === role) return;
    setRole(next);
    setPin("");
    setPhone("");
  }

  async function add() {
    setBusy(true);
    onError("");
    const res = await api<{ error?: string }>("/api/team", {
      method: "POST",
      body: JSON.stringify({
        role,
        fullName,
        pin,
        phone: phone.trim() || undefined,
        // Sent explicitly, always: the server refuses to guess (F03), and an
        // omitted policy is the very bug this form had.
        locationScope,
        locationIds: locationScope === "selected" ? branchIds : [],
        defaultLocationId: locationScope === "home" ? defaultLocationId : null,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      onError(errorMessage(res.data.error));
      return;
    }
    setFullName("");
    setPin("");
    setPhone("");
    setBranchIds([]);
    setDefaultLocationId("");
    await onChanged();
  }

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">پرسنل صندوق و آشپزخانه</p>
          <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">
            ایجاد حساب کارمند با رمز عددی
          </h2>
        </div>
      }
      /*
       * Issue #947 (TEAM-F07) — the heading says what the door *creates*.
       *
       * «افزودن کارکنان صندوق و آشپزخانه» sat next to the personnel directory below,
       * which also has an «افزودن» button, and the two do different things: this one
       * makes an account with a PIN login *and* the personnel file behind it, while the
       * directory creates only the accounting record. An owner who wanted «just a file»
       * landed here, and one who wanted a login created a file with no door.
       */
      description="یک حساب کاربری با ورود رمز عددی روی دستگاه مشترک می‌سازد (بدون ایمیل)، و پروندهٔ پرسنلی متناظر را هم ایجاد می‌کند."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="نام">
          <input className={inputClass} value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="نقش">
          <SearchableSelect
            value={role}
            onChange={changeRole}
            options={PIN_ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
          />
        </Field>
        <Field
          label={`رمز عددی (${toPersianDigits(PIN_MIN_LENGTH)} تا ${toPersianDigits(PIN_MAX_LENGTH)} رقم)`}
          /*
           * Issue #947 (TEAM-F03) opened this hint because it claimed the PIN was
           * unique per *branch* while the door matched it business-wide. Main has since
           * removed uniqueness altogether (migration 0221, #953): the PIN door names
           * the member, so a PIN is a personal secret two members may happen to share,
           * and a hint promising uniqueness would be as wrong as the old one.
           */
          hint="رمز شخصی همین عضو است؛ در فهرست ورود با نام او پیدا می‌شود."
        >
          <input
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            maxLength={PIN_MAX_LENGTH}
            value={pin}
            onChange={(e) => setPin(toLatinDigits(e.target.value).replace(/[^0-9]/g, ""))}
          />
        </Field>
        <Field
          label="شمارهٔ موبایل"
          hint="اختیاری؛ برای ورود با پیامک. بار اول با کد تأیید فعال می‌شود."
        >
          <input
            className={inputClass}
            dir="ltr"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="09121234567"
          />
        </Field>
      </div>
      {/* Issue #947 (TEAM-F03) — the visible branch policy. Same vocabulary and
          controls as the invitation form above, so «دسترسی شعبه» means one thing
          on this screen. */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field
          label="دسترسی شعبه"
          hint={
            activeLocations.length <= 1
              ? "این کسب‌وکار یک شعبه دارد؛ تفاوتی میان گزینه‌ها نیست."
              : "این عضو در کدام شعبه‌ها کار می‌کند؟ تا وقتی انتخاب نکنید، عضو ساخته نمی‌شود."
          }
        >
          <SearchableSelect
            value={locationScope}
            onChange={(value) => {
              setLocationScope(value);
              if (value !== "selected") setBranchIds([]);
              if (value !== "home") setDefaultLocationId("");
            }}
            options={[
              ...(locationScope === "" ? [{ value: "", label: "— انتخاب کنید —" }] : []),
              { value: "all", label: "همهٔ شعبه‌ها" },
              { value: "selected", label: "شعبه‌های انتخابی" },
              { value: "home", label: "فقط شعبهٔ اصلی" },
              { value: "none", label: "بدون دسترسی شعبه" },
            ]}
          />
        </Field>
        {locationScope === "home" ? (
          <Field label="شعبهٔ اصلی" hint="تنها شعبه‌ای که این عضو به آن دسترسی دارد.">
            <SearchableSelect
              value={defaultLocationId}
              onChange={setDefaultLocationId}
              options={[
                { value: "", label: "— انتخاب نشده —" },
                ...activeLocations.map((location) => ({ value: location.id, label: location.name })),
              ]}
            />
          </Field>
        ) : null}
      </div>
      {locationScope === "selected" ? (
        <Field label="شعبه‌ها" hint="فقط شعبه‌های انتخاب‌شده در دسترس خواهند بود.">
          {activeLocations.length === 0 ? (
            <p className="text-xs text-muted-foreground">شعبهٔ فعالی ثبت نشده است.</p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {activeLocations.map((location) => (
                <label key={location.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={branchIds.includes(location.id)}
                    onCheckedChange={(checked) =>
                      setBranchIds((current) =>
                        checked === true
                          ? [...current, location.id]
                          : current.filter((id) => id !== location.id),
                      )
                    }
                  />
                  <span>{location.name}</span>
                </label>
              ))}
            </div>
          )}
        </Field>
      ) : null}
      <div className="mt-4">
        {/* The same shape rule the backend gates on (pin-policy.ts) — the
            button says no before the request leaves, instead of answering
            with a 400 after it does. */}
        <PrimaryButton
          onClick={add}
          disabled={busy || !fullName.trim() || !isValidPin(pin) || !scopeComplete}
        >
          افزودن
        </PrimaryButton>
      </div>
    </SectionCard>
  );
}
