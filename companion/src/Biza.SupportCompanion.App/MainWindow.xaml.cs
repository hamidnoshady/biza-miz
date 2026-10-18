using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;
using Biza.SupportCompanion.Core;
using Microsoft.Win32;

namespace Biza.SupportCompanion.App;

/// <summary>
/// Issue #984 — the companion shell. Thin by design: every decision the
/// operator sees is made by the Core library (diagnostics catalog, offline
/// verifier, repair executor, update verifier) or the server; this window
/// collects inputs, shows states honestly, and never fabricates success.
/// Secrets (claim codes, tokens, credentials, JWTs) are never logged.
/// </summary>
public partial class MainWindow : Window
{
    private readonly CompanionSettings _settings = new();
    private readonly ExecutorRoots _roots;
    private readonly List<string> _pendingLinks = new();
    private readonly List<PollAssistanceDto> _assistanceItems = new();

    private CompanionClient? _client;
    private string? _clientOrigin;
    private string? _deviceBearer;
    private CompanionSessionDto? _session;
    private PollResponseDto? _poll;
    private IReadOnlyList<Finding>? _findings;
    private List<string>? _findingModules;
    private RepairRunEnvelope? _envelope;
    private DryRunPlan? _plan;
    private CancellationTokenSource? _diagCts;
    private CancellationTokenSource? _repairCts;
    private DispatcherTimer? _leaseTimer;
    private string? _leaseSessionId;
    private bool _leaseRenewing;
    private OfflineTokenClaims? _verifiedOffline;
    private string? _verifiedOfflineToken;
    private string? _pendingChallenge;
    private string? _ticketHint;
    private bool _loaded;

    public MainWindow()
    {
        InitializeComponent();
        _settings.Load();
        _roots = new ExecutorRoots(
            _settings.DataDir,
            Path.Combine(_settings.DataDir, "temp"),
            Path.Combine(_settings.DataDir, "logs"),
            Path.Combine(_settings.DataDir, "journal"),
            _settings.ReportsDir,
            _settings.StagingDir);
        Loaded += MainWindow_Loaded;
        Closing += (_, _) =>
        {
            try
            {
                _leaseTimer?.Stop();
            }
            catch (Exception)
            {
            }

            try
            {
                _diagCts?.Cancel();
            }
            catch (Exception)
            {
            }

            try
            {
                _repairCts?.Cancel();
            }
            catch (Exception)
            {
            }
        };
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        _loaded = true;
        try
        {
            _settings.EnsureDataDirs();
            Directory.CreateDirectory(_roots.TempDir);
            Directory.CreateDirectory(_roots.LogDir);
            Directory.CreateDirectory(_roots.JournalDir);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
            SettingsStatusText.Text = $"Data dir not writable ({ex.GetType().Name}): run the installer or set BIZA_COMPANION_DATA.";
        }

        EnrollServerUrlBox.Text = _settings.ServerUrl;
        EnrollNameBox.Text = _settings.DisplayName.Length > 0 ? _settings.DisplayName : Environment.MachineName;
        SettingsServerUrlBox.Text = _settings.ServerUrl;
        SettingsManifestUrlBox.Text = _settings.ManifestUrl;
        SettingsChannelBox.Text = _settings.Channel;
        SettingsDisplayNameBox.Text = EnrollNameBox.Text;
        ManifestUrlBox.Text = _settings.ManifestUrl;
        DataDirText.Text = "Data dir: " + _settings.DataDir;
        CurrentVersionText.Text = "Current version: " + CompanionSettings.CompanionVersion();
        if (_settings.Notice.Length > 0)
        {
            SettingsStatusText.Text = _settings.Notice;
        }

        RefreshStatusTexts();

        var mesh = await Task.Run(() => MeshAgent.Probe()).ConfigureAwait(true);
        MeshStatusText.Text = "MeshCentral agent: " + mesh.Note;

        DrainPendingLinks();
    }

    /// <summary>Protocol activations land here, including before load.</summary>
    public void HandleDeepLink(string url)
    {
        if (!_loaded)
        {
            _pendingLinks.Add(url);
            return;
        }

        if (SupportProtocol.TryParseEnrollLink(url, out var server, out var enrollmentId, out var claim))
        {
            string origin;
            try
            {
                origin = CompanionClient.NormalizeOrigin(server);
            }
            catch (ArgumentException)
            {
                EnrollStatusText.Text = "Link rejected: it names an invalid server URL.";
                MainTabs.SelectedIndex = 1;
                return;
            }

            EnrollServerUrlBox.Text = origin;
            EnrollIdBox.Text = enrollmentId ?? string.Empty;
            EnrollClaimBox.Text = claim ?? string.Empty;
            EnrollStatusText.Text = "Enrollment details filled from the link. Press “Complete enrollment”.";
            MainTabs.SelectedIndex = 1;
            return;
        }

        if (SupportProtocol.TryParseTicketLink(url, out var ticketId))
        {
            if (ticketId is not null)
            {
                _ticketHint = ticketId;
                PollStatusText.Text = $"Opened for ticket {ticketId}: polling pre-selects its requests.";
                MainTabs.SelectedIndex = 0;
            }

            return;
        }

        EnrollStatusText.Text = "Link rejected: not a support link.";
        MainTabs.SelectedIndex = 1;
    }

    private void DrainPendingLinks()
    {
        foreach (var url in _pendingLinks)
        {
            HandleDeepLink(url);
        }

        _pendingLinks.Clear();
    }

    // ── Shared helpers ──────────────────────────────────────────────────────

    private void RefreshStatusTexts()
    {
        ServerStateText.Text = "Server: " +
            (_settings.ServerUrl.Length > 0 ? _settings.ServerUrl : "not configured");
        EnrollmentStateText.Text = "Enrollment: " +
            (_settings.HasDeviceCredential()
                ? "enrolled" + (_settings.InstallationId.Length > 0 ? $" ({_settings.InstallationId})" : string.Empty)
                : "not enrolled on this machine");
        InstallationStateText.Text = "Installation: " +
            (_poll?.Installation is not null
                ? $"{_poll.Installation.DisplayName ?? _poll.Installation.Id} (generation {_poll.Installation.Generation}, live={(_poll.Live ? "yes" : "no")})"
                : "unknown — poll first");
        SessionStateText.Text = "Session: " + DescribeSession(_session);
        SessionInfoText.Text = DescribeSession(_session);
    }

