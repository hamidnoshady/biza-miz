using Biza.SupportCompanion.Core;

using Xunit;

namespace Biza.SupportCompanion.Core.Tests;

/// <summary>
/// The server→executor seam: seed-faithful catalog fixtures must build
/// envelopes the executor accepts, and anything off-contract must refuse
/// with a name the shell can show. Recipe hashes are the migration-seed
/// pins — if a fixture drifts from the seed, the hash check fails here.
/// </summary>
public sealed class RepairEnvelopeBuilderTests
{
    private const string InstallationId = "11111111-1111-1111-1111-111111111111";
    private const string TicketId = "22222222-2222-2222-2222-222222222222";

    private const string CleanTempHash = "ba74ad2b84b51556b140aa9170c414abdd951ecc157399f7b632783c815a45f2";

    private static string RunJson(string state = "authorized") =>
        "{\"id\":\"run-1\",\"ticketId\":\"" + TicketId +
        "\",\"installationId\":\"" + InstallationId +
        "\",\"recipeId\":\"companion.clean_temp\",\"recipeVersion\":1,\"state\":\"" + state + "\"}";

    private static string CleanTempRecipeJson() =>
        "{\"recipeId\":\"companion.clean_temp\",\"version\":1," +
        "\"title\":\"seed\",\"description\":\"seed\",\"risk\":\"low\"," +
        "\"compatibility\":{\"platform\":[\"windows\"]}," +
        "\"preconditions\":[{\"check\":\"root_owned\",\"detail\":\"companion_temp\"},{\"check\":\"dry_run_first\"}]," +
        "\"effects\":[{\"effect\":\"delete_companion_temp_older_than_days\",\"days\":7}]," +
        "\"postchecks\":[{\"check\":\"journal_intact\"},{\"check\":\"reports_intact\"}]," +
        "\"backupPolicy\":\"none\"," +
        "\"recipe\":{\"action\":\"companion.clean_temp\",\"params\":{\"maxAgeDays\":7,\"roots\":[\"companion_temp\"]}}," +
        "\"recipeHash\":\"" + CleanTempHash + "\"}";

    private static ExecutorRoots TempRoots()
    {
        var baseDir = Path.Combine(Path.GetTempPath(), $"companion-seam-{Guid.NewGuid():N}");
        var roots = new ExecutorRoots(
            Path.Combine(baseDir, "data"),
            Path.Combine(baseDir, "temp"),
            Path.Combine(baseDir, "logs"),
            Path.Combine(baseDir, "journal"),
            Path.Combine(baseDir, "reports"),
            Path.Combine(baseDir, "staging"),
            Path.Combine(baseDir, "maintenance.lock"));
        Directory.CreateDirectory(roots.DataDir);
        Directory.CreateDirectory(roots.TempDir);
        Directory.CreateDirectory(roots.LogDir);
        Directory.CreateDirectory(roots.JournalDir);
        Directory.CreateDirectory(roots.ReportsDir);
        Directory.CreateDirectory(roots.StagingDir);
        return roots;
    }

