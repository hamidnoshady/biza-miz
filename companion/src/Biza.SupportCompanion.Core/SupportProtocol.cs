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
}
