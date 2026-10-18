using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Biza.SupportCompanion.App;

/// <summary>An HTTP-level API failure: status plus the server's error name.</summary>
public sealed class CompanionApiException : Exception
{
    public HttpStatusCode StatusCode { get; }
    public string Error { get; }

    public CompanionApiException(HttpStatusCode statusCode, string error)
        : base($"Companion API {(int)statusCode} {statusCode}: {error}")
    {
        StatusCode = statusCode;
        Error = error;
    }
}

// ── DTOs: the server's camelCase JSON, case-insensitive on the way in.
// Nullable throughout: the client reports contract drift as errors instead
// of throwing deserialization exceptions mid-flow. ──────────────────────────

public sealed record CompanionSessionDto(
    string? TokenId,
    string? TicketId,
    string? BusinessId,
    string? InstallationId,
    int InstallationGeneration,
    string? OperatorAdminId,
    string[]? Scope,
    string? SessionJwt,
    string? ExpiresAt);

public sealed record PollInstallationDto(string? Id, int Generation, string? DisplayName);

public sealed record PollScopeDto(
    string? BusinessId, string? LocationId, string? DisplayName, string? MainVersion, string? CompanionVersion);

public sealed record PollRequestDto(
    string? Id,
    string? TicketId,
    int InstallationGeneration,
    string? InitiatedBy,
    string[]? Modules,
    string[]? AllowedOperations,
    string? ExpiresAt,
    string? State,
    PollScopeDto? Scope,
    string? CreatedAt);

public sealed record PollAssistanceDto(
    string? Id, string? TicketId, string[]? RequestedCaps, string? State, string? CreatedAt);

public sealed record PollResponseDto(
    PollInstallationDto? Installation,
    bool Live,
    PollRequestDto[]? Requests,
    PollAssistanceDto[]? Assistance,
    string? OfflineKeys,
    string? MeshNodeId);

public sealed record RepairRunBundle(JsonObject Run, JsonObject Recipe);

