using Biza.SupportCompanion.Core;

using Xunit;

namespace Biza.SupportCompanion.Core.Tests;

/// <summary>
/// Cross-runtime proof: these vectors were minted by the real server signer
/// (<c>jose</c> ES256, same claim shape as
/// <c>issueOfflineToken</c>) and the C# verifier must accept exactly what the
/// server-side <c>verifyOfflineToken</c> accepts. The private key was
/// discarded after minting — only the public JWK and the tokens ship here.
/// Valid window: iat/nbf 1890000000, exp 1890003600 (year 2029).
/// </summary>
public sealed class OfflineTokenVerifierTests
{
    private const string PublicJwk =
        """{"kty":"EC","crv":"P-256","x":"zH9Dq4F3YHGpgw7FIU6T9BjEnSdx7e0orVqJ0cWJeT4","y":"CjJqGGQyDk6J1pidwK7rZlUlyqmFlduI2F5mXxwh0Cg","kid":"offline-test-v1"}""";

    // Second minting key for the mixed/garbage claim matrix. Same provenance
    // (real server signer shape, key discarded after minting); every vector
    // below was verified against the server verifier before embedding.
    private const string PublicJwk2 =
        """{"kty":"EC","crv":"P-256","x":"Uz6wfsOkz5WVWppIDArEkPugx_TAmSRV652hCdKEFqo","y":"ILr2LG3vlCuvyN_uO5Sogc3fzpfdvRcl3GE8pX31GH4","kid":"offline-test-v2"}""";

    private static string ApprovedKeysJson => "[" + PublicJwk + "]";

    private static string ApprovedKeysJson2 => "[" + PublicJwk2 + "]";

    private const long NowInWindow = 1890000100;

    private const string ValidToken =
        "eyJhbGciOiJFUzI1NiIsImtpZCI6Im9mZmxpbmUtdGVzdC12MSJ9." +
        "eyJ0aWNrZXRfaWQiOiJ0aWNrZXQtdmVjdG9yLTEiLCJidXNpbmVzc19pZCI6ImJpei12ZWN0b3ItMSIsImluc3RhbGxhdGlvbl9pZCI6Imluc3QtdmVjdG9yLTEiLCJpbnN0YWxsYXRpb25fZ2VuZXJhdGlvbiI6Mywib3BlcmF0b3JfYWRtaW5faWQiOiJhZG1pbi12ZWN0b3ItMSIsInNjb3BlIjpbImRpYWdub3N0aWNzLnJ1biIsInJlcG9ydC51cGxvYWQiXSwidGVjaG5pY2lhbl9iaW5kaW5nX2hhc2giOiJ0ZWNoaGFzaCIsImNoYWxsZW5nZSI6ImNoYWwiLCJwb2xpY3lfdmVyc2lvbiI6InYxIiwiaXNzIjoiYml6YS1taXotc3VwcG9ydCIsImF1ZCI6InN1cHBvcnQtY29tcGFuaW9uLW9uc2l0ZSIsImp0aSI6Imp0aS12ZWN0b3ItMSIsImlhdCI6MTg5MDAwMDAwMCwibmJmIjoxODkwMDAwMDAwLCJleHAiOjE4OTAwMDM2MDB9." +
        "5bA6nEBF4wL-AhUaJF6rUhtFkIdQiRCqmyp5_KNryazWc4W3mtCJqnPTYoptyA0b4ICiIvFWrjULh5fLhG65-A";

