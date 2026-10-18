using System.Diagnostics;
using System.IO;

namespace Biza.SupportCompanion.App;

/// <summary>What the companion could prove about the MeshCentral agent.</summary>
public sealed record MeshAgentStatus(bool ProcessRunning, string? InstallDir, string Note);

/// <summary>
/// Issue #984 — MeshCentral agent presence probing. The companion never
/// controls the agent; it reports presence so the operator console can tell
/// "agent missing — send the installer" apart from "agent present — waiting
/// on consent". The agent's node id links server-side when the agent phones
/// home to MeshCentral (the broker matches it to the installation) — the
/// companion reports presence only, never a guessed id.
/// </summary>
public static class MeshAgent
{
    private const string ProcessName = "meshagent";

    public static MeshAgentStatus Probe()
    {
        var running = false;
        try
        {
            foreach (var process in Process.GetProcesses())
            {
                string name;
                try
                {
                    name = process.ProcessName;
                }
                catch (Exception ex) when (ex is InvalidOperationException || ex is NotSupportedException)
                {
                    continue;
                }
                finally
                {
                    process.Dispose();
                }

                if (string.Equals(name, ProcessName, StringComparison.OrdinalIgnoreCase))
                {
                    running = true;
                    break;
                }
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException || ex is NotSupportedException || ex is UnauthorizedAccessException)
        {
            return new MeshAgentStatus(false, null, $"process list unreadable ({ex.GetType().Name})");
        }

        string? installDir = null;
        foreach (var special in new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86 })
        {
            var baseDir = Environment.GetFolderPath(special);
            if (baseDir.Length == 0)
            {
                continue;
            }

            var candidate = Path.Combine(baseDir, "Mesh Agent");
            try
            {
                if (Directory.Exists(candidate))
                {
                    installDir = candidate;
                    break;
                }
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
            {
                // Keep probing the other candidate.
            }
        }

        var note = (running, installDir is not null) switch
        {
            (true, _) => "MeshCentral agent process is running.",
            (false, true) => "MeshCentral agent is installed but its process is not running.",
            (false, false) => "MeshCentral agent not detected — ask the operator for the installer link.",
        };
        return new MeshAgentStatus(running, installDir, note);
    }
}
