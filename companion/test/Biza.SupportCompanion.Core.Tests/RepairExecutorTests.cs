using System.Text.Json;
using System.Text.Json.Nodes;

using Biza.SupportCompanion.Core;

using Xunit;

namespace Biza.SupportCompanion.Core.Tests;

public sealed class RepairExecutorTests
{
    private const string CleanTempRecipe =
        """{"action": "companion.clean_temp", "params": {"maxAgeDays": 7, "roots": ["companion_temp"]}}""";
    private const string CleanTempHash =
        "ba74ad2b84b51556b140aa9170c414abdd951ecc157399f7b632783c815a45f2";
    private const string RotateLogsRecipe =
        """{"action": "companion.rotate_logs", "params": {"keepFiles": 10}}""";
    private const string RotateLogsHash =
        "def201fe2839679211c802746c84340b9b60a50cf4802185a9c2a32a2cebbd7e";
    private const string RestartBackendRecipe =
        """{"action": "main.restart_backend", "params": {"requireGate": true, "timeoutSec": 120}}""";
    private const string RestartBackendHash =
        "466f770b14207ee2280555749bd9f42e30c9585f627b3b3a721715e30b1ff7a7";

    private const string LowConsent = """{"consentId":"consent-1"}""";
    private const string MediumConsent = """{"consentId":"consent-2","riskAcknowledged":true}""";

    private static ExecutorRoots FreshRoots()
    {
        var data = Path.Combine(Path.GetTempPath(), "biza-exec-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(data);
        return new ExecutorRoots(
            DataDir: data,
            TempDir: Path.Combine(data, "temp"),
            LogDir: Path.Combine(data, "logs"),
            JournalDir: Path.Combine(data, "journal"),
            ReportsDir: Path.Combine(data, "reports"),
            StagingDir: Path.Combine(data, "staging"),
            LockPathOverride: Path.Combine(data, "maintenance.lock"));
    }

    private static RepairRunEnvelope Envelope(
        string recipeJson, string recipeHash, string risk = "low", string backupPolicy = "none",
        string preconditions = """[{"check":"root_owned","detail":"companion_temp"},{"check":"dry_run_first"}]""",
        string postchecks = """[{"check":"journal_intact"},{"check":"reports_intact"}]""")
    {
        var json = """{"runId":"run-1","recipeId":"test.recipe","recipeVersion":1,"recipeHash":""""
            + recipeHash + """","risk":"""" + risk + """","backupPolicy":"""" + backupPolicy
            + """","recipe":""" + recipeJson
            + ""","preconditions":""" + preconditions + ""","postchecks":""" + postchecks + "}";
        Assert.True(RepairRunEnvelope.TryParse(json, out var envelope, out var error), error);
        return envelope!;
    }

    private static void WriteOldFile(string path, string content = "old")
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
        File.SetLastWriteTimeUtc(path, DateTimeOffset.UtcNow.AddDays(-30).UtcDateTime);
    }

    private static string ReceiptField(RepairOutcome outcome, string name)
    {
        var receipt = JsonNode.Parse(outcome.ReceiptJson) as JsonObject;
        if (receipt is not null && receipt.TryGetPropertyValue(name, out var node) &&
            node is JsonValue value && value.TryGetValue<string>(out var text))
        {
            return text ?? string.Empty;
        }

        return string.Empty;
    }

    private static string ReceiptReason(RepairOutcome outcome)
    {
        var reason = ReceiptField(outcome, "reason");
        return reason.Length > 0 ? reason : ReceiptField(outcome, "refusal");
    }

    [Fact]
    public void RejectsMalformedEnvelopes()
    {
        Assert.False(RepairRunEnvelope.TryParse(null, out _, out _));
        Assert.False(RepairRunEnvelope.TryParse("{oops", out _, out _));
        Assert.False(RepairRunEnvelope.TryParse("""{"runId":"x"}""", out _, out _));
        Assert.False(RepairRunEnvelope.TryParse(
            """{"runId":"r","recipeId":"x","recipeVersion":"1","recipeHash":"h","risk":"low","backupPolicy":"none","recipe":{}}""",
            out _, out _));
    }

