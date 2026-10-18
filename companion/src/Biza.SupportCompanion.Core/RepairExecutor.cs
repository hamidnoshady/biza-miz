using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Biza.SupportCompanion.Core;

/// <summary>One precondition/postcheck entry from the recipe.</summary>
public sealed record RepairCheck(string Check, string? Detail);

/// <summary>
/// The exact approved run the shell hands to the executor: the pinned hash
/// plus the recipe bytes to verify against it. The shell builds this from
/// <c>GET /api/support-companion/repairs?runId=…</c>; the executor trusts
/// nothing it cannot re-derive.
/// </summary>
public sealed record RepairRunEnvelope(
    string RunId,
    string RecipeId,
    int RecipeVersion,
    string RecipeHash,
    string Risk,
    string BackupPolicy,
    string RecipeJson,
    IReadOnlyList<RepairCheck> Preconditions,
    IReadOnlyList<RepairCheck> Postchecks)
{
    /// <summary>Parses the shell-built envelope. Never throws.</summary>
    public static bool TryParse(string? json, out RepairRunEnvelope? envelope, out string error)
    {
        envelope = null;
        error = string.Empty;
        if (string.IsNullOrWhiteSpace(json))
        {
            error = "empty envelope";
            return false;
        }

        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                error = "envelope is not an object";
                return false;
            }

            string Req(string name)
            {
                if (!root.TryGetProperty(name, out var prop) || prop.ValueKind != JsonValueKind.String)
                {
                    throw new FormatException($"envelope.{name} missing");
                }

                return prop.GetString() ?? string.Empty;
            }

            var runId = Req("runId");
            var recipeId = Req("recipeId");
            var recipeHash = Req("recipeHash");
            var risk = Req("risk");
            var backupPolicy = Req("backupPolicy");
            if (!root.TryGetProperty("recipeVersion", out var versionProp) ||
                versionProp.ValueKind != JsonValueKind.Number ||
                !versionProp.TryGetInt32(out var recipeVersion))
            {
                error = "envelope.recipeVersion missing";
                return false;
            }

            if (!root.TryGetProperty("recipe", out var recipeProp) ||
                recipeProp.ValueKind != JsonValueKind.Object)
            {
                error = "envelope.recipe missing";
                return false;
            }

            if (runId.Length == 0 || recipeId.Length == 0 || recipeHash.Length == 0)
            {
                error = "envelope ids missing";
                return false;
            }

            static IReadOnlyList<RepairCheck> Checks(JsonElement parent, string name, out string error)
            {
                error = string.Empty;
                var list = new List<RepairCheck>();
                if (!parent.TryGetProperty(name, out var arr) || arr.ValueKind != JsonValueKind.Array)
                {
                    return list;
                }

                foreach (var item in arr.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.Object ||
                        !item.TryGetProperty("check", out var check) ||
                        check.ValueKind != JsonValueKind.String)
                    {
                        error = $"envelope.{name} entry malformed";
                        return list;
                    }

                    string? detail = null;
                    if (item.TryGetProperty("detail", out var detailProp) &&
                        detailProp.ValueKind == JsonValueKind.String)
                    {
                        detail = detailProp.GetString();
                    }

                    list.Add(new RepairCheck(check.GetString() ?? string.Empty, detail));
                }

                return list;
            }

            var preconditions = Checks(root, "preconditions", out var preError);
            if (preError.Length > 0)
            {
                error = preError;
                return false;
            }

            var postchecks = Checks(root, "postchecks", out var postError);
            if (postError.Length > 0)
            {
                error = postError;
                return false;
            }

            envelope = new RepairRunEnvelope(
                runId, recipeId, recipeVersion, recipeHash, risk, backupPolicy,
                recipeProp.GetRawText(), preconditions, postchecks);
            return true;
        }
        catch (Exception ex) when (ex is JsonException || ex is FormatException)
        {
            error = "envelope malformed";
            return false;
        }
    }
}

/// <summary>Local directories the executor may touch. Nothing else, ever.</summary>
public sealed record ExecutorRoots(
    string DataDir,
    string TempDir,
    string LogDir,
    string JournalDir,
    string ReportsDir,
    string StagingDir,
    string? LockPathOverride = null,
    int StagingRetentionDays = 7);

/// <summary>A dry-run plan: what WOULD happen. Shown to the operator before approval.</summary>
public sealed record DryRunPlan(
    string RunId,
    string RecipeId,
    int RecipeVersion,
    string RecipeHash,
    string Verb,
    string Risk,
    string TargetsJson,
    string EffectsSummary,
    string BackupPlan,
    string WarningsJson,
    string PreconditionResultsJson,
    string PlanHash,
    string PlannedAt);

/// <summary>
/// The executor's verdict plus the exact patch payloads the shell POSTs to
/// <c>/api/support-companion/repairs</c> (precondition_results, backup_ref,
/// before/after findings, verification, receipt).
/// </summary>
public sealed record RepairOutcome(
    bool Ok,
    string ServerState,
    string? Refusal,
    string? Reason,
    string PreconditionResultsJson,
    string? BackupRef,
    string BeforeFindingsJson,
    string AfterFindingsJson,
    string VerificationJson,
    string ReceiptJson);

/// <summary>
/// Issue #984 — the local repair executor. Allowlisted verbs only, every
/// recipe hash-pinned and re-verified, dry-run before approval, durable
/// intent journalled before acting, the installation gate held during the
/// window, bounded effects, postchecks before success, rollback or
/// recovery-required on failure, and a receipt for the ticket. Anything it
/// cannot prove becomes <c>blocked</c>/<c>failed</c> with a reason — success
/// is never fabricated.
/// </summary>
public static class RepairExecutor
{
    public const string VerbCleanTemp = "companion.clean_temp";
    public const string VerbRotateLogs = "companion.rotate_logs";

