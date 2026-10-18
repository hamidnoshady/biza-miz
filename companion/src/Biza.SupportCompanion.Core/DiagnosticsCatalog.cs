using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Biza.SupportCompanion.Core;

/// <summary>
/// The fixed collector catalog. These names must equal
/// <c>SUPPORT_DIAGNOSTIC_MODULES</c> in
/// <c>src/lib/support-companion/types.ts</c>; unknown requested modules are
/// dropped, never executed.
/// </summary>
public static class DiagnosticModules
{
    public const string Startup = "startup";
    public const string Runtime = "runtime";
    public const string Storage = "storage";
    public const string Database = "database";
    public const string Schema = "schema";
    public const string Backup = "backup";
    public const string Connectivity = "connectivity";
    public const string Sync = "sync";
    public const string Certificates = "certificates";
    public const string Gateway = "gateway";

    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.Ordinal)
    {
        Startup, Runtime, Storage, Database, Schema, Backup, Connectivity, Sync, Certificates, Gateway,
    };
}

/// <summary>Per-check outcome. Mirrors the epic's collector vocabulary.</summary>
public enum CheckStatus
{
    Passed,
    Failed,
    Warning,
    Unavailable,
    Skipped,
    Cancelled,
}

/// <summary>One collector finding. Details are redacted before sealing.</summary>
public sealed record Finding(
    string Module,
    string CheckId,
    CheckStatus Status,
    string Code,
    string Detail,
    string ObservedAt);

/// <summary>What a probe measured. No secrets, no PII, bounded text.</summary>
public sealed record ProbeResult(CheckStatus Status, string Code, string Detail);

/// <summary>One bounded collector. Implementations are synchronous and fast; the catalog enforces timeouts.</summary>
public interface IDiagnosticProbe
{
    string Module { get; }
    string CheckId { get; }
    ProbeResult Probe(CancellationToken token);
}

/// <summary>Explicit inputs for the standard probes. Nothing is guessed.</summary>
public sealed record CompanionProbeConfig(
    string DataDir,
    string TempDir,
    string JournalDir,
    string ReportsDir,
    string? SupportBaseUrl = null,
    string? MainInstallHint = null);

/// <summary>
/// Issue #984 — the bounded offline diagnostics catalog. Fixed probes with
/// explicit module coverage, per-check timeouts, cancellation, redaction
/// before sealing, and honest <c>unavailable</c> states. Absent data is
/// never a passing check; modules without probes report
/// <c>unsupported</c> in coverage instead of fake findings.
/// </summary>
public static class DiagnosticsCatalog
{
    public const string CatalogVersion = "1";
    public const int MaxFindings = 100;
    public const int MaxDetailChars = 2000;

    public static string CoreVersion =>
        typeof(DiagnosticsCatalog).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    /// <summary>The standard probe set. Conditional probes report honest unavailability when unconfigured.</summary>
    public static IReadOnlyList<IDiagnosticProbe> StandardProbes(CompanionProbeConfig config)
    {
        ArgumentNullException.ThrowIfNull(config);
        return
        [
            new OsProbe(),
            new FrameworkProbe(),
            new ClockProbe(),
            new ReportsManifestProbe(config.ReportsDir),
            new CompanionInstallProbe(),
            new CompanionProcessProbe(),
            new JournalProbe(config.JournalDir),
            new MainAppDiscoveryProbe(config.MainInstallHint),
            new MainProcessProbe(config.MainInstallHint),
            new DiskProbe(config.DataDir),
            new TempSizeProbe(config.TempDir),
            new ConnectivityProbe(config.SupportBaseUrl),
            new PostgresProcessProbe(config.MainInstallHint),
        ];
    }