    [Fact]
    public void PlansCleanTempFromTheSeedRecipe()
    {
        var roots = FreshRoots();
        WriteOldFile(Path.Combine(roots.TempDir, "stale.tmp"));
        File.WriteAllText(Path.Combine(roots.TempDir, "fresh.tmp"), "new");

        var (plan, refusal) = RepairExecutor.Plan(Envelope(CleanTempRecipe, CleanTempHash), roots);

        Assert.Null(refusal);
        Assert.NotNull(plan);
        Assert.Equal(RepairExecutor.VerbCleanTemp, plan.Verb);
        Assert.Contains("stale.tmp", plan.TargetsJson);
        Assert.DoesNotContain("fresh.tmp", plan.TargetsJson);
        Assert.Contains("journal, reports and business data untouched", plan.EffectsSummary);
    }

    [Fact]
    public void RefusesADriftedRecipe()
    {
        var roots = FreshRoots();
        var tampered = CleanTempRecipe.Replace("companion_temp", "companion_logs");

        var (plan, refusal) = RepairExecutor.Plan(Envelope(tampered, CleanTempHash), roots);

        Assert.Null(plan);
        Assert.NotNull(refusal);
        Assert.Equal("blocked", refusal.ServerState);
        Assert.Equal("recipe_drifted", refusal.Refusal);
    }

    [Fact]
    public void RefusesAnUnknownVerb()
    {
        var roots = FreshRoots();
        var recipe = """{"action":"companion.reboot_world","params":{}}""";
        var hash = CanonicalJson.TryHashRecipe(recipe);
        Assert.NotNull(hash);

        var (plan, refusal) = RepairExecutor.Plan(Envelope(recipe, hash), roots);

        Assert.Null(plan);
        Assert.NotNull(refusal);
        Assert.Equal("unknown_verb", refusal.Refusal);
    }

    [Fact]
    public void NamesKnownButUnimplementedVerbsHonestly()
    {
        var roots = FreshRoots();

        var (plan, refusal) = RepairExecutor.Plan(Envelope(RestartBackendRecipe, RestartBackendHash), roots);

        Assert.Null(plan);
        Assert.NotNull(refusal);
        Assert.Equal("unsupported_verb", refusal.Refusal);
        Assert.Contains("main-app cooperation protocol", ReceiptReason(refusal));
    }

    [Fact]
    public void RefusesForbiddenEscapeHatchKeys()
    {
        var roots = FreshRoots();
        var recipe = """{"action":"companion.clean_temp","params":{"maxAgeDays":7,"roots":["companion_temp"]},"command":"del *"}""";
        var hash = CanonicalJson.TryHashRecipe(recipe);
        Assert.NotNull(hash);

        var (plan, refusal) = RepairExecutor.Plan(Envelope(recipe, hash), roots);

        Assert.Null(plan);
        Assert.NotNull(refusal);
        Assert.Equal("forbidden_content", refusal.Refusal);
    }

    [Fact]
    public void RefusesCleanTempOutsideItsOwnRoot()
    {
        var roots = FreshRoots();
        var recipe = """{"action":"companion.clean_temp","params":{"maxAgeDays":7,"roots":["windows"]}}""";
        var hash = CanonicalJson.TryHashRecipe(recipe);
        Assert.NotNull(hash);

        var (plan, refusal) = RepairExecutor.Plan(Envelope(recipe, hash), roots);

        Assert.Null(plan);
        Assert.NotNull(refusal);
        Assert.Equal("invalid_params", refusal.Refusal);
    }

    [Fact]
    public void FailsClosedOnUnevaluablePreconditions()
    {
        var roots = FreshRoots();

        var (plan, refusal) = RepairExecutor.Plan(
            Envelope(CleanTempRecipe, CleanTempHash, preconditions: """[{"check":"no_active_orders_or_uploads"}]"""),
            roots);

        Assert.Null(plan);
        Assert.NotNull(refusal);
        Assert.Equal("precondition_failed", refusal.Refusal);
        Assert.Contains("no_active_orders_or_uploads", refusal.PreconditionResultsJson);
    }

