namespace Biza.SupportCompanion.Core;

/// <summary>
/// Issue #984 — the one deep-link shape the companion accepts. The desktop
/// shell builds the same links (see <c>electron/support-companion.js</c>);
/// opening one authorizes nothing by itself.
/// </summary>
public static class SupportProtocol
{
    public const string Scheme = "biza-support";

    /// <summary>
    /// <c>biza-support://ticket/{id}</c>, or <c>biza-support://open</c> when
    /// no ticket is hinted.
    /// </summary>
    public static string TicketLink(string? ticketId)
    {
        var id = (ticketId ?? string.Empty).Trim();
        return id.Length == 0
            ? $"{Scheme}://open"
            : $"{Scheme}://ticket/{Uri.EscapeDataString(id)}";
    }

    /// <summary>
    /// Parses a companion link. Returns <c>false</c> for anything that is not
    /// exactly the accepted shape; <paramref name="ticketId"/> is <c>null</c>
    /// for a bare <c>://open</c> link.
    /// </summary>
    public static bool TryParseTicketLink(string? link, out string? ticketId)
    {
        ticketId = null;
        if (string.IsNullOrWhiteSpace(link))
        {
            return false;
        }

        if (!Uri.TryCreate(link.Trim(), UriKind.Absolute, out var uri))
        {
            return false;
        }

        if (!string.Equals(uri.Scheme, Scheme, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (string.Equals(uri.Host, "open", StringComparison.OrdinalIgnoreCase) &&
            uri.AbsolutePath.Trim('/').Length == 0)
        {
            return true;
        }

        if (string.Equals(uri.Host, "ticket", StringComparison.OrdinalIgnoreCase))
        {
            var id = Uri.UnescapeDataString(uri.AbsolutePath.Trim('/'));
            if (id.Length == 0 || id.Contains('/'))
            {
                return false;
            }

            ticketId = id;
            return true;
        }

        return false;
    }

    /// <summary>
    /// Owner-transferred enrollment links:
    /// <c>biza-support://enroll?server=&lt;origin&gt;&amp;enrollmentId=&lt;id&gt;&amp;claim=&lt;code&gt;</c>
    /// (optional <c>v=1</c>), built shell-side by
    /// <c>companionEnrollLink</c>. Parses shape only — the shell validates
    /// the server origin, and the claim redeem over TLS is the credential.
    /// </summary>
    public static bool TryParseEnrollLink(
        string? link, out string? server, out string? enrollmentId, out string? claim)
    {
        server = null;
        enrollmentId = null;
        claim = null;
        if (string.IsNullOrWhiteSpace(link))
        {
            return false;
        }

        if (!Uri.TryCreate(link.Trim(), UriKind.Absolute, out var uri))
        {
            return false;
        }

        if (!string.Equals(uri.Scheme, Scheme, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(uri.Host, "enroll", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var query = ParseQuery(uri.Query);
        if (query.TryGetValue("v", out var version) && version != "1")
        {
            return false;
        }

        if (!query.TryGetValue("server", out var rawServer) || string.IsNullOrWhiteSpace(rawServer))
        {
            return false;
        }

        if (!query.TryGetValue("enrollmentId", out var rawId) || string.IsNullOrWhiteSpace(rawId))
        {
            return false;
        }

        if (!query.TryGetValue("claim", out var rawClaim) || string.IsNullOrWhiteSpace(rawClaim))
        {
            return false;
        }

        server = rawServer.Trim();
        enrollmentId = rawId.Trim();
        claim = rawClaim.Trim();
        return true;
    }

    private static Dictionary<string, string> ParseQuery(string query)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var part in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var equals = part.IndexOf('=');
            var name = equals < 0 ? part : part.Substring(0, equals);
            var value = equals < 0 ? string.Empty : part.Substring(equals + 1);
            map[Uri.UnescapeDataString(name.Replace('+', ' '))] =
                Uri.UnescapeDataString(value.Replace('+', ' '));
        }

        return map;
    }
}