    /// <summary>
    /// Runs the requested modules' probes. Unknown modules are ignored;
    /// modules with no probes are reported unsupported in coverage.
    /// Probes run synchronously on the caller's thread: callers must invoke
    /// this on a worker thread, never a UI thread.
    /// </summary>
    public static IReadOnlyList<Finding> Run(
        IEnumerable<string> requestedModules,
        IEnumerable<IDiagnosticProbe> probes,
        TimeSpan perCheckTimeout,
        CancellationToken token = default)
    {
        var requested = new HashSet<string>(requestedModules.Where(DiagnosticModules.All.Contains), StringComparer.Ordinal);
        var findings = new List<Finding>();
        foreach (var probe in probes)
        {
            if (findings.Count >= MaxFindings)
            {
                break;
            }

            if (!requested.Contains(probe.Module))
            {
                continue;
            }

            if (token.IsCancellationRequested)
            {
                findings.Add(new Finding(probe.Module, probe.CheckId, CheckStatus.Skipped,
                    "run_cancelled", "skipped: run cancelled before this check", Stamp()));
                continue;
            }

            findings.Add(RunOne(probe, perCheckTimeout, token));
        }

        return findings;
    }

    private static Finding RunOne(IDiagnosticProbe probe, TimeSpan perCheckTimeout, CancellationToken token)
    {
        using var timeout = new CancellationTokenSource(perCheckTimeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, timeout.Token);
        try
        {
            var result = probe.Probe(linked.Token);
            return new Finding(probe.Module, probe.CheckId, result.Status, result.Code,
                Truncate(result.Detail), Stamp());
        }
        catch (OperationCanceledException)
        {
            return token.IsCancellationRequested
                ? new Finding(probe.Module, probe.CheckId, CheckStatus.Cancelled,
                    "operator_stop", "cancelled by operator Stop", Stamp())
                : new Finding(probe.Module, probe.CheckId, CheckStatus.Unavailable,
                    "check_timeout", $"check exceeded {perCheckTimeout.TotalSeconds}s; not measured", Stamp());
        }
        catch (Exception ex)
        {
            // A probe must never kill a run: unexpected probe errors become
            // unavailable findings with the exception TYPE only (messages
            // can carry paths/PII).
            return new Finding(probe.Module, probe.CheckId, CheckStatus.Unavailable,
                "probe_error", $"probe failed internally: {ex.GetType().Name}", Stamp());
        }
    }

    private static string Stamp() => DateTimeOffset.UtcNow.ToString("O");

    private static string Truncate(string detail)
    {
        if (detail.Length <= MaxDetailChars)
        {
            return detail;
        }

        return detail.Substring(0, MaxDetailChars) + "…[truncated]";
    }

    /// <summary>Suggests the runs-POST state from findings plus requested modules. The shell owns the final call.</summary>
    public static string SuggestRunState(IReadOnlyList<Finding> findings, IEnumerable<string> requestedModules)
    {
        if (findings.Any(static f => f.Status == CheckStatus.Failed))
        {
            return "failed";
        }

        if (findings.Any(static f => f.Status == CheckStatus.Cancelled))
        {
            return "cancelled";
        }

        var requested = new HashSet<string>(requestedModules.Where(DiagnosticModules.All.Contains), StringComparer.Ordinal);
        var covered = new HashSet<string>(findings.Select(static f => f.Module), StringComparer.Ordinal);
        var clean = findings.All(static f => f.Status == CheckStatus.Passed);
        return requested.IsSubsetOf(covered) && clean ? "completed" : "partial";
    }

    /// <summary>ok only when every finding passed; failed on any failure; warning otherwise.</summary>
    public static string SeverityOverall(IReadOnlyList<Finding> findings)
    {
        if (findings.Any(static f => f.Status == CheckStatus.Failed))
        {
            return "failed";
        }

        return findings.All(static f => f.Status == CheckStatus.Passed) ? "ok" : "warning";
    }

    /// <summary>Per-requested-module coverage, including explicit unsupported modules.</summary>
    public static JsonObject Coverage(IReadOnlyList<Finding> findings, IEnumerable<string> requestedModules)
    {
        var coverage = new JsonObject();
        foreach (var module in requestedModules.Where(DiagnosticModules.All.Contains).Distinct())
        {
            var moduleFindings = findings.Where(f => f.Module == module).ToList();
            coverage[module] = new JsonObject
            {
                ["total"] = moduleFindings.Count,
                ["passed"] = moduleFindings.Count(static f => f.Status == CheckStatus.Passed),
                ["failed"] = moduleFindings.Count(static f => f.Status == CheckStatus.Failed),
                ["warning"] = moduleFindings.Count(static f => f.Status == CheckStatus.Warning),
                ["unavailable"] = moduleFindings.Count(static f => f.Status == CheckStatus.Unavailable),
                ["skipped"] = moduleFindings.Count(static f => f.Status == CheckStatus.Skipped),
                ["cancelled"] = moduleFindings.Count(static f => f.Status == CheckStatus.Cancelled),
                ["unsupported"] = moduleFindings.Count == 0,
            };
        }

        return coverage;
    }

