using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Biza.SupportCompanion.Core;

/// <summary>
/// One verified update file entry: relative path, expected bytes, sha256.
/// </summary>
public sealed record UpdateFile(string Path, long Bytes, string Sha256);

/// <summary>
/// A verified update manifest: the channel/version the shell may install,
/// plus the file list the installer re-hashes after download.
/// </summary>
public sealed record VerifiedManifest(
    string Channel, string Version, string Kid, IReadOnlyList<UpdateFile> Files);

/// <summary>
/// Issue #984 — the companion update channel's trust root. Manifests are
/// RSA-signed (PKCS#1 v1.5 + SHA-256) over the canonical manifest JSON by
/// the release authority, and verified against a provisioned approved-keys
/// bundle — the same bundle discipline as the offline-token keys. The
/// installer refuses anything unverified; downgrades are refused (rollback
/// is last-known-good recovery, never an older manifest).
/// </summary>
public static class UpdateManifest
{
    public const int MaxManifestBytes = 256 * 1024;
    public const int MaxFiles = 5_000;

    /// <summary>
    /// Verifies a manifest for <paramref name="channel"/> as an upgrade over
    /// <paramref name="currentVersion"/>. Returns the verified manifest, or
    /// <c>null</c> with a precise reason. Never throws.
    /// </summary>
    public static VerifiedManifest? TryVerify(
        string? manifestJson,
        string? signatureBase64Url,
        string? approvedKeysJson,
        string channel,
        string currentVersion,
        out string error)
    {
        error = string.Empty;
        if (string.IsNullOrWhiteSpace(manifestJson) ||
            Encoding.UTF8.GetByteCount(manifestJson) > MaxManifestBytes)
        {
            error = "manifest missing or oversize";
            return null;
        }

        if (string.IsNullOrWhiteSpace(signatureBase64Url))
        {
            error = "manifest signature missing";
            return null;
        }

        string canonical;
        try
        {
            canonical = CanonicalJson.Canonicalize(manifestJson);
        }
        catch (Exception ex) when (ex is JsonException || ex is FormatException)
        {
            error = "manifest is not valid JSON";
            return null;
        }

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(manifestJson);
        }
        catch (JsonException)
        {
            error = "manifest is not valid JSON";
            return null;
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                error = "manifest is not an object";
                return null;
            }

            if (!GetString(root, "channel", out var manifestChannel) ||
                !string.Equals(manifestChannel, channel, StringComparison.Ordinal))
            {
                error = $"manifest is not for channel '{channel}'";
                return null;
            }

            if (!GetString(root, "version", out var version) ||
                !Version.TryParse(version, out var manifestVersion))
            {
                error = "manifest version missing or unparsable";
                return null;
            }

            if (!Version.TryParse(currentVersion, out var current) || manifestVersion <= current)
            {
                error = $"manifest version {version} is not an upgrade over {currentVersion}";
                return null;
            }

            if (!GetString(root, "kid", out var kid) || kid.Length == 0)
            {
                error = "manifest key id missing";
                return null;
            }

            var files = ReadFiles(root, out var filesError);
            if (files is null)
            {
                error = filesError;
                return null;
            }

            if (!VerifySignature(canonical, signatureBase64Url, approvedKeysJson, kid))
            {
                error = "manifest signature invalid or key not approved";
                return null;
            }

            error = string.Empty;
            return new VerifiedManifest(channel, version, kid, files);
        }
    }

    private static bool GetString(JsonElement root, string name, out string value)
    {
        value = string.Empty;
        if (!root.TryGetProperty(name, out var prop) || prop.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        value = prop.GetString() ?? string.Empty;
        return true;
    }

    private static IReadOnlyList<UpdateFile>? ReadFiles(JsonElement root, out string error)
    {
        error = string.Empty;
        if (!root.TryGetProperty("files", out var filesProp) || filesProp.ValueKind != JsonValueKind.Array)
        {
            error = "manifest files missing";
            return null;
        }

        var files = new List<UpdateFile>();
        foreach (var item in filesProp.EnumerateArray())
        {
            if (files.Count >= MaxFiles)
            {
                error = "manifest names too many files";
                return null;
            }

            if (item.ValueKind != JsonValueKind.Object ||
                !item.TryGetProperty("path", out var pathProp) ||
                pathProp.ValueKind != JsonValueKind.String ||
                !item.TryGetProperty("sha256", out var shaProp) ||
                shaProp.ValueKind != JsonValueKind.String ||
                !item.TryGetProperty("bytes", out var bytesProp) ||
                bytesProp.ValueKind != JsonValueKind.Number ||
                !bytesProp.TryGetInt64(out var bytes))
            {
                error = "manifest file entry malformed";
                return null;
            }

            var path = pathProp.GetString() ?? string.Empty;
            var sha = (shaProp.GetString() ?? string.Empty).ToLowerInvariant();
            if (!IsSafeRelativePath(path) || sha.Length != 64 || bytes < 0)
            {
                error = $"manifest file entry unsafe: '{path}'";
                return null;
            }

            files.Add(new UpdateFile(path, bytes, sha));
        }

        if (files.Count == 0)
        {
            error = "manifest names no files";
            return null;
        }

        return files;
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

        // No drive specs (C:foo is rooted-looking but IsPathRooted misses it)
        // and no characters Windows refuses in paths.
        return !path.Contains(':') && path.IndexOfAny(Path.GetInvalidPathChars()) < 0;
    }

    private static bool VerifySignature(
        string canonicalManifest, string signatureBase64Url, string? approvedKeysJson, string kid)
    {
        if (string.IsNullOrWhiteSpace(approvedKeysJson))
        {
            return false;
        }

        byte[] signature;
        try
        {
            signature = OfflineTokenVerifier.Base64UrlDecode(signatureBase64Url.Trim());
        }
        catch (FormatException)
        {
            return false;
        }

        try
        {
            using var doc = JsonDocument.Parse(approvedKeysJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Array)
            {
                return false;
            }

            var data = Encoding.UTF8.GetBytes(canonicalManifest);
            foreach (var key in doc.RootElement.EnumerateArray())
            {
                if (key.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                if (!key.TryGetProperty("kid", out var keyKid) ||
                    keyKid.ValueKind != JsonValueKind.String ||
                    keyKid.GetString() != kid)
                {
                    continue;
                }

                if (!key.TryGetProperty("kty", out var kty) ||
                    kty.ValueKind != JsonValueKind.String ||
                    kty.GetString() != "RSA")
                {
                    continue;
                }

                if (!key.TryGetProperty("n", out var nProp) || nProp.ValueKind != JsonValueKind.String ||
                    !key.TryGetProperty("e", out var eProp) || eProp.ValueKind != JsonValueKind.String)
                {
                    continue;
                }

                byte[] modulus;
                byte[] exponent;
                try
                {
                    modulus = OfflineTokenVerifier.Base64UrlDecode((nProp.GetString() ?? string.Empty).Trim());
                    exponent = OfflineTokenVerifier.Base64UrlDecode((eProp.GetString() ?? string.Empty).Trim());
                }
                catch (FormatException)
                {
                    continue;
                }

                try
                {
                    using var rsa = RSA.Create(new RSAParameters { Modulus = modulus, Exponent = exponent });
                    if (rsa.VerifyData(data, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1))
                    {
                        return true;
                    }
                }
                catch (CryptographicException)
                {
                    // Bad key material: try the next approved key, if any.
                }
            }

            return false;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}
