using System.Text;

namespace Biza.SupportCompanion.Core;

/// <summary>
/// Issue #984 — the cross-runtime maintenance gate. The companion, the main
/// app and any repair executor must never run maintenance (repairs, sync
/// resets, reinstalls) concurrently: they coordinate through this lock file.
/// The open HANDLE is the lock (held with <c>FileShare.None</c>), so a crash
/// releases it — the OS closes handles, no PID bookkeeping, no stale-lock
/// protocol. The file content is only an operator stamp (who holds it).
///
/// The default path is a cross-runtime contract: the main-app side must adopt
/// the same path (gap: Electron/Next adoption — see companion/README.md).
/// <c>%ProgramData%\Biza</c> is machine-wide so per-user and service runtimes
/// meet here; the installer creates it with a Users-write ACL because standard
/// accounts cannot create directories under <c>%ProgramData%</c> themselves.
/// </summary>
public sealed class MaintenanceLock : IDisposable
{
    public const string LockFileName = "maintenance.lock";
    public const string LockOverrideVariable = "BIZA_MAINTENANCE_LOCK";

    /// <summary>
    /// Electron-side claim files: <c>maintenance.electron.&lt;pid&gt;.claim</c>,
    /// written by <c>electron/maintenance-gate.js</c> while the main app runs
    /// maintenance. Node cannot hold a share-none HANDLE, so the Electron
    /// side claims with a PID-stamped file plus a mtime heartbeat instead;
    /// this side refuses while a claim looks live and deletes provably stale
    /// ones. Crash-safe both ways: a dead C# holder's HANDLE dies with the
    /// OS, a dead Electron holder's PID dies with the process.
    /// </summary>
    public const string ElectronClaimPrefix = "maintenance.electron.";
    public const string ElectronClaimSuffix = ".claim";

    /// <summary>A claim older than this with no fresh heartbeat is suspect.</summary>
    public static readonly TimeSpan ElectronClaimStaleAge = TimeSpan.FromSeconds(60);

    /// <summary>PID-start agreement tolerance (Node reports ms precision).</summary>
    public static readonly TimeSpan ElectronClaimStartTolerance = TimeSpan.FromSeconds(120);

    /// <summary>No maintenance run holds the gate this long; absolute backstop.</summary>
    public static readonly TimeSpan ElectronClaimMaxAge = TimeSpan.FromHours(24);