    /// <summary>
    /// The runs-POST body: state, collector versions, coverage, redacted
    /// findings, severity, observation time. Redaction counts are returned
    /// so the UI shows exclusions.
    /// </summary>
    public static (string BodyJson, RedactionSummary Redaction) BuildReportBody(
        string requestId, string state, IReadOnlyList<Finding> findings, IEnumerable<string> requestedModules)
    {
        var summary = new RedactionSummary();
        var findingsArray = new JsonArray();
        string? earliest = null;
        foreach (var finding in findings.Take(MaxFindings))
        {
            var detail = Redactor.RedactSecrets(finding.Detail);
            if (!string.Equals(detail, finding.Detail, StringComparison.Ordinal))
            {
                summary.ScrubbedValues++;
            }

            if (earliest is null || string.Compare(finding.ObservedAt, earliest, StringComparison.Ordinal) < 0)
            {
                earliest = finding.ObservedAt;
            }

            findingsArray.Add(new JsonObject
            {
                ["module"] = finding.Module,
                ["checkId"] = finding.CheckId,
                ["status"] = finding.Status.ToString().ToLowerInvariant(),
                ["code"] = finding.Code,
                ["detail"] = detail,
                ["observedAt"] = finding.ObservedAt,
            });
        }

        var body = new JsonObject
        {
            ["requestId"] = requestId,
            ["state"] = state,
            ["collectorVersions"] = new JsonObject
            {
                ["companion_core"] = CoreVersion,
                ["diagnostics_catalog"] = CatalogVersion,
            },
            ["coverage"] = Coverage(findings, requestedModules),
            ["findings"] = findingsArray,
            ["severityOverall"] = SeverityOverall(findings),
            ["observedAt"] = earliest,
            ["versions"] = new JsonObject { ["companionVersion"] = CoreVersion },
        };
        return (body.ToJsonString(), summary);
    }

    /// <summary>
    /// Seals a built report body to the reports dir and records it in the
    /// manifest, so repairs later prove they left reports untouched.
    /// Returns the file name plus its sha256.
    /// </summary>
    public static (string FileName, string Sha256Hex) SealReport(string reportsDir, string bodyJson)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(reportsDir);
        ArgumentNullException.ThrowIfNull(bodyJson);
        Directory.CreateDirectory(reportsDir);
        var fileName = $"report-{DateTimeOffset.UtcNow:yyyyMMddTHHmmssZ}-{Guid.NewGuid().ToString("N")[..8]}.json";
        var path = Path.Combine(reportsDir, fileName);
        File.WriteAllText(path, bodyJson, Encoding.UTF8);
        using var sha = SHA256.Create();
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        var hash = Convert.ToHexString(sha.ComputeHash(stream)).ToLowerInvariant();
        ReportsManifest.Record(reportsDir, fileName, hash);
        return (fileName, hash);
    }
}

// ── Built-in probes ──────────────────────────────────────────────────────

/// <summary>OS description + architecture. Informational, always passed.</summary>
public sealed class OsProbe : IDiagnosticProbe
{
    public string Module => DiagnosticModules.Runtime;
    public string CheckId => "os_info";

    public ProbeResult Probe(CancellationToken token)
    {
        return new ProbeResult(CheckStatus.Passed, "os_info",
            $"{RuntimeInformation.OSDescription.Trim()} ({RuntimeInformation.OSArchitecture})".Trim());
    }
}

/// <summary>The exact .NET runtime executing the companion.</summary>
public sealed class FrameworkProbe : IDiagnosticProbe
{
    public string Module => DiagnosticModules.Runtime;
    public string CheckId => "dotnet_runtime";

    public ProbeResult Probe(CancellationToken token)
    {
        return new ProbeResult(CheckStatus.Passed, "dotnet_runtime", RuntimeInformation.FrameworkDescription.Trim());
    }
}

/// <summary>
/// Local clock report. The source is always the local machine clock, which
/// is untrusted for replay protection — stated in the finding, never hidden.
/// </summary>
public sealed class ClockProbe : IDiagnosticProbe
{
    public string Module => DiagnosticModules.Runtime;
    public string CheckId => "clock_report";

