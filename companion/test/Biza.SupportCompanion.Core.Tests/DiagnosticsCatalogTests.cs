using System.Text.Json.Nodes;

using Biza.SupportCompanion.Core;

using Xunit;

namespace Biza.SupportCompanion.Core.Tests;

public sealed class DiagnosticsCatalogTests
{
    private sealed class ScriptedProbe : IDiagnosticProbe
    {
        private readonly ProbeResult _result;
        private readonly int _sleepMs;

        public ScriptedProbe(string module, string checkId, ProbeResult result, int sleepMs = 0)
        {
            Module = module;
            CheckId = checkId;
            _result = result;
            _sleepMs = sleepMs;
        }

        public string Module { get; }
        public string CheckId { get; }

        public ProbeResult Probe(CancellationToken token)
        {
            if (_sleepMs > 0)
            {
                Task.Delay(_sleepMs, token).GetAwaiter().GetResult();
            }

            return _result;
        }
    }

    private sealed class ExplodingProbe : IDiagnosticProbe
    {
        public string Module => DiagnosticModules.Runtime;
        public string CheckId => "boom";

        public ProbeResult Probe(CancellationToken token) => throw new InvalidOperationException("boom");
    }

    private static string FreshDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), "biza-diag-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static CompanionProbeConfig Config(string dir, string? baseUrl = null, string? hint = null) =>
        new(
            DataDir: dir,
            TempDir: Path.Combine(dir, "temp"),
            JournalDir: Path.Combine(dir, "journal"),
            ReportsDir: Path.Combine(dir, "reports"),
            SupportBaseUrl: baseUrl,
            MainInstallHint: hint);

    [Fact]
    public void InfoProbesAlwaysPassWithContent()
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        foreach (IDiagnosticProbe probe in new IDiagnosticProbe[] { new OsProbe(), new FrameworkProbe(), new ClockProbe() })
        {
            var result = probe.Probe(cts.Token);
            Assert.Equal(CheckStatus.Passed, result.Status);
            Assert.NotEqual(string.Empty, result.Detail.Trim());
        }

        var clock = new ClockProbe().Probe(cts.Token);
        Assert.Contains("local_clock_untrusted_for_replay", clock.Detail);
    }

    [Fact]
    public void DiskProbeReportsStructuredCapacity()
    {
        var dir = FreshDir();
        var result = new DiskProbe(dir).Probe(CancellationToken.None);

        Assert.True(result.Status is CheckStatus.Passed or CheckStatus.Warning or CheckStatus.Failed,
            $"unexpected disk status {result.Status}");
        Assert.Contains("total_bytes=", result.Detail);
        Assert.Contains("free_bytes=", result.Detail);
    }

    [Fact]
    public void JournalProbeReflectsChainIntegrity()
    {
        var dir = FreshDir();
        var journal = Path.Combine(dir, "journal");

        var fresh = new JournalProbe(journal).Probe(CancellationToken.None);
        Assert.Equal(CheckStatus.Passed, fresh.Status);

        OperationJournal.Append(journal, "intent", null, """{"a":1}""");
        var intact = new JournalProbe(journal).Probe(CancellationToken.None);
        Assert.Equal(CheckStatus.Passed, intact.Status);

        var path = Path.Combine(journal, OperationJournal.FileName);
        File.WriteAllText(path, File.ReadAllText(path).Replace("GENESIS", "GENESIX"));
        var broken = new JournalProbe(journal).Probe(CancellationToken.None);
        Assert.Equal(CheckStatus.Failed, broken.Status);
    }

    [Fact]
    public void MainDiscoveryIsHonestWithoutAndWithHints()
    {
        var missing = new MainAppDiscoveryProbe(null).Probe(CancellationToken.None);
        Assert.Equal(CheckStatus.Unavailable, missing.Status);
        Assert.Contains("refusing to guess", missing.Detail);

        var dir = FreshDir();
        var present = new MainAppDiscoveryProbe(dir).Probe(CancellationToken.None);
        Assert.Equal(CheckStatus.Passed, present.Status);

        var absent = new MainAppDiscoveryProbe(Path.Combine(dir, "nope")).Probe(CancellationToken.None);
        Assert.Equal(CheckStatus.Failed, absent.Status);
    }

    [Fact]
    public void MainProcessProbeNeedsAHintAndCountsHonestly()
    {
        var noHint = new MainProcessProbe(null).Probe(CancellationToken.None);
        Assert.Equal(CheckStatus.Unavailable, noHint.Status);

        var dir = FreshDir();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var scanned = new MainProcessProbe(dir).Probe(cts.Token);
        Assert.Equal(CheckStatus.Passed, scanned.Status);
        Assert.Contains("0 running process(es)", scanned.Detail);
    }

    [Fact]
    public void ConnectivityProbeHandlesUnconfiguredBadAndRefusedEndpoints()
    {
        var none = new ConnectivityProbe(null).Probe(CancellationToken.None);
        Assert.Equal(CheckStatus.Unavailable, none.Status);

        var bad = new ConnectivityProbe("not a url").Probe(CancellationToken.None);
        Assert.Equal(CheckStatus.Failed, bad.Status);
        Assert.Equal("bad_endpoint_config", bad.Code);

        // Nothing listens on discard-port 9: deterministic refusal, no network needed.
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var refused = new ConnectivityProbe("http://127.0.0.1:9").Probe(cts.Token);
        Assert.Equal(CheckStatus.Failed, refused.Status);
        Assert.Equal("connect_failed", refused.Code);
    }

    [Fact]
    public void PostgresProbeNeedsAHint()
    {
        var noHint = new PostgresProcessProbe(null).Probe(CancellationToken.None);
        Assert.Equal(CheckStatus.Unavailable, noHint.Status);

        var dir = FreshDir();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var scanned = new PostgresProcessProbe(dir).Probe(cts.Token);
        Assert.Equal(CheckStatus.Passed, scanned.Status);
        Assert.Contains("0 postgres process(es)", scanned.Detail);
    }

    [Fact]
    public void RunExecutesOnlyRequestedKnownModules()
    {
        var probes = new IDiagnosticProbe[]
        {
            new ScriptedProbe(DiagnosticModules.Startup, "a", new ProbeResult(CheckStatus.Passed, "a", "ok")),
            new ScriptedProbe(DiagnosticModules.Runtime, "b", new ProbeResult(CheckStatus.Passed, "b", "ok")),
        };

        var findings = DiagnosticsCatalog.Run(
            ["startup", "bogus_module"], probes, TimeSpan.FromSeconds(5));

        Assert.Single(findings);
        Assert.Equal("a", findings[0].CheckId);
    }

    [Fact]
    public void RunIsolatesExplodingProbesAndEnforcesTimeouts()
    {
        var probes = new IDiagnosticProbe[]
        {
            new ExplodingProbe(),
            new ScriptedProbe(DiagnosticModules.Storage, "slow",
                new ProbeResult(CheckStatus.Passed, "slow", "ok"), sleepMs: 30_000),
        };

        var findings = DiagnosticsCatalog.Run(
            [DiagnosticModules.Runtime, DiagnosticModules.Storage], probes, TimeSpan.FromMilliseconds(100));

        Assert.Equal(2, findings.Count);
        Assert.Equal(CheckStatus.Unavailable, findings[0].Status);
        Assert.Equal("probe_error", findings[0].Code);
        Assert.Contains("InvalidOperationException", findings[0].Detail);
        Assert.Equal(CheckStatus.Unavailable, findings[1].Status);
        Assert.Equal("check_timeout", findings[1].Code);
    }

    [Fact]
    public void RunHonoursCancellation()
    {
        var probes = new IDiagnosticProbe[]
        {
            new ScriptedProbe(DiagnosticModules.Startup, "a", new ProbeResult(CheckStatus.Passed, "a", "ok")),
        };
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        var findings = DiagnosticsCatalog.Run(["startup"], probes, TimeSpan.FromSeconds(5), cts.Token);

        Assert.Single(findings);
        Assert.Equal(CheckStatus.Skipped, findings[0].Status);
    }

    [Fact]
    public void SuggestsTruthfulRunStates()
    {
        Finding Passed(string module) => new(module, "c", CheckStatus.Passed, "ok", "d", "2026-01-01T00:00:00Z");
        var failed = new Finding(DiagnosticModules.Runtime, "c", CheckStatus.Failed, "bad", "d", "2026-01-01T00:00:00Z");
        var cancelled = new Finding(DiagnosticModules.Runtime, "c", CheckStatus.Cancelled, "stop", "d", "2026-01-01T00:00:00Z");
        var unavailable = new Finding(DiagnosticModules.Runtime, "c", CheckStatus.Unavailable, "na", "d", "2026-01-01T00:00:00Z");

        Assert.Equal("failed", DiagnosticsCatalog.SuggestRunState([failed], ["runtime"]));
        Assert.Equal("cancelled", DiagnosticsCatalog.SuggestRunState([cancelled], ["runtime"]));
        Assert.Equal("completed", DiagnosticsCatalog.SuggestRunState([Passed("runtime")], ["runtime"]));
        Assert.Equal("partial", DiagnosticsCatalog.SuggestRunState([unavailable], ["runtime"]));
        // Requested module with no probes: partial, never completed.
        Assert.Equal("partial", DiagnosticsCatalog.SuggestRunState([Passed("runtime")], ["runtime", "backup"]));
        Assert.Equal("ok", DiagnosticsCatalog.SeverityOverall([Passed("runtime")]));
        Assert.Equal("failed", DiagnosticsCatalog.SeverityOverall([Passed("runtime"), failed]));
        Assert.Equal("warning", DiagnosticsCatalog.SeverityOverall([Passed("runtime"), unavailable]));
    }

    [Fact]
    public void CoverageMarksUnsupportedModulesExplicitly()
    {
        Finding Passed(string module) => new(module, "c", CheckStatus.Passed, "ok", "d", "t");
        var coverage = DiagnosticsCatalog.Coverage([Passed("runtime")], ["runtime", "backup"]);

        var runtime = coverage["runtime"] as JsonObject;
        Assert.NotNull(runtime);
        var totalOk = runtime["total"] is JsonValue totalValue &&
            totalValue.TryGetValue<int>(out var total) && total == 1;
        Assert.True(totalOk);
        var backup = coverage["backup"] as JsonObject;
        Assert.NotNull(backup);
        var unsupportedOk = backup["unsupported"] is JsonValue unsupportedValue &&
            unsupportedValue.TryGetValue<bool>(out var unsupported) && unsupported;
        Assert.True(unsupportedOk);
    }

    [Fact]
    public void ReportBodyMatchesTheRunsContractAndRedactsSecrets()
    {
        var findings = new List<Finding>
        {
            new(DiagnosticModules.Runtime, "os_info", CheckStatus.Passed, "os_info", "Windows", "2026-01-01T00:00:00Z"),
            new(DiagnosticModules.Storage, "disk_space", CheckStatus.Passed, "disk_ok",
                "note password: hunter2", "2026-01-01T00:00:01Z"),
        };

        var (bodyJson, redaction) = DiagnosticsCatalog.BuildReportBody(
            "request-1", "completed", findings, ["runtime", "storage"]);

        var body = JsonNode.Parse(bodyJson) as JsonObject;
        Assert.NotNull(body);
        Assert.Equal("request-1", (body["requestId"] as JsonValue)?.TryGetValue<string>(out var id) == true ? id : null);
        Assert.Equal("completed", (body["state"] as JsonValue)?.TryGetValue<string>(out var state) == true ? state : null);
        Assert.Equal("ok", (body["severityOverall"] as JsonValue)?.TryGetValue<string>(out var sev) == true ? sev : null);
        Assert.Equal(1, redaction.ScrubbedValues);
        Assert.Contains("[REDACTED]", bodyJson);
        Assert.DoesNotContain("hunter2", bodyJson);
        var versions = body["collectorVersions"] as JsonObject;
        Assert.NotNull(versions);
    }

    [Fact]
    public void SealReportWritesAndManifests()
    {
        var dir = FreshDir();
        var reports = Path.Combine(dir, "reports");

        var (fileName, hash) = DiagnosticsCatalog.SealReport(reports, """{"findings":[]}""");

        Assert.StartsWith("report-", fileName);
        Assert.True(File.Exists(Path.Combine(reports, fileName)));
        var (ok, _) = ReportsManifest.Verify(reports);
        Assert.True(ok);
        Assert.Equal(64, hash.Length);
    }

    [Fact]
    public void StandardProbesCoverTheHonestCatalog()
    {
        var dir = FreshDir();
        var probes = DiagnosticsCatalog.StandardProbes(Config(dir));

        // 13 probes across startup/runtime/storage/connectivity/database; the
        // schema/backup/sync/certificates/gateway modules have no probes in
        // this companion version and report unsupported, never fake checks.
        Assert.Equal(13, probes.Count);
        Assert.DoesNotContain(probes, p => p.Module == DiagnosticModules.Backup);
        Assert.Contains(probes, p => p is ConnectivityProbe);
    }
}
