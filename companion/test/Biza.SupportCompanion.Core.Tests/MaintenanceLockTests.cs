using Biza.SupportCompanion.Core;

using Xunit;

namespace Biza.SupportCompanion.Core.Tests;

public sealed class MaintenanceLockTests
{
    [Fact]
    public void DefaultPathIsMachineWideAndOverrideable()
    {
        Assert.Equal("maintenance.lock", MaintenanceLock.LockFileName);
        Assert.Equal("BIZA_MAINTENANCE_LOCK", MaintenanceLock.LockOverrideVariable);

        var previous = Environment.GetEnvironmentVariable(MaintenanceLock.LockOverrideVariable);
        try
        {
            Environment.SetEnvironmentVariable(MaintenanceLock.LockOverrideVariable, @"D:\x\y.lock");
            Assert.Equal(@"D:\x\y.lock", MaintenanceLock.DefaultLockPath());

            Environment.SetEnvironmentVariable(MaintenanceLock.LockOverrideVariable, null);
            Assert.Equal(
                Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                    "Biza",
                    "maintenance.lock"),
                MaintenanceLock.DefaultLockPath());
        }
        finally
        {
            Environment.SetEnvironmentVariable(MaintenanceLock.LockOverrideVariable, previous);
        }
    }

    [Fact]
    public void SecondAcquireFailsWhileFirstIsHeld()
    {
        var path = TempLockPath();
        try
        {
            using var first = MaintenanceLock.TryAcquire(path);
            Assert.NotNull(first);
            Assert.True(first.IsHeld);
            Assert.Equal(path, first.LockPath);

            using var second = MaintenanceLock.TryAcquire(path);
            Assert.Null(second);
        }
        finally
        {
            TryDelete(path);
        }
    }

    [Fact]
    public void DisposeReleasesForTheNextAcquirer()
    {
        var path = TempLockPath();
        try
        {
            var first = MaintenanceLock.TryAcquire(path);
            Assert.NotNull(first);
            first.Dispose();
            Assert.False(first.IsHeld);

            using var second = MaintenanceLock.TryAcquire(path);
            Assert.NotNull(second);
            Assert.True(second.IsHeld);
        }
        finally
        {
            TryDelete(path);
        }
    }

    [Fact]
    public void CreatesMissingDirectories()
    {
        var path = Path.Combine(Path.GetTempPath(), $"companion-lock-{Guid.NewGuid():N}", "nested", "maintenance.lock");
        try
        {
            using (var gate = MaintenanceLock.TryAcquire(path))
            {
                Assert.NotNull(gate);
                Assert.True(File.Exists(path));
            }

            // Readable once released: the stamp says who held it.
            Assert.Contains("pid=", File.ReadAllText(path));
        }
        finally
        {
            TryDelete(path);
        }
    }

    [Fact]
    public void UnwritablePathReturnsNullInsteadOfThrowing()
    {
        // A lock path nested under a regular file can never be created:
        // contention-style absence, not an exception.
        var blocker = Path.Combine(Path.GetTempPath(), $"companion-block-{Guid.NewGuid():N}.tmp");
        try
        {
            File.WriteAllBytes(blocker, [0x00]);
            var impossible = Path.Combine(blocker, "maintenance.lock");
            Assert.Null(MaintenanceLock.TryAcquire(impossible));
        }
        finally
        {
            TryDelete(blocker);
        }
    }

    private sealed class ClaimDir : IDisposable
    {
        private readonly string _dir;

        public ClaimDir(out string dir)
        {
            _dir = dir = Path.Combine(Path.GetTempPath(), $"companion-claim-{Guid.NewGuid():N}");
            Directory.CreateDirectory(dir);
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(_dir, recursive: true);
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                // Best effort: CI runners are ephemeral, dev boxes are not.
            }
        }
    }

    private static string WriteClaim(string dir, int pid, string startedValue)
    {
        var path = Path.Combine(dir, $"maintenance.electron.{pid}.claim");
        File.WriteAllText(path, $"pid={pid}\nstarted={startedValue}\nacquired={DateTimeOffset.UtcNow:O}\n");
        return path;
    }

    private static long OwnStartTicks()
    {
        using var self = System.Diagnostics.Process.GetCurrentProcess();
        return self.StartTime.ToUniversalTime().Ticks;
    }

    [Fact]
    public void LiveElectronClaimRefusesAcquire()
    {
        using var cleanup = new ClaimDir(out var dir);
        var claim = WriteClaim(dir, Environment.ProcessId, OwnStartTicks().ToString());

        using var gate = MaintenanceLock.TryAcquire(Path.Combine(dir, "maintenance.lock"));

        Assert.Null(gate);
        Assert.True(File.Exists(claim));
    }

    [Fact]
    public void DeadPidClaimIsStaleAndDeleted()
    {
        using var cleanup = new ClaimDir(out var dir);
        var claim = WriteClaim(dir, int.MaxValue, DateTimeOffset.UtcNow.AddMinutes(-1).UtcTicks.ToString());

        using var gate = MaintenanceLock.TryAcquire(Path.Combine(dir, "maintenance.lock"));

        Assert.NotNull(gate);
        Assert.False(File.Exists(claim));
    }

    [Fact]
    public void ReusedPidWithColdHeartbeatIsStale()
    {
        using var cleanup = new ClaimDir(out var dir);
        var claim = WriteClaim(dir, Environment.ProcessId, DateTimeOffset.UtcNow.AddHours(-1).UtcTicks.ToString());
        File.SetLastWriteTimeUtc(claim, DateTimeOffset.UtcNow.AddSeconds(-70).UtcDateTime);

        using var gate = MaintenanceLock.TryAcquire(Path.Combine(dir, "maintenance.lock"));

        Assert.NotNull(gate);
        Assert.False(File.Exists(claim));
    }

    [Fact]
    public void MatchingStartWithColdHeartbeatStaysLive()
    {
        using var cleanup = new ClaimDir(out var dir);
        var claim = WriteClaim(dir, Environment.ProcessId, OwnStartTicks().ToString());
        File.SetLastWriteTimeUtc(claim, DateTimeOffset.UtcNow.AddSeconds(-70).UtcDateTime);

        using var gate = MaintenanceLock.TryAcquire(Path.Combine(dir, "maintenance.lock"));

        Assert.Null(gate);
        Assert.True(File.Exists(claim));
    }

    [Fact]
    public void MalformedClaimWithLivePidRefuses()
    {
        using var cleanup = new ClaimDir(out var dir);
        var claim = Path.Combine(dir, $"maintenance.electron.{Environment.ProcessId}.claim");
        File.WriteAllText(claim, "garbage without structure\n");

        using var gate = MaintenanceLock.TryAcquire(Path.Combine(dir, "maintenance.lock"));

        Assert.Null(gate);
        Assert.True(File.Exists(claim));
    }

    [Fact]
    public void MalformedClaimWithDeadPidIsDeleted()
    {
        using var cleanup = new ClaimDir(out var dir);
        var claim = Path.Combine(dir, $"maintenance.electron.{int.MaxValue}.claim");
        File.WriteAllText(claim, "garbage without structure\n");

        using var gate = MaintenanceLock.TryAcquire(Path.Combine(dir, "maintenance.lock"));

        Assert.NotNull(gate);
        Assert.False(File.Exists(claim));
    }

    [Fact]
    public void ForeignPatternFileIsLeftAlone()
    {
        using var cleanup = new ClaimDir(out var dir);
        var foreign = Path.Combine(dir, "maintenance.electron.xyz.claim");
        File.WriteAllText(foreign, "not a claim\n");

        using var gate = MaintenanceLock.TryAcquire(Path.Combine(dir, "maintenance.lock"));

        Assert.NotNull(gate);
        Assert.True(File.Exists(foreign));
    }

    [Fact]
    public void AncientClaimHitsTheBackstop()
    {
        using var cleanup = new ClaimDir(out var dir);
        var claim = WriteClaim(dir, Environment.ProcessId, OwnStartTicks().ToString());
        File.SetLastWriteTimeUtc(claim, DateTimeOffset.UtcNow.AddHours(-25).UtcDateTime);

        using var gate = MaintenanceLock.TryAcquire(Path.Combine(dir, "maintenance.lock"));

        Assert.NotNull(gate);
        Assert.False(File.Exists(claim));
    }

    private static string TempLockPath() =>
        Path.Combine(Path.GetTempPath(), $"companion-lock-{Guid.NewGuid():N}.lock");

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
            var dir = Path.GetDirectoryName(path);
            if (dir is not null && dir.StartsWith(Path.GetTempPath(), StringComparison.OrdinalIgnoreCase))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch (IOException)
        {
            // Best-effort cleanup of temp probes.
        }
        catch (UnauthorizedAccessException)
        {
            // Best-effort cleanup of temp probes.
        }
    }
}
