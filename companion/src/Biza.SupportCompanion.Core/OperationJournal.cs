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
                // One handle for read+append: the writer-excluded open
                // (FileShare.Read) forbids a second opener from taking
                // write-compatible share, so reading the tail through a
                // separate File.ReadLines handle self-deadlocks with a
                // sharing violation on Windows. ReadWrite on a single
                // OpenOrCreate handle keeps writer-exclusion AND lets us
                // see the tail we chain onto.
                using var stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read);
                var tail = ReadTailFromStream(stream);
                // A previous crash may have left a valid-but-unterminated
                // tail (full line, no trailing newline): terminate it
                // before appending, or the new line glues onto it and both
                // are lost to the next Verify.
                if (stream.Length > 0)
                {
                    stream.Seek(-1, SeekOrigin.End);
                    if (stream.ReadByte() != (byte)'\n')
                    {
                        stream.Seek(0, SeekOrigin.End);
                        stream.WriteByte((byte)'\n');
                    }
                }

                stream.Seek(0, SeekOrigin.End);
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

                var lineError = ValidateLine(line, expectedSeq, expectedPrev, out var recordHash);
                if (lineError is not null)
                {
                    return (false, lineError);
                }

                expectedSeq++;
                expectedPrev = recordHash!;
            }

            return (true, string.Empty);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
        {
            return (false, $"journal unreadable: {ex.GetType().Name}");
        }
    }

    /// <summary>
    /// Validates one non-empty journal line against the expected chain
    /// position. Returns <c>null</c> on success (with the record's hash),
    /// or the precise failure — the single validation both <see cref="Verify"/>
    /// and <see cref="TryDiscardTornTail"/> walk, so recovery can never
    /// disagree with verification about what is intact.
    /// </summary>
    private static string? ValidateLine(string line, long expectedSeq, string expectedPrev, out string? recordHash)
    {
        recordHash = null;
        JournalRecord? record;
        try
        {
            record = Deserialize(line);
        }
        catch (Exception ex) when (ex is JsonException || ex is KeyNotFoundException || ex is InvalidOperationException || ex is FormatException)
        {
            return $"journal line {expectedSeq} is not a valid record";
        }

        if (record is null || record.Seq != expectedSeq || record.PrevHash != expectedPrev)
        {
            return $"journal chain broken at line {expectedSeq}";
        }

        if (HashRecord(record with { Hash = string.Empty }) != record.Hash)
        {
            return $"journal hash mismatch at line {expectedSeq}";
        }

        recordHash = record.Hash;
        return null;
    }

    /// <summary>
    /// Crash recovery: discards a torn tail (crash mid-append) and restores
    /// a missing trailing newline, then journals the recovery itself as a
    /// <c>journal_recovered</c> record so the truncation is audited, not
    /// silent. Only the LAST non-empty line may be discarded, and only when
    /// every line before it verifies — mid-file corruption (tamper or
    /// deletion) is evidence, never repaired, and fails closed with the
    /// file untouched. A racing writer surfaces as busy (fail closed, retry);
    /// a clean journal is a no-op success. Truncation is byte-exact
    /// (no re-serialization of the kept records).
    /// </summary>
    public static (bool Ok, int Kept, int Dropped, bool Normalized, string Error) TryDiscardTornTail(string journalDir)
    {
        var path = Path.Combine(journalDir, FileName);
        if (!File.Exists(path))
        {
            return (true, 0, 0, false, string.Empty);
        }

        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.Read);
            // Recovery reads the whole file; journals are small audit logs,
            // and anything beyond this cap fails closed instead of OOMing.
            const long maxRecoveryBytes = 256L * 1024 * 1024;
            if (stream.Length > maxRecoveryBytes)
            {
                return (false, 0, 0, false, "journal too large to recover in memory");
            }

            var raw = new byte[(int)stream.Length];
            var read = 0;
            while (read < raw.Length)
            {
                var n = stream.Read(raw, read, raw.Length - read);
                if (n == 0)
                {
                    break;
                }

                read += n;
            }

            // Split on \n with byte offsets; strip exactly one trailing
            // \r per segment to mirror what Verify sees via ReadLine
            // (which strips one terminator, not all trailing \r).
            var starts = new List<int> { 0 };
            for (var i = 0; i < read; i++)
            {
                if (raw[i] == (byte)'\n')
                {
                    starts.Add(i + 1);
                }
            }

            var expectedSeq = 1L;
            var expectedPrev = GenesisHash;
            var kept = 0;
            var badStart = -1;
            for (var s = 0; s < starts.Count; s++)
            {
                var start = starts[s];
                var end = s + 1 < starts.Count ? starts[s + 1] - 1 : read;
                var text = Encoding.UTF8.GetString(raw, start, end - start).StripOneCarriageReturn();
                if (text.Trim().Length == 0)
                {
                    continue;
                }

                if (ValidateLine(text, expectedSeq, expectedPrev, out var recordHash) is not null)
                {
                    badStart = start;
                    break;
                }

                kept++;
                expectedSeq++;
                expectedPrev = recordHash!;
            }

            if (badStart >= 0)
            {
                // Torn means last: anything non-empty after the bad line is
                // tamper/deletion evidence, and truncating it would destroy
                // the proof. Refuse with the file untouched.
                for (var s = 0; s < starts.Count; s++)
                {
                    if (starts[s] <= badStart)
                    {
                        continue;
                    }

                    var start = starts[s];
                    var end = s + 1 < starts.Count ? starts[s + 1] - 1 : read;
                    var text = Encoding.UTF8.GetString(raw, start, end - start).StripOneCarriageReturn();
                    if (text.Trim().Length > 0)
                    {
                        return (false, 0, 0, false,
                            "journal corruption is not a torn tail; refusing to truncate (evidence preserved)");
                    }
                }

                var droppedBytes = read - badStart;
                stream.SetLength(badStart);
                stream.Flush(flushToDisk: true);
                AppendRecoveryRecord(stream, kept, expectedPrev, dropped: 1, normalized: false, droppedBytes);
                stream.Flush(flushToDisk: true);
                stream.Dispose();
                return VerifyRecovered(journalDir, kept, dropped: 1, normalized: false);
            }

            if (read > 0 && raw[read - 1] != (byte)'\n')
            {
                stream.Seek(0, SeekOrigin.End);
                stream.WriteByte((byte)'\n');
                AppendRecoveryRecord(stream, kept, expectedPrev, dropped: 0, normalized: true, droppedBytes: 0);
                stream.Flush(flushToDisk: true);
                stream.Dispose();
                return VerifyRecovered(journalDir, kept, dropped: 0, normalized: true);
            }

            return (true, kept, 0, false, string.Empty);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
        {
            return (false, 0, 0, false, $"journal unrecoverable: {ex.GetType().Name}");
        }
    }

    /// <summary>
    /// Strips exactly one trailing carriage return — what
    /// <c>StreamReader.ReadLine</c> removes from a <c>\r\n</c>-terminated
    /// line, no more. Recovery must see byte-identical line text to
    /// <see cref="Verify"/>, or the two could disagree about integrity.
    /// </summary>
    private static string StripOneCarriageReturn(this string text) =>
        text.EndsWith('\r') ? text[..^1] : text;

    /// <summary>
    /// Re-verifies after a recovery mutation. The recovery handle must be
    /// disposed first: Verify opens its own handle, and ours shares Read
    /// only (same single-handle discipline as Append's writer exclusion).
    /// </summary>
    private static (bool Ok, int Kept, int Dropped, bool Normalized, string Error) VerifyRecovered(
        string journalDir, int kept, int dropped, bool normalized)
    {
        var (ok, error) = Verify(journalDir);
        return ok
            ? (true, kept, dropped, normalized, string.Empty)
            : (false, 0, 0, false, $"recovery produced an unverifiable journal: {error}");
    }

    /// <summary>
    /// Writes the <c>journal_recovered</c> audit record through the caller's
    /// already-open, already-positioned handle: chained onto the truncated
    /// tail like any other record, so the recovery is itself verifiable.
    /// </summary>
    private static void AppendRecoveryRecord(
        FileStream stream, int kept, string tailHash, int dropped, bool normalized, int droppedBytes)
    {
        var record = new JournalRecord(
            Seq: kept + 1,
            Ts: DateTimeOffset.UtcNow.ToString("O"),
            Kind: "journal_recovered",
            RunId: null,
            DataJson: "{\"kept\":" + kept + ",\"dropped\":" + dropped
                + ",\"normalized\":" + (normalized ? "true" : "false")
                + ",\"droppedBytes\":" + droppedBytes + "}",
            PrevHash: tailHash,
            Hash: string.Empty);
        record = record with { Hash = HashRecord(record) };
        var bytes = Encoding.UTF8.GetBytes(Serialize(record) + "\n");
        stream.Write(bytes, 0, bytes.Length);
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

    private static (long seq, string hash) ReadTailFromStream(FileStream stream)
    {
        // Small file, simple scan: take the last non-empty line.
        // Reads through the caller's already-open handle (see Append):
        // leaveOpen, and the caller re-seeks to the end before writing.
        string? last = null;
        stream.Seek(0, SeekOrigin.Begin);
        using (var reader = new StreamReader(stream, Encoding.UTF8, leaveOpen: true))
        {
            string? line;
            while ((line = reader.ReadLine()) != null)
            {
                if (line.Trim().Length > 0)
                {
                    last = line;
                }
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
