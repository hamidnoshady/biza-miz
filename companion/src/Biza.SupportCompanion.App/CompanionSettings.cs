using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Biza.SupportCompanion.Core;

namespace Biza.SupportCompanion.App;

/// <summary>
/// Issue #984 — the companion's on-disk state. Per-user under
/// <c>%LocalAppData%\Biza\SupportCompanion</c> (no admin install needed) or
/// wherever <c>BIZA_COMPANION_DATA</c> points for tests and portable
/// layouts. Each Windows account enrolls its own installation — the
/// credential never roams across accounts on the machine.
///
/// Trust split: <c>settings.json</c> is plain operator configuration;
/// <c>device-credential.dat</c> is current-user-DPAPI-sealed via Core's
/// crypt32 P/Invoke (zero packages); session JWTs are memory-only and
/// never persisted.
/// </summary>
public sealed class CompanionSettings
{
    public const string DataOverrideVariable = "BIZA_COMPANION_DATA";
    public const string DataDirectoryName = "SupportCompanion";
    public const string SettingsFileName = "settings.json";
    public const string CredentialFileName = "device-credential.dat";
    public const string PendingChallengeFileName = "pending-challenge.txt";
    public const string OfflineKeysFileName = "offline-keys.json";
    public const string ReportsDirectoryName = "reports";
    public const string StagingDirectoryName = "staging";

    public string ServerUrl { get; set; } = string.Empty;
    public string InstallationId { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string ManifestUrl { get; set; } = string.Empty;
    public string Channel { get; set; } = "stable";

    /// <summary>Set when a corrupt settings file was quarantined on load.</summary>
    public string Notice { get; private set; } = string.Empty;

    public string DataDir { get; }
    public string SettingsPath => Path.Combine(DataDir, SettingsFileName);
    public string CredentialPath => Path.Combine(DataDir, CredentialFileName);
    public string ReportsDir => Path.Combine(DataDir, ReportsDirectoryName);
    public string StagingDir => Path.Combine(DataDir, StagingDirectoryName);

    public CompanionSettings()
        : this(ResolveDataDir())
    {
    }

    public CompanionSettings(string dataDir)
    {
        DataDir = dataDir;
    }

    public static string ResolveDataDir()
    {
        var over = (Environment.GetEnvironmentVariable(DataOverrideVariable) ?? string.Empty).Trim();
        if (over.Length > 0)
        {
            return over;
        }

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Biza",
            DataDirectoryName);
    }

    public static string CompanionVersion()
    {
        var assembly = typeof(CompanionSettings).Assembly;
        var informational = assembly
            .GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false)
            .OfType<System.Reflection.AssemblyInformationalVersionAttribute>()
            .FirstOrDefault()?.InformationalVersion;
        if (!string.IsNullOrWhiteSpace(informational))
        {
            return informational;
        }