    public ProbeResult Probe(CancellationToken token)
    {
        var now = DateTimeOffset.UtcNow;
        return new ProbeResult(CheckStatus.Passed, "clock_report",
            $"utc={now:O} local_offset_min={TimeZoneInfo.Local.GetUtcOffset(now).TotalMinutes} source=local_clock_untrusted_for_replay");
    }
}

/// <summary>Sealed-report manifest integrity. Missing manifest = no reports yet = passed.</summary>
public sealed class ReportsManifestProbe : IDiagnosticProbe
{
    private readonly string _reportsDir;

    public ReportsManifestProbe(string reportsDir)
    {
        _reportsDir = reportsDir;
    }

    public string Module => DiagnosticModules.Runtime;
    public string CheckId => "reports_manifest";

    public ProbeResult Probe(CancellationToken token)
    {
        var (ok, detail) = ReportsManifest.Verify(_reportsDir);
        return ok
            ? new ProbeResult(CheckStatus.Passed, "reports_manifest_ok", detail)
            : new ProbeResult(CheckStatus.Failed, "reports_manifest_bad", detail);
    }
}

/// <summary>Whether this process runs from an installed companion location.</summary>
public sealed class CompanionInstallProbe : IDiagnosticProbe
{
    public string Module => DiagnosticModules.Startup;
    public string CheckId => "companion_install";

    public ProbeResult Probe(CancellationToken token)
    {
        var exe = CompanionPaths.ResolveInstalledExe();
        return exe is null
            ? new ProbeResult(CheckStatus.Warning, "portable_or_test",
                "no installed companion EXE found at the machine/per-user candidates (portable run or test)")
            : new ProbeResult(CheckStatus.Passed, "installed", $"installed at {exe}");
    }
}

/// <summary>Own-process identity (PID, start time, image path). No broad inventory.</summary>
public sealed class CompanionProcessProbe : IDiagnosticProbe
{
    public string Module => DiagnosticModules.Startup;
    public string CheckId => "companion_process";

    public ProbeResult Probe(CancellationToken token)
    {
        try
        {
            using var self = Process.GetCurrentProcess();
            return new ProbeResult(CheckStatus.Passed, "process_ok",
                $"pid={self.Id} started={self.StartTime.ToUniversalTime():O}");
        }
        catch (Exception ex) when (ex is InvalidOperationException || ex is NotSupportedException)
        {
            return new ProbeResult(CheckStatus.Unavailable, "process_unknown", ex.GetType().Name);
        }
    }
}

/// <summary>Operation-journal hash-chain integrity.</summary>
public sealed class JournalProbe : IDiagnosticProbe
{
    private readonly string _journalDir;

    public JournalProbe(string journalDir)
    {
        _journalDir = journalDir;
    }

    public string Module => DiagnosticModules.Startup;
    public string CheckId => "journal_integrity";

    public ProbeResult Probe(CancellationToken token)
    {
        var (ok, detail) = OperationJournal.Verify(_journalDir);
        return ok
            ? new ProbeResult(CheckStatus.Passed, "journal_ok", detail.Length > 0 ? detail : "chain verified")
            : new ProbeResult(CheckStatus.Failed, "journal_bad", detail);
    }
}

/// <summary>
/// Main-app install discovery from an explicit launcher-supplied hint. No
/// hint = unavailable (never guessed); hint-but-absent = failed (actionable).
/// </summary>
public sealed class MainAppDiscoveryProbe : IDiagnosticProbe
{
    private readonly string? _hint;

    public MainAppDiscoveryProbe(string? hint)
    {
        _hint = string.IsNullOrWhiteSpace(hint) ? null : hint;
    }

    public string Module => DiagnosticModules.Startup;
    public string CheckId => "main_app_discovery";

    public ProbeResult Probe(CancellationToken token)
    {
        if (_hint is null)
        {
            return new ProbeResult(CheckStatus.Unavailable, "no_install_hint",
                "no main-install hint supplied by the launcher; refusing to guess paths");
        }

        return Directory.Exists(_hint)
            ? new ProbeResult(CheckStatus.Passed, "main_install_present", $"hint exists: {_hint}")
            : new ProbeResult(CheckStatus.Failed, "main_install_not_found", $"hinted install absent: {_hint}");
    }
}