    private static string DescribeSession(CompanionSessionDto? session)
    {
        if (session?.SessionJwt is null || session.TicketId is null)
        {
            return "No session.";
        }

        var scope = session.Scope is not null ? string.Join(", ", session.Scope) : "(no scope)";
        return $"Ticket {session.TicketId}, scope [{scope}], expires {session.ExpiresAt ?? "unknown"}.";
    }

    private bool EnsureClient(out CompanionClient client, out string error)
    {
        error = string.Empty;
        if (_settings.ServerUrl.Length == 0)
        {
            error = "Server URL is not configured (Settings tab).";
            client = null!;
            return false;
        }

        if (_client is not null && _clientOrigin == _settings.ServerUrl)
        {
            client = _client;
            return true;
        }

        try
        {
            _client?.Dispose();
            _client = new CompanionClient(_settings.ServerUrl);
            _clientOrigin = _settings.ServerUrl;
            client = _client;
            return true;
        }
        catch (ArgumentException ex)
        {
            error = ex.Message;
            client = null!;
            return false;
        }
    }

    private bool EnsureDeviceBearer(out string bearer, out string error)
    {
        error = string.Empty;
        bearer = string.Empty;
        if (_deviceBearer is not null)
        {
            bearer = _deviceBearer;
            return true;
        }

        if (_settings.TryLoadDeviceCredential(out var stored, out var loadError))
        {
            _deviceBearer = stored;
            bearer = stored;
            return true;
        }

        error = loadError;
        return false;
    }

    private bool EnsureSession(out CompanionSessionDto session, out string error)
    {
        error = string.Empty;
        if (_session?.SessionJwt is not null && _session.TicketId is not null)
        {
            session = _session;
            return true;
        }

        error = "No session — redeem a code or token on the Authorize tab first.";
        session = null!;
        return false;
    }

    private void Log(string message)
    {
        try
        {
            var line = $"{DateTimeOffset.UtcNow:O} {message}{Environment.NewLine}";
            File.AppendAllText(
                Path.Combine(_roots.LogDir, $"companion-{DateTimeOffset.UtcNow:yyyyMMdd}.log"),
                line,
                Encoding.UTF8);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
        }
    }

    private static string Friendly(Exception ex) => ex switch
    {
        CompanionApiException api => $"Server: {api.Error} (HTTP {(int)api.StatusCode}).",
        HttpRequestException http => "Server unreachable: " + http.Message,
        OperationCanceledException => "Cancelled.",
        _ => ex.Message,
    };

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static string NodeString(JsonObject obj, string name)
    {
        if (obj.TryGetPropertyValue(name, out var node) &&
            node is JsonValue value &&
            value.TryGetValue<string>(out var text) &&
            text is not null)
        {
            return text;
        }

        return string.Empty;
    }

