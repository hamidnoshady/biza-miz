using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Biza.SupportCompanion.Core;

/// <summary>
/// Issue #984 — local verification of the signed offline on-site token, the
/// exact counterpart of <c>verifyOfflineToken</c> in
/// <c>src/lib/support-companion/access-tokens.ts</c>. Error names match the
/// server one-for-one so both sides (and the UI states above them) agree on
/// what went wrong.
/// </summary>
public enum OfflineTokenError
{
    Malformed,
    UnknownKey,
    InvalidSignature,
    WrongAudience,
    Expired,
    NotYetValid,
}

public sealed record OfflineTokenClaims(
    string Jti,
    string TicketId,
    string BusinessId,
    string InstallationId,
    int InstallationGeneration,
    string OperatorAdminId,
    IReadOnlyList<string> Scope,
    string TechnicianBindingHash,
    string Challenge,
    string PolicyVersion,
    long IssuedAt,
    long NotBefore,
    long ExpiresAt);

public sealed class OfflineTokenVerifyResult
{
    public bool Ok { get; }
    public OfflineTokenClaims? Claims { get; }
    public string? Kid { get; }
    public OfflineTokenError? Error { get; }

    private OfflineTokenVerifyResult(bool ok, OfflineTokenClaims? claims, string? kid, OfflineTokenError? error)
    {
        Ok = ok;
        Claims = claims;
        Kid = kid;
        Error = error;
    }

    public static OfflineTokenVerifyResult Valid(OfflineTokenClaims claims, string kid) =>
        new(true, claims, kid, null);

    public static OfflineTokenVerifyResult Invalid(OfflineTokenError error) =>
        new(false, null, null, error);
}

public static class OfflineTokenVerifier
{
    /// <summary>Must equal <c>SUPPORT_TOKEN_ISSUER</c> on the server.</summary>
    public const string Issuer = "biza-miz-support";

    /// <summary>Must equal <c>SUPPORT_TOKEN_AUDIENCE_ONSITE</c> on the server.</summary>
    public const string Audience = "support-companion-onsite";

    /// <summary>
    /// Must equal <c>SUPPORT_OPERATIONS</c> in
    /// <c>src/lib/support-companion/types.ts</c>. Add operations on both sides.
    /// </summary>
    public static readonly IReadOnlySet<string> KnownOperations = new HashSet<string>(StringComparer.Ordinal)
    {
        "diagnostics.run",
        "report.upload",
        "repair.propose",
        "repair.execute",
        "remote.view",
        "remote.control",
        "ai.assist",
    };

    private sealed record ApprovedKey(string Kid, byte[] X, byte[] Y);

