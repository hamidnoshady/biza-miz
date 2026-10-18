using Biza.SupportCompanion.Core;

using Xunit;

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

    [Fact]
    public void ParsesEnrollLinks()
    {
        const string link = "biza-support://enroll?server=https%3A%2F%2Fsupport.example" +
            "&enrollmentId=enr-1&claim=ABCD-1234";
        Assert.True(SupportProtocol.TryParseEnrollLink(link, out var server, out var id, out var claim));
        Assert.Equal("https://support.example", server);
        Assert.Equal("enr-1", id);
        Assert.Equal("ABCD-1234", claim);
    }

    [Fact]
    public void EnrollAcceptsExplicitV1()
    {
        const string link = "biza-support://enroll?v=1&server=https%3A%2F%2Fx" +
            "&enrollmentId=e&claim=c";
        Assert.True(SupportProtocol.TryParseEnrollLink(link, out _, out _, out _));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("   ")]
    [InlineData("biza-support://ticket/1")]
    [InlineData("biza-support://open")]
    [InlineData("biza-support://enroll?server=https%3A%2F%2Fx&enrollmentId=e")]
    [InlineData("biza-support://enroll?server=https%3A%2F%2Fx&claim=c")]
    [InlineData("biza-support://enroll?enrollmentId=e&claim=c")]
    [InlineData("biza-support://enroll?v=2&server=https%3A%2F%2Fx&enrollmentId=e&claim=c")]
    [InlineData("https://example.com/enroll")]
    [InlineData("not a link")]
    public void RejectsMalformedEnrollLinks(string? link)
    {
        Assert.False(SupportProtocol.TryParseEnrollLink(link, out _, out _, out _));
    }
}