/// <summary>
/// Main-app processes whose image lives under the hinted install dir. No
/// command lines, no broad inventory; per-process access errors are skipped.
/// </summary>
public sealed class MainProcessProbe : IDiagnosticProbe
{
    private readonly string? _hint;

    public MainProcessProbe(string? hint)
    {
        _hint = string.IsNullOrWhiteSpace(hint) ? null : hint;
    }

    public string Module => DiagnosticModules.Startup;
    public string CheckId => "main_process";

    public ProbeResult Probe(CancellationToken token)
    {
        if (_hint is null)
        {
            return new ProbeResult(CheckStatus.Unavailable, "no_install_hint",
                "no main-install hint supplied by the launcher; refusing to scan blindly");
        }

        string fullHint;
        try
        {
            fullHint = Path.GetFullPath(_hint);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
            return new ProbeResult(CheckStatus.Unavailable, "hint_unreadable", ex.GetType().Name);
        }

        var count = 0;
        foreach (var process in Process.GetProcesses())
        {
            token.ThrowIfCancellationRequested();
            try
            {
                var image = process.MainModule?.FileName;
                if (image is not null &&
                    image.StartsWith(fullHint + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                {
                    count++;
                }
            }
            catch (Exception ex) when (ex is InvalidOperationException || ex is NotSupportedException ||
                ex is UnauthorizedAccessException || ex is System.ComponentModel.Win32Exception)
            {
                // System/protected processes: skip, never fail the check.
            }
            finally
            {
                process.Dispose();
            }
        }

        return new ProbeResult(CheckStatus.Passed, "main_process_scan",
            $"{count} running process(es) with images under the hinted install");
    }
}

/// <summary>Data-drive capacity. Thresholds are documented constants, not guesses.</summary>
public sealed class DiskProbe : IDiagnosticProbe
{
    public const long WarnBytesFree = 5L * 1024 * 1024 * 1024;
    public const long FailBytesFree = 512L * 1024 * 1024;

    private readonly string _dir;

    public DiskProbe(string dir)
    {
        _dir = dir;
    }

    public string Module => DiagnosticModules.Storage;
    public string CheckId => "disk_space";

    public ProbeResult Probe(CancellationToken token)
    {
        try
        {
            var root = Path.GetPathRoot(Path.GetFullPath(_dir));
            if (string.IsNullOrEmpty(root))
            {
                return new ProbeResult(CheckStatus.Unavailable, "drive_unknown", "drive root unknown");
            }

            var drive = new DriveInfo(root);
            if (!drive.IsReady)
            {
                return new ProbeResult(CheckStatus.Unavailable, "drive_not_ready", $"{root} not ready");
            }

            var detail = $"drive={root} total_bytes={drive.TotalSize} free_bytes={drive.AvailableFreeSpace}";
            if (drive.AvailableFreeSpace < FailBytesFree)
            {
                return new ProbeResult(CheckStatus.Failed, "disk_critical", detail);
            }

            if (drive.AvailableFreeSpace < WarnBytesFree)
            {
                return new ProbeResult(CheckStatus.Warning, "disk_low", detail);
            }

            return new ProbeResult(CheckStatus.Passed, "disk_ok", detail);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException ||
            ex is ArgumentException || ex is NotSupportedException)
        {
            return new ProbeResult(CheckStatus.Unavailable, "drive_error", ex.GetType().Name);
        }
    }
}

/// <summary>Companion temp footprint (count + bytes, bounded enumeration).</summary>
public sealed class TempSizeProbe : IDiagnosticProbe
{
    private const int Cap = 10_000;

    private readonly string _tempDir;

    public TempSizeProbe(string tempDir)
    {
        _tempDir = tempDir;
    }

    public string Module => DiagnosticModules.Storage;
    public string CheckId => "companion_temp_size";

    public ProbeResult Probe(CancellationToken token)
    {
        try
        {
            if (!Directory.Exists(_tempDir))
            {
                return new ProbeResult(CheckStatus.Passed, "temp_absent", "temp dir absent (nothing staged)");
            }

            long bytes = 0;
            var count = 0;
            var truncated = false;
            foreach (var file in Directory.EnumerateFiles(_tempDir, "*", SearchOption.AllDirectories))
            {
                token.ThrowIfCancellationRequested();
                if (count >= Cap)
                {
                    truncated = true;
                    break;
                }

                try
                {
                    bytes += new FileInfo(file).Length;
                    count++;
                }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
                {
                }
            }

            return new ProbeResult(CheckStatus.Passed, "temp_size",
                $"files={count} bytes={bytes}" + (truncated ? " enumeration_capped" : string.Empty));
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
            return new ProbeResult(CheckStatus.Unavailable, "temp_unreadable", ex.GetType().Name);
        }
    }
}

/// <summary>
/// Support-endpoint reachability via the public database-free health check.
/// Status code only — bodies are never collected. No URL = unavailable.
/// </summary>
public sealed class ConnectivityProbe : IDiagnosticProbe
{
    private readonly string? _baseUrl;

    public ConnectivityProbe(string? baseUrl)
    {
        _baseUrl = string.IsNullOrWhiteSpace(baseUrl) ? null : baseUrl.Trim().TrimEnd('/');
    }

    public string Module => DiagnosticModules.Connectivity;
    public string CheckId => "cloud_reachable";

    public ProbeResult Probe(CancellationToken token)
    {
        if (_baseUrl is null)
        {
            return new ProbeResult(CheckStatus.Unavailable, "no_endpoint_configured",
                "no support endpoint configured; nothing to probe");
        }

        if (!Uri.TryCreate(_baseUrl + "/api/health", UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            return new ProbeResult(CheckStatus.Failed, "bad_endpoint_config",
                "configured support endpoint is not an http(s) URL");
        }

        try
        {
            using var client = new HttpClient();
            using var response = client.GetAsync(uri, token).GetAwaiter().GetResult();
            return response.IsSuccessStatusCode
                ? new ProbeResult(CheckStatus.Passed, "endpoint_ok", $"GET {uri.Host} status={(int)response.StatusCode}")
                : new ProbeResult(CheckStatus.Failed, "endpoint_bad_status", $"GET {uri.Host} status={(int)response.StatusCode}");
        }
        catch (HttpRequestException ex)
        {
            return new ProbeResult(CheckStatus.Failed, "connect_failed",
                $"health check failed: {ex.HttpRequestError}");
        }
        catch (Exception ex) when (ex is InvalidOperationException || ex is NotSupportedException || ex is UriFormatException)
        {
            return new ProbeResult(CheckStatus.Unavailable, "probe_error", ex.GetType().Name);
        }
    }
}

/// <summary>
/// PostgreSQL processes under the hinted install dir. A port probe would
/// prove nothing (and must never trigger a competing server), so this
/// reports process presence only — and unavailable without a hint.
/// </summary>
public sealed class PostgresProcessProbe : IDiagnosticProbe
{
    private readonly string? _hint;

    public PostgresProcessProbe(string? hint)
    {
        _hint = string.IsNullOrWhiteSpace(hint) ? null : hint;
    }

    public string Module => DiagnosticModules.Database;
    public string CheckId => "postgres_process";

    public ProbeResult Probe(CancellationToken token)
    {
        if (_hint is null)
        {
            return new ProbeResult(CheckStatus.Unavailable, "no_install_hint",
                "no main-install hint supplied; database checks need the restricted adapter provisioning");
        }

        string fullHint;
        try
        {
            fullHint = Path.GetFullPath(_hint);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
            return new ProbeResult(CheckStatus.Unavailable, "hint_unreadable", ex.GetType().Name);
        }

        var count = 0;
        foreach (var process in Process.GetProcessesByName("postgres"))
        {
            token.ThrowIfCancellationRequested();
            try
            {
                var image = process.MainModule?.FileName;
                if (image is not null &&
                    image.StartsWith(fullHint + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                {
                    count++;
                }
            }
            catch (Exception ex) when (ex is InvalidOperationException || ex is NotSupportedException ||
                ex is UnauthorizedAccessException || ex is System.ComponentModel.Win32Exception)
            {
            }
            finally
            {
                process.Dispose();
            }
        }

        return new ProbeResult(CheckStatus.Passed, "postgres_scan",
            $"{count} postgres process(es) with images under the hinted install");
    }
}