    /// <summary>
    /// Verifies a compact ES256 offline token against approved public keys.
    /// <paramref name="approvedKeysJson"/> is the JSON array from the
    /// <c>SUPPORT_OFFLINE_TOKEN_PUBLIC_KEYS</c> server variable (each entry a
    /// P-256 public JWK). <paramref name="nowSeconds"/> is Unix time — passed
    /// in so tests pin the clock.
    /// </summary>
    /// <remarks>
    /// The claim-failure matrix below is not a guess: it was probed against
    /// the real server verifier (<c>verifyOfflineToken</c>, jose claim order
    /// aud/iss → exp → nbf → iat plus the soft-expiry re-verify) and every
    /// cell has a vector test. Signature good from here on:
    /// <list type="bullet">
    /// <item>trust wrong (aud or iss) + time ok → <c>WrongAudience</c>.</item>
    /// <item>trust wrong + time bad → <c>InvalidSignature</c> (the re-verify
    /// still enforces the clock).</item>
    /// <item>trust ok + expired → <c>Expired</c>; trust ok + premature nbf →
    /// <c>NotYetValid</c>.</item>
    /// <item>present-but-non-numeric exp → <c>InvalidSignature</c>;
    /// present-but-non-numeric nbf or iat → <c>NotYetValid</c>. A future
    /// numeric iat verifies (jose does not police iat futurism).</item>
    /// </list>
    /// The one deliberate delta: <c>exp</c>/<c>nbf</c> are required here and
    /// report <c>Malformed</c> when absent. The server's shape check never
    /// reads them, so a timeless token verifies server-side — but the
    /// companion is the offline enforcement point, and a token with no local
    /// deadline must never verify locally. One-directional (stricter), fails
    /// closed.
    /// </remarks>
    public static OfflineTokenVerifyResult Verify(string? token, string? approvedKeysJson, long nowSeconds)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return OfflineTokenVerifyResult.Invalid(OfflineTokenError.Malformed);
        }

        var parts = token.Trim().Split('.');
        if (parts.Length != 3)
        {
            return OfflineTokenVerifyResult.Invalid(OfflineTokenError.Malformed);
        }

        JsonDocument headerDoc;
        JsonDocument payloadDoc;
        try
        {
            headerDoc = JsonDocument.Parse(Base64UrlDecode(parts[0]));
            payloadDoc = JsonDocument.Parse(Base64UrlDecode(parts[1]));
        }
        catch (Exception ex) when (ex is FormatException || ex is JsonException || ex is ArgumentException)
        {
            return OfflineTokenVerifyResult.Invalid(OfflineTokenError.Malformed);
        }

        using (headerDoc)
        using (payloadDoc)
        {
            return VerifyParsed(parts, headerDoc.RootElement, payloadDoc.RootElement, approvedKeysJson, nowSeconds);
        }
    }

    private static OfflineTokenVerifyResult VerifyParsed(
        string[] parts, JsonElement header, JsonElement payload, string? approvedKeysJson, long nowSeconds)
    {
        if (header.ValueKind != JsonValueKind.Object || payload.ValueKind != JsonValueKind.Object)
        {
            return OfflineTokenVerifyResult.Invalid(OfflineTokenError.Malformed);
        }

        // Any algorithm other than ES256 — including a missing one — is a
        // signature failure, never a negotiation. Matches the server.
        if (GetString(header, "alg") != "ES256")
        {
            return OfflineTokenVerifyResult.Invalid(OfflineTokenError.InvalidSignature);
        }

        var kid = GetString(header, "kid");
        var keys = ParseApprovedKeys(approvedKeysJson);
        if (keys is null || keys.Count == 0)
        {
            return OfflineTokenVerifyResult.Invalid(OfflineTokenError.UnknownKey);
        }

        // A token naming an unknown kid fails closed — never verified against
        // a guessed or supplied key. A token with no kid at all is tried
        // against every approved key, as on the server.
        var candidates = kid is null ? keys : keys.Where(k => k.Kid == kid).ToList();
        if (candidates.Count == 0)
        {
            return OfflineTokenVerifyResult.Invalid(OfflineTokenError.UnknownKey);
        }

        var signingInput = Encoding.ASCII.GetBytes(parts[0] + "." + parts[1]);
        byte[] signature;
        try
        {
            signature = Base64UrlDecode(parts[2]);
        }
        catch (FormatException)
        {
            return OfflineTokenVerifyResult.Invalid(OfflineTokenError.InvalidSignature);
        }

        foreach (var key in candidates)
        {
            if (!VerifySignature(signingInput, signature, key))
            {
                continue;
            }

            return CheckClaims(payload, nowSeconds, kid ?? key.Kid);
        }

        return OfflineTokenVerifyResult.Invalid(OfflineTokenError.InvalidSignature);
    }

    private static OfflineTokenVerifyResult CheckClaims(JsonElement payload, long nowSeconds, string kid)
    {
        // The signature is good from here on. This order encodes the probed
        // server matrix (see the Verify remarks): jose checks aud/iss before
        // exp before nbf before iat, and the soft-expiry re-verify converts a
        // trust failure into InvalidSignature whenever the clock also fails.
        // Trust and time therefore interact — compute both before reporting.
        var trustOk = GetString(payload, "iss") == Issuer && AudienceMatches(payload);

        // Deliberate strictness delta: a token with no local deadline must
        // never verify offline, so absence reports Malformed here (the server
        // would accept). Present-but-garbage keeps the server's mapping below.
        if (!IsPresent(payload, "exp") || !IsPresent(payload, "nbf"))
        {
            return OfflineTokenVerifyResult.Invalid(OfflineTokenError.Malformed);
        }

        var exp = GetInt64(payload, "exp");
        var nbf = GetInt64(payload, "nbf");
        var expOk = exp.HasValue && nowSeconds < exp.Value;
        var nbfOk = nbf.HasValue && nowSeconds >= nbf.Value;
        var clockOk = expOk && nbfOk && !IsPresentNonNumeric(payload, "iat");

        if (!trustOk)
        {
            return OfflineTokenVerifyResult.Invalid(
                clockOk ? OfflineTokenError.WrongAudience : OfflineTokenError.InvalidSignature);
        }

        if (!exp.HasValue)
        {
            // Present-but-non-numeric exp breaks the server's re-verify.
            return OfflineTokenVerifyResult.Invalid(OfflineTokenError.InvalidSignature);
        }

        if (nowSeconds >= exp.Value)
        {
            return OfflineTokenVerifyResult.Invalid(OfflineTokenError.Expired);
        }

        if (!nbfOk)
        {
            // Premature or present-but-non-numeric nbf: jose names the claim.
            return OfflineTokenVerifyResult.Invalid(OfflineTokenError.NotYetValid);
        }

        if (IsPresentNonNumeric(payload, "iat"))
        {
            // Present-but-non-numeric iat names the iat claim. A future
            // NUMERIC iat, notably, verifies — jose does not police iat
            // futurism, and neither do we.
            return OfflineTokenVerifyResult.Invalid(OfflineTokenError.NotYetValid);
        }

        var iat = GetInt64(payload, "iat");
        var claims = ReadClaims(payload, iat ?? nbf.Value, nbf.Value, exp.Value);
        if (claims is null)
        {
            return OfflineTokenVerifyResult.Invalid(OfflineTokenError.Malformed);
        }

        return OfflineTokenVerifyResult.Valid(claims, kid);
    }

    private static bool IsPresent(JsonElement el, string name) =>
        el.TryGetProperty(name, out _);

    private static bool IsPresentNonNumeric(JsonElement el, string name) =>
        el.TryGetProperty(name, out var prop) &&
        !(prop.ValueKind == JsonValueKind.Number && prop.TryGetInt64(out _));

    private static bool AudienceMatches(JsonElement payload)
    {
        if (!payload.TryGetProperty("aud", out var aud))
        {
            return false;
        }

        if (aud.ValueKind == JsonValueKind.String)
        {
            return aud.GetString() == Audience;
        }

        // The server always mints a string, but accept an array containing the
        // audience the way jose does — rejecting nothing the server accepts.
        if (aud.ValueKind == JsonValueKind.Array)
        {
            foreach (var entry in aud.EnumerateArray())
            {
                if (entry.ValueKind == JsonValueKind.String && entry.GetString() == Audience)
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static OfflineTokenClaims? ReadClaims(JsonElement payload, long iat, long nbf, long exp)
    {
        var jti = GetString(payload, "jti");
        var ticketId = GetString(payload, "ticket_id");
        var businessId = GetString(payload, "business_id");
        var installationId = GetString(payload, "installation_id");
        var generation = GetInt32(payload, "installation_generation");
        var operatorAdminId = GetString(payload, "operator_admin_id");
        var binding = GetString(payload, "technician_binding_hash");
        var challenge = GetString(payload, "challenge");
        var policyVersion = GetString(payload, "policy_version") ?? "v1";

        if (jti is null || ticketId is null || businessId is null || installationId is null ||
            generation is null || operatorAdminId is null || binding is null || challenge is null)
        {
            return null;
        }

        if (!payload.TryGetProperty("scope", out var scope) || scope.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var operations = new List<string>();
        foreach (var entry in scope.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            var op = entry.GetString();
            // Unknown operations reject the token (fail closed); the empty
            // scope the server's shape check accepts still verifies here for
            // parity — it authorizes nothing by itself.
            if (op is null || !KnownOperations.Contains(op))
            {
                return null;
            }

            operations.Add(op);
        }

        return new OfflineTokenClaims(
            jti, ticketId, businessId, installationId, generation.Value, operatorAdminId,
            operations, binding, challenge, policyVersion, iat, nbf, exp);
    }

    private static List<ApprovedKey>? ParseApprovedKeys(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            var keys = new List<ApprovedKey>();
            foreach (var el in doc.RootElement.EnumerateArray())
            {
                if (el.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                if (GetString(el, "kty") != "EC" || GetString(el, "crv") != "P-256")
                {
                    continue;
                }

                var x = GetString(el, "x");
                var y = GetString(el, "y");
                if (string.IsNullOrEmpty(x) || string.IsNullOrEmpty(y))
                {
                    continue;
                }

                var kid = GetString(el, "kid") ?? string.Empty;
                keys.Add(new ApprovedKey(kid, Base64UrlDecode(x), Base64UrlDecode(y)));
            }

            return keys;
        }
        catch (Exception ex) when (ex is FormatException || ex is JsonException || ex is ArgumentException)
        {
            return null;
        }
    }

    private static bool VerifySignature(byte[] signingInput, byte[] signature, ApprovedKey key)
    {
        // ES256 JWS signatures are raw R||S, 32 bytes each.
        if (signature.Length != 64 || key.X.Length != 32 || key.Y.Length != 32)
        {
            return false;
        }

        try
        {
            using var ecdsa = ECDsa.Create(new ECParameters
            {
                Curve = ECCurve.NamedCurves.nistP256,
                Q = new ECPoint { X = key.X, Y = key.Y },
            });
            return ecdsa.VerifyData(
                signingInput, signature, HashAlgorithmName.SHA256,
                DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        }
        catch (CryptographicException)
        {
            return false;
        }
    }

    private static string? GetString(JsonElement el, string name)
    {
        if (el.TryGetProperty(name, out var prop) && prop.ValueKind == JsonValueKind.String)
        {
            return prop.GetString();
        }

        return null;
    }

    private static long? GetInt64(JsonElement el, string name)
    {
        if (el.TryGetProperty(name, out var prop) &&
            prop.ValueKind == JsonValueKind.Number &&
            prop.TryGetInt64(out var value))
        {
            return value;
        }

        return null;
    }

    private static int? GetInt32(JsonElement el, string name)
    {
        if (el.TryGetProperty(name, out var prop) &&
            prop.ValueKind == JsonValueKind.Number &&
            prop.TryGetInt32(out var value))
        {
            return value;
        }

        return null;
    }

    internal static byte[] Base64UrlDecode(string encoded)
    {
        var s = encoded.Replace('-', '+').Replace('_', '/');
        switch (s.Length % 4)
        {
            case 2: s += "=="; break;
            case 3: s += "="; break;
        }

        return Convert.FromBase64String(s);
    }
}