    /// <summary>
    /// The machine-wide default path, or the <c>BIZA_MAINTENANCE_LOCK</c>
    /// override (tests, portable layouts).
    /// </summary>
    public static string DefaultLockPath()
    {
        var over = (Environment.GetEnvironmentVariable(LockOverrideVariable) ?? string.Empty).Trim();
        if (over.Length > 0)
        {
            return over;
        }

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "Biza",
            LockFileName);
    }

    private FileStream? _held;

    /// <summary>The path this instance guards.</summary>
    public string LockPath { get; }

    /// <summary>Whether this instance currently holds the lock.</summary>
    public bool IsHeld => _held is not null;

    private MaintenanceLock(string lockPath)
    {
        LockPath = lockPath;
    }

    /// <summary>
    /// Acquires the lock, or returns <c>null</c> when another runtime holds it
    /// (or the path is not writable). Never blocks, never throws for
    /// contention — callers report "maintenance already running" honestly.
    /// </summary>
    public static MaintenanceLock? TryAcquire(string? lockPath = null)
    {
        var full = lockPath ?? DefaultLockPath();
        try
        {
            var dir = Path.GetDirectoryName(full);
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }

            if (HasLiveElectronClaim(dir))
            {
                return null;
            }

            var stream = new FileStream(full, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            try
            {
                stream.SetLength(0);
                var stamp = Encoding.UTF8.GetBytes(
                    $"pid={Environment.ProcessId} acquired={DateTimeOffset.UtcNow:O}{Environment.NewLine}");
                stream.Write(stamp, 0, stamp.Length);
                stream.Flush();
            }
            catch
            {
                stream.Dispose();
                return null;
            }

            // Close the race: an Electron claim that landed between the
            // pre-check and the open still wins; release and refuse.
            if (!string.IsNullOrEmpty(dir) && HasLiveElectronClaim(dir))
            {
                stream.Dispose();
                return null;
            }

            var gate = new MaintenanceLock(full)
            {
                _held = stream,
            };
            return gate;
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
        {
            // Sharing violation (held elsewhere) or ACL denial: both mean
            // "cannot hold the gate", reported as absence, not an error.
            return null;
        }
    }

    /// <summary>
    /// Scans for live Electron claims, deleting provably stale ones.
    /// Conservative: anything unparseable or unverifiable counts as live
    /// (refuse, retry later) unless the PID is provably dead.
    /// </summary>
    private static bool HasLiveElectronClaim(string? dir)
    {
        if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
        {
            return false;
        }

        string[] claims;
        try
        {
            claims = Directory.GetFiles(dir, ElectronClaimPrefix + "*" + ElectronClaimSuffix);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
        {
            return false;
        }

        foreach (var claim in claims)
        {
            // Only pid-parseable names are ours; foreign junk is left alone.
            if (!TryParseClaimPid(claim, out _))
            {
                continue;
            }

            if (IsLiveElectronClaim(claim))
            {
                return true;
            }

            try
            {
                File.Delete(claim);
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                // Someone else holds it: leave it; next acquire retries.
            }
        }

        return false;
    }

    private static bool TryParseClaimPid(string claimPath, out int pid)
    {
        pid = 0;
        var name = Path.GetFileName(claimPath);
        if (!name.StartsWith(ElectronClaimPrefix, StringComparison.Ordinal) ||
            !name.EndsWith(ElectronClaimSuffix, StringComparison.Ordinal))
        {
            return false;
        }

        var pidText = name.Substring(
            ElectronClaimPrefix.Length, name.Length - ElectronClaimPrefix.Length - ElectronClaimSuffix.Length);
        return int.TryParse(pidText, out pid) && pid > 0;
    }

    private static bool IsLiveElectronClaim(string claimPath)
    {
        if (!TryParseClaimPid(claimPath, out var pid))
        {
            return false;
        }

        var claimedStart = ReadClaimStartUtc(claimPath);
        var pidAlive = ProbePidAlive(pid, out var actualStartUtc);

        // Provably dead PID: stale whatever the file says.
        if (!pidAlive)
        {
            return false;
        }

        // Absolute backstop: no maintenance run holds the gate for a day.
        DateTime mtime;
        try
        {
            mtime = File.GetLastWriteTimeUtc(claimPath);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
        {
            return true;
        }

        if (DateTime.UtcNow - mtime > ElectronClaimMaxAge)
        {
            return false;
        }

        // Unparseable content with a live PID: conservative live.
        if (claimedStart is null)
        {
            return true;
        }

        // Heartbeat gone cold AND the PID is provably not the claimant
        // (reuse): stale. Otherwise live.
        if (DateTime.UtcNow - mtime > ElectronClaimStaleAge &&
            actualStartUtc is not null &&
            (actualStartUtc.Value - claimedStart.Value).Duration() > ElectronClaimStartTolerance)
        {
            return false;
        }

        return true;
    }

    /// <summary>Claimed process start (ticks or ISO), or null when unreadable.</summary>
    private static DateTime? ReadClaimStartUtc(string claimPath)
    {
        try
        {
            foreach (var line in File.ReadLines(claimPath))
            {
                var trimmed = line.Trim();
                if (!trimmed.StartsWith("started=", StringComparison.Ordinal))
                {
                    continue;
                }

                var value = trimmed.Substring("started=".Length).Trim();
                if (long.TryParse(value, out var ticks))
                {
                    return new DateTime(ticks, DateTimeKind.Utc);
                }

                if (DateTimeOffset.TryParse(value, out var parsed))
                {
                    return parsed.UtcDateTime;
                }

                return null;
            }
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
        {
            return null;
        }

        return null;
    }

    /// <summary>
    /// PID liveness plus actual start time. Access-denied reads mean the
    /// process exists (someone else's) — alive with unknown start.
    /// </summary>
    private static bool ProbePidAlive(int pid, out DateTime? actualStartUtc)
    {
        actualStartUtc = null;
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(pid);
            try
            {
                actualStartUtc = process.StartTime.ToUniversalTime();
            }
            catch (Exception ex) when (ex is InvalidOperationException ||
                ex is NotSupportedException || ex is UnauthorizedAccessException ||
                ex is System.ComponentModel.Win32Exception)
            {
                // Exists but unreadable: alive, start unknown.
            }

            return true;
        }
        catch (Exception ex) when (ex is ArgumentException || ex is InvalidOperationException)
        {
            // No such PID (or table race): dead.
            return false;
        }
    }

    public void Dispose()
    {
        _held?.Dispose();
        _held = null;
    }
}
