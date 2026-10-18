using System.Security.Cryptography;
using System.Text;

namespace Biza.SupportCompanion.Core;

/// <summary>
/// Issue #984 — verified update download staging plus the apply script.
///
/// The companion updates itself from its own signed channel (see
/// <see cref="UpdateManifest"/>): the shell downloads each manifest file,
/// this stager re-hashes every byte against the verified manifest and
/// lays the set down in a versioned staging dir — any mismatch aborts and
/// wipes the staging dir, so a partial or tampered set can never install.
/// Applying then needs a helper: Windows locks the running EXE, so
/// <see cref="TryWriteApplyScript"/> writes a small <c>.cmd</c> that waits
/// for our PID to exit, moves the verified files over the install dir,
/// and restarts the app. The shell launches that script detached and exits.
///
/// Trust notes: only bytes that match the RSA-verified manifest (path +
/// size + sha256) are ever staged or moved; paths are re-validated here
/// (defense in depth — the manifest verifier already enforces them); the
/// target dir must exist and be writable, otherwise the install refuses
/// honestly instead of half-applying (per-machine installs need an
/// elevated shell). This channel serves the companion only — the main app
/// keeps its own Electron updater, so the maintenance gate is not involved.
/// </summary>
public static class UpdateStager
{
    /// <summary>Per-file download cap. A single-file companion build is ~100-200MB.</summary>
    public const long MaxFileBytes = 512L * 1024 * 1024;

    /// <summary>Whole-manifest cap, enforced from the manifest's declared sizes before any fetch.</summary>
    public const long MaxTotalBytes = 1024L * 1024 * 1024;