    [Fact]
    public void BuildsSeedCleanTempEndToEnd()
    {
        var ok = RepairEnvelopeBuilder.TryBuild(
            RunJson(), CleanTempRecipeJson(), InstallationId, TicketId,
            out var envelopeJson, out var error);

        Assert.True(ok, error);
        Assert.True(RepairRunEnvelope.TryParse(envelopeJson, out var envelope, out var parseError), parseError);
        Assert.NotNull(envelope);
        Assert.Equal("run-1", envelope.RunId);
        Assert.Equal("companion.clean_temp", envelope.RecipeId);
        Assert.Equal(1, envelope.RecipeVersion);
        Assert.Equal(CleanTempHash, envelope.RecipeHash);
        Assert.Equal("low", envelope.Risk);
        Assert.Equal("none", envelope.BackupPolicy);
        Assert.Equal(2, envelope.Preconditions.Count);
        Assert.Equal("root_owned", envelope.Preconditions[0].Check);
        Assert.Equal("companion_temp", envelope.Preconditions[0].Detail);
        Assert.Equal(2, envelope.Postchecks.Count);

        // The seam's whole point: the executor plans the built envelope.
        var roots = TempRoots();
        try
        {
            var (plan, refusal) = RepairExecutor.Plan(envelope, roots);
            Assert.Null(refusal);
            Assert.NotNull(plan);
            Assert.Equal("companion.clean_temp", plan.Verb);
        }
        finally
        {
            try
            {
                Directory.Delete(Path.GetDirectoryName(roots.DataDir)!, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

    [Fact]
    public void RunNotAuthorizedRefusesWithState()
    {
        var ok = RepairEnvelopeBuilder.TryBuild(
            RunJson("proposed"), CleanTempRecipeJson(), InstallationId, TicketId,
            out _, out var error);

        Assert.False(ok);
        Assert.Equal("run_not_authorized:proposed", error);
    }

    [Fact]
    public void InstallationMismatchRefuses()
    {
        var ok = RepairEnvelopeBuilder.TryBuild(
            RunJson(), CleanTempRecipeJson(), "other-installation", TicketId,
            out _, out var error);

        Assert.False(ok);
        Assert.Equal("installation_mismatch", error);
    }

    [Fact]
    public void TicketMismatchRefuses()
    {
        var ok = RepairEnvelopeBuilder.TryBuild(
            RunJson(), CleanTempRecipeJson(), InstallationId, "other-ticket",
            out _, out var error);

        Assert.False(ok);
        Assert.Equal("ticket_mismatch", error);
    }

    [Fact]
    public void RecipeVersionMismatchRefuses()
    {
        var run = RunJson().Replace("\"recipeVersion\":1", "\"recipeVersion\":2");
        var ok = RepairEnvelopeBuilder.TryBuild(
            run, CleanTempRecipeJson(), InstallationId, TicketId,
            out _, out var error);

        Assert.False(ok);
        Assert.Equal("recipe_mismatch", error);
    }

    [Fact]
    public void TamperedRecipeBytesRefuse()
    {
        var recipe = CleanTempRecipeJson().Replace("\"maxAgeDays\":7", "\"maxAgeDays\":1");
        var ok = RepairEnvelopeBuilder.TryBuild(
            RunJson(), recipe, InstallationId, TicketId,
            out _, out var error);

        Assert.False(ok);
        Assert.Equal("recipe_hash_mismatch", error);
    }

    [Fact]
    public void NonWindowsPlatformRefuses()
    {
        var recipe = CleanTempRecipeJson().Replace("[\"windows\"]", "[\"linux\"]");
        var ok = RepairEnvelopeBuilder.TryBuild(
            RunJson(), recipe, InstallationId, TicketId,
            out _, out var error);

        Assert.False(ok);
        Assert.Equal("incompatible_platform", error);
    }

    [Fact]
    public void MalformedPreconditionsRefuse()
    {
        var recipe = CleanTempRecipeJson().Replace("{\"check\":\"dry_run_first\"}", "{\"nonsense\":true}");
        var ok = RepairEnvelopeBuilder.TryBuild(
            RunJson(), recipe, InstallationId, TicketId,
            out _, out var error);

        Assert.False(ok);
        Assert.Equal("preconditions_malformed", error);
    }

    [Fact]
    public void MalformedInputsRefuse()
    {
        Assert.False(RepairEnvelopeBuilder.TryBuild(
            "not json", CleanTempRecipeJson(), InstallationId, TicketId, out _, out var runError));
        Assert.Equal("run_malformed", runError);

        Assert.False(RepairEnvelopeBuilder.TryBuild(
            RunJson(), "[1,2]", InstallationId, TicketId, out _, out var recipeError));
        Assert.Equal("recipe_malformed", recipeError);

        Assert.False(RepairEnvelopeBuilder.TryBuild(
            null, null, InstallationId, TicketId, out _, out var nullError));
        Assert.Equal("run_malformed", nullError);
    }
}