/// <summary>
/// Issue #984 — typed HTTP client for <c>/api/support-companion/*</c>.
/// Device calls carry the DPAPI-sealed installation credential, session
/// calls the ticket-bound session JWT; both travel as Bearer. Origins are
/// https, or http only for loopback (on-machine dev backend).
/// </summary>
public sealed class CompanionClient : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    private readonly HttpClient _http;
    private readonly string _origin;

    public string Origin => _origin;

    public CompanionClient(string serverOrigin, HttpMessageHandler? handler = null)
    {
        _origin = NormalizeOrigin(serverOrigin);
        _http = handler is null ? new HttpClient() : new HttpClient(handler);
        _http.Timeout = TimeSpan.FromSeconds(30);
        _http.DefaultRequestHeaders.UserAgent.ParseAdd(
            "BizaSupportCompanion/" + CompanionSettings.CompanionVersion());
    }

    public void Dispose() => _http.Dispose();

    public static string NormalizeOrigin(string? serverOrigin)
    {
        if (!Uri.TryCreate((serverOrigin ?? string.Empty).Trim(), UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            throw new ArgumentException("Server URL must be an absolute http(s) URL.", nameof(serverOrigin));
        }

        if (uri.Scheme == Uri.UriSchemeHttp && !uri.IsLoopback)
        {
            throw new ArgumentException("Plain http is only allowed for loopback dev backends.", nameof(serverOrigin));
        }

        return uri.GetLeftPart(UriPartial.Authority);
    }

    // ── Enrollment ──────────────────────────────────────────────────────────

    public async Task<string> CompleteEnrollmentAsync(
        string enrollmentId, string claimCode, string credential,
        string? displayName, string? osBuild, string? companionVersion,
        CancellationToken ct)
    {
        var body = new Dictionary<string, object?>
        {
            ["action"] = "complete",
            ["enrollmentId"] = enrollmentId,
            ["claimCode"] = claimCode,
            ["credential"] = credential,
            ["installation"] = new Dictionary<string, object?>
            {
                ["displayName"] = string.IsNullOrWhiteSpace(displayName) ? null : displayName.Trim(),
                ["osBuild"] = string.IsNullOrWhiteSpace(osBuild) ? null : osBuild.Trim(),
                ["companionVersion"] = string.IsNullOrWhiteSpace(companionVersion) ? null : companionVersion.Trim(),
            },
        };
        var json = await PostAsync("/api/support-companion/enrollment", body, null, ct).ConfigureAwait(false);
        return RequiredString(json, "installationId");
    }

    public async Task RotateCredentialAsync(string deviceBearer, string newCredential, CancellationToken ct)
    {
        var body = new Dictionary<string, object?>
        {
            ["action"] = "rotate",
            ["credential"] = newCredential,
        };
        await PostAsync("/api/support-companion/enrollment", body, deviceBearer, ct).ConfigureAwait(false);
    }

    public async Task ConfirmRotationAsync(string newBearer, CancellationToken ct)
    {
        var body = new Dictionary<string, object?> { ["action"] = "confirm-rotation" };
        await PostAsync("/api/support-companion/enrollment", body, newBearer, ct).ConfigureAwait(false);
    }

    // ── Authorization ───────────────────────────────────────────────────────

    public async Task<CompanionSessionDto> RedeemOnlineCodeAsync(
        string code, string? technicianBindingHash, CancellationToken ct)
    {
        var body = new Dictionary<string, object?>
        {
            ["mode"] = "online_code",
            ["code"] = code,
            ["technicianBindingHash"] = technicianBindingHash,
        };
        var json = await PostAsync("/api/support-companion/token-redeem", body, null, ct).ConfigureAwait(false);
        return RequiredChild<CompanionSessionDto>(json, "session");
    }

    public async Task<CompanionSessionDto> RedeemOfflineTokenAsync(
        string token, string technicianBindingHash, string challenge, CancellationToken ct)
    {
        var body = new Dictionary<string, object?>
        {
            ["mode"] = "offline",
            ["token"] = token,
            ["technicianBindingHash"] = technicianBindingHash,
            ["challenge"] = challenge,
        };
        var json = await PostAsync("/api/support-companion/token-redeem", body, null, ct).ConfigureAwait(false);
        return RequiredChild<CompanionSessionDto>(json, "session");
    }

    // ── Poll ────────────────────────────────────────────────────────────────

    public async Task<PollResponseDto> PollAsync(
        string deviceBearer, string? meshNodeId, bool meshAgentPresent, CancellationToken ct)
    {
        var query = new StringBuilder("/api/support-companion/requests?meshAgentPresent=");
        query.Append(meshAgentPresent ? "true" : "false");
        if (!string.IsNullOrWhiteSpace(meshNodeId))
        {
            query.Append("&meshNodeId=").Append(Uri.EscapeDataString(meshNodeId.Trim()));
        }

        var json = await GetAsync(query.ToString(), deviceBearer, ct).ConfigureAwait(false);
        var poll = json.Deserialize<PollResponseDto>(JsonOptions);
        if (poll is null || poll.Installation?.Id is null)
        {
            throw new InvalidOperationException("Server poll response is missing the installation.");
        }

        return poll;
    }

    // ── Diagnostic runs ─────────────────────────────────────────────────────

    public async Task<(JsonObject Run, JsonObject Redaction)> UploadRunAsync(
        string sessionJwt, JsonObject body, CancellationToken ct)
    {
        var json = await PostAsync("/api/support-companion/runs", body, sessionJwt, ct).ConfigureAwait(false);
        return (RequiredObject(json, "run"), RequiredObject(json, "redaction"));
    }

    // ── Repairs ─────────────────────────────────────────────────────────────

    public async Task<RepairRunBundle> GetRepairRunAsync(string sessionJwt, string runId, CancellationToken ct)
    {
        var json = await GetAsync(
            "/api/support-companion/repairs/" + Uri.EscapeDataString(runId), sessionJwt, ct).ConfigureAwait(false);
        return new RepairRunBundle(RequiredObject(json, "run"), RequiredObject(json, "recipe"));
    }

    public async Task<JsonObject> TransitionRepairAsync(
        string sessionJwt, string runId, string state, Dictionary<string, object?> extras, CancellationToken ct)
    {
        var body = new Dictionary<string, object?>(extras)
        {
            ["runId"] = runId,
            ["state"] = state,
        };
        var json = await PostAsync("/api/support-companion/repairs", body, sessionJwt, ct).ConfigureAwait(false);
        return RequiredObject(json, "run");
    }

    // ── Consent & assistance ────────────────────────────────────────────────

    public async Task<JsonObject> RecordConsentAsync(
        string bearer, string? ticketId, string subject, string decision,
        JsonObject? scope, int? expiresInMinutes, CancellationToken ct)
    {
        var body = new Dictionary<string, object?>
        {
            ["ticketId"] = ticketId,
            ["subject"] = subject,
            ["decision"] = decision,
            ["scope"] = scope,
            ["expiresInMinutes"] = expiresInMinutes,
        };
        var json = await PostAsync("/api/support-companion/consent", body, bearer, ct).ConfigureAwait(false);
        return RequiredObject(json, "event");
    }

    public async Task<JsonObject> AssistanceAsync(
        string bearer, string action, string sessionId,
        bool? approved, string[]? approvedCaps, JsonObject? proof, CancellationToken ct)
    {
        var body = new Dictionary<string, object?>
        {
            ["action"] = action,
            ["sessionId"] = sessionId,
            ["approved"] = approved,
            ["approvedCaps"] = approvedCaps,
            ["proof"] = proof,
        };
        var json = await PostAsync("/api/support-companion/assistance", body, bearer, ct).ConfigureAwait(false);
        return RequiredObject(json, "session");
    }

    // ── Artifacts ───────────────────────────────────────────────────────────

    public async Task<JsonObject> BeginArtifactAsync(
        string sessionJwt, string runId, string name, string sha256,
        long sizeBytes, int chunkCount, string? kind, string? mimeType, CancellationToken ct)
    {
        var body = new Dictionary<string, object?>
        {
            ["runId"] = runId,
            ["name"] = name,
            ["kind"] = kind,
            ["mimeType"] = mimeType,
            ["sha256"] = sha256,
            ["sizeBytes"] = sizeBytes,
            ["chunkCount"] = chunkCount,
        };
        var json = await PostAsync("/api/support-companion/artifacts", body, sessionJwt, ct).ConfigureAwait(false);
        return RequiredObject(json, "artifact");
    }

    public async Task UploadChunkAsync(
        string sessionJwt, string artifactId, int chunkIndex, string base64Data, CancellationToken ct)
    {
        var body = new Dictionary<string, object?>
        {
            ["chunkIndex"] = chunkIndex,
            ["data"] = base64Data,
        };
        await PutAsync("/api/support-companion/artifacts/" + Uri.EscapeDataString(artifactId) + "/chunks",
            body, sessionJwt, ct).ConfigureAwait(false);
    }

    public async Task<JsonObject> CompleteArtifactAsync(string sessionJwt, string artifactId, CancellationToken ct)
    {
        var json = await PostAsync(
            "/api/support-companion/artifacts/" + Uri.EscapeDataString(artifactId) + "/complete",
            new Dictionary<string, object?>(), sessionJwt, ct).ConfigureAwait(false);
        return RequiredObject(json, "artifact");
    }

    // ── Update manifests (signed; transport is untrusted) ───────────────────

    // Update payloads need a far longer timeout than API calls, and raising
    // the shared client's Timeout mid-flight would race other calls — so
    // downloads get their own client. Bytes are untrusted until the stager
    // re-hashes them against the verified manifest.
    private static readonly HttpClient _downloads = new() { Timeout = TimeSpan.FromMinutes(10) };

    public async Task<byte[]> GetUpdateFileBytesAsync(string fileUrl, long maxBytes, CancellationToken ct)
    {
        if (!Uri.TryCreate((fileUrl ?? string.Empty).Trim(), UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            throw new ArgumentException("Update file URL must be an absolute http(s) URL.", nameof(fileUrl));
        }

        using var res = await _downloads.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
        {
            throw new CompanionApiException(res.StatusCode, "update_file_unavailable");
        }

        if (res.Content.Headers.ContentLength is long declared && declared > maxBytes)
        {
            throw new IOException($"Update file exceeds the {maxBytes}-byte cap (declared {declared}).");
        }

        using var stream = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var sink = new MemoryStream();
        var buffer = new byte[81920];
        long total = 0;
        int read;
        while ((read = await stream.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
        {
            total += read;
            if (total > maxBytes)
            {
                throw new IOException($"Update file exceeds the {maxBytes}-byte cap.");
            }

            sink.Write(buffer, 0, read);
        }

        return sink.ToArray();
    }


    public async Task<string> GetManifestAsync(string manifestUrl, CancellationToken ct)
    {
        if (!Uri.TryCreate((manifestUrl ?? string.Empty).Trim(), UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            throw new ArgumentException("Manifest URL must be an absolute http(s) URL.", nameof(manifestUrl));
        }

        using var res = await _http.GetAsync(uri, ct).ConfigureAwait(false);
        var text = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
        {
            throw new CompanionApiException(res.StatusCode, "manifest_unavailable");
        }

        return text;
    }

    // ── Transport ───────────────────────────────────────────────────────────

    private async Task<JsonObject> GetAsync(string path, string? bearer, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, _origin + path);
        SetBearer(req, bearer);
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        return await ReadEnvelopeAsync(res, ct).ConfigureAwait(false);
    }

    private async Task<JsonObject> PostAsync(string path, object body, string? bearer, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, _origin + path);
        SetBearer(req, bearer);
        req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        return await ReadEnvelopeAsync(res, ct).ConfigureAwait(false);
    }

    private async Task<JsonObject> PutAsync(string path, object body, string? bearer, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Put, _origin + path);
        SetBearer(req, bearer);
        req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        return await ReadEnvelopeAsync(res, ct).ConfigureAwait(false);
    }

    private static void SetBearer(HttpRequestMessage req, string? bearer)
    {
        if (!string.IsNullOrEmpty(bearer))
        {
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        }
    }

    private static async Task<JsonObject> ReadEnvelopeAsync(HttpResponseMessage res, CancellationToken ct)
    {
        // Transport failures (HttpRequestException) and cancellation
        // (OperationCanceledException) propagate untouched so the shell can
        // tell "server unreachable" and "cancelled" apart from API errors.
        var text = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        JsonNode? node;
        try
        {
            node = JsonNode.Parse(text);
        }
        catch (JsonException)
        {
            node = null;
        }

        if (!res.IsSuccessStatusCode)
        {
            var error = "request_failed";
            if (node is JsonObject obj &&
                obj.TryGetPropertyValue("error", out var errNode) &&
                errNode is JsonValue errValue &&
                errValue.TryGetValue<string>(out var errText) &&
                !string.IsNullOrWhiteSpace(errText))
            {
                error = errText;
            }

            throw new CompanionApiException(res.StatusCode, error);
        }

        if (node is not JsonObject ok)
        {
            throw new CompanionApiException(res.StatusCode, "invalid_response");
        }

        return ok;
    }

    private static string RequiredString(JsonObject json, string name)
    {
        if (json.TryGetPropertyValue(name, out var node) &&
            node is JsonValue value &&
            value.TryGetValue<string>(out var text) &&
            !string.IsNullOrWhiteSpace(text))
        {
            return text;
        }

        throw new InvalidOperationException($"Server response is missing '{name}'.");
    }

    private static JsonObject RequiredObject(JsonObject json, string name)
    {
        if (json.TryGetPropertyValue(name, out var node) && node is JsonObject obj)
        {
            return obj;
        }

        throw new InvalidOperationException($"Server response is missing '{name}'.");
    }

    private static T RequiredChild<T>(JsonObject json, string name)
        where T : class
    {
        var child = RequiredObject(json, name);
        var dto = child.Deserialize<T>(JsonOptions);
        if (dto is null)
        {
            throw new InvalidOperationException($"Server response has an unreadable '{name}'.");
        }

        return dto;
    }
}
