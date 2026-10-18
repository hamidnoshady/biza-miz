using System.Security.Cryptography;
using System.Text;

using Biza.SupportCompanion.Core;

using Xunit;

namespace Biza.SupportCompanion.Core.Tests;

public sealed class UpdateManifestTests
{
    private const string Channel = "companion-stable";
    private const string Kid = "release-1";

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static (string ApprovedKeysJson, Func<string, string> Sign) TestAuthority()
    {
        using var rsa = RSA.Create(2048);
        var parameters = rsa.ExportParameters(includePrivateParameters: true);
        var keys = "[{\"kid\":\"" + Kid + "\",\"kty\":\"RSA\",\"n\":\""
            + Base64Url(parameters.Modulus!) + "\",\"e\":\"" + Base64Url(parameters.Exponent!) + "\"}]";
        var signer = RSA.Create(parameters);
        string Sign(string manifestJson)
        {
            var canonical = CanonicalJson.Canonicalize(manifestJson);
            var signature = signer.SignData(
                Encoding.UTF8.GetBytes(canonical), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            return Base64Url(signature);
        }

        return (keys, Sign);
    }

    private static string Manifest(string version = "1.2.0", string channel = Channel, string kid = Kid) =>
        "{\"channel\":\"" + channel + "\",\"version\":\"" + version + "\",\"kid\":\"" + kid
        + "\",\"files\":[{\"path\":\"BizaSupportCompanion.exe\",\"sha256\":\""
        + new string('a', 64) + "\",\"bytes\":12345}]}";

    [Fact]
    public void VerifiesASignedUpgrade()
    {
        var (keys, sign) = TestAuthority();
        var manifest = Manifest();

        var verified = UpdateManifest.TryVerify(manifest, sign(manifest), keys, Channel, "1.1.9", out var error);

        Assert.NotNull(verified);
        Assert.Equal(Channel, verified.Channel);
        Assert.Equal("1.2.0", verified.Version);
        Assert.Single(verified.Files);
        Assert.Equal("BizaSupportCompanion.exe", verified.Files[0].Path);
    }

    [Fact]
    public void RejectsATamperedManifest()
    {
        var (keys, sign) = TestAuthority();
        var manifest = Manifest();
        var signature = sign(manifest);
        var tampered = manifest.Replace("1.2.0", "9.9.9");

        var verified = UpdateManifest.TryVerify(tampered, signature, keys, Channel, "1.1.9", out var error);

        Assert.Null(verified);
        Assert.Contains("signature", error);
    }

    [Fact]
    public void RejectsWrongChannelDowngradesAndUnknownKids()
    {
        var (keys, sign) = TestAuthority();

        var wrongChannel = UpdateManifest.TryVerify(
            Manifest(channel: "other"), sign(Manifest(channel: "other")), keys, Channel, "1.1.9", out var channelError);
        Assert.Null(wrongChannel);
        Assert.Contains(Channel, channelError);

        var same = UpdateManifest.TryVerify(
            Manifest(version: "1.1.9"), sign(Manifest(version: "1.1.9")), keys, Channel, "1.1.9", out var sameError);
        Assert.Null(same);
        Assert.Contains("not an upgrade", sameError);

        var older = UpdateManifest.TryVerify(
            Manifest(version: "1.1.8"), sign(Manifest(version: "1.1.8")), keys, Channel, "1.1.9", out _);
        Assert.Null(older);

        var unknownKid = UpdateManifest.TryVerify(
            Manifest(kid: "nope"), sign(Manifest()), keys, Channel, "1.1.9", out var kidError);
        Assert.Null(unknownKid);
        Assert.Contains("signature", kidError);
    }

    [Fact]
    public void RejectsUnsafeFileEntries()
    {
        var (keys, sign) = TestAuthority();
        foreach (var badPath in new[] { "../evil.exe", "C:\\\\Windows\\\\evil.exe", "/etc/evil", "a:b.exe", string.Empty })
        {
            var manifest = "{\"channel\":\"" + Channel
                + "\",\"version\":\"1.2.0\",\"kid\":\"" + Kid
                + "\",\"files\":[{\"path\":\"" + badPath + "\",\"sha256\":\"" + new string('b', 64) + "\",\"bytes\":1}]}";
            var verified = UpdateManifest.TryVerify(manifest, sign(manifest), keys, Channel, "1.1.9", out var error);
            Assert.Null(verified);
            Assert.Contains("unsafe", error);
        }
    }

    [Fact]
    public void RejectsMalformedInputs()
    {
        var (keys, sign) = TestAuthority();
        var manifest = Manifest();
        var signature = sign(manifest);

        Assert.Null(UpdateManifest.TryVerify(null, signature, keys, Channel, "1.1.9", out _));
        Assert.Null(UpdateManifest.TryVerify("{oops", signature, keys, Channel, "1.1.9", out _));
        Assert.Null(UpdateManifest.TryVerify(manifest, "!!!", keys, Channel, "1.1.9", out _));
        Assert.Null(UpdateManifest.TryVerify(manifest, signature, "[]", Channel, "1.1.9", out _));
        Assert.Null(UpdateManifest.TryVerify(manifest, signature, null, Channel, "1.1.9", out _));
        Assert.Null(UpdateManifest.TryVerify(
            """{"channel":"c","version":"x","kid":"k","files":[]}""",
            signature, keys, "c", "1.0.0", out var versionError));
        Assert.Contains("version", versionError);
    }
}
