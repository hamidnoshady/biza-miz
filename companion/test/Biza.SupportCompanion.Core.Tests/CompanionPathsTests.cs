using Biza.SupportCompanion.Core;

namespace Biza.SupportCompanion.Core.Tests;

/// <summary>
/// The install locations are a cross-runtime contract with
/// <c>electron/support-companion.js</c> — these tests pin the names and the
/// override rule so the two sides cannot drift silently.
/// </summary>
public sealed class CompanionPathsTests
{
    [Fact]
    public void DirectoryAndExeNamesArePinned()
    {
        Assert.Equal("Biza Support Companion", CompanionPaths.DirectoryName);
        Assert.Equal("BizaSupportCompanion.exe", CompanionPaths.ExeName);
        Assert.Equal("BIZA_SUPPORT_COMPANION_EXE", CompanionPaths.ExeOverrideVariable);
    }

    [Fact]
    public void DefaultCandidatesAreMachineThenPerUserInstall()
    {
        var paths = CompanionPaths.CandidateInstallPaths();

        Assert.Equal(2, paths.Count);
        Assert.EndsWith(
            Path.Combine("Biza Support Companion", "BizaSupportCompanion.exe"),
            paths[0],
            StringComparison.OrdinalIgnoreCase);
        Assert.EndsWith(
            Path.Combine("Biza Support Companion", "BizaSupportCompanion.exe"),
            paths[1],
            StringComparison.OrdinalIgnoreCase);
        Assert.StartsWith(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            paths[0],
            StringComparison.OrdinalIgnoreCase);
        Assert.StartsWith(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            paths[1],
            StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ExplicitOverrideIsTheOnlyCandidate()
    {
        var previous = Environment.GetEnvironmentVariable(CompanionPaths.ExeOverrideVariable);
        try
        {
            Environment.SetEnvironmentVariable(
                CompanionPaths.ExeOverrideVariable, @"D:\tools\companion.exe");
            Assert.Equal(
                [@"D:\tools\companion.exe"],
                CompanionPaths.CandidateInstallPaths());
        }
        finally
        {
            Environment.SetEnvironmentVariable(CompanionPaths.ExeOverrideVariable, previous);
        }
    }

    [Fact]
    public void ResolveInstalledExeFindsTheOverride()
    {
        var previous = Environment.GetEnvironmentVariable(CompanionPaths.ExeOverrideVariable);
        var probe = Path.Combine(Path.GetTempPath(), $"companion-probe-{Guid.NewGuid():N}.exe");
        try
        {
            File.WriteAllBytes(probe, [0x4D, 0x5A]);
            Environment.SetEnvironmentVariable(CompanionPaths.ExeOverrideVariable, probe);
            Assert.Equal(probe, CompanionPaths.ResolveInstalledExe());
        }
        finally
        {
            Environment.SetEnvironmentVariable(CompanionPaths.ExeOverrideVariable, previous);
            File.Delete(probe);
        }
    }

    [Fact]
    public void ResolveInstalledExeIsNullWhenAbsent()
    {
        var previous = Environment.GetEnvironmentVariable(CompanionPaths.ExeOverrideVariable);
        try
        {
            Environment.SetEnvironmentVariable(
                CompanionPaths.ExeOverrideVariable,
                Path.Combine(Path.GetTempPath(), $"missing-{Guid.NewGuid():N}.exe"));
            Assert.Null(CompanionPaths.ResolveInstalledExe());
        }
        finally
        {
            Environment.SetEnvironmentVariable(CompanionPaths.ExeOverrideVariable, previous);
        }
    }
}