    [Fact]
    public void ExecutesCleanTempEndToEndWithReceipt()
    {
        var roots = FreshRoots();
        var stale = Path.Combine(roots.TempDir, "stale.tmp");
        WriteOldFile(stale);
        var fresh = Path.Combine(roots.TempDir, "fresh.tmp");
        File.WriteAllText(fresh, "new");

        var envelope = Envelope(CleanTempRecipe, CleanTempHash);
        var (plan, planRefusal) = RepairExecutor.Plan(envelope, roots);
        Assert.Null(planRefusal);
        Assert.NotNull(plan);

        var outcome = RepairExecutor.Execute(envelope, plan, LowConsent, null, roots);

        Assert.True(outcome.Ok, ReceiptReason(outcome));
        Assert.Equal("succeeded", outcome.ServerState);
        Assert.False(File.Exists(stale));
        Assert.True(File.Exists(fresh));
        Assert.True(Directory.Exists(Path.Combine(roots.StagingDir, "run-1")));
        Assert.True(File.Exists(Path.Combine(roots.StagingDir, "run-1", "manifest.json")));

        var verification = JsonNode.Parse(outcome.VerificationJson) as JsonObject;
        var verified = verification is not null && verification.TryGetPropertyValue("verified", out var flag) &&
            flag is JsonValue value && value.TryGetValue<bool>(out var parsed) && parsed == true;
        Assert.True(verified);
        var journal = OperationJournal.ReadRun(roots.JournalDir, "run-1");
        Assert.Contains(journal, r => r.Kind == "intent");
        Assert.Contains(journal, r => r.Kind == "executing");
        Assert.Contains(journal, r => r.Kind == "succeeded");
        var (journalOk, journalError) = OperationJournal.Verify(roots.JournalDir);
        Assert.True(journalOk, journalError);
    }

    [Fact]
    public void RotatesLogsKeepingTheNewest()
    {
        var roots = FreshRoots();
        for (var i = 0; i < 12; i++)
        {
            var path = Path.Combine(roots.LogDir, $"app-{i:00}.log");
            Directory.CreateDirectory(roots.LogDir);
            File.WriteAllText(path, "log");
            File.SetLastWriteTimeUtc(path, DateTimeOffset.UtcNow.AddHours(-i).UtcDateTime);
        }

        var envelope = Envelope(RotateLogsRecipe, RotateLogsHash,
            preconditions: """[{"check":"root_owned","detail":"companion_logs"}]""",
            postchecks: """[{"check":"log_write_ok"}]""");
        var (plan, planRefusal) = RepairExecutor.Plan(envelope, roots);
        Assert.Null(planRefusal);
        Assert.NotNull(plan);

        var outcome = RepairExecutor.Execute(envelope, plan, LowConsent, null, roots);

        Assert.True(outcome.Ok, ReceiptReason(outcome));
        Assert.Equal(10, Directory.GetFiles(roots.LogDir, "*.log").Length);
        Assert.True(File.Exists(Path.Combine(roots.LogDir, "app-00.log")));
        Assert.False(File.Exists(Path.Combine(roots.LogDir, "app-11.log")));
    }

    [Fact]
    public void RollsBackWhenPostchecksFail()
    {
        var roots = FreshRoots();
        var stale = Path.Combine(roots.TempDir, "stale.tmp");
        WriteOldFile(stale);

        // A sealed report that changes before execution completes.
        Directory.CreateDirectory(roots.ReportsDir);
        var report = Path.Combine(roots.ReportsDir, "r1.json");
        File.WriteAllText(report, """{"a":1}""");
        using (var sha = System.Security.Cryptography.SHA256.Create())
        {
            using var stream = File.OpenRead(report);
            var hash = Convert.ToHexString(sha.ComputeHash(stream)).ToLowerInvariant();
            ReportsManifest.Record(roots.ReportsDir, "r1.json", hash);
        }

        File.WriteAllText(report, """{"a":2}""");

        var envelope = Envelope(CleanTempRecipe, CleanTempHash);
        var (plan, planRefusal) = RepairExecutor.Plan(envelope, roots);
        Assert.Null(planRefusal);
        Assert.NotNull(plan);

        var outcome = RepairExecutor.Execute(envelope, plan, LowConsent, null, roots);

        Assert.False(outcome.Ok);
        Assert.Equal("rolled_back", outcome.ServerState);
        Assert.True(File.Exists(stale));
        Assert.Equal("stale.tmp rollback content mismatch", "old", File.ReadAllText(stale));
    }

