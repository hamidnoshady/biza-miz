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

    public void Dispose()
    {
        _held?.Dispose();
        _held = null;
    }
}
