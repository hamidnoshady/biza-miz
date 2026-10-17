using Biza.SupportCompanion.Core;

namespace Biza.SupportCompanion.Core.Tests;

public sealed class SupportProtocolTests
{
    [Fact]
    public void BuildsTheOneAcceptedLinkShape()
    {
        Assert.Equal("biza-support", SupportProtocol.Scheme);
        Assert.Equal("biza-support://ticket/ticket-1", SupportProtocol.TicketLink("ticket-1"));
        Assert.Equal("biza-support://open", SupportProtocol.TicketLink("  "));
        Assert.Equal("biza-support://open", SupportProtocol.TicketLink(null));
    }

    [Fact]
    public void EscapesTicketIds()
    {
        Assert.Equal("biza-support://ticket/a%20b", SupportProtocol.TicketLink("a b"));
    }

    [Theory]
    [InlineData("biza-support://ticket/ticket-1", "ticket-1")]
    [InlineData("biza-support://ticket/a%20b", "a b")]
    public void ParsesTicketLinks(string link, string expectedTicketId)
    {
        Assert.True(SupportProtocol.TryParseTicketLink(link, out var ticketId));
        Assert.Equal(expectedTicketId, ticketId);
    }

    [Fact]
    public void ParsesBareOpenLinkWithoutTicket()
    {
        Assert.True(SupportProtocol.TryParseTicketLink("biza-support://open", out var ticketId));
        Assert.Null(ticketId);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("https://example.com/ticket/1")]
    [InlineData("biza-support://ticket/")]
    [InlineData("biza-support://ticket/a/b")]
    [InlineData("biza-support://repair/1")]
    [InlineData("biza-support:ticket-1")]
    [InlineData("not a link")]
    public void RejectsAnythingElse(string? link)
    {
        Assert.False(SupportProtocol.TryParseTicketLink(link, out _));
    }
}
