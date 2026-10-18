using System.Text.Json;

namespace Biza.SupportCompanion.Core;

/// <summary>
/// Issue #984 — translates a server repair run + catalog recipe into the
/// executor's <see cref="RepairRunEnvelope"/>. The App fetches both halves
/// from <c>GET /api/support-companion/repairs/:runId</c>; this builder is
/// the seam that refuses anything the executor must never see: runs that
/// are not <c>authorized</c>, installation/ticket/run↔recipe mismatches,
/// non-Windows recipes, malformed check lists, and recipe bytes whose
/// canonical hash no longer matches the pinned <c>recipeHash</c> (the
/// executor re-verifies on the way in — this is the fail-fast twin that
/// keeps junk out of the journal).
///
/// Both inputs are the route's camelCase JSON. Strict on purpose: the
/// contract is ours on both ends, so drift must fail loudly, not coerce.
/// </summary>
public static class RepairEnvelopeBuilder
{
    public static bool TryBuild(
        string? runJson,
        string? recipeJson,
        string expectedInstallationId,
        string expectedTicketId,
        out string envelopeJson,
        out string error)
    {
        envelopeJson = string.Empty;
        error = string.Empty;

        JsonDocument run;
        JsonDocument recipe;
        try
        {
            run = JsonDocument.Parse(runJson ?? string.Empty);
        }
        catch (Exception ex) when (ex is JsonException || ex is ArgumentException)
        {
            error = "run_malformed";
            return false;
        }

        using (run)
        {
            try
            {
                recipe = JsonDocument.Parse(recipeJson ?? string.Empty);
            }
            catch (Exception ex) when (ex is JsonException || ex is ArgumentException)
            {
                error = "recipe_malformed";
                return false;
            }

            using (recipe)
            {
                return TryBuild(run.RootElement, recipe.RootElement,
                    expectedInstallationId, expectedTicketId, out envelopeJson, out error);
            }
        }
    }

    private static bool TryBuild(
        JsonElement run,
        JsonElement recipe,
        string expectedInstallationId,
        string expectedTicketId,
        out string envelopeJson,
        out string error)
    {
        envelopeJson = string.Empty;
        error = string.Empty;

        if (run.ValueKind != JsonValueKind.Object)
        {
            error = "run_malformed";
            return false;
        }

        if (recipe.ValueKind != JsonValueKind.Object)
        {
            error = "recipe_malformed";
            return false;
        }

        var runId = GetString(run, "id");
        var runState = GetString(run, "state");
        var runRecipeId = GetString(run, "recipeId");
        var runTicketId = GetString(run, "ticketId");
        var runInstallationId = GetString(run, "installationId");
        if (runId is null || runState is null || runRecipeId is null ||
            runTicketId is null || runInstallationId is null ||
            !run.TryGetProperty("recipeVersion", out var runVersionProp) ||
            runVersionProp.ValueKind != JsonValueKind.Number ||
            !runVersionProp.TryGetInt32(out var runVersion))
        {
            error = "run_malformed";
            return false;
        }

        if (!string.Equals(runState, "authorized", StringComparison.Ordinal))
        {
            error = $"run_not_authorized:{runState}";
            return false;
        }

        if (!string.Equals(runInstallationId, expectedInstallationId, StringComparison.Ordinal))
        {
            error = "installation_mismatch";
            return false;
        }

        if (!string.Equals(runTicketId, expectedTicketId, StringComparison.Ordinal))
        {
            error = "ticket_mismatch";
            return false;
        }

        var recipeId = GetString(recipe, "recipeId");
        var risk = GetString(recipe, "risk");
        var backupPolicy = GetString(recipe, "backupPolicy");
        var recipeHash = GetString(recipe, "recipeHash");
        if (recipeId is null || risk is null || backupPolicy is null || recipeHash is null ||
            !recipe.TryGetProperty("version", out var versionProp) ||
            versionProp.ValueKind != JsonValueKind.Number ||
            !versionProp.TryGetInt32(out var version) ||
            !recipe.TryGetProperty("recipe", out var recipeDef) ||
            recipeDef.ValueKind != JsonValueKind.Object)
        {
            error = "recipe_malformed";
            return false;
        }

        if (!string.Equals(recipeId, runRecipeId, StringComparison.Ordinal) || version != runVersion)
        {
            error = "recipe_mismatch";
            return false;
        }

        if (!PlatformIncludesWindows(recipe))
        {
            error = "incompatible_platform";
            return false;
        }

        var recipeDefJson = recipeDef.GetRawText();
        var actualHash = CanonicalJson.TryHashRecipe(recipeDefJson);
        if (actualHash is null ||
            !string.Equals(actualHash, recipeHash, StringComparison.OrdinalIgnoreCase))
        {
            error = "recipe_hash_mismatch";
            return false;
        }

        if (!TryReadChecks(recipe, "preconditions", out var preconditionsJson, out _))
        {
            error = "preconditions_malformed";
            return false;
        }

        if (!TryReadChecks(recipe, "postchecks", out var postchecksJson, out _))
        {
            error = "postchecks_malformed";
            return false;
        }

        envelopeJson =
            "{\"runId\":" + JsonSerializer.Serialize(runId) +
            ",\"recipeId\":" + JsonSerializer.Serialize(recipeId) +
            ",\"recipeVersion\":" + version.ToString() +
            ",\"recipeHash\":" + JsonSerializer.Serialize(recipeHash) +
            ",\"risk\":" + JsonSerializer.Serialize(risk) +
            ",\"backupPolicy\":" + JsonSerializer.Serialize(backupPolicy) +
            ",\"recipe\":" + recipeDefJson +
            ",\"preconditions\":" + preconditionsJson +
            ",\"postchecks\":" + postchecksJson +
            "}";

        // The builder's output must always be executor-parseable; a failure
        // here is a builder bug, reported as one (never thrown to the shell).
        if (!RepairRunEnvelope.TryParse(envelopeJson, out _, out var parseError))
        {
            envelopeJson = string.Empty;
            error = "builder_output_rejected:" + parseError;
            return false;
        }

        return true;
    }