    /// <summary>Server verbs this companion version knows but cannot execute yet — named honestly.</summary>
    public static readonly IReadOnlyDictionary<string, string> KnownUnsupportedVerbs =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["main.restart_backend"] = "verified backend restart needs the main-app cooperation protocol (open)",
            ["main.restart_postgres"] = "cluster-identity verification is not implemented in this companion version",
            ["main.repair_binaries"] = "signed payload acquisition is not wired in this companion version",
            ["main.retry_sync_event"] = "business-service command path is not implemented in this companion version",
            ["main.renew_gateway_certificate"] = "privileged certificate workflow is not implemented in this companion version",
            ["main.clear_print_queue"] = "print-spooler access is not implemented in this companion version",
        };

    private static readonly IReadOnlySet<string> ForbiddenKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "command", "sql", "query", "script", "url", "powershell", "shell", "code",
    };

    private const int MaxEnumeratedFiles = 10_000;
    private const int MaxStagingPurge = 1_000;

    /// <summary>
    /// Validates the envelope and produces the dry-run plan. Read-only: plans
    /// never mutate. Returns a refusal outcome instead of a plan when the run
    /// must not proceed.
    /// </summary>
    public static (DryRunPlan? Plan, RepairOutcome? Refusal) Plan(RepairRunEnvelope envelope, ExecutorRoots roots)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        ArgumentNullException.ThrowIfNull(roots);

        var startedAt = DateTimeOffset.UtcNow;
        if (!ParseRecipe(envelope, out var verb, out var paramsJson, out var refusal))
        {
            return (null, refusal);
        }

        if (verb != VerbCleanTemp && verb != VerbRotateLogs)
        {
            if (KnownUnsupportedVerbs.TryGetValue(verb, out var why))
            {
                return (null, Refuse(envelope, startedAt, "unsupported_verb",
                    $"{verb} is not implemented in this companion version: {why}."));
            }

            return (null, Refuse(envelope, startedAt, "unknown_verb",
                $"Unknown recipe verb '{verb}'. Refusing."));
        }

        if (!EvaluatePreconditions(envelope, roots, out var preconditions, out var preReason))
        {
            return (null, Refuse(envelope, startedAt, "precondition_failed", preReason, preconditions));
        }

        var targets = verb == VerbCleanTemp
            ? PlanCleanTemp(paramsJson, roots)
            : PlanRotateLogs(paramsJson, roots);
        if (targets.Refusal is not null)
        {
            return (null, Refuse(envelope, startedAt, targets.Refusal, targets.Reason ?? "planning failed", preconditions));
        }

        var warnings = new JsonArray();
        if (targets.Truncated)
        {
            warnings.Add("enumeration hit the file cap; remaining files left untouched");
        }

        var targetsJson = targets.Targets.ToJsonString();
        var plan = new DryRunPlan(
            envelope.RunId, envelope.RecipeId, envelope.RecipeVersion, envelope.RecipeHash,
            verb, envelope.Risk, targetsJson,
            targets.Summary,
            BackupPlanFor(envelope, verb),
            warnings.ToJsonString(),
            preconditions,
            CanonicalJson.Sha256Hex(verb + "\n" + CanonicalJson.Canonicalize(targetsJson)),
            DateTimeOffset.UtcNow.ToString("O"));
        return (plan, null);
    }

    /// <summary>
    /// Executes an approved plan: re-plans and refuses on drift from the
    /// approved bytes, journals intent, holds the gate, checkpoints, acts,
    /// postchecks, and receipts. The caller must have moved the run to
    /// <c>authorized</c> (operator approval) and POSTs <c>executing</c>
    /// before calling this. Never throws for run failures — they become
    /// terminal outcomes; infrastructure failures (journal/gate IO) become
    /// <c>blocked</c>/<c>failed</c>/<c>recovery_required</c>, never silent.
    /// </summary>
    public static RepairOutcome Execute(
        RepairRunEnvelope envelope,
        DryRunPlan approvedPlan,
        string consentRefJson,
        string? backupRef,
        ExecutorRoots roots,
        CancellationToken token = default)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        ArgumentNullException.ThrowIfNull(approvedPlan);
        ArgumentNullException.ThrowIfNull(roots);

        var startedAt = DateTimeOffset.UtcNow;
        if (token.IsCancellationRequested)
        {
            return CancelledOutcome(envelope, startedAt, "cancelled by operator Stop before start");
        }

        var consentError = CheckConsent(envelope, consentRefJson);
        if (consentError is not null)
        {
            return Refuse(envelope, startedAt, "consent_missing", consentError);
        }

        if (envelope.Risk != "low" && envelope.Risk != "medium" && envelope.Risk != "high")
        {
            return Refuse(envelope, startedAt, "invalid_risk", $"Unknown risk tier '{envelope.Risk}'.");
        }

        if (envelope.BackupPolicy != "none" && envelope.BackupPolicy != "checkpoint" &&
            envelope.BackupPolicy != "verified_backup")
        {
            return Refuse(envelope, startedAt, "invalid_backup_policy",
                $"Unknown backup policy '{envelope.BackupPolicy}'.");
        }

        if (envelope.BackupPolicy == "verified_backup" && string.IsNullOrWhiteSpace(backupRef))
        {
            return Refuse(envelope, startedAt, "backup_required",
                "Recipe requires a verified backup reference; none was provided.");
        }

        var (freshPlan, planRefusal) = Plan(envelope, roots);
        if (freshPlan is null)
        {
            return planRefusal!;
        }

        if (freshPlan.PlanHash != approvedPlan.PlanHash)
        {
            return Refuse(envelope, startedAt, "plan_drifted",
                "Live state changed since approval; the approved dry-run no longer matches. Re-plan and re-approve.");
        }

        PurgeStaleStaging(roots, envelope.RunId);

        var timeoutSec = TimeoutFor(freshPlan);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSec));
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, timeout.Token);

        if (!Journal(envelope, roots, "intent", new JsonObject
            {
                ["verb"] = freshPlan.Verb,
                ["planHash"] = freshPlan.PlanHash,
            }.ToJsonString()))
        {
            return Refuse(envelope, startedAt, "journal_failed",
                "Intent could not be journalled; refusing to act without an audit trail.");
        }

        using var gate = MaintenanceLock.TryAcquire(roots.LockPathOverride);
        if (gate is null)
        {
            Journal(envelope, roots, "refused", """{"refusal":"gate_busy"}""");
            return Refuse(envelope, startedAt, "gate_busy",
                "Another maintenance run holds the installation gate. Retry later.");
        }

        if (!Journal(envelope, roots, "executing", new JsonObject { ["verb"] = freshPlan.Verb }.ToJsonString()))
        {
            return Terminal(envelope, startedAt, freshPlan, BeforeFindings(freshPlan), AfterFindingsOnError(),
                "failed", "journal_failed", "Phase journal write failed before mutation; nothing was changed.",
                backupRef, string.Empty);
        }

        var before = BeforeFindings(freshPlan);
        var mutated = false;
        string? verbError = null;
        string stagingRef = string.Empty;
        try
        {
            (mutated, stagingRef, verbError) = freshPlan.Verb == VerbCleanTemp
                ? RunCleanTemp(freshPlan, roots, envelope.RunId, linked.Token)
                : RunRotateLogs(freshPlan, roots, envelope.RunId, linked.Token);
        }
        catch (OperationCanceledException)
        {
            verbError = !token.IsCancellationRequested
                ? $"verb timed out after {timeoutSec}s"
                : "cancelled by operator Stop";
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException ||
            ex is ArgumentException || ex is InvalidOperationException || ex is FormatException ||
            ex is JsonException || ex is NotSupportedException)
        {
            verbError = $"verb failure: {ex.GetType().Name}";
        }

        if (verbError is not null)
        {
            Journal(envelope, roots, "verb_failed", new JsonObject { ["reason"] = verbError }.ToJsonString());
            if (mutated)
            {
                var rolledBack = TryRollbackStaging(stagingRef, roots);
                Journal(envelope, roots, rolledBack ? "rolled_back" : "recovery_required",
                    new JsonObject { ["stagingRef"] = stagingRef }.ToJsonString());
                return Terminal(envelope, startedAt, freshPlan, before, AfterFindingsOnError(),
                    rolledBack ? "rolled_back" : "recovery_required",
                    rolledBack ? null : "verb_failed_rollback_failed", verbError, backupRef, stagingRef);
            }

            return Terminal(envelope, startedAt, freshPlan, before, AfterFindingsOnError(),
                token.IsCancellationRequested ? "cancelled" : "failed",
                "verb_failed", verbError, backupRef, stagingRef);
        }

        var postchecks = RunPostchecks(envelope, roots);
        var verified = postchecks.All(static v => v.Passed);
        Journal(envelope, roots, "verifying", PostchecksJson(postchecks));
        if (!verified)
        {
            var rolledBack = TryRollbackStaging(stagingRef, roots);
            var reason = "postchecks failed: " +
                string.Join("; ", postchecks.Where(static v => !v.Passed).Select(static v => v.Check));
            Journal(envelope, roots, rolledBack ? "rolled_back" : "recovery_required",
                new JsonObject { ["reason"] = reason }.ToJsonString());
            return Terminal(envelope, startedAt, freshPlan, before, AfterFindings(freshPlan),
                rolledBack ? "rolled_back" : "recovery_required",
                rolledBack ? null : "postcheck_failed_rollback_failed", reason, backupRef, stagingRef, postchecks);
        }

        Journal(envelope, roots, "succeeded", PostchecksJson(postchecks));
        return Terminal(envelope, startedAt, freshPlan, before, AfterFindings(freshPlan),
            "succeeded", null, null, backupRef, stagingRef, postchecks);
    }

    // ── Small JSON helpers (never throw on hostile shapes) ─────────────────

    private static string NodeString(JsonObject? obj, string name)
    {
        if (obj is not null && obj.TryGetPropertyValue(name, out var node) &&
            node is JsonValue value && value.TryGetValue<string>(out var text) && text is not null)
        {
            return text;
        }

        return string.Empty;
    }

    private static int NodeInt(JsonObject? obj, string name, int fallback, out bool valid)
    {
        valid = true;
        if (obj is null || !obj.TryGetPropertyValue(name, out var node) || node is null)
        {
            return fallback;
        }

        if (node is JsonValue value && value.TryGetValue<int>(out var number))
        {
            return number;
        }

        valid = false;
        return fallback;
    }

    private static bool NodeBool(JsonObject? obj, string name)
    {
        return obj is not null && obj.TryGetPropertyValue(name, out var node) &&
            node is JsonValue value && value.TryGetValue<bool>(out var flag) && flag == true;
    }

    private static JsonArray NodeArray(JsonObject? obj, string name)
    {
        if (obj is not null && obj.TryGetPropertyValue(name, out var node) && node is JsonArray arr)
        {
            return arr;
        }

        return new JsonArray();
    }

    // ── Recipe parsing ───────────────────────────────────────────────────

    private static bool ParseRecipe(
        RepairRunEnvelope envelope, out string verb, out JsonObject paramsJson, out RepairOutcome? refusal)
    {
        verb = string.Empty;
        paramsJson = new JsonObject();
        refusal = null;
        var startedAt = DateTimeOffset.UtcNow;

        var computed = CanonicalJson.TryHashRecipe(envelope.RecipeJson);
        if (computed is null)
        {
            refusal = Refuse(envelope, startedAt, "invalid_recipe", "Recipe is not a bounded valid JSON object.");
            return false;
        }

        if (!string.Equals(computed, envelope.RecipeHash, StringComparison.OrdinalIgnoreCase))
        {
            refusal = Refuse(envelope, startedAt, "recipe_drifted",
                "Recipe bytes do not match the approved pin. Edited after approval: refusing.");
            return false;
        }

        JsonNode? node;
        try
        {
            node = JsonNode.Parse(envelope.RecipeJson);
        }
        catch (JsonException)
        {
            refusal = Refuse(envelope, startedAt, "invalid_recipe", "Recipe is not valid JSON.");
            return false;
        }

        if (node is not JsonObject recipe)
        {
            refusal = Refuse(envelope, startedAt, "invalid_recipe", "Recipe is not an object.");
            return false;
        }

        if (ContainsForbiddenKey(recipe))
        {
            refusal = Refuse(envelope, startedAt, "forbidden_content",
                "Recipe names an escape-hatch key (command/sql/script/url/…). Refusing.");
            return false;
        }

        verb = NodeString(recipe, "action");
        if (verb.Length == 0)
        {
            refusal = Refuse(envelope, startedAt, "invalid_recipe", "Recipe names no action verb.");
            return false;
        }

        if (recipe.TryGetPropertyValue("params", out var paramsNode))
        {
            if (paramsNode is not JsonObject paramsObj)
            {
                refusal = Refuse(envelope, startedAt, "invalid_recipe", "Recipe params are not an object.");
                return false;
            }

            paramsJson = paramsObj;
        }

        return true;
    }

    private static bool ContainsForbiddenKey(JsonNode? node)
    {
        if (node is JsonObject obj)
        {
            foreach (var kvp in obj)
            {
                if (ForbiddenKeys.Contains(kvp.Key))
                {
                    return true;
                }

                if (ContainsForbiddenKey(kvp.Value))
                {
                    return true;
                }
            }
        }
        else if (node is JsonArray arr)
        {
            foreach (var item in arr)
            {
                if (ContainsForbiddenKey(item))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static string? CheckConsent(RepairRunEnvelope envelope, string consentRefJson)
    {
        if (string.IsNullOrWhiteSpace(consentRefJson))
        {
            return "Local customer consent is required and was not provided.";
        }

        try
        {
            var node = JsonNode.Parse(consentRefJson);
            if (node is not JsonObject obj || obj.Count == 0)
            {
                return "Local customer consent record is empty.";
            }

            if ((envelope.Risk == "medium" || envelope.Risk == "high") && !NodeBool(obj, "riskAcknowledged"))
            {
                return $"Risk '{envelope.Risk}' work needs explicit risk acknowledgement in the consent record.";
            }
        }
        catch (JsonException)
        {
            return "Local customer consent record is malformed.";
        }

        return null;
    }

    private static int TimeoutFor(DryRunPlan plan)
    {
        try
        {
            var node = JsonNode.Parse(plan.TargetsJson) as JsonObject;
            return Math.Clamp(NodeInt(node, "timeoutSec", 120, out _), 5, 600);
        }
        catch (JsonException)
        {
            return 120;
        }
    }

    // ── Preconditions / postchecks ───────────────────────────────────────

    private sealed record CheckResult(string Check, bool Passed, string Detail)
    {
        public JsonObject ToJson() => new() { ["check"] = Check, ["passed"] = Passed, ["detail"] = Detail };
    }

    private static bool EvaluatePreconditions(
        RepairRunEnvelope envelope, ExecutorRoots roots, out string resultsJson, out string reason)
    {
        var results = new List<CheckResult>();
        foreach (var check in envelope.Preconditions)
        {
            var result = EvaluateCheck(check, roots);
            results.Add(result);
            if (!result.Passed)
            {
                resultsJson = ResultsJson(results);
                reason = $"precondition '{check.Check}' failed: {result.Detail}";
                return false;
            }
        }

        resultsJson = ResultsJson(results);
        reason = string.Empty;
        return true;
    }

    private static string ResultsJson(List<CheckResult> results)
    {
        var arr = new JsonArray();
        foreach (var result in results)
        {
            arr.Add(result.ToJson());
        }

        return arr.ToJsonString();
    }

    private static string PostchecksJson(List<CheckResult> postchecks)
    {
        var arr = new JsonArray();
        foreach (var postcheck in postchecks)
        {
            arr.Add(postcheck.ToJson());
        }

        return arr.ToJsonString();
    }

    private static CheckResult EvaluateCheck(RepairCheck check, ExecutorRoots roots)
    {
        return check.Check switch
        {
            "dry_run_first" => new CheckResult(check.Check, true, "this plan is the dry run"),
            "root_owned" => CheckRootOwned(check.Detail, roots),
            "journal_intact" => CheckJournalIntact(roots),
            "reports_intact" => CheckReportsIntact(roots),
            "log_write_ok" => CheckLogWritable(roots),
            "installation_gate_free" => CheckGateFree(roots),
            _ => new CheckResult(check.Check, false,
                $"check '{check.Check}' is not evaluable by this companion version; failing closed"),
        };
    }

    private static CheckResult CheckRootOwned(string? detail, ExecutorRoots roots)
    {
        var dir = detail switch
        {
            "companion_temp" => roots.TempDir,
            "companion_logs" => roots.LogDir,
            _ => null,
        };
        if (dir is null)
        {
            return new CheckResult("root_owned", false, $"unknown root '{detail}'");
        }

        try
        {
            Directory.CreateDirectory(dir);
            var full = Path.GetFullPath(dir);
            var dataFull = Path.GetFullPath(roots.DataDir);
            if (!full.StartsWith(dataFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(full, dataFull, StringComparison.OrdinalIgnoreCase))
            {
                return new CheckResult("root_owned", false, "root escapes the companion data dir");
            }

            var probe = Path.Combine(full, ".biza-write-probe");
            File.WriteAllBytes(probe, [0x00]);
            File.Delete(probe);

            var owner = new DirectoryInfo(full).GetAccessControl().GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
            var current = WindowsIdentity.GetCurrent().User;
            var admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            if (owner is null || current is null || (!owner.Equals(current) && !owner.Equals(admins)))
            {
                return new CheckResult("root_owned", false, "root is owned by another account; refusing to touch it");
            }

            return new CheckResult("root_owned", true, detail ?? string.Empty);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException ||
            ex is ArgumentException || ex is SystemException)
        {
            return new CheckResult("root_owned", false, $"root not writable/owned: {ex.GetType().Name}");
        }
    }

    private static CheckResult CheckJournalIntact(ExecutorRoots roots)
    {
        var (ok, error) = OperationJournal.Verify(roots.JournalDir);
        if (ok)
        {
            return new CheckResult("journal_intact", true, "chain verified");
        }

        // A torn tail is the expected crash artifact — recover it (last
        // line only, everything before re-verified, the truncation itself
        // journalled) instead of bricking the executor on this machine
        // forever. Tamper/deletion evidence is never truncated and still
        // fails closed below, as does a busy journal (retry).
        var (recovered, kept, dropped, normalized, recoverError) =
            OperationJournal.TryDiscardTornTail(roots.JournalDir);
        if (!recovered)
        {
            return new CheckResult("journal_intact", false, error + "; recovery refused: " + recoverError);
        }

        var (reok, reerror) = OperationJournal.Verify(roots.JournalDir);
        if (!reok)
        {
            return new CheckResult("journal_intact", false, "recovery did not restore the chain: " + reerror);
        }

        return dropped > 0
            ? new CheckResult("journal_intact", true, $"recovered torn tail (kept {kept}, dropped {dropped})")
            : new CheckResult("journal_intact", true,
                normalized ? "restored missing trailing newline" : "chain verified");
    }

    private static CheckResult CheckReportsIntact(ExecutorRoots roots)
    {
        var (ok, detail) = ReportsManifest.Verify(roots.ReportsDir);
        return new CheckResult("reports_intact", ok, detail);
    }

    private static CheckResult CheckLogWritable(ExecutorRoots roots)
    {
        try
        {
            Directory.CreateDirectory(roots.LogDir);
            var probe = Path.Combine(roots.LogDir, ".biza-write-probe");
            File.WriteAllBytes(probe, [0x00]);
            File.Delete(probe);
            return new CheckResult("log_write_ok", true, "log dir writable");
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
            return new CheckResult("log_write_ok", false, ex.GetType().Name);
        }
    }

    private static CheckResult CheckGateFree(ExecutorRoots roots)
    {
        using var gate = MaintenanceLock.TryAcquire(roots.LockPathOverride);
        return gate is null
            ? new CheckResult("installation_gate_free", false, "gate held by another maintenance run")
            : new CheckResult("installation_gate_free", true, "gate free (advisory; re-acquired at execution)");
    }

    private static List<CheckResult> RunPostchecks(RepairRunEnvelope envelope, ExecutorRoots roots)
    {
        var results = new List<CheckResult>();
        foreach (var check in envelope.Postchecks)
        {
            results.Add(check.Check switch
            {
                "journal_intact" => CheckJournalIntact(roots),
                "reports_intact" => CheckReportsIntact(roots),
                "log_write_ok" => CheckLogWritable(roots),
                _ => new CheckResult(check.Check, false,
                    $"postcheck '{check.Check}' is not evaluable by this companion version"),
            });
        }

        return results;
    }

    // ── Planning ─────────────────────────────────────────────────────────

    private sealed record VerbPlan(
        JsonObject Targets, string Summary, bool Truncated, string? Refusal, string? Reason);

    private static VerbPlan PlanCleanTemp(JsonObject paramsJson, ExecutorRoots roots)
    {
        var maxAgeDays = Math.Clamp(NodeInt(paramsJson, "maxAgeDays", 7, out var ageValid), 1, 90);
        if (!ageValid)
        {
            return new VerbPlan(new JsonObject(), string.Empty, false, "invalid_params", "maxAgeDays is not an integer");
        }

        var timeoutSec = Math.Clamp(NodeInt(paramsJson, "timeoutSec", 120, out var timeoutValid), 5, 600);
        if (!timeoutValid)
        {
            return new VerbPlan(new JsonObject(), string.Empty, false, "invalid_params", "timeoutSec is not an integer");
        }

        var rootsArray = NodeArray(paramsJson, "roots");
        if (rootsArray.Count == 0)
        {
            return new VerbPlan(new JsonObject(), string.Empty, false, "invalid_params", "clean_temp names no roots");
        }

        foreach (var entry in rootsArray)
        {
            var name = entry is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
            if (name != "companion_temp")
            {
                return new VerbPlan(new JsonObject(), string.Empty, false, "invalid_params",
                    "clean_temp may only target 'companion_temp'");
            }
        }

        var cutoff = DateTimeOffset.UtcNow.AddDays(-maxAgeDays);
        var targets = new JsonArray();
        long bytes = 0;
        var truncated = false;
        foreach (var file in EnumerateSafeFiles(roots.TempDir))
        {
            if (targets.Count >= MaxEnumeratedFiles)
            {
                truncated = true;
                break;
            }

            FileInfo info;
            try
            {
                info = new FileInfo(file);
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
            {
                continue;
            }

            if (info.LastWriteTimeUtc >= cutoff.UtcDateTime)
            {
                continue;
            }

            targets.Add(new JsonObject
            {
                ["path"] = Path.GetRelativePath(roots.TempDir, file),
                ["bytes"] = info.Length,
            });
            bytes += info.Length;
        }

        return new VerbPlan(
            new JsonObject
            {
                ["verb"] = VerbCleanTemp,
                ["root"] = roots.TempDir,
                ["maxAgeDays"] = maxAgeDays,
                ["timeoutSec"] = timeoutSec,
                ["files"] = targets,
                ["totalBytes"] = bytes,
            },
            $"{targets.Count} temp files ({bytes} bytes) older than {maxAgeDays} days will be staged for removal; journal, reports and business data untouched",
            truncated, null, null);
    }

    private static VerbPlan PlanRotateLogs(JsonObject paramsJson, ExecutorRoots roots)
    {
        var keepFiles = Math.Clamp(NodeInt(paramsJson, "keepFiles", 10, out var keepValid), 1, 100);
        if (!keepValid)
        {
            return new VerbPlan(new JsonObject(), string.Empty, false, "invalid_params", "keepFiles is not an integer");
        }

        var timeoutSec = Math.Clamp(NodeInt(paramsJson, "timeoutSec", 120, out var timeoutValid), 5, 600);
        if (!timeoutValid)
        {
            return new VerbPlan(new JsonObject(), string.Empty, false, "invalid_params", "timeoutSec is not an integer");
        }

        var candidates = new List<(string Path, DateTime Mtime, long Bytes)>();
        foreach (var file in EnumerateSafeFiles(roots.LogDir, "*.log"))
        {
            if (candidates.Count >= 1000)
            {
                break;
            }

            try
            {
                var info = new FileInfo(file);
                candidates.Add((file, info.LastWriteTimeUtc, info.Length));
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
            {
            }
        }

        candidates.Sort(static (a, b) => b.Mtime.CompareTo(a.Mtime));
        var targets = new JsonArray();
        long bytes = 0;
        foreach (var candidate in candidates.Skip(keepFiles))
        {
            targets.Add(new JsonObject
            {
                ["path"] = Path.GetRelativePath(roots.LogDir, candidate.Path),
                ["bytes"] = candidate.Bytes,
            });
            bytes += candidate.Bytes;
        }

        return new VerbPlan(
            new JsonObject
            {
                ["verb"] = VerbRotateLogs,
                ["root"] = roots.LogDir,
                ["keepFiles"] = keepFiles,
                ["timeoutSec"] = timeoutSec,
                ["files"] = targets,
                ["totalBytes"] = bytes,
            },
            $"{targets.Count} log files ({bytes} bytes) beyond the newest {keepFiles} will be staged for removal",
            false, null, null);
    }

    /// <summary>
    /// Files only — never follows reparse points, never leaves the root.
    /// A missing root enumerates empty (a verb over an absent dir is a
    /// journalled no-op success, not an error).
    /// </summary>
    private static IEnumerable<string> EnumerateSafeFiles(string root, string pattern = "*")
    {
        string fullRoot;
        try
        {
            if (!Directory.Exists(root))
            {
                yield break;
            }

            fullRoot = Path.GetFullPath(root);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
            yield break;
        }

        var stack = new Stack<string>();
        stack.Push(fullRoot);
        while (stack.Count > 0)
        {
            var dir = stack.Pop();
            string[] entries;
            try
            {
                entries = Directory.GetFileSystemEntries(dir, pattern, SearchOption.TopDirectoryOnly);
                if (pattern != "*")
                {
                    // The pattern filters files; every directory is still descended.
                    foreach (var sub in Directory.GetFileSystemEntries(dir, "*", SearchOption.TopDirectoryOnly))
                    {
                        if (Directory.Exists(sub) && !IsReparsePoint(sub))
                        {
                            stack.Push(sub);
                        }
                    }
                }
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
            {
                continue;
            }

            foreach (var entry in entries)
            {
                string full;
                try
                {
                    full = Path.GetFullPath(entry);
                }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
                {
                    continue;
                }

                if (!full.StartsWith(fullRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (IsReparsePoint(full))
                {
                    continue;
                }

                if (Directory.Exists(full))
                {
                    if (pattern == "*")
                    {
                        stack.Push(full);
                    }
                }
                else
                {
                    yield return full;
                }
            }
        }
    }

    private static bool IsReparsePoint(string path)
    {
        try
        {
            return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
            return true;
        }
    }

    private static string BackupPlanFor(RepairRunEnvelope envelope, string verb)
    {
        return envelope.BackupPolicy switch
        {
            "none" or "checkpoint" =>
                "checkpoint: staged trash under the companion data dir (restorable for 7 days)",
            "verified_backup" =>
                "caller-provided verified backup reference, recorded on the receipt (server cross-check open)",
            _ => "unknown backup policy: refusing at execution",
        };
    }

    // ── Verb execution ───────────────────────────────────────────────────

    private static (bool Mutated, string StagingRef, string? Error) RunCleanTemp(
        DryRunPlan plan, ExecutorRoots roots, string runId, CancellationToken token)
    {
        return RunStagingVerb(plan, roots, runId, roots.TempDir, token);
    }

    private static (bool Mutated, string StagingRef, string? Error) RunRotateLogs(
        DryRunPlan plan, ExecutorRoots roots, string runId, CancellationToken token)
    {
        return RunStagingVerb(plan, roots, runId, roots.LogDir, token);
    }

    /// <summary>
    /// Moves planned files into run-scoped staging (never deletes), with a
    /// hash manifest so rollback restores exact bytes. Re-verifies every
    /// path against the plan and the root before moving.
    /// </summary>
    private static (bool Mutated, string StagingRef, string? Error) RunStagingVerb(
        DryRunPlan plan, ExecutorRoots roots, string runId, string rootDir, CancellationToken token)
    {
        var stageDir = Path.Combine(roots.StagingDir, runId);
        Directory.CreateDirectory(stageDir);
        var manifest = new JsonArray();
        var mutated = false;

        JsonNode? targetsNode;
        try
        {
            targetsNode = JsonNode.Parse(plan.TargetsJson);
        }
        catch (JsonException ex)
        {
            return (false, stageDir, $"plan targets malformed: {ex.Message}");
        }

        var files = NodeArray(targetsNode as JsonObject, "files");
        string fullRoot;
        try
        {
            fullRoot = Path.GetFullPath(rootDir);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
            return (false, stageDir, $"root unreadable: {ex.GetType().Name}");
        }

        var index = 0;
        foreach (var file in files)
        {
            token.ThrowIfCancellationRequested();
            index++;
            var relative = NodeString(file as JsonObject, "path");
            if (relative.Length == 0)
            {
                continue;
            }

            string full;
            try
            {
                full = Path.GetFullPath(Path.Combine(fullRoot, relative));
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
            {
                return (mutated, stageDir, $"target escapes root or unreadable: {relative}");
            }

            if (!full.StartsWith(fullRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                IsReparsePoint(full) || !File.Exists(full))
            {
                // Vanished or swapped since planning: skip honestly, note it.
                manifest.Add(new JsonObject { ["path"] = relative, ["skipped"] = "absent_or_unsafe_at_execution" });
                continue;
            }

            string hash;
            try
            {
                using var sha = SHA256.Create();
                using var stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.Read);
                hash = Convert.ToHexString(sha.ComputeHash(stream)).ToLowerInvariant();
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
            {
                return (mutated, stageDir, $"target unreadable at execution: {relative}");
            }

            var staged = Path.Combine(stageDir, $"{index:000000}_{Path.GetFileName(full)}");
            try
            {
                File.Move(full, staged, overwrite: false);
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
            {
                return (mutated, stageDir, $"failed to stage {relative}: {ex.GetType().Name}");
            }

            mutated = true;
            manifest.Add(new JsonObject
            {
                ["path"] = relative,
                ["stagedAs"] = Path.GetFileName(staged),
                ["sha256"] = hash,
            });
        }

        var manifestDoc = new JsonObject
        {
            ["runId"] = runId,
            ["verb"] = plan.Verb,
            ["stagedAt"] = DateTimeOffset.UtcNow.ToString("O"),
            ["root"] = fullRoot,
            ["files"] = manifest,
        };
        File.WriteAllText(Path.Combine(stageDir, "manifest.json"), manifestDoc.ToJsonString());
        return (mutated, stageDir, null);
    }

    private static bool TryRollbackStaging(string stagingRef, ExecutorRoots roots)
    {
        try
        {
            if (string.IsNullOrEmpty(stagingRef) || !Directory.Exists(stagingRef))
            {
                return true;
            }

            var manifestPath = Path.Combine(stagingRef, "manifest.json");
            if (!File.Exists(manifestPath))
            {
                return false;
            }

            var manifest = JsonNode.Parse(File.ReadAllText(manifestPath)) as JsonObject;
            var root = NodeString(manifest, "root");
            if (root.Length == 0)
            {
                return false;
            }

            var fullRoot = Path.GetFullPath(root);
            var dataFull = Path.GetFullPath(roots.DataDir);
            if (!fullRoot.StartsWith(dataFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(fullRoot, dataFull, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            foreach (var file in NodeArray(manifest, "files"))
            {
                var entry = file as JsonObject;
                var relative = NodeString(entry, "path");
                var stagedAs = NodeString(entry, "stagedAs");
                var expectedHash = NodeString(entry, "sha256");
                if (relative.Length == 0 || stagedAs.Length == 0 || expectedHash.Length == 0)
                {
                    continue;
                }

                var staged = Path.Combine(stagingRef, stagedAs);
                var target = Path.GetFullPath(Path.Combine(fullRoot, relative));
                if (!target.StartsWith(fullRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }

                if (!File.Exists(staged))
                {
                    return false;
                }

                using (var sha = SHA256.Create())
                {
                    using var stream = new FileStream(staged, FileMode.Open, FileAccess.Read, FileShare.Read);
                    var hash = Convert.ToHexString(sha.ComputeHash(stream)).ToLowerInvariant();
                    if (!string.Equals(hash, expectedHash, StringComparison.OrdinalIgnoreCase))
                    {
                        return false;
                    }
                }

                var targetDir = Path.GetDirectoryName(target);
                if (targetDir is null || File.Exists(target))
                {
                    return false;
                }

                Directory.CreateDirectory(targetDir);
                File.Move(staged, target, overwrite: false);
            }

            return true;
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException ||
            ex is ArgumentException || ex is JsonException || ex is InvalidOperationException ||
            ex is FormatException || ex is NotSupportedException)
        {
            return false;
        }
    }

    private static void PurgeStaleStaging(ExecutorRoots roots, string currentRunId)
    {
        try
        {
            if (!Directory.Exists(roots.StagingDir))
            {
                return;
            }

            var cutoff = DateTimeOffset.UtcNow.AddDays(-roots.StagingRetentionDays);
            var purged = 0;
            foreach (var dir in Directory.GetDirectories(roots.StagingDir))
            {
                if (purged >= MaxStagingPurge)
                {
                    break;
                }

                if (string.Equals(Path.GetFileName(dir), currentRunId, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                try
                {
                    var manifestPath = Path.Combine(dir, "manifest.json");
                    if (!File.Exists(manifestPath))
                    {
                        continue;
                    }

                    var manifest = JsonNode.Parse(File.ReadAllText(manifestPath)) as JsonObject;
                    var stagedAt = NodeString(manifest, "stagedAt");
                    if (!DateTimeOffset.TryParse(stagedAt, out var when) || when >= cutoff)
                    {
                        continue;
                    }

                    Directory.Delete(dir, recursive: true);
                    purged++;
                }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException ||
                    ex is ArgumentException || ex is JsonException || ex is NotSupportedException)
                {
                }
            }

            if (purged > 0)
            {
                OperationJournal.Append(roots.JournalDir, "staging_purge", null,
                    new JsonObject { ["purgedRuns"] = purged }.ToJsonString());
            }
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
        }
    }

    // ── Findings / outcomes ──────────────────────────────────────────────

    private static JsonArray BeforeFindings(DryRunPlan plan)
    {
        return new JsonArray
        {
            new JsonObject
            {
                ["module"] = "runtime",
                ["check"] = "repair_targets_planned",
                ["summary"] = plan.EffectsSummary,
            },
        };
    }

    private static JsonArray AfterFindings(DryRunPlan plan)
    {
        return new JsonArray
        {
            new JsonObject
            {
                ["module"] = "runtime",
                ["check"] = "repair_targets_after",
                ["summary"] = plan.EffectsSummary,
            },
        };
    }

    private static JsonArray AfterFindingsOnError()
    {
        return new JsonArray
        {
            new JsonObject
            {
                ["module"] = "runtime",
                ["check"] = "repair_after_error",
                ["summary"] = "verb did not complete; see receipt",
            },
        };
    }

    private static RepairOutcome Refuse(
        RepairRunEnvelope envelope, DateTimeOffset startedAt, string refusal, string reason,
        string preconditionResultsJson = "[]")
    {
        var receipt = new JsonObject
        {
            ["runId"] = envelope.RunId,
            ["recipeId"] = envelope.RecipeId,
            ["recipeVersion"] = envelope.RecipeVersion,
            ["recipeHash"] = envelope.RecipeHash,
            ["outcome"] = "blocked",
            ["refusal"] = refusal,
            ["reason"] = reason,
            ["startedAt"] = startedAt.ToString("O"),
            ["finishedAt"] = DateTimeOffset.UtcNow.ToString("O"),
        };
        return new RepairOutcome(
            false, "blocked", refusal, reason, preconditionResultsJson, null,
            "[]", "[]",
            new JsonObject { ["verified"] = false, ["postchecks"] = new JsonArray() }.ToJsonString(),
            receipt.ToJsonString());
    }

    private static RepairOutcome CancelledOutcome(
        RepairRunEnvelope envelope, DateTimeOffset startedAt, string reason)
    {
        var receipt = new JsonObject
        {
            ["runId"] = envelope.RunId,
            ["recipeId"] = envelope.RecipeId,
            ["recipeVersion"] = envelope.RecipeVersion,
            ["recipeHash"] = envelope.RecipeHash,
            ["outcome"] = "cancelled",
            ["reason"] = reason,
            ["startedAt"] = startedAt.ToString("O"),
            ["finishedAt"] = DateTimeOffset.UtcNow.ToString("O"),
        };
        return new RepairOutcome(
            false, "cancelled", "cancelled", reason, "[]", null,
            "[]", "[]",
            new JsonObject { ["verified"] = false, ["postchecks"] = new JsonArray() }.ToJsonString(),
            receipt.ToJsonString());
    }

    private static RepairOutcome Terminal(
        RepairRunEnvelope envelope, DateTimeOffset startedAt, DryRunPlan plan,
        JsonArray before, JsonArray after, string serverState, string? refusal, string? reason,
        string? backupRef, string stagingRef, List<CheckResult>? postchecks = null)
    {
        var verification = new JsonObject
        {
            ["verified"] = serverState == "succeeded",
            ["postchecks"] = new JsonArray(),
        };
        if (postchecks is not null)
        {
            var arr = new JsonArray();
            foreach (var postcheck in postchecks)
            {
                arr.Add(postcheck.ToJson());
            }

            verification["postchecks"] = arr;
        }

        var receipt = new JsonObject
        {
            ["runId"] = envelope.RunId,
            ["recipeId"] = envelope.RecipeId,
            ["recipeVersion"] = envelope.RecipeVersion,
            ["recipeHash"] = envelope.RecipeHash,
            ["verb"] = plan.Verb,
            ["outcome"] = serverState,
            ["startedAt"] = startedAt.ToString("O"),
            ["finishedAt"] = DateTimeOffset.UtcNow.ToString("O"),
            ["stagingRef"] = stagingRef,
        };
        if (refusal is not null)
        {
            receipt["refusal"] = refusal;
        }

        if (reason is not null)
        {
            receipt["reason"] = reason;
        }

        if (envelope.BackupPolicy == "verified_backup")
        {
            receipt["backupRefClaim"] = backupRef ?? string.Empty;
            receipt["backupVerification"] = "claimed_not_verified: server backup cross-check is open";
        }

        return new RepairOutcome(
            serverState == "succeeded", serverState, refusal, reason, plan.PreconditionResultsJson, backupRef,
            before.ToJsonString(), after.ToJsonString(),
            verification.ToJsonString(), receipt.ToJsonString());
    }

    private static bool Journal(RepairRunEnvelope envelope, ExecutorRoots roots, string kind, string dataJson)
    {
        try
        {
            OperationJournal.Append(roots.JournalDir, kind, envelope.RunId, dataJson);
            return true;
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException ||
            ex is ArgumentException || ex is NotSupportedException)
        {
            return false;
        }
    }
}

/// <summary>
/// Sealed-report manifest: every report sealed by the diagnostics catalog is
/// recorded with its hash, so repairs prove they left reports untouched.
/// Missing manifest = no sealed reports yet = vacuously intact.
/// </summary>
public static class ReportsManifest
{
    public const string FileName = "manifest.json";

    public static (bool Ok, string Detail) Verify(string reportsDir)
    {
        try
        {
            var path = Path.Combine(reportsDir, FileName);
            if (!File.Exists(path))
            {
                return (true, "no sealed reports yet");
            }

            var manifest = JsonNode.Parse(File.ReadAllText(path)) as JsonObject;
            if (manifest is null || !manifest.TryGetPropertyValue("files", out var filesNode) ||
                filesNode is not JsonObject files)
            {
                return (false, "manifest malformed");
            }

            var count = 0;
            foreach (var kvp in files)
            {
                var expected = kvp.Value is JsonValue value &&
                    value.TryGetValue<string>(out var text) ? text ?? string.Empty : string.Empty;
                var full = Path.GetFullPath(Path.Combine(reportsDir, kvp.Key));
                var dirFull = Path.GetFullPath(reportsDir);
                if (!full.StartsWith(dirFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                    !File.Exists(full))
                {
                    return (false, $"report missing or escaped: {kvp.Key}");
                }

                using var sha = SHA256.Create();
                using var stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.Read);
                var actual = Convert.ToHexString(sha.ComputeHash(stream)).ToLowerInvariant();
                if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
                {
                    return (false, $"report changed since seal: {kvp.Key}");
                }

                count++;
            }

            return (true, $"{count} sealed reports verified");
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException ||
            ex is ArgumentException || ex is JsonException || ex is NotSupportedException)
        {
            return (false, $"manifest unreadable: {ex.GetType().Name}");
        }
    }

    /// <summary>Records a newly sealed report. Called only by the report sealer.</summary>
    public static void Record(string reportsDir, string fileName, string sha256Hex)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(fileName);
        ArgumentException.ThrowIfNullOrWhiteSpace(sha256Hex);
        if (fileName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
            fileName.Contains('/') || fileName.Contains('\\'))
        {
            throw new ArgumentException("Report file name must be a bare file name.", nameof(fileName));
        }

        Directory.CreateDirectory(reportsDir);
        var path = Path.Combine(reportsDir, FileName);
        JsonObject manifest = new();
        try
        {
            if (File.Exists(path))
            {
                manifest = JsonNode.Parse(File.ReadAllText(path)) as JsonObject ?? new JsonObject();
            }
        }
        catch (JsonException)
        {
            manifest = new JsonObject();
        }

        var files = manifest.TryGetPropertyValue("files", out var filesNode) && filesNode is JsonObject existing
            ? existing
            : new JsonObject();
        files[fileName] = sha256Hex;
        manifest["files"] = files;
        manifest["updatedAt"] = DateTimeOffset.UtcNow.ToString("O");
        File.WriteAllText(path, manifest.ToJsonString());
    }
}