    private static JsonNode? ParseOrNull(string json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            return JsonNode.Parse(json);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string Truncate(string text, int max)
    {
        if (text.Length <= max)
        {
            return text;
        }

        return text.Substring(0, max) + "…";
    }

    private void RepairLog(string message)
    {
        RepairLogList.Items.Add($"{DateTimeOffset.Now:HH:mm:ss} {message}");
        RepairLogList.ScrollIntoView(RepairLogList.Items[RepairLogList.Items.Count - 1]);
    }

    private static bool MaintenanceGateWritable(out string gatePath)
    {
        gatePath = MaintenanceLock.DefaultLockPath();
        var dir = Path.GetDirectoryName(gatePath);
        if (string.IsNullOrEmpty(dir))
        {
            return false;
        }

        try
        {
            Directory.CreateDirectory(dir);
            var probe = Path.Combine(dir, $"companion-gate-probe-{Guid.NewGuid():N}.tmp");
            File.WriteAllText(probe, "probe");
            File.Delete(probe);
            return true;
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
            return false;
        }
    }

    // ── Status / poll ───────────────────────────────────────────────────────

    private async void PollButton_Click(object sender, RoutedEventArgs e)
    {
        PollStatusText.Text = string.Empty;
        if (!EnsureClient(out var client, out var clientError))
        {
            PollStatusText.Text = clientError;
            return;
        }

        if (!EnsureDeviceBearer(out var bearer, out var bearerError))
        {
            PollStatusText.Text = bearerError + " (Enrollment tab).";
            return;
        }

        PollButton.IsEnabled = false;
        try
        {
            var mesh = await Task.Run(() => MeshAgent.Probe()).ConfigureAwait(true);
            MeshStatusText.Text = "MeshCentral agent: " + mesh.Note;

            var poll = await client.PollAsync(bearer, null, mesh.ProcessRunning, CancellationToken.None).ConfigureAwait(true);
            _poll = poll;
            if (poll.OfflineKeys is not null && poll.OfflineKeys.Length > 0)
            {
                _settings.SaveOfflineKeys(poll.OfflineKeys);
            }

            PollList.Items.Clear();
            _assistanceItems.Clear();
            AssistanceList.Items.Clear();
            foreach (var request in poll.Requests ?? [])
            {
                var modules = request.Modules is not null ? string.Join(",", request.Modules) : string.Empty;
                PollList.Items.Add($"diag {request.Id} ticket {request.TicketId} [{request.State}] modules:{modules}");
            }

            foreach (var session in poll.Assistance ?? [])
            {
                var caps = session.RequestedCaps is not null ? string.Join(",", session.RequestedCaps) : string.Empty;
                PollList.Items.Add($"assist {session.Id} ticket {session.TicketId} caps:{caps} [{session.State}]");
                _assistanceItems.Add(session);
                AssistanceList.Items.Add($"ticket {session.TicketId} caps:{caps} [{session.State}] id:{session.Id}");
            }

            var requests = poll.Requests ?? [];
            var hinted = _ticketHint is not null
                ? requests.FirstOrDefault(r => r.TicketId == _ticketHint && r.Id is not null)
                : null;
            var firstRequest = hinted ?? requests.FirstOrDefault(r => r.Id is not null);
            if (firstRequest?.Id is not null && UploadRequestIdBox.Text.Length == 0)
            {
                UploadRequestIdBox.Text = firstRequest.Id;
            }

            var hintNote = hinted?.Id is not null
                ? $" Ticket {_ticketHint} has an open request ({hinted.Id}); pre-selected for upload."
                : string.Empty;
            _ticketHint = null;

            PollStatusText.Text = (poll.Live
                ? $"Polled: {(poll.Requests ?? []).Length} request(s), {(poll.Assistance ?? []).Length} assistance session(s)."
                : "Polled, but the installation is not live (revoked or retired) — contact the operator.") + hintNote;
            Log($"poll ok live={poll.Live} requests={(poll.Requests ?? []).Length} assistance={(poll.Assistance ?? []).Length}");
        }
        catch (Exception ex)
        {
            PollStatusText.Text = Friendly(ex);
            Log("poll failed: " + ex.GetType().Name);
        }
        finally
        {
            RefreshStatusTexts();
            PollButton.IsEnabled = true;
        }
    }

    // ── Enrollment ──────────────────────────────────────────────────────────

    private async void EnrollButton_Click(object sender, RoutedEventArgs e)
    {
        EnrollStatusText.Text = string.Empty;
        var serverUrl = EnrollServerUrlBox.Text.Trim();
        var enrollmentId = EnrollIdBox.Text.Trim();
        var claimCode = EnrollClaimBox.Text.Trim();
        var displayName = EnrollNameBox.Text.Trim();
        if (serverUrl.Length == 0 || enrollmentId.Length == 0 || claimCode.Length == 0)
        {
            EnrollStatusText.Text = "Server URL, enrollment id, and claim code are all required.";
            return;
        }

        string origin;
        try
        {
            origin = CompanionClient.NormalizeOrigin(serverUrl);
        }
        catch (ArgumentException ex)
        {
            EnrollStatusText.Text = ex.Message;
            return;
        }

        EnrollButton.IsEnabled = false;
        try
        {
            using var client = new CompanionClient(origin);
            var credential = Base64Url(RandomNumberGenerator.GetBytes(32));
            var installationId = await client.CompleteEnrollmentAsync(
                enrollmentId, claimCode, credential,
                displayName.Length > 0 ? displayName : Environment.MachineName,
                Environment.OSVersion.VersionString,
                CompanionSettings.CompanionVersion(),
                CancellationToken.None).ConfigureAwait(true);

            _settings.ServerUrl = origin;
            _settings.InstallationId = installationId;
            _settings.DisplayName = displayName;
            _settings.SaveDeviceCredential(credential);
            _settings.Save();
            _deviceBearer = credential;
            _clientOrigin = null;

            SettingsServerUrlBox.Text = origin;
            SettingsDisplayNameBox.Text = displayName;
            EnrollClaimBox.Text = string.Empty;
            EnrollStatusText.Text = $"Enrolled as installation {installationId}. The claim code is consumed; poll on the Status tab.";
            Log($"enrolled installation={installationId}");
        }
        catch (Exception ex)
        {
            EnrollStatusText.Text = Friendly(ex);
            Log("enroll failed: " + ex.GetType().Name);
        }
        finally
        {
            RefreshStatusTexts();
            EnrollButton.IsEnabled = true;
        }
    }

    private async void RotateButton_Click(object sender, RoutedEventArgs e)
    {
        EnrollStatusText.Text = string.Empty;
        if (!EnsureClient(out var client, out var clientError))
        {
            EnrollStatusText.Text = clientError;
            return;
        }

        if (!EnsureDeviceBearer(out var bearer, out var bearerError))
        {
            EnrollStatusText.Text = bearerError;
            return;
        }

        RotateButton.IsEnabled = false;
        try
        {
            var replacement = Base64Url(RandomNumberGenerator.GetBytes(32));
            await client.RotateCredentialAsync(bearer, replacement, CancellationToken.None).ConfigureAwait(true);
            await client.ConfirmRotationAsync(replacement, CancellationToken.None).ConfigureAwait(true);
            _settings.SaveDeviceCredential(replacement);
            _deviceBearer = replacement;
            EnrollStatusText.Text = "Credential rotated and confirmed.";
            Log("credential rotated");
        }
        catch (Exception ex)
        {
            EnrollStatusText.Text = Friendly(ex) + " If rotation staged but confirmation failed, re-enroll this machine.";
            Log("rotate failed: " + ex.GetType().Name);
        }
        finally
        {
            RotateButton.IsEnabled = true;
        }
    }

    // ── Authorization ───────────────────────────────────────────────────────

    private async void RedeemOnlineButton_Click(object sender, RoutedEventArgs e)
    {
        AuthStatusText.Text = string.Empty;
        if (!EnsureClient(out var client, out var clientError))
        {
            AuthStatusText.Text = clientError;
            return;
        }

        var code = OnlineCodeBox.Text.Trim();
        if (code.Length == 0)
        {
            AuthStatusText.Text = "Paste the ticket's code first.";
            return;
        }

        var binding = OnlineBindingBox.Text.Trim();
        RedeemOnlineButton.IsEnabled = false;
        try
        {
            var session = await client.RedeemOnlineCodeAsync(
                code, binding.Length > 0 ? binding : null, CancellationToken.None).ConfigureAwait(true);
            if (session.SessionJwt is null || session.TicketId is null)
            {
                AuthStatusText.Text = "Server returned an incomplete session.";
                return;
            }

            _session = session;
            OnlineCodeBox.Text = string.Empty;
            OnlineBindingBox.Text = string.Empty;
            AuthStatusText.Text = "Session redeemed.";
            Log($"session redeemed ticket={session.TicketId}");
        }
        catch (Exception ex)
        {
            AuthStatusText.Text = Friendly(ex);
            Log("redeem online failed: " + ex.GetType().Name);
        }
        finally
        {
            RefreshStatusTexts();
            RedeemOnlineButton.IsEnabled = true;
        }
    }

    private void NewChallengeButton_Click(object sender, RoutedEventArgs e)
    {
        _pendingChallenge = Base64Url(RandomNumberGenerator.GetBytes(16));
        OfflineChallengeBox.Text = _pendingChallenge;
        AuthStatusText.Text = "Show this challenge to the operator; the minted token must answer it.";
    }

    private void VerifyOfflineButton_Click(object sender, RoutedEventArgs e)
    {
        AuthStatusText.Text = string.Empty;
        var token = OfflineTokenBox.Text.Trim();
        if (token.Length == 0)
        {
            AuthStatusText.Text = "Paste the operator's offline token first.";
            return;
        }

        var challenge = _pendingChallenge;
        string challengeTicket = string.Empty;
        if (challenge is null && _settings.TryLoadPendingChallenge(out var savedTicket, out var savedChallenge))
        {
            challenge = savedChallenge;
            challengeTicket = savedTicket;
        }

        if (challenge is null)
        {
            AuthStatusText.Text = "Generate a challenge first — the token must answer one of ours.";
            return;
        }

        if (!_settings.TryLoadOfflineKeys(out var approvedKeys))
        {
            AuthStatusText.Text = "No offline keys cached — poll once while online so the server's keys are pinned.";
            return;
        }

        var result = OfflineTokenVerifier.Verify(
            token, approvedKeys, DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        if (!result.Ok || result.Claims is null)
        {
            AuthStatusText.Text = "Offline token rejected: " + (result.Error?.ToString() ?? "unknown");
            Log("offline verify rejected: " + result.Error?.ToString());
            return;
        }

        var claims = result.Claims;
        if (!string.Equals(claims.Challenge, challenge, StringComparison.Ordinal))
        {
            AuthStatusText.Text = "Offline token rejected: it answers a different challenge.";
            return;
        }

        if (!string.Equals(claims.InstallationId, _settings.InstallationId, StringComparison.Ordinal))
        {
            AuthStatusText.Text = "Offline token rejected: it names a different installation.";
            return;
        }

        if (challengeTicket.Length > 0 && !string.Equals(challengeTicket, claims.TicketId, StringComparison.Ordinal))
        {
            AuthStatusText.Text = "Offline token rejected: challenge was issued for another ticket.";
            return;
        }

        _verifiedOffline = claims;
        _verifiedOfflineToken = token;
        _settings.SavePendingChallenge(claims.TicketId, challenge);
        var scope = string.Join(", ", claims.Scope);
        var expires = DateTimeOffset.FromUnixTimeSeconds(claims.ExpiresAt).ToLocalTime();
        AuthStatusText.Text =
            $"Offline token valid (key {result.Kid}): ticket {claims.TicketId}, scope [{scope}], expires {expires}. " +
            "Redeem it while online, or run diagnostics offline and upload later.";
        Log($"offline verified ticket={claims.TicketId}");
        RefreshStatusTexts();
    }

    private async void RedeemOfflineButton_Click(object sender, RoutedEventArgs e)
    {
        AuthStatusText.Text = string.Empty;
        if (!EnsureClient(out var client, out var clientError))
        {
            AuthStatusText.Text = clientError;
            return;
        }

        if (_verifiedOffline is null || _verifiedOfflineToken is null)
        {
            AuthStatusText.Text = "Verify an offline token first.";
            return;
        }

        RedeemOfflineButton.IsEnabled = false;
        try
        {
            var session = await client.RedeemOfflineTokenAsync(
                _verifiedOfflineToken,
                _verifiedOffline.TechnicianBindingHash,
                _verifiedOffline.Challenge,
                CancellationToken.None).ConfigureAwait(true);
            if (session.SessionJwt is null || session.TicketId is null)
            {
                AuthStatusText.Text = "Server returned an incomplete session.";
                return;
            }

            _session = session;
            _settings.ClearPendingChallenge();
            OfflineTokenBox.Text = string.Empty;
            AuthStatusText.Text = "Offline token redeemed into a session.";
            Log($"session redeemed offline ticket={session.TicketId}");
        }
        catch (Exception ex)
        {
            AuthStatusText.Text = Friendly(ex);
            Log("redeem offline failed: " + ex.GetType().Name);
        }
        finally
        {
            RefreshStatusTexts();
            RedeemOfflineButton.IsEnabled = true;
        }
    }

    // ── Diagnostics ─────────────────────────────────────────────────────────

    private List<string> SelectedModules()
    {
        var modules = new List<string>();
        if (ModuleStartup.IsChecked == true)
        {
            modules.Add(DiagnosticModules.Startup);
        }

        if (ModuleRuntime.IsChecked == true)
        {
            modules.Add(DiagnosticModules.Runtime);
        }

        if (ModuleStorage.IsChecked == true)
        {
            modules.Add(DiagnosticModules.Storage);
        }

        if (ModuleDatabase.IsChecked == true)
        {
            modules.Add(DiagnosticModules.Database);
        }

        if (ModuleConnectivity.IsChecked == true)
        {
            modules.Add(DiagnosticModules.Connectivity);
        }

        return modules;
    }

    private async void RunDiagnosticsButton_Click(object sender, RoutedEventArgs e)
    {
        DiagnosticsStatusText.Text = string.Empty;
        var modules = SelectedModules();
        if (modules.Count == 0)
        {
            DiagnosticsStatusText.Text = "Select at least one module.";
            return;
        }

        _diagCts?.Dispose();
        _diagCts = new CancellationTokenSource();
        var ct = _diagCts.Token;
        RunDiagnosticsButton.IsEnabled = false;
        CancelDiagnosticsButton.IsEnabled = true;
        SaveReportButton.IsEnabled = false;
        UploadRunButton.IsEnabled = false;

        try
        {
            var config = new CompanionProbeConfig(
                _settings.DataDir,
                _roots.TempDir,
                _roots.JournalDir,
                _settings.ReportsDir,
                _settings.ServerUrl.Length > 0 ? _settings.ServerUrl : null);
            var probes = DiagnosticsCatalog.StandardProbes(config);
            var findings = await Task.Run(
                () => DiagnosticsCatalog.Run(modules, probes, TimeSpan.FromSeconds(10), ct), ct).ConfigureAwait(true);
            _findings = findings;
            _findingModules = modules;

            FindingsList.Items.Clear();
            var counts = new Dictionary<CheckStatus, int>();
            var covered = new SortedSet<string>(StringComparer.Ordinal);
            foreach (var finding in findings)
            {
                counts[finding.Status] = counts.TryGetValue(finding.Status, out var n) ? n + 1 : 1;
                covered.Add(finding.Module);
                FindingsList.Items.Add(
                    $"{finding.Module}/{finding.CheckId}: {finding.Status} — {finding.Code} — {Truncate(finding.Detail, 120)}");
            }

            var missing = modules.Where(m => !covered.Contains(m)).ToList();
            var parts = counts.OrderBy(kvp => kvp.Key.ToString()).Select(kvp => $"{kvp.Value} {kvp.Key.ToString().ToLowerInvariant()}");
            CoverageText.Text = $"Findings: {findings.Count} ({string.Join(", ", parts)}). Modules covered: {string.Join(",", covered)}." +
                (missing.Count > 0 ? $" No probes ran for: {string.Join(",", missing)} (unsupported here)." : string.Empty);
            DiagnosticsStatusText.Text = "Run finished. Seal the report for offline export, or upload it against a request id.";
            SaveReportButton.IsEnabled = true;
            UploadRunButton.IsEnabled = true;
            Log($"diagnostics ran modules={string.Join(",", modules)} findings={findings.Count}");
        }
        catch (OperationCanceledException)
        {
            DiagnosticsStatusText.Text = "Run stopped by the operator; partial findings kept.";
            Log("diagnostics cancelled");
        }
        catch (Exception ex)
        {
            DiagnosticsStatusText.Text = Friendly(ex);
            Log("diagnostics failed: " + ex.GetType().Name);
        }
        finally
        {
            RunDiagnosticsButton.IsEnabled = true;
            CancelDiagnosticsButton.IsEnabled = false;
        }
    }

    private void CancelDiagnosticsButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            _diagCts?.Cancel();
        }
        catch (Exception)
        {
        }
    }