    private static string? GetString(JsonElement parent, string name)
    {
        if (!parent.TryGetProperty(name, out var prop) || prop.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        var value = prop.GetString();
        return string.IsNullOrEmpty(value) ? null : value;
    }

    private static bool PlatformIncludesWindows(JsonElement recipe)
    {
        if (!recipe.TryGetProperty("compatibility", out var compat) ||
            compat.ValueKind != JsonValueKind.Object ||
            !compat.TryGetProperty("platform", out var platforms) ||
            platforms.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        foreach (var platform in platforms.EnumerateArray())
        {
            if (platform.ValueKind == JsonValueKind.String &&
                string.Equals(platform.GetString(), "windows", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Reads a check list, tolerating absence (→ <c>[]</c>) but never
    /// malformed entries. Emits canonical check JSON for the envelope.
    /// </summary>
    private static bool TryReadChecks(
        JsonElement recipe, string name, out string checksJson, out string error)
    {
        checksJson = "[]";
        error = string.Empty;
        if (!recipe.TryGetProperty(name, out var arr))
        {
            return true;
        }

        if (arr.ValueKind != JsonValueKind.Array)
        {
            error = "not an array";
            return false;
        }

        var parts = new List<string>();
        foreach (var item in arr.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object ||
                !item.TryGetProperty("check", out var check) ||
                check.ValueKind != JsonValueKind.String ||
                string.IsNullOrEmpty(check.GetString()))
            {
                error = "entry malformed";
                return false;
            }

            string? detail = null;
            if (item.TryGetProperty("detail", out var detailProp) &&
                detailProp.ValueKind == JsonValueKind.String)
            {
                detail = detailProp.GetString();
            }

            parts.Add(
                "{\"check\":" + JsonSerializer.Serialize(check.GetString() ?? string.Empty) +
                (detail is null ? string.Empty : ",\"detail\":" + JsonSerializer.Serialize(detail)) +
                "}");
        }

        checksJson = "[" + string.Join(",", parts) + "]";
        return true;
    }
}
