using Biza.SupportCompanion.Core;

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
        // A path inside a missing drive can never be created: contention-style
        // absence, not an exception.
        var impossible = Path.Combine("\\\\?\\GLOBALROOT", $"nope-{Guid.NewGuid():N}.lock");
        Assert.Null(MaintenanceLock.TryAcquire(impossible));
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
