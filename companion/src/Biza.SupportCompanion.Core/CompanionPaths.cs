namespace Biza.SupportCompanion.Core;

/// <summary>
/// Issue #984 — where the companion lives on disk. These names are a
/// cross-runtime contract: the desktop shell resolves the same paths from
/// <c>electron/support-companion.js</c>. Change both or neither.
/// </summary>
public static class CompanionPaths
{
    public const string DirectoryName = "Biza Support Companion";
    public const string ExeName = "BizaSupportCompanion.exe";

    /// <summary>
    /// Explicit EXE override (tests, portable layouts). When set, it is the
    /// only candidate — same rule as the shell-side launcher.
    /// </summary>
    public const string ExeOverrideVariable = "BIZA_SUPPORT_COMPANION_EXE";

    /// <summary>
    /// Install candidates in check order: machine install, then per-user install.
    /// </summary>
    public static IReadOnlyList<string> CandidateInstallPaths() =>
        CandidateInstallPaths(Environment.GetEnvironmentVariable);

    internal static IReadOnlyList<string> CandidateInstallPaths(Func<string, string?> getVariable)
    {
        var over = (getVariable(ExeOverrideVariable) ?? string.Empty).Trim();
        if (over.Length > 0)
        {
            return [over];
        }

        var paths = new List<string>(capacity: 2);
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        if (programFiles.Length > 0)
        {
            paths.Add(Path.Combine(programFiles, DirectoryName, ExeName));
        }

        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (localAppData.Length > 0)
        {
            paths.Add(Path.Combine(localAppData, DirectoryName, ExeName));
        }

        return paths;
    }

    /// <summary>
    /// The installed companion EXE, or <c>null</c> when no candidate exists.
    /// </summary>
    public static string? ResolveInstalledExe() =>
        CandidateInstallPaths().FirstOrDefault(File.Exists);
}