    [Fact]
    public void RefusesWithoutConsentAndWithoutRiskAcknowledgement()
    {
        var roots = FreshRoots();
        var envelope = Envelope(CleanTempRecipe, CleanTempHash);
        var (plan, _) = RepairExecutor.Plan(envelope, roots);
        Assert.NotNull(plan);

        var noConsent = RepairExecutor.Execute(envelope, plan, string.Empty, null, roots);
        Assert.Equal("consent_missing", noConsent.Refusal);

        var medium = Envelope(CleanTempRecipe, CleanTempHash, risk: "medium");
        var (mediumPlan, _) = RepairExecutor.Plan(medium, roots);
        Assert.NotNull(mediumPlan);
        var noAck = RepairExecutor.Execute(medium, mediumPlan, LowConsent, null, roots);
        Assert.Equal("consent_missing", noAck.Refusal);
        var acked = RepairExecutor.Execute(medium, mediumPlan, MediumConsent, null, roots);
        Assert.NotEqual("consent_missing", acked.Refusal);
    }

    [Fact]
    public void RefusesVerifiedBackupRecipesWithoutABackupRef()
    {
        var roots = FreshRoots();
        var envelope = Envelope(CleanTempRecipe, CleanTempHash, backupPolicy: "verified_backup");
        var (plan, _) = RepairExecutor.Plan(envelope, roots);
        Assert.NotNull(plan);

        var missing = RepairExecutor.Execute(envelope, plan, LowConsent, null, roots);
        Assert.Equal("backup_required", missing.Refusal);

        var claimed = RepairExecutor.Execute(envelope, plan, LowConsent, "backup-123", roots);
        Assert.NotEqual("backup_required", claimed.Refusal);
        Assert.Contains("claimed_not_verified", claimed.ReceiptJson);
    }

    [Fact]
    public void RefusesWhenTheGateIsHeld()
    {
        var roots = FreshRoots();
        using var held = MaintenanceLock.TryAcquire(roots.LockPathOverride);
        Assert.NotNull(held);

        var envelope = Envelope(CleanTempRecipe, CleanTempHash);
        var (plan, _) = RepairExecutor.Plan(envelope, roots);
        Assert.NotNull(plan);

        var outcome = RepairExecutor.Execute(envelope, plan, LowConsent, null, roots);
        Assert.Equal("gate_busy", outcome.Refusal);
    }

    [Fact]
    public void RefusesWhenTheApprovedPlanDrifted()
    {
        var roots = FreshRoots();
        WriteOldFile(Path.Combine(roots.TempDir, "a.tmp"));

        var envelope = Envelope(CleanTempRecipe, CleanTempHash);
        var (plan, _) = RepairExecutor.Plan(envelope, roots);
        Assert.NotNull(plan);

        WriteOldFile(Path.Combine(roots.TempDir, "b.tmp"));

        var outcome = RepairExecutor.Execute(envelope, plan, LowConsent, null, roots);
        Assert.Equal("plan_drifted", outcome.Refusal);
        Assert.True(File.Exists(Path.Combine(roots.TempDir, "a.tmp")));
    }

    [Fact]
    public void HonoursCancellation()
    {
        var roots = FreshRoots();
        WriteOldFile(Path.Combine(roots.TempDir, "a.tmp"));

        var envelope = Envelope(CleanTempRecipe, CleanTempHash);
        var (plan, _) = RepairExecutor.Plan(envelope, roots);
        Assert.NotNull(plan);

        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        var outcome = RepairExecutor.Execute(envelope, plan, LowConsent, null, roots, cancelled.Token);
        Assert.Equal("cancelled", outcome.ServerState);
        Assert.True(File.Exists(Path.Combine(roots.TempDir, "a.tmp")));
    }

    [Fact]
    public void ReportsManifestDetectsChangedReports()
    {
        var roots = FreshRoots();
        Directory.CreateDirectory(roots.ReportsDir);
        var report = Path.Combine(roots.ReportsDir, "r1.json");
        File.WriteAllText(report, """{"a":1}""");
        using (var sha = System.Security.Cryptography.SHA256.Create())
        {
            using var stream = File.OpenRead(report);
            ReportsManifest.Record(roots.ReportsDir, "r1.json",
                Convert.ToHexString(sha.ComputeHash(stream)).ToLowerInvariant());
        }

        var (okBefore, _) = ReportsManifest.Verify(roots.ReportsDir);
        Assert.True(okBefore);
        File.WriteAllText(report, """{"a":2}""");
        var (okAfter, detail) = ReportsManifest.Verify(roots.ReportsDir);
        Assert.False(okAfter);
        Assert.Contains("r1.json", detail);
    }
}
