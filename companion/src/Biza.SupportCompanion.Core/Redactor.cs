using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Biza.SupportCompanion.Core;

/// <summary>
/// Issue #984 — redaction for diagnostic evidence, before persistence. The
/// exact counterpart of <c>redactValue</c>/<c>filterAttributedLines</c> in
/// <c>src/lib/support-companion/redaction.ts</c> plus the shared secret
/// patterns from <c>src/lib/error-report.ts</c>: the same blocked field names,
/// the same four secret patterns, the same attribution rule, the same summary
/// counts — so evidence redacted offline on the companion matches what the
/// server would have removed. Keep both sides in sync.
/// </summary>
public sealed class RedactionSummary
{
    /// <summary>Number of fields dropped by name.</summary>
    public int BlockedFields { get; set; }

    /// <summary>Number of string values scrubbed by secret patterns.</summary>
    public int ScrubbedValues { get; set; }

    /// <summary>Number of log lines excluded for missing business attribution.</summary>
    public int UnattributedLines { get; set; }
}

public sealed record LogLine(string Text, string? BusinessId);

public static class Redactor
{
    public const string Redacted = "[REDACTED]";

    /// <summary>
    /// Field names that are never persisted into reports, AI evidence or
    /// receipts. Must equal <c>BLOCKED_FIELDS</c> in
    /// <c>src/lib/support-companion/redaction.ts</c>.
    /// </summary>
    public static readonly IReadOnlySet<string> BlockedFields = new HashSet<string>(StringComparer.Ordinal)
    {
        "password", "passwd", "pin", "otp", "secret", "jwt", "token",
        "cookie", "cookies", "session", "connectionstring", "connection_string",
        "databaseurl", "database_url", "privatekey", "private_key",
        "masterkey", "master_key", "encryptionkey", "encryption_key",
        "apikey", "api_key", "clientsecret", "client_secret",
        "webhooksecret", "webhook_secret", "authorization", "set-cookie",
    };

    private static readonly TimeSpan PatternTimeout = TimeSpan.FromSeconds(2);

    /// <summary>
    /// Must equal <c>SECRET_PATTERNS</c> in <c>src/lib/error-report.ts</c>.
    /// Each pattern captures its innocent prefix in group 1; the secret in
    /// group 2 is replaced with <c>[REDACTED]</c>.
    /// </summary>
    private static readonly Regex[] SecretPatterns =
    [
        new(@"(postgres(?:ql)?://[^:\s]+:)[^@\s]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, PatternTimeout),
        new(@"(authorization\s*[:=]\s*bearer\s+)[^\s]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, PatternTimeout),
        new(@"((?:jwt|sync|pairing|api)[_-]?(?:secret|token|code)\s*[:=]\s*)[^\s,;]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, PatternTimeout),
        new(@"((?:password|passphrase)\s*[:=]\s*)[^\s,;]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, PatternTimeout),
    ];

    /// <summary>Scrubs secret patterns from free text, keeping the prefixes.</summary>
    public static string RedactSecrets(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var out_ = text;
        foreach (var pattern in SecretPatterns)
        {
            out_ = pattern.Replace(out_, "$1" + Redacted);
        }

        return out_;
    }

    /// <summary>
    /// Walks a JSON value, replacing blocklisted object keys with
    /// <c>[REDACTED]</c> and scrubbing every string with the secret patterns.
    /// Containers are redacted in place; the summary counts what was removed
    /// so callers show exclusions instead of silently dropping evidence.
    /// </summary>
    public static JsonNode? RedactNode(JsonNode? node, RedactionSummary summary)
    {
        ArgumentNullException.ThrowIfNull(summary);
        switch (node)
        {
            case JsonValue value when value.TryGetValue<string>(out var text) && text is not null:
            {
                var scrubbed = RedactSecrets(text);
                if (!string.Equals(scrubbed, text, StringComparison.Ordinal))
                {
                    summary.ScrubbedValues++;
                }

                return JsonValue.Create(scrubbed);
            }

            case JsonObject obj:
            {
                // Snapshot the keys: entries are replaced during the walk.
                // A redacted child is only re-attached when it is a NEW node —
                // re-attaching a node to its own parent throws.
                foreach (var key in obj.Select(entry => entry.Key).ToList())
                {
                    if (BlockedFields.Contains(NormalizeKey(key)))
                    {
                        summary.BlockedFields++;
                        obj[key] = JsonValue.Create(Redacted);
                        continue;
                    }

                    var child = obj[key];
                    var redacted = RedactNode(child, summary);
                    if (!ReferenceEquals(redacted, child))
                    {
                        obj[key] = redacted;
                    }
                }

                return obj;
            }

            case JsonArray array:
            {
                for (var i = 0; i < array.Count; i++)
                {
                    var child = array[i];
                    var redacted = RedactNode(child, summary);
                    if (!ReferenceEquals(redacted, child))
                    {
                        array[i] = redacted;
                    }
                }

                return array;
            }

            default:
                return node;
        }
    }

    /// <summary>
    /// Filters candidate log lines for a tenant upload. A line joins the
    /// tenant package only when it carries trustworthy business attribution
    /// matching <paramref name="businessId"/>; installation-level lines
    /// without attribution are excluded (counted in the summary), never
    /// attributed by guessing the selected tenant.
    /// </summary>
    public static List<string> FilterAttributedLines(
        IEnumerable<LogLine> lines, string businessId, RedactionSummary summary)
    {
        ArgumentNullException.ThrowIfNull(lines);
        ArgumentNullException.ThrowIfNull(businessId);
        ArgumentNullException.ThrowIfNull(summary);
        var kept = new List<string>();
        foreach (var line in lines)
        {
            if (!string.Equals(line.BusinessId, businessId, StringComparison.Ordinal))
            {
                summary.UnattributedLines++;
                continue;
            }

            kept.Add(RedactSecrets(line.Text));
        }

        return kept;
    }

    private static string NormalizeKey(string key)
    {
        var builder = new System.Text.StringBuilder(key.Length);
        foreach (var ch in key.ToLowerInvariant())
        {
            if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9'))
            {
                builder.Append(ch);
            }
        }

        return builder.ToString();
    }
}
