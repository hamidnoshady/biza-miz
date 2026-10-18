using Biza.SupportCompanion.Core;

using Xunit;

namespace Biza.SupportCompanion.Core.Tests;

/// <summary>
/// Cross-runtime proof: these recipe hashes were computed by the server's
/// <c>recipeHashFor</c> and are pinned in
/// <c>migrations/0228_support_repair_catalog_seed.sql</c>. The C# executor
/// must reproduce them byte-for-byte, or it refuses every recipe.
/// </summary>
public sealed class CanonicalJsonTests
{
    [Theory]
    [InlineData(
        """{"action": "companion.clean_temp", "params": {"maxAgeDays": 7, "roots": ["companion_temp"]}}""",
        "ba74ad2b84b51556b140aa9170c414abdd951ecc157399f7b632783c815a45f2")]
    [InlineData(
        """{"action": "companion.rotate_logs", "params": {"keepFiles": 10}}""",
        "def201fe2839679211c802746c84340b9b60a50cf4802185a9c2a32a2cebbd7e")]
    [InlineData(
        """{"action": "main.restart_backend", "params": {"requireGate": true, "timeoutSec": 120}}""",
        "466f770b14207ee2280555749bd9f42e30c9585f627b3b3a721715e30b1ff7a7")]
    public void ReproducesTheServerRecipeHashes(string recipeJson, string expectedHash)
    {
        Assert.Equal(expectedHash, CanonicalJson.TryHashRecipe(recipeJson));
    }

    [Fact]
    public void SortsKeysRecursivelyWithNoWhitespace()
    {
        Assert.Equal(
            """{"a":1,"b":{"c":[3,2],"d":true}}""",
            CanonicalJson.Canonicalize("""{"b": {"c": [3, 2], "d": true}, "a": 1}"""));
    }

    [Fact]
    public void EscapesStringsExactlyLikeJsonStringify()
    {
        Assert.Equal(
            "\"\\\\\\\"\\b\\f\\n\\r\\t\\u0000\\u0007éü/\"",
            CanonicalJson.Canonicalize("\"\\u005c\\u0022\\b\\f\\n\\r\\t\\u0000\\u0007éü/\""));
    }

    [Fact]
    public void EmitsLiteralsAndPreservesNumbers()
    {
        Assert.Equal(
            """{"f":false,"n":null,"t":true,"x":-12.5}""",
            CanonicalJson.Canonicalize("""{"x": -12.5, "t": true, "f": false, "n": null}"""));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("[1,2]")]
    [InlineData("\"str\"")]
    [InlineData("{oops")]
    public void RejectsNonObjectOrInvalidInput(string? recipeJson)
    {
        Assert.Null(CanonicalJson.TryHashRecipe(recipeJson));
    }

    [Fact]
    public void RejectsOversizeDocuments()
    {
        var big = "{\"a\":\"" + new string('x', CanonicalJson.MaxDocumentBytes) + "\"}";
        Assert.Null(CanonicalJson.TryHashRecipe(big));
    }
}