    private async void SaveReportButton_Click(object sender, RoutedEventArgs e)
    {
        DiagnosticsStatusText.Text = string.Empty;
        if (_findings is null || _findingModules is null)
        {
            DiagnosticsStatusText.Text = "Run diagnostics first.";
            return;
        }

        SaveReportButton.IsEnabled = false;
        try
        {
            var requestId = UploadRequestIdBox.Text.Trim();
            var state = DiagnosticsCatalog.SuggestRunState(_findings, _findingModules);
            var (bodyJson, redaction) = DiagnosticsCatalog.BuildReportBody(
                requestId.Length > 0 ? requestId : "local", state, _findings, _findingModules);
            var reportsDir = _settings.ReportsDir;
            var sealed_ = await Task.Run(() => DiagnosticsCatalog.SealReport(reportsDir, bodyJson)).ConfigureAwait(true);
            DiagnosticsStatusText.Text =
                $"Sealed {sealed_.FileName} (sha256 {sealed_.Sha256Hex[..16]}…). " +
                $"Redaction: {redaction.ScrubbedValues} value(s) scrubbed, {redaction.BlockedFields} field(s) blocked.";
            Log($"report sealed file={sealed_.FileName}");
        }
        catch (Exception ex)
        {
            DiagnosticsStatusText.Text = Friendly(ex);
            Log("seal failed: " + ex.GetType().Name);
        }
        finally
        {
            SaveReportButton.IsEnabled = true;
        }
    }