    private const string ExpiredToken =
        "eyJhbGciOiJFUzI1NiIsImtpZCI6Im9mZmxpbmUtdGVzdC12MSJ9." +
        "eyJ0aWNrZXRfaWQiOiJ0aWNrZXQtdmVjdG9yLTEiLCJidXNpbmVzc19pZCI6ImJpei12ZWN0b3ItMSIsImluc3RhbGxhdGlvbl9pZCI6Imluc3QtdmVjdG9yLTEiLCJpbnN0YWxsYXRpb25fZ2VuZXJhdGlvbiI6Mywib3BlcmF0b3JfYWRtaW5faWQiOiJhZG1pbi12ZWN0b3ItMSIsInNjb3BlIjpbImRpYWdub3N0aWNzLnJ1biIsInJlcG9ydC51cGxvYWQiXSwidGVjaG5pY2lhbl9iaW5kaW5nX2hhc2giOiJ0ZWNoaGFzaCIsImNoYWxsZW5nZSI6ImNoYWwiLCJwb2xpY3lfdmVyc2lvbiI6InYxIiwiaXNzIjoiYml6YS1taXotc3VwcG9ydCIsImF1ZCI6InN1cHBvcnQtY29tcGFuaW9uLW9uc2l0ZSIsImp0aSI6Imp0aS12ZWN0b3ItMSIsImlhdCI6MTg5MDAwMDAwMCwibmJmIjoxODkwMDAwMDAwLCJleHAiOjE3MDAwMDAwMDB9." +
        "8EUX4iYpy5UuKyBw3AmNpJc1cEA5oWYtZOrQpP241QGArAqEXmNPq7sMajIGKB3F1d8YjOhCIuzswsHK89NM7Q";

    private const string WrongAudienceToken =
        "eyJhbGciOiJFUzI1NiIsImtpZCI6Im9mZmxpbmUtdGVzdC12MSJ9." +
        "eyJ0aWNrZXRfaWQiOiJ0aWNrZXQtdmVjdG9yLTEiLCJidXNpbmVzc19pZCI6ImJpei12ZWN0b3ItMSIsImluc3RhbGxhdGlvbl9pZCI6Imluc3QtdmVjdG9yLTEiLCJpbnN0YWxsYXRpb25fZ2VuZXJhdGlvbiI6Mywib3BlcmF0b3JfYWRtaW5faWQiOiJhZG1pbi12ZWN0b3ItMSIsInNjb3BlIjpbImRpYWdub3N0aWNzLnJ1biIsInJlcG9ydC51cGxvYWQiXSwidGVjaG5pY2lhbl9iaW5kaW5nX2hhc2giOiJ0ZWNoaGFzaCIsImNoYWxsZW5nZSI6ImNoYWwiLCJwb2xpY3lfdmVyc2lvbiI6InYxIiwiaXNzIjoiYml6YS1taXotc3VwcG9ydCIsImF1ZCI6InNvbWV0aGluZy1lbHNlIiwianRpIjoianRpLXZlY3Rvci0xIiwiaWF0IjoxODkwMDAwMDAwLCJuYmYiOjE4OTAwMDAwMDAsImV4cCI6MTg5MDAwMzYwMH0." +
        "wWbYbm54ezPdQcqk6Shr7IcUA8R2w3FXemPANGWCFx-1FhP01wWSpowvqhpJCfRm7j6HWH7BKoiOjnH_AhrkaA";

    [Fact]
    public void VerifiesTheServerMintedVector()
    {
        var result = OfflineTokenVerifier.Verify(ValidToken, ApprovedKeysJson, NowInWindow);

        Assert.True(result.Ok);
        Assert.Equal("offline-test-v1", result.Kid);
        var claims = result.Claims;
        Assert.NotNull(claims);
        Assert.Equal("jti-vector-1", claims.Jti);
        Assert.Equal("ticket-vector-1", claims.TicketId);
        Assert.Equal("biz-vector-1", claims.BusinessId);
        Assert.Equal("inst-vector-1", claims.InstallationId);
        Assert.Equal(3, claims.InstallationGeneration);
        Assert.Equal("admin-vector-1", claims.OperatorAdminId);
        Assert.Equal(["diagnostics.run", "report.upload"], claims.Scope);
        Assert.Equal("techhash", claims.TechnicianBindingHash);
        Assert.Equal("chal", claims.Challenge);
        Assert.Equal("v1", claims.PolicyVersion);
    }

