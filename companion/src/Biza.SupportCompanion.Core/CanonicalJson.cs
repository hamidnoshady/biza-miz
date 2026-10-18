using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Biza.SupportCompanion.Core;

/// <summary>
/// Issue #984 — canonical JSON that byte-matches the server's
/// <c>canonicalRecipeJson</c> (<c>src/lib/support-companion/repair-catalog.ts</c>):
/// object keys sorted ordinally (UTF-16 code-unit order, the same order JS
/// <c>Array.sort</c> uses), no whitespace, JS string escaping, and numbers
/// preserved from the wire text. The executor recomputes
/// <c>recipe_hash</c> locally and refuses any recipe whose bytes drifted
/// from the approved pin — a recipe edited after approval is a new recipe,
/// never a silent substitution.
/// </summary>
public static class CanonicalJson
{
    /// <summary>Recipes are small bounded objects; anything larger is refused, not parsed.</summary>
    public const int MaxDocumentBytes = 64 * 1024;

    /// <summary>
    /// Canonicalizes parsed JSON. Throws <c>JsonException</c> on invalid input
    /// and <c>FormatException</c> on oversize input; callers map both to
    /// their fail-closed error.
    /// </summary>
    public static string Canonicalize(string json)
    {
        ArgumentNullException.ThrowIfNull(json);
        if (Encoding.UTF8.GetByteCount(json) > MaxDocumentBytes)
        {
            throw new FormatException("JSON document exceeds the bounded size.");
        }

        using var doc = JsonDocument.Parse(json);
        var out_ = new StringBuilder(json.Length);
        AppendCanonical(doc.RootElement, out_);
        return out_.ToString();
    }

    /// <summary>
    /// Lowercase-hex sha256, matching Node's <c>digest("hex")</c>.
    /// </summary>
    public static string Sha256Hex(string canonical)
    {
        ArgumentNullException.ThrowIfNull(canonical);
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(canonical));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    /// <summary>
    /// The recipe hash over a recipe object, or <c>null</c> when the input is
    /// not a bounded valid JSON object. Never throws.
    /// </summary>
    public static string? TryHashRecipe(string? recipeJson)
    {
        if (string.IsNullOrWhiteSpace(recipeJson))
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(recipeJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            return Sha256Hex(Canonicalize(recipeJson));
        }
        catch (Exception ex) when (ex is JsonException || ex is FormatException)
        {
            return null;
        }
    }

    private static void AppendCanonical(JsonElement element, StringBuilder out_)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                out_.Append('{');
                var first = true;
                foreach (var property in element.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                {
                    if (!first)
                    {
                        out_.Append(',');
                    }

                    first = false;
                    AppendCanonicalString(property.Name, out_);
                    out_.Append(':');
                    AppendCanonical(property.Value, out_);
                }

                out_.Append('}');
                break;
            case JsonValueKind.Array:
                out_.Append('[');
                var firstItem = true;
                foreach (var item in element.EnumerateArray())
                {
                    if (!firstItem)
                    {
                        out_.Append(',');
                    }

                    firstItem = false;
                    AppendCanonical(item, out_);
                }

                out_.Append(']');
                break;
            case JsonValueKind.String:
                AppendCanonicalString(element.GetString() ?? string.Empty, out_);
                break;
            case JsonValueKind.Number:
                // The server hashes its own JS-serialized form, and the
                // executor receives that same text over the wire — so the raw
                // literal is already JS-normalized (7, not 7.0). Preserving
                // it is exact; a hand-written non-normalized literal can only
                // fail closed later at the hash comparison, never verify.
                out_.Append(element.GetRawText());
                break;
            case JsonValueKind.True:
                out_.Append("true");
                break;
            case JsonValueKind.False:
                out_.Append("false");
                break;
            case JsonValueKind.Null:
            case JsonValueKind.Undefined:
                out_.Append("null");
                break;
        }
    }

    /// <summary>
    /// Exactly <c>JSON.stringify</c> escaping: quotes, backslash and C0
    /// controls escaped (short forms where JS has them, lowercase
    /// <c>\u00xx</c> otherwise); everything else — including DEL,
    /// non-ASCII and <c>/</c> — is emitted literally.
    /// </summary>
    private static void AppendCanonicalString(string value, StringBuilder out_)
    {
        out_.Append('"');
        foreach (var ch in value)
        {
            switch (ch)
            {
                case '"': out_.Append("\\\""); break;
                case '\\': out_.Append("\\\\"); break;
                case '\b': out_.Append("\\b"); break;
                case '\f': out_.Append("\\f"); break;
                case '\n': out_.Append("\\n"); break;
                case '\r': out_.Append("\\r"); break;
                case '\t': out_.Append("\\t"); break;
                default:
                    if (ch < 0x20)
                    {
                        out_.Append("\\u00");
                        out_.Append(((int)ch).ToString("x2"));
                    }
                    else
                    {
                        out_.Append(ch);
                    }

                    break;
            }
        }

        out_.Append('"');
    }
}