    private async void UploadRunButton_Click(object sender, RoutedEventArgs e)
    {
        DiagnosticsStatusText.Text = string.Empty;
        if (!EnsureClient(out var client, out var clientError))
        {
            DiagnosticsStatusText.Text = clientError;
            return;
        }

        if (!EnsureSession(out var session, out var sessionError))
        {
            DiagnosticsStatusText.Text = sessionError;
            return;
        }

        if (_findings is null || _findingModules is null)
        {
            DiagnosticsStatusText.Text = "Run diagnostics first.";
            return;
        }

        var requestId = UploadRequestIdBox.Text.Trim();
        if (requestId.Length == 0)
        {
            DiagnosticsStatusText.Text = "A request id is required — poll on the Status tab to list open requests.";
            return;
        }

        UploadRunButton.IsEnabled = false;
        try
        {
            var state = DiagnosticsCatalog.SuggestRunState(_findings, _findingModules);
            var (bodyJson, _) = DiagnosticsCatalog.BuildReportBody(requestId, state, _findings, _findingModules);
            var body = JsonNode.Parse(bodyJson) as JsonObject;
            if (body is null)
            {
                DiagnosticsStatusText.Text = "Built report body is not an object (internal error).";
                return;
            }

            var (run, redaction) = await client.UploadRunAsync(session.SessionJwt!, body, CancellationToken.None).ConfigureAwait(true);
            var runId = NodeString(run, "id");
            DiagnosticsStatusText.Text =
                $"Uploaded as run {runId}. Server redaction: {redaction.ToJsonString()}. Only this receipt clears the ticket's not_sent label.";
            Log($"run uploaded request={requestId} run={runId}");
        }
        catch (Exception ex)
        {
            DiagnosticsStatusText.Text = Friendly(ex);
            Log("upload failed: " + ex.GetType().Name);
        }
        finally
        {
            UploadRunButton.IsEnabled = true;
        }
    }

    // ── Repairs ─────────────────────────────────────────────────────────────

    private async void FetchRepairButton_Click(object sender, RoutedEventArgs e)
    {
        RepairStatusText.Text = string.Empty;
        PlanSummaryText.Text = string.Empty;
        if (!EnsureClient(out var client, out var clientError))
        {
            RepairStatusText.Text = clientError;
            return;
        }

        if (!EnsureSession(out var session, out var sessionError))
        {
            RepairStatusText.Text = sessionError;
            return;
        }

        var runId = RepairRunIdBox.Text.Trim();
        if (runId.Length == 0)
        {
            RepairStatusText.Text = "Enter the repair run id from the ticket.";
            return;
        }

        FetchRepairButton.IsEnabled = false;
        PlanRepairButton.IsEnabled = false;
        ExecuteRepairButton.IsEnabled = false;
        try
        {
            var bundle = await client.GetRepairRunAsync(session.SessionJwt!, runId, CancellationToken.None).ConfigureAwait(true);
            if (!RepairEnvelopeBuilder.TryBuild(
                    bundle.Run.ToJsonString(), bundle.Recipe.ToJsonString(),
                    _settings.InstallationId, session.TicketId!,
                    out var envelopeJson, out var buildError))
            {
                RecipeSummaryText.Text = "Run refused before planning: " + buildError;
                RepairStatusText.Text = "Run refused before planning: " + buildError;
                Log($"repair fetch refused run={runId}: {buildError}");
                return;
            }

            if (!RepairRunEnvelope.TryParse(envelopeJson, out var envelope, out var parseError) || envelope is null)
            {
                RepairStatusText.Text = "Built envelope rejected: " + parseError;
                return;
            }

            _envelope = envelope;
            _plan = null;
            var title = NodeString(bundle.Recipe, "title");
            var description = NodeString(bundle.Recipe, "description");
            RecipeSummaryText.Text =
                $"{envelope.RecipeId} v{envelope.RecipeVersion} (risk {envelope.Risk}, backup {envelope.BackupPolicy}): {title}. {description}";
            RepairStatusText.Text = "Run fetched and verified against its pinned hash. Dry-run the plan next.";
            PlanRepairButton.IsEnabled = true;
            RepairLog($"fetched run {runId} ({envelope.RecipeId} v{envelope.RecipeVersion})");
            Log($"repair fetched run={runId} recipe={envelope.RecipeId}");
        }
        catch (CompanionApiException ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            RepairStatusText.Text = "Run not found — or the server predates the run-fetch route. " + Friendly(ex);
        }
        catch (Exception ex)
        {
            RepairStatusText.Text = Friendly(ex);
            Log("repair fetch failed: " + ex.GetType().Name);
        }
        finally
        {
            FetchRepairButton.IsEnabled = true;
        }
    }