    /// <summary>
    /// Downloads (via <paramref name="fetch"/>) and verifies every manifest
    /// file into <c>stagingDir</c>. <paramref name="fetch"/> returns the raw
    /// bytes or <c>null</c> on transport failure. Never throws for data
    /// errors; wipes <paramref name="stagingDir"/> on any failure.
    /// </summary>
    public static bool TryStage(
        string stagingDir,
        IReadOnlyList<UpdateFile> files,
        Func<UpdateFile, byte[]?> fetch,
        out IReadOnlyList<string> stagedPaths,
        out string error)
    {
        stagedPaths = [];
        error = string.Empty;
        ArgumentException.ThrowIfNullOrWhiteSpace(stagingDir);
        ArgumentNullException.ThrowIfNull(files);
        ArgumentNullException.ThrowIfNull(fetch);

        if (files.Count == 0)
        {
            error = "manifest names no files";
            return false;
        }

        long total = 0;
        foreach (var file in files)
        {
            if (!IsSafeRelativePath(file.Path))
            {
                error = $"refusing unsafe staged path: '{file.Path}'";
                return false;
            }

            if (file.Bytes < 0 || file.Bytes > MaxFileBytes)
            {
                error = $"file '{file.Path}' exceeds the per-file size cap";
                return false;
            }

            total += file.Bytes;
            if (total > MaxTotalBytes)
            {
                error = "manifest total exceeds the download cap";
                return false;
            }
        }

        try
        {
            Directory.CreateDirectory(stagingDir);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
            error = "staging dir unwritable: " + ex.GetType().Name;
            return false;
        }

        var staged = new List<string>(files.Count);
        foreach (var file in files)
        {
            byte[]? bytes;
            try
            {
                bytes = fetch(file);
            }
            catch (Exception ex)
            {
                Wipe(stagingDir);
                error = $"fetch for '{file.Path}' failed: {ex.GetType().Name}";
                return false;
            }

            if (bytes is null)
            {
                Wipe(stagingDir);
                error = $"fetch for '{file.Path}' failed";
                return false;
            }

            if (bytes.LongLength != file.Bytes)
            {
                Wipe(stagingDir);
                error = $"file '{file.Path}' size mismatch (manifest {file.Bytes}, got {bytes.LongLength})";
                return false;
            }

            var actual = Convert.ToHexStringLower(SHA256.HashData(bytes));
            if (!string.Equals(actual, file.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                Wipe(stagingDir);
                error = $"file '{file.Path}' hash mismatch: bytes drifted from the verified manifest";
                return false;
            }

            var dest = Path.Combine(stagingDir, file.Path);
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                File.WriteAllBytes(dest, bytes);
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
            {
                Wipe(stagingDir);
                error = $"staging write for '{file.Path}' failed: " + ex.GetType().Name;
                return false;
            }

            staged.Add(dest);
        }

        stagedPaths = staged;
        return true;
    }

    /// <summary>
    /// Writes <c>apply.cmd</c> into <paramref name="stagingDir"/>: it waits
    /// (bounded, ~60s) for <paramref name="ownPid"/> to exit, moves every
    /// staged file over <paramref name="targetDir"/>, removes the staging
    /// dir, and restarts <paramref name="restartExeName"/>. The shell
    /// launches the script detached and then exits itself.
    /// </summary>
    public static bool TryWriteApplyScript(
        string stagingDir,
        IReadOnlyList<UpdateFile> files,
        string targetDir,
        int ownPid,
        string restartExeName,
        out string scriptPath,
        out string error)
    {
        scriptPath = string.Empty;
        error = string.Empty;
        ArgumentException.ThrowIfNullOrWhiteSpace(stagingDir);
        ArgumentNullException.ThrowIfNull(files);
        ArgumentException.ThrowIfNullOrWhiteSpace(targetDir);
        ArgumentException.ThrowIfNullOrWhiteSpace(restartExeName);

        if (files.Count == 0)
        {
            error = "manifest names no files";
            return false;
        }

        if (!Directory.Exists(targetDir))
        {
            error = "install dir does not exist: " + targetDir;
            return false;
        }

        if (!IsWritableDir(targetDir))
        {
            error = "install dir is not writable from this shell (a per-machine install needs elevation)";
            return false;
        }

        foreach (var file in files)
        {
            if (!IsSafeRelativePath(file.Path) || !File.Exists(Path.Combine(stagingDir, file.Path)))
            {
                error = $"staged set incomplete, missing '{file.Path}' (re-download first)";
                return false;
            }
        }

        var script = new StringBuilder();
        script.AppendLine("@echo off");
        script.AppendLine("rem Biza companion self-update apply script (generated, verified bytes only).");
        script.AppendLine("setlocal");
        script.AppendLine("set STAGE=%~dp0");
        script.AppendLine("set TARGET=" + targetDir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        script.AppendLine("set PID=" + ownPid);
        script.AppendLine();
        script.AppendLine("rem Wait for the running companion to exit (bounded ~60s).");
        script.AppendLine("set WAITED=0");
        script.AppendLine(":waitpid");
        script.Append("tasklist /FI \"PID eq %PID%\" 2>nul | find /I \"%PID%\" >nul && ");
        script.AppendLine("(set /a WAITED+=1 & if %WAITED% GEQ 60 (echo companion did not exit; aborting. & exit /b 1) & timeout /t 1 /nobreak >nul & goto waitpid)");
        script.AppendLine();
        foreach (var file in files)
        {
            var rel = file.Path.Replace('/', '\\');
            var parent = Path.GetDirectoryName(rel);
            if (!string.IsNullOrEmpty(parent))
            {
                script.AppendLine($"if not exist \"%TARGET%\\{parent}\" mkdir \"%TARGET%\\{parent}\"");
            }

            script.AppendLine($"move /y \"%STAGE%{rel}\" \"%TARGET%\\{rel}\" >nul || (echo failed to install {rel}. & exit /b 1)");
        }

        script.AppendLine();
        script.AppendLine("rem Restart the companion, then remove the staging dir and this script.");
        script.AppendLine("start \"\" \"%TARGET%\\" + restartExeName + "\"");
        script.AppendLine("cd /d \"%TEMP%\"");
        script.AppendLine("rmdir /s /q \"%STAGE:~0,-1%\"");
        script.AppendLine("(goto) 2>nul & del \"%~f0\"");

        scriptPath = Path.Combine(stagingDir, "apply.cmd");
        try
        {
            File.WriteAllText(scriptPath, script.ToString(), Encoding.ASCII);
            return true;
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
            error = "could not write the apply script: " + ex.GetType().Name;
            scriptPath = string.Empty;
            return false;
        }
    }

    private static bool IsWritableDir(string dir)
    {
        try
        {
            var probe = Path.Combine(dir, ".biza-write-probe-" + Guid.NewGuid().ToString("N"));
            File.WriteAllBytes(probe, [0x42]);
            File.Delete(probe);
            return true;
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
            return false;
        }
    }

    private static void Wipe(string stagingDir)
    {
        try
        {
            if (Directory.Exists(stagingDir))
            {
                Directory.Delete(stagingDir, recursive: true);
            }
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
        }
    }

    private static bool IsSafeRelativePath(string path)
    {
        if (path.Length == 0 || path.Length > 260)
        {
            return false;
        }

        if (Path.IsPathRooted(path) || path.Contains("..", StringComparison.Ordinal))
        {
            return false;
        }

        return !path.Contains(':') && path.IndexOfAny(Path.GetInvalidPathChars()) < 0;
    }
}
