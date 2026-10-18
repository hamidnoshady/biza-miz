using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Biza.SupportCompanion.Core;

/// <summary>
/// One journal record. <c>Hash</c> chains to <c>PrevHash</c>, so deleting or
/// reordering lines is detectable — tamper-evident, not tamper-proof
/// against a local administrator (epic §10: no such promise is made).
/// </summary>
public sealed record JournalRecord(
    long Seq,
    string Ts,
    string Kind,
    string? RunId,
    string DataJson,
    string PrevHash,
    string Hash);

/// <summary>
/// Issue #984 — the companion's durable operation journal. Repairs record
/// intent before acting, every phase transition, and the receipt; a
/// crashed run reconciles actual state from this journal before doing
/// anything, and never blindly replays. One JSON object per line, hash
/// chained, appended with writer-exclusion plus bounded retries.
/// </summary>
public static class OperationJournal
{
    public const string FileName = "operations.jsonl";
    public const string GenesisHash = "GENESIS";

    private const int AppendAttempts = 5;

    /// <summary>
    /// Appends a record. <paramref name="data"/> must already be redacted —
    /// the journal never sees secrets (callers pass evidence through
    /// <see cref="Redactor"/> first).
    /// </summary>
    public static JournalRecord Append(string journalDir, string kind, string? runId, string dataJson)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(journalDir);
        ArgumentException.ThrowIfNullOrWhiteSpace(kind);
        ArgumentNullException.ThrowIfNull(dataJson);

        Directory.CreateDirectory(journalDir);
        var path = Path.Combine(journalDir, FileName);

        IOException? last = null;
        for (var attempt = 0; attempt < AppendAttempts; attempt++)
        {
            try
            {
                using var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read);
                var tail = ReadTail(path);
                var record = new JournalRecord(
                    Seq: tail.seq + 1,
                    Ts: DateTimeOffset.UtcNow.ToString("O"),
                    Kind: kind,
                    RunId: runId,
                    DataJson: dataJson,
                    PrevHash: tail.hash,
                    Hash: string.Empty);
                var hash = HashRecord(record with { Hash = string.Empty });
                record = record with { Hash = hash };
                var line = Serialize(record);
                var bytes = Encoding.UTF8.GetBytes(line + "\n");
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(flushToDisk: true);
                return record;
            }
            catch (IOException ex)
            {
                // Another process holds the writer-excluded handle (a repair
                // racing a diagnostic write): bounded backoff, then loud.
                last = ex;
                Thread.Sleep(50 * (attempt + 1));
            }
        }

        throw new IOException($"Journal append failed after {AppendAttempts} attempts.", last);
    }

    /// <summary>
    /// Replays the chain: sequence continuity plus every hash link.
    /// Returns <c>(true, "")</c> for a missing or empty journal — nothing
    /// recorded yet is not corruption.
    /// </summary>
    public static (bool Ok, string Error) Verify(string journalDir)
    {
        var path = Path.Combine(journalDir, FileName);
        if (!File.Exists(path))
        {
            return (true, string.Empty);
        }

        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            var expectedSeq = 1L;
            var expectedPrev = GenesisHash;
            string? line;
            while ((line = reader.ReadLine()) != null)
            {
                if (line.Trim().Length == 0)
                {
                    continue;
                }

                JournalRecord? record;
                try
                {
                    record = Deserialize(line);
                }
                catch (Exception ex) when (ex is JsonException || ex is KeyNotFoundException || ex is InvalidOperationException || ex is FormatException)
                {
                    return (false, $"journal line {expectedSeq} is not a valid record");
                }

                if (record is null || record.Seq != expectedSeq || record.PrevHash != expectedPrev)
                {
                    return (false, $"journal chain broken at line {expectedSeq}");
                }

                if (HashRecord(record with { Hash = string.Empty }) != record.Hash)
                {
                    return (false, $"journal hash mismatch at line {expectedSeq}");
                }

                expectedSeq++;
                expectedPrev = record.Hash;
            }

            return (true, string.Empty);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
        {
            return (false, $"journal unreadable: {ex.GetType().Name}");
        }
    }

    /// <summary>All records for one run, oldest first. Unverified — call <see cref="Verify"/> first.</summary>
    public static IReadOnlyList<JournalRecord> ReadRun(string journalDir, string runId)
    {
        var path = Path.Combine(journalDir, FileName);
        if (!File.Exists(path))
        {
            return [];
        }

        var out_ = new List<JournalRecord>();
        foreach (var line in File.ReadLines(path, Encoding.UTF8))
        {
            if (line.Trim().Length == 0)
            {
                continue;
            }

            JournalRecord? record;
            try
            {
                record = Deserialize(line);
            }
            catch (Exception ex) when (ex is JsonException || ex is KeyNotFoundException || ex is InvalidOperationException || ex is FormatException)
            {
                continue;
            }

            if (record is not null && record.RunId == runId)
            {
                out_.Add(record);
            }
        }

        return out_;
    }

    private static (long seq, string hash) ReadTail(string path)
    {
        if (!File.Exists(path))
        {
            return (0, GenesisHash);
        }

        // Small file, simple scan: take the last non-empty line.
        string? last = null;
        foreach (var line in File.ReadLines(path, Encoding.UTF8))
        {
            if (line.Trim().Length > 0)
            {
                last = line;
            }
        }

        if (last is null)
        {
            return (0, GenesisHash);
        }

        try
        {
            var record = Deserialize(last);
            return record is null ? (0, GenesisHash) : (record.Seq, record.Hash);
        }
        catch (Exception ex) when (ex is JsonException || ex is KeyNotFoundException || ex is InvalidOperationException || ex is FormatException)
        {
            // A torn tail (crash mid-write) is detected by Verify; the next
            // append would fork the chain, so refuse loudly instead.
            throw new IOException("Journal tail is torn; refusing to fork the chain.");
        }
    }

    private static string HashRecord(JournalRecord record)
    {
        var canonical = CanonicalJson.Canonicalize(Serialize(record with { Hash = string.Empty, PrevHash = record.PrevHash }));
        return CanonicalJson.Sha256Hex(record.PrevHash + "\n" + canonical);
    }

    private static string Serialize(JournalRecord record)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteNumber("seq", record.Seq);
            writer.WriteString("ts", record.Ts);
            writer.WriteString("kind", record.Kind);
            if (record.RunId is null)
            {
                writer.WriteNull("runId");
            }
            else
            {
                writer.WriteString("runId", record.RunId);
            }

            writer.WriteString("dataJson", record.DataJson);
            writer.WriteString("prevHash", record.PrevHash);
            writer.WriteString("hash", record.Hash);
            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static JournalRecord? Deserialize(string line)
    {
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        return new JournalRecord(
            Seq: root.GetProperty("seq").GetInt64(),
            Ts: root.GetProperty("ts").GetString() ?? string.Empty,
            Kind: root.GetProperty("kind").GetString() ?? string.Empty,
            RunId: root.TryGetProperty("runId", out var runId) && runId.ValueKind == JsonValueKind.String
                ? runId.GetString()
                : null,
            DataJson: root.GetProperty("dataJson").GetString() ?? string.Empty,
            PrevHash: root.GetProperty("prevHash").GetString() ?? string.Empty,
            Hash: root.GetProperty("hash").GetString() ?? string.Empty);
    }
}