    private async void PlanRepairButton_Click(object sender, RoutedEventArgs e)
    {
        RepairStatusText.Text = string.Empty;
        if (_envelope is null)
        {
            RepairStatusText.Text = "Fetch a run first.";
            return;
        }

        PlanRepairButton.IsEnabled = false;
        ExecuteRepairButton.IsEnabled = false;
        try
        {
            var envelope = _envelope;
            var roots = _roots;
            var (plan, refusal) = await Task.Run(() => RepairExecutor.Plan(envelope, roots)).ConfigureAwait(true);
            if (refusal is not null || plan is null)
            {
                PlanSummaryText.Text = $"Refused: {refusal?.Refusal} — {refusal?.Reason}";
                RepairStatusText.Text = $"Plan refused: {refusal?.Refusal} — {refusal?.Reason}";
                RepairLog($"plan refused: {refusal?.Refusal}");
                Log($"repair plan refused: {refusal?.Refusal}");
                return;
            }

            _plan = plan;
            PlanSummaryText.Text =
                $"Would run {plan.Verb}: {plan.EffectsSummary} Backup: {plan.BackupPlan}. " +
                $"Warnings: {plan.WarningsJson} Preconditions: {plan.PreconditionResultsJson}";
            RepairStatusText.Text = "Plan ready. Check customer consent (and risk acknowledgement for medium/high risk), then execute.";
            ExecuteRepairButton.IsEnabled = true;
            RepairLog($"planned {plan.Verb} (hash {plan.PlanHash[..Math.Min(16, plan.PlanHash.Length)]}…)");

            // Medium/high-risk plans need the acknowledgement box; low-risk
            // work proceeds on consent alone.
            RiskAckCheck.IsEnabled = plan.Risk == "medium" || plan.Risk == "high";
        }
        catch (Exception ex)
        {
            RepairStatusText.Text = Friendly(ex);
            Log("repair plan failed: " + ex.GetType().Name);
        }
        finally
        {
            PlanRepairButton.IsEnabled = true;
        }
    }

    private async void ExecuteRepairButton_Click(object sender, RoutedEventArgs e)
    {
        RepairStatusText.Text = string.Empty;
        if (!EnsureClient(out var client, out var clientError))
        {
            RepairStatusText.Text = clientError;
            return;
        }

        if (!EnsureSession(out var session, out var sessionError))
        {
            RepairStatusText.Text = sessionError;
            return;
        }

        if (_envelope is null || _plan is null)
        {
            RepairStatusText.Text = "Fetch a run and dry-run its plan first.";
            return;
        }

        if (ConsentCheck.IsChecked != true)
        {
            RepairStatusText.Text = "Customer consent is required — رضایت مشتری لازم است.";
            return;
        }

        // Fail fast with the true reason when the machine-wide gate dir was
        // never provisioned, instead of journaling intent and reporting busy.
        if (!MaintenanceGateWritable(out var gatePath))
        {
            RepairStatusText.Text =
                $"Maintenance gate unavailable ({gatePath}): run a machine install once, " +
                "or point BIZA_MAINTENANCE_LOCK at a writable path. Nothing was executed.";
            return;
        }

        var consent = new JsonObject
        {
            ["grantedBy"] = "customer",
            ["grantedAt"] = DateTimeOffset.UtcNow.ToString("O"),
            ["runId"] = _envelope.RunId,
            ["riskAcknowledged"] = RiskAckCheck.IsChecked == true,
        };

        _repairCts?.Dispose();
        _repairCts = new CancellationTokenSource();
        var ct = _repairCts.Token;
        ExecuteRepairButton.IsEnabled = false;
        CancelRepairButton.IsEnabled = true;
        try
        {
            var envelope = _envelope;
            var plan = _plan;
            var roots = _roots;
            RepairLog("reporting executing…");
            await client.TransitionRepairAsync(
                session.SessionJwt!, envelope.RunId, "executing",
                new Dictionary<string, object?>
                {
                    ["consentRef"] = consent,
                    ["preconditionResults"] = ParseOrNull(plan.PreconditionResultsJson),
                },
                ct).ConfigureAwait(true);

            RepairLog("executing locally…");
            var outcome = await Task.Run(
                () => RepairExecutor.Execute(envelope, plan, consent.ToJsonString(), null, roots, ct), ct).ConfigureAwait(true);
            RepairLog($"local outcome: {outcome.ServerState}" +
                (outcome.Refusal is not null ? $" ({outcome.Refusal}: {outcome.Reason})" : string.Empty));

            RepairLog($"reporting {outcome.ServerState}…");
            await client.TransitionRepairAsync(
                session.SessionJwt!, envelope.RunId, outcome.ServerState,
                new Dictionary<string, object?>
                {
                    ["consentRef"] = consent,
                    ["preconditionResults"] = ParseOrNull(outcome.PreconditionResultsJson),
                    ["backupRef"] = outcome.BackupRef,
                    ["beforeFindings"] = ParseOrNull(outcome.BeforeFindingsJson),
                    ["afterFindings"] = ParseOrNull(outcome.AfterFindingsJson),
                    ["verification"] = ParseOrNull(outcome.VerificationJson),
                    ["receipt"] = ParseOrNull(outcome.ReceiptJson),
                },
                CancellationToken.None).ConfigureAwait(true);

            RepairStatusText.Text = outcome.Ok
                ? $"Repair {outcome.ServerState}; the ticket carries the receipt."
                : $"Repair ended {outcome.ServerState}: {outcome.Refusal} — {outcome.Reason}";
            Log($"repair done run={envelope.RunId} state={outcome.ServerState}");
            _plan = null;
        }
        catch (OperationCanceledException)
        {
            RepairStatusText.Text = "Stopped by the operator. The run stays executing server-side until it is re-driven or cancelled from the ticket.";
            RepairLog("stopped by operator");
            Log("repair cancelled by operator");
        }
        catch (Exception ex)
        {
            RepairStatusText.Text = Friendly(ex);
            RepairLog("error: " + Friendly(ex));
            Log("repair execute failed: " + ex.GetType().Name);
        }
        finally
        {
            ExecuteRepairButton.IsEnabled = _plan is not null;
            CancelRepairButton.IsEnabled = false;
        }
    }

