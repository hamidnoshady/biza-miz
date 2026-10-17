using System.Security.Cryptography;
using System.Text;
using Biza.SupportCompanion.Core;

using Xunit;

namespace Biza.SupportCompanion.Core.Tests;

/// <summary>
/// DPAPI round-trips against the real Windows DPAPI — these tests only run
/// on Windows (the companion CI job), which is exactly where the P/Invoke
/// must work.
/// </summary>
public sealed class DpapiTests
{
    [Fact]
    public void ProtectUnprotectRoundTrips()
    {
        var plaintext = Encoding.UTF8.GetBytes("device-credential-secret");

        var cipher = Dpapi.Protect(plaintext);

        Assert.False(plaintext.SequenceEqual(cipher));
        Assert.True(plaintext.SequenceEqual(Dpapi.Unprotect(cipher)));
    }

    [Fact]
    public void ProtectIsRandomized()
    {
        var plaintext = Encoding.UTF8.GetBytes("same-input");

        Assert.NotEqual(Dpapi.Protect(plaintext), Dpapi.Protect(plaintext));
    }

    [Fact]
    public void UnprotectForeignBlobThrows()
    {
        Assert.Throws<CryptographicException>(() => Dpapi.Unprotect(new byte[] { 1, 2, 3, 4 }));
    }

    [Fact]
    public void EmptyPayloadsAreRejected()
    {
        Assert.Throws<ArgumentException>(() => Dpapi.Protect([]));
        Assert.Throws<ArgumentException>(() => Dpapi.Unprotect([]));
    }
}
