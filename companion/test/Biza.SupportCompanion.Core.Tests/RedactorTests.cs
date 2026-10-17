using System.Text.Json.Nodes;
using Biza.SupportCompanion.Core;

using Xunit;

namespace Biza.SupportCompanion.Core.Tests;

/// <summary>
/// Parity with <c>redaction.ts</c> + <c>error-report.ts</c>: the same blocked
/// field names, the same four secret patterns, the same attribution rule —
/// so evidence redacted offline matches what the server would have removed.
/// </summary>
public sealed class RedactorTests
{
    [Theory]
    [InlineData(
        "connect postgresql://svc:s3cret@db:5432/pos failed",
        "connect postgresql://svc:[REDACTED]@db:5432/pos failed")]
    [InlineData(
        "Authorization: Bearer abc.def.ghi rejected",
        "Authorization: Bearer [REDACTED] rejected")]
    [InlineData(
        "pairing_code: 123-456 expired",
        "pairing_code: [REDACTED] expired")]
    [InlineData(
        "api_token=xyz789, retry",
        "api_token=[REDACTED], retry")]
    [InlineData(
        "password: hunter2 is weak",
        "password: [REDACTED] is weak")]
    [InlineData(
        "nothing secret here",
        "nothing secret here")]
    public void RedactSecretsKeepsPrefixes(string input, string expected)
    {
        Assert.Equal(expected, Redactor.RedactSecrets(input));
    }

    [Fact]
    public void RedactNodeDropsBlockedFieldsAndScrubsStrings()
    {
        var node = JsonNode.Parse(
            """{"user":"op","password":"hunter2","nested":{"api_key":"k","ok":1},"tags":["a","jwt_token: zzz"]}""");
        var summary = new RedactionSummary();

        var redacted = Redactor.RedactNode(node, summary);

        Assert.Equal(
            """{"user":"op","password":"[REDACTED]","nested":{"api_key":"[REDACTED]","ok":1},"tags":["a","jwt_token: [REDACTED]"]}""",
            redacted?.ToJsonString());
        Assert.Equal(2, summary.BlockedFields);
        Assert.Equal(1, summary.ScrubbedValues);
        Assert.Equal(0, summary.UnattributedLines);
    }

    [Fact]
    public void RedactNodeMatchesKeysCaseInsensitivelyIgnoringSeparators()
    {
        var node = JsonNode.Parse("""{"ConnectionString":"x","SET-COOKIE":"y","kept":"z"}""");
        var summary = new RedactionSummary();

        var redacted = Redactor.RedactNode(node, summary);

        Assert.Equal(
            """{"ConnectionString":"[REDACTED]","SET-COOKIE":"[REDACTED]","kept":"z"}""",
            redacted?.ToJsonString());
        Assert.Equal(2, summary.BlockedFields);
    }

    [Fact]
    public void FilterAttributedLinesNeverGuessesTheTenant()
    {
        var summary = new RedactionSummary();
        var lines = new[]
        {
            new LogLine("biz-a booted password: x", "biz-a"),
            new LogLine("installation-level line", null),
            new LogLine("other tenant line", "biz-b"),
        };

        var kept = Redactor.FilterAttributedLines(lines, "biz-a", summary);

        Assert.Equal(["biz-a booted password: [REDACTED]"], kept);
        Assert.Equal(2, summary.UnattributedLines);
    }
}