    private void CancelRepairButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            _repairCts?.Cancel();
        }
        catch (Exception)
        {
        }
    }

    // ── Assistance ──────────────────────────────────────────────────────────

    private PollAssistanceDto? SelectedAssistance()
    {
        var index = AssistanceList.SelectedIndex;
        if (index < 0 || index >= _assistanceItems.Count)
        {
            return null;
        }

        return _assistanceItems[index];
    }

    private async Task ConsentAssistanceAsync(bool approved, string[]? caps)
    {
        AssistanceStatusText.Text = string.Empty;
        if (!EnsureClient(out var client, out var clientError))
        {
            AssistanceStatusText.Text = clientError;
            return;
        }

        if (!EnsureSession(out var session, out var sessionError))
        {
            AssistanceStatusText.Text = sessionError;
            return;
        }

        var item = SelectedAssistance();
        if (item?.Id is null)
        {
            AssistanceStatusText.Text = "Select a session from the list first (poll on the Status tab).";
            return;
        }

        try
        {
            var proof = new JsonObject
            {
                ["grantedBy"] = "customer",
                ["decidedAt"] = DateTimeOffset.UtcNow.ToString("O"),
            };
            var updated = await client.AssistanceAsync(
                session.SessionJwt!, "consent", item.Id, approved, caps, proof, CancellationToken.None).ConfigureAwait(true);
            var state = NodeString(updated, "state");
            AssistanceStatusText.Text = approved
                ? $"Approved ({string.Join(",", caps ?? [])}); session state: {state}. The lease renews automatically until you STOP it."
                : $"Denied; session state: {state}.";
            Log($"assistance consent session={item.Id} approved={approved}");

            if (approved)
            {
                StartLeaseTimer(session.SessionJwt!, item.Id);
            }
        }
        catch (Exception ex)
        {
            AssistanceStatusText.Text = Friendly(ex);
            Log("assistance consent failed: " + ex.GetType().Name);
        }
    }

    private async void ApproveViewButton_Click(object sender, RoutedEventArgs e) =>
        await ConsentAssistanceAsync(true, ["view"]).ConfigureAwait(true);

    private async void ApproveControlButton_Click(object sender, RoutedEventArgs e) =>
        await ConsentAssistanceAsync(true, ["view", "control"]).ConfigureAwait(true);

    private async void DenyButton_Click(object sender, RoutedEventArgs e) =>
        await ConsentAssistanceAsync(false, null).ConfigureAwait(true);

    private async void StopAssistanceButton_Click(object sender, RoutedEventArgs e)
    {
        AssistanceStatusText.Text = string.Empty;
        StopLeaseTimer();
        if (!EnsureClient(out var client, out var clientError))
        {
            AssistanceStatusText.Text = clientError;
            return;
        }

        // Stop rides the device credential on purpose: ending access must
        // never depend on the operator's authorization still being valid.
        if (!EnsureDeviceBearer(out var bearer, out var bearerError))
        {
            AssistanceStatusText.Text = bearerError;
            return;
        }

        var item = SelectedAssistance();
        var sessionId = item?.Id ?? _leaseSessionId;
        if (sessionId is null)
        {
            AssistanceStatusText.Text = "Select a session from the list first.";
            return;
        }

        try
        {
            var updated = await client.AssistanceAsync(
                bearer, "stop", sessionId, null, null, null, CancellationToken.None).ConfigureAwait(true);
            AssistanceStatusText.Text = $"STOP recorded; session state: {NodeString(updated, "state")}.";
            Log($"assistance stopped session={sessionId}");
        }
        catch (Exception ex)
        {
            AssistanceStatusText.Text = Friendly(ex);
            Log("assistance stop failed: " + ex.GetType().Name);
        }
    }

    private void StartLeaseTimer(string sessionJwt, string sessionId)
    {
        StopLeaseTimer();
        _leaseSessionId = sessionId;
        _leaseTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(20) };
        _leaseTimer.Tick += async (_, _) => await RenewLeaseAsync(sessionJwt, sessionId).ConfigureAwait(true);
        _leaseTimer.Start();
        LeaseStatusText.Text = "Lease keep-alive running.";
    }

    private void StopLeaseTimer()
    {
        _leaseTimer?.Stop();
        _leaseTimer = null;
        _leaseSessionId = null;
        LeaseStatusText.Text = string.Empty;
    }

    private async Task RenewLeaseAsync(string sessionJwt, string sessionId)
    {
        if (_leaseRenewing || !EnsureClient(out var client, out _))
        {
            return;
        }

        _leaseRenewing = true;
        try
        {
            await client.AssistanceAsync(
                sessionJwt, "renew_lease", sessionId, null, null, null, CancellationToken.None).ConfigureAwait(true);
            LeaseStatusText.Text = $"Lease renewed {DateTimeOffset.Now:HH:mm:ss}.";
        }
        catch (Exception ex)
        {
            StopLeaseTimer();
            AssistanceStatusText.Text = "Lease renewal failed — keep-alive stopped: " + Friendly(ex);
            Log("lease renew failed: " + ex.GetType().Name);
        }
        finally
        {
            _leaseRenewing = false;
        }
    }

    // ── Updates ─────────────────────────────────────────────────────────────

    private async void CheckUpdateButton_Click(object sender, RoutedEventArgs e)
    {
        UpdateStatusText.Text = string.Empty;
        ManifestSummaryText.Text = string.Empty;

        // Updates never touch the API client: the manifest URL is absolute
        // and the signature — not the transport — is the trust root.
        var manifestUrl = ManifestUrlBox.Text.Trim();
        if (manifestUrl.Length == 0)
        {
            UpdateStatusText.Text = "Enter the channel manifest URL (Settings tab stores it).";
            return;
        }

        var keysPath = Path.Combine(_settings.DataDir, "update-keys.json");
        if (!File.Exists(keysPath))
        {
            UpdateStatusText.Text = "Release keys not provisioned: the installer places update-keys.json in the data dir.";
            return;
        }

        CheckUpdateButton.IsEnabled = false;
        try
        {
            using var plain = new CompanionClient(
                _settings.ServerUrl.Length > 0 ? _settings.ServerUrl : "https://localhost");
            var keys = await File.ReadAllTextAsync(keysPath).ConfigureAwait(true);
            var manifest = await plain.GetManifestAsync(manifestUrl, CancellationToken.None).ConfigureAwait(true);
            var signature = await plain.GetManifestAsync(manifestUrl + ".sig", CancellationToken.None).ConfigureAwait(true);
            var channel = _settings.Channel.Length > 0 ? _settings.Channel : "stable";
            var verified = await Task.Run(() => UpdateManifest.TryVerify(
                manifest.Trim(), signature.Trim(), keys, channel,
                CompanionSettings.CompanionVersion(), out var verifyError) is VerifiedManifest vm
                    ? (ok: true, manifest: vm, error: string.Empty)
                    : (ok: false, manifest: (VerifiedManifest?)null, error: verifyError)).ConfigureAwait(true);
            if (!verified.ok || verified.manifest is null)
            {
                UpdateStatusText.Text = "Manifest rejected: " + verified.error;
                Log("update manifest rejected: " + verified.error);
                return;
            }

            long total = 0;
            foreach (var file in verified.manifest.Files)
            {
                total += file.Bytes;
            }

            ManifestSummaryText.Text =
                $"Channel {verified.manifest.Channel} offers {verified.manifest.Version} " +
                $"({verified.manifest.Files.Count} file(s), {total} bytes, key {verified.manifest.Kid}).";
            UpdateStatusText.Text = "Verified. Downloading and installing the staged files is a follow-up — this version only verifies.";
            Log($"update verified version={verified.manifest.Version}");
        }
        catch (Exception ex)
        {
            UpdateStatusText.Text = Friendly(ex);
            Log("update check failed: " + ex.GetType().Name);
        }
        finally
        {
            CheckUpdateButton.IsEnabled = true;
        }
    }

    // ── Settings ────────────────────────────────────────────────────────────

    private void SaveSettingsButton_Click(object sender, RoutedEventArgs e)
    {
        SettingsStatusText.Text = string.Empty;
        var serverUrl = SettingsServerUrlBox.Text.Trim();
        if (serverUrl.Length > 0)
        {
            try
            {
                serverUrl = CompanionClient.NormalizeOrigin(serverUrl);
            }
            catch (ArgumentException ex)
            {
                SettingsStatusText.Text = ex.Message;
                return;
            }
        }

        _settings.ServerUrl = serverUrl;
        _settings.ManifestUrl = SettingsManifestUrlBox.Text.Trim();
        _settings.Channel = SettingsChannelBox.Text.Trim().Length > 0 ? SettingsChannelBox.Text.Trim() : "stable";
        _settings.DisplayName = SettingsDisplayNameBox.Text.Trim();
        try
        {
            _settings.Save();
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
            SettingsStatusText.Text = "Settings could not be saved: " + ex.Message;
            return;
        }

        _clientOrigin = null;
        EnrollServerUrlBox.Text = serverUrl;
        ManifestUrlBox.Text = _settings.ManifestUrl;
        SettingsStatusText.Text = "Saved.";
        RefreshStatusTexts();
        Log("settings saved");
    }

    private async void ExportBundleButton_Click(object sender, RoutedEventArgs e)
    {
        SettingsStatusText.Text = string.Empty;
        var dialog = new SaveFileDialog
        {
            Filter = "Zip archives (*.zip)|*.zip",
            FileName = $"companion-bundle-{DateTimeOffset.UtcNow:yyyyMMddHHmmss}.zip",
        };
        if (dialog.ShowDialog() != true)
        {
            return;
        }

        ExportBundleButton.IsEnabled = false;
        try
        {
            var zipPath = dialog.FileName;
            var dataDir = _settings.DataDir;
            await Task.Run(() =>
            {
                var staging = Path.Combine(Path.GetTempPath(), $"companion-bundle-{Guid.NewGuid():N}");
                Directory.CreateDirectory(staging);
                try
                {
                    var reports = Path.Combine(dataDir, CompanionSettings.ReportsDirectoryName);
                    if (Directory.Exists(reports))
                    {
                        foreach (var file in Directory.GetFiles(reports))
                        {
                            File.Copy(file, Path.Combine(staging, "report-" + Path.GetFileName(file)));
                        }
                    }

                    var journal = Path.Combine(dataDir, "journal", OperationJournal.FileName);
                    if (File.Exists(journal))
                    {
                        File.Copy(journal, Path.Combine(staging, OperationJournal.FileName));
                    }

                    var settings = Path.Combine(dataDir, CompanionSettings.SettingsFileName);
                    if (File.Exists(settings))
                    {
                        // Settings hold no secrets (the credential seals separately).
                        File.Copy(settings, Path.Combine(staging, CompanionSettings.SettingsFileName));
                    }

                    if (File.Exists(zipPath))
                    {
                        File.Delete(zipPath);
                    }

                    ZipFile.CreateFromDirectory(staging, zipPath);
                }
                finally
                {
                    Directory.Delete(staging, recursive: true);
                }
            }).ConfigureAwait(true);

            SettingsStatusText.Text = "Bundle exported to " + zipPath;
            Log("bundle exported");
        }
        catch (Exception ex)
        {
            SettingsStatusText.Text = Friendly(ex);
            Log("bundle export failed: " + ex.GetType().Name);
        }
        finally
        {
            ExportBundleButton.IsEnabled = true;
        }
    }
}