    [Fact]
    public void RejectsATamperedSignature()
    {
        var tampered = ValidToken[..^1] + (ValidToken[^1] == 'A' ? 'B' : 'A');

        var result = OfflineTokenVerifier.Verify(tampered, ApprovedKeysJson, NowInWindow);

        Assert.False(result.Ok);
        Assert.Equal(OfflineTokenError.InvalidSignature, result.Error);
    }

    [Fact]
    public void RejectsATamperedPayload()
    {
        var parts = ValidToken.Split('.');
        var payload = parts[1].ToCharArray();
        payload[10] = payload[10] == 'A' ? 'B' : 'A';
        var tampered = parts[0] + "." + new string(payload) + "." + parts[2];

        var result = OfflineTokenVerifier.Verify(tampered, ApprovedKeysJson, NowInWindow);

        Assert.False(result.Ok);
        // The payload no longer parses (or no longer matches the signature):
        // either way it fails closed, never verified.
        Assert.True(
            result.Error is OfflineTokenError.InvalidSignature or OfflineTokenError.Malformed,
            $"unexpected error {result.Error}");
    }

    [Fact]
    public void DistinguishesExpiryFromABadSignature()
    {
        var result = OfflineTokenVerifier.Verify(ExpiredToken, ApprovedKeysJson, NowInWindow);

        Assert.False(result.Ok);
        Assert.Equal(OfflineTokenError.Expired, result.Error);
    }

    [Fact]
    public void DistinguishesNotYetValid()
    {
        var result = OfflineTokenVerifier.Verify(ValidToken, ApprovedKeysJson, 1890000000 - 1);

        Assert.False(result.Ok);
        Assert.Equal(OfflineTokenError.NotYetValid, result.Error);
    }

    [Fact]
    public void DistinguishesWrongAudience()
    {
        var result = OfflineTokenVerifier.Verify(WrongAudienceToken, ApprovedKeysJson, NowInWindow);

        Assert.False(result.Ok);
        Assert.Equal(OfflineTokenError.WrongAudience, result.Error);
    }

    // The mixed/garbage claim matrix (kid offline-test-v2). Each expectation
    // was verified against the server verifier before embedding.
    private const string MixedExpiredWrongAudToken =
        "eyJhbGciOiJFUzI1NiIsImtpZCI6Im9mZmxpbmUtdGVzdC12MiJ9." +
        "eyJ0aWNrZXRfaWQiOiJ0MiIsImJ1c2luZXNzX2lkIjoiYjIiLCJpbnN0YWxsYXRpb25faWQiOiJpMiIsImluc3RhbGxhdGlvbl9nZW5lcmF0aW9uIjoxLCJvcGVyYXRvcl9hZG1pbl9pZCI6ImEyIiwic2NvcGUiOlsiZGlhZ25vc3RpY3MucnVuIl0sInRlY2huaWNpYW5fYmluZGluZ19oYXNoIjoiaCIsImNoYWxsZW5nZSI6ImMiLCJwb2xpY3lfdmVyc2lvbiI6InYxIiwiaXNzIjoiYml6YS1taXotc3VwcG9ydCIsImp0aSI6ImoyIiwiaWF0IjoxODkwMDAwMDAwLCJuYmYiOjE4OTAwMDAwMDAsImV4cCI6MTcwMDAwMDAwMCwiYXVkIjoic29tZXRoaW5nLWVsc2UifQ." +
        "EktnPIoHcnCISabffsb-d9kDJco4cg94KFdvno6lviUGcLqfsROFpp9IDB_LDlrMECUc4lLd1Aug3ok9AyLiWA";