        return assembly.GetName().Version?.ToString() ?? "0.0.0";
    }

    public void EnsureDataDirs()
    {
        Directory.CreateDirectory(DataDir);
        Directory.CreateDirectory(ReportsDir);
        Directory.CreateDirectory(StagingDir);
    }

    public void Load()
    {
        Notice = string.Empty;
        if (!File.Exists(SettingsPath))
        {
            return;
        }

        string text;
        try
        {
            text = File.ReadAllText(SettingsPath, Encoding.UTF8);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
            Notice = $"Settings unreadable ({ex.GetType().Name}); using defaults.";
            return;
        }

        JsonNode? node;
        try
        {
            node = JsonNode.Parse(text);
        }
        catch (JsonException)
        {
            node = null;
        }

        if (node is not JsonObject obj)
        {
            QuarantineCorruptSettings();
            return;
        }

        ServerUrl = NodeString(obj, "serverUrl");
        InstallationId = NodeString(obj, "installationId");
        DisplayName = NodeString(obj, "displayName");
        ManifestUrl = NodeString(obj, "manifestUrl");
        var channel = NodeString(obj, "channel");
        Channel = channel.Length > 0 ? channel : "stable";
    }

    public void Save()
    {
        EnsureDataDirs();
        var obj = new JsonObject
        {
            ["serverUrl"] = ServerUrl.Trim(),
            ["installationId"] = InstallationId.Trim(),
            ["displayName"] = DisplayName.Trim(),
            ["manifestUrl"] = ManifestUrl.Trim(),
            ["channel"] = Channel.Trim(),
        };
        File.WriteAllText(SettingsPath, obj.ToJsonString(new JsonSerializerOptions { WriteIndented = true }), Encoding.UTF8);
    }

    public bool HasDeviceCredential() => File.Exists(CredentialPath);

    public void SaveDeviceCredential(string credential)
    {
        if (string.IsNullOrEmpty(credential))
        {
            throw new ArgumentException("Device credential must not be empty.", nameof(credential));
        }

        EnsureDataDirs();
        var sealed_ = Dpapi.Protect(Encoding.UTF8.GetBytes(credential));
        File.WriteAllBytes(CredentialPath, sealed_);
    }

    public bool TryLoadDeviceCredential(out string credential, out string error)
    {
        credential = string.Empty;
        error = string.Empty;
        if (!File.Exists(CredentialPath))
        {
            error = "not enrolled on this machine";
            return false;
        }

        try
        {
            var sealed_ = File.ReadAllBytes(CredentialPath);
            var plain = Dpapi.Unprotect(sealed_);
            credential = Encoding.UTF8.GetString(plain);
            if (credential.Length == 0)
            {
                error = "stored credential is empty; re-enroll this machine";
                return false;
            }

            return true;
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is CryptographicException || ex is ArgumentException)
        {
            error = $"stored credential unreadable ({ex.GetType().Name}); re-enroll this machine";
            return false;
        }
    }

    public void ClearDeviceCredential()
    {
        try
        {
            File.Delete(CredentialPath);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
        {
        }
    }

    public void SavePendingChallenge(string ticketId, string challenge)
    {
        EnsureDataDirs();
        File.WriteAllText(
            Path.Combine(DataDir, PendingChallengeFileName),
            ticketId + "\n" + challenge + "\n",
            Encoding.UTF8);
    }

    public bool TryLoadPendingChallenge(out string ticketId, out string challenge)
    {
        ticketId = string.Empty;
        challenge = string.Empty;
        var path = Path.Combine(DataDir, PendingChallengeFileName);
        if (!File.Exists(path))
        {
            return false;
        }

        try
        {
            var lines = File.ReadAllLines(path, Encoding.UTF8);
            if (lines.Length < 2 || lines[0].Length == 0 || lines[1].Length == 0)
            {
                return false;
            }

            ticketId = lines[0].Trim();
            challenge = lines[1].Trim();
            return ticketId.Length > 0 && challenge.Length > 0;
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
        {
            return false;
        }
    }

    public void ClearPendingChallenge()
    {
        try
        {
            File.Delete(Path.Combine(DataDir, PendingChallengeFileName));
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
        {
        }
    }

    public void SaveOfflineKeys(string approvedKeysJson)
    {
        EnsureDataDirs();
        File.WriteAllText(Path.Combine(DataDir, OfflineKeysFileName), approvedKeysJson, Encoding.UTF8);
    }

    public bool TryLoadOfflineKeys(out string approvedKeysJson)
    {
        approvedKeysJson = string.Empty;
        var path = Path.Combine(DataDir, OfflineKeysFileName);
        if (!File.Exists(path))
        {
            return false;
        }

        try
        {
            approvedKeysJson = File.ReadAllText(path, Encoding.UTF8);
            return !string.IsNullOrWhiteSpace(approvedKeysJson);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
        {
            return false;
        }
    }

    private void QuarantineCorruptSettings()
    {
        try
        {
            var backup = Path.Combine(
                DataDir, $"settings.corrupt-{DateTimeOffset.UtcNow:yyyyMMddHHmmss}.json");
            File.Move(SettingsPath, backup);
            Notice = "Settings file was corrupt and was moved aside; using defaults.";
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
            Notice = $"Settings file is corrupt and could not be moved aside ({ex.GetType().Name}); using defaults.";
        }
    }

    private static string NodeString(JsonObject obj, string name)
    {
        if (obj.TryGetPropertyValue(name, out var node) &&
            node is JsonValue value &&
            value.TryGetValue<string>(out var text) &&
            text is not null)
        {
            return text;
        }

        return string.Empty;
    }
}