    private const string StringExpToken =
        "eyJhbGciOiJFUzI1NiIsImtpZCI6Im9mZmxpbmUtdGVzdC12MiJ9." +
        "eyJ0aWNrZXRfaWQiOiJ0MiIsImJ1c2luZXNzX2lkIjoiYjIiLCJpbnN0YWxsYXRpb25faWQiOiJpMiIsImluc3RhbGxhdGlvbl9nZW5lcmF0aW9uIjoxLCJvcGVyYXRvcl9hZG1pbl9pZCI6ImEyIiwic2NvcGUiOlsiZGlhZ25vc3RpY3MucnVuIl0sInRlY2huaWNpYW5fYmluZGluZ19oYXNoIjoiaCIsImNoYWxsZW5nZSI6ImMiLCJwb2xpY3lfdmVyc2lvbiI6InYxIiwiaXNzIjoiYml6YS1taXotc3VwcG9ydCIsImp0aSI6ImoyIiwiaWF0IjoxODkwMDAwMDAwLCJuYmYiOjE4OTAwMDAwMDAsImV4cCI6InRvbW9ycm93IiwiYXVkIjoic3VwcG9ydC1jb21wYW5pb24tb25zaXRlIn0." +
        "7zxjF-JMdNHhcq1kO2D-lqTXqeCOEZazD42ROowjaUHaV6qgM6ndw5yqqmPqDQ0wa5XfEEq7NJV8mcxO0e7UEA";

    private const string StringNbfToken =
        "eyJhbGciOiJFUzI1NiIsImtpZCI6Im9mZmxpbmUtdGVzdC12MiJ9." +
        "eyJ0aWNrZXRfaWQiOiJ0MiIsImJ1c2luZXNzX2lkIjoiYjIiLCJpbnN0YWxsYXRpb25faWQiOiJpMiIsImluc3RhbGxhdGlvbl9nZW5lcmF0aW9uIjoxLCJvcGVyYXRvcl9hZG1pbl9pZCI6ImEyIiwic2NvcGUiOlsiZGlhZ25vc3RpY3MucnVuIl0sInRlY2huaWNpYW5fYmluZGluZ19oYXNoIjoiaCIsImNoYWxsZW5nZSI6ImMiLCJwb2xpY3lfdmVyc2lvbiI6InYxIiwiaXNzIjoiYml6YS1taXotc3VwcG9ydCIsImp0aSI6ImoyIiwiaWF0IjoxODkwMDAwMDAwLCJuYmYiOiJ5ZXN0ZXJkYXkiLCJleHAiOjE4OTAwMDM2MDAsImF1ZCI6InN1cHBvcnQtY29tcGFuaW9uLW9uc2l0ZSJ9." +
        "ioZwxETKops1FVKLos1_d9WCHAkmAY8GNQeqH1cnneA9qCyj9dO1HvJEKVqUExtSe75Iwb_hiLtNRqnQ6G5TXw";

    private const string StringIatToken =
        "eyJhbGciOiJFUzI1NiIsImtpZCI6Im9mZmxpbmUtdGVzdC12MiJ9." +
        "eyJ0aWNrZXRfaWQiOiJ0MiIsImJ1c2luZXNzX2lkIjoiYjIiLCJpbnN0YWxsYXRpb25faWQiOiJpMiIsImluc3RhbGxhdGlvbl9nZW5lcmF0aW9uIjoxLCJvcGVyYXRvcl9hZG1pbl9pZCI6ImEyIiwic2NvcGUiOlsiZGlhZ25vc3RpY3MucnVuIl0sInRlY2huaWNpYW5fYmluZGluZ19oYXNoIjoiaCIsImNoYWxsZW5nZSI6ImMiLCJwb2xpY3lfdmVyc2lvbiI6InYxIiwiaXNzIjoiYml6YS1taXotc3VwcG9ydCIsImp0aSI6ImoyIiwiaWF0Ijoic29tZWRheSIsIm5iZiI6MTg5MDAwMDAwMCwiZXhwIjoxODkwMDAzNjAwLCJhdWQiOiJzdXBwb3J0LWNvbXBhbmlvbi1vbnNpdGUifQ." +
        "SN239h0LwXaCbxYgDXc0v9jeCCwIklTaG22bbTmNO30ashRUo-9AZmseNBAc8UlFe41eUtmwZnZRm3r4kDih3Q";

    [Fact]
    public void ExpiredAndWrongAudienceIsInvalidSignature()
    {
        // Trust wrong + time bad: the server's re-verify still enforces the
        // clock, so this is InvalidSignature, not WrongAudience or Expired.
        var result = OfflineTokenVerifier.Verify(MixedExpiredWrongAudToken, ApprovedKeysJson2, NowInWindow);

        Assert.False(result.Ok);
        Assert.Equal(OfflineTokenError.InvalidSignature, result.Error);
    }

    [Fact]
    public void NonNumericExpIsInvalidSignature()
    {
        var result = OfflineTokenVerifier.Verify(StringExpToken, ApprovedKeysJson2, NowInWindow);

        Assert.False(result.Ok);
        Assert.Equal(OfflineTokenError.InvalidSignature, result.Error);
    }

    [Fact]
    public void NonNumericNbfIsNotYetValid()
    {
        var result = OfflineTokenVerifier.Verify(StringNbfToken, ApprovedKeysJson2, NowInWindow);

        Assert.False(result.Ok);
        Assert.Equal(OfflineTokenError.NotYetValid, result.Error);
    }

    [Fact]
    public void NonNumericIatIsNotYetValid()
    {
        var result = OfflineTokenVerifier.Verify(StringIatToken, ApprovedKeysJson2, NowInWindow);

        Assert.False(result.Ok);
        Assert.Equal(OfflineTokenError.NotYetValid, result.Error);
    }

    [Fact]
    public void ExpiresExactlyAtExp()
    {
        var atExp = OfflineTokenVerifier.Verify(ValidToken, ApprovedKeysJson, 1890003600);
        Assert.False(atExp.Ok);
        Assert.Equal(OfflineTokenError.Expired, atExp.Error);

        var beforeExp = OfflineTokenVerifier.Verify(ValidToken, ApprovedKeysJson, 1890003600 - 1);
        Assert.True(beforeExp.Ok);
    }

    [Fact]
    public void FailsClosedOnUnknownKid()
    {
        var otherKeys = """[{"kty":"EC","crv":"P-256","x":"zH9Dq4F3YHGpgw7FIU6T9BjEnSdx7e0orVqJ0cWJeT4","y":"CjJqGGQyDk6J1pidwK7rZlUlyqmFlduI2F5mXxwh0Cg","kid":"some-other-kid"}]""";

        var result = OfflineTokenVerifier.Verify(ValidToken, otherKeys, NowInWindow);

        Assert.False(result.Ok);
        Assert.Equal(OfflineTokenError.UnknownKey, result.Error);
    }

    [Fact]
    public void RejectsNonEs256Algorithms()
    {
        // "alg":"none" with the valid payload — must never verify.
        var noneHeader = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("""{"alg":"none","kid":"offline-test-v1"}"""))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var parts = ValidToken.Split('.');
        var forged = noneHeader + "." + parts[1] + ".";

        var result = OfflineTokenVerifier.Verify(forged, ApprovedKeysJson, NowInWindow);

        Assert.False(result.Ok);
        Assert.Equal(OfflineTokenError.InvalidSignature, result.Error);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not-a-jwt")]
    [InlineData("a.b")]
    [InlineData("a.b.c.d")]
    [InlineData("!!!.@@@.###")]
    public void RejectsMalformedTokens(string? token)
    {
        var result = OfflineTokenVerifier.Verify(token, ApprovedKeysJson, NowInWindow);

        Assert.False(result.Ok);
        Assert.Equal(OfflineTokenError.Malformed, result.Error);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not-json")]
    [InlineData("{}")]
    [InlineData("[]")]
    public void FailsClosedWithoutApprovedKeys(string? keysJson)
    {
        var result = OfflineTokenVerifier.Verify(ValidToken, keysJson, NowInWindow);

        Assert.False(result.Ok);
        Assert.Equal(OfflineTokenError.UnknownKey, result.Error);
    }
}
