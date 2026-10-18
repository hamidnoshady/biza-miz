using Biza.SupportCompanion.Core;

using Xunit;

namespace Biza.SupportCompanion.Core.Tests;

public sealed class OperationJournalTests
{
    private static string FreshDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), "biza-journal-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    [Fact]
    public void AppendsSequencedHashChainedRecords()
    {
        var dir = FreshDir();

        var first = OperationJournal.Append(dir, "intent", "run-1", """"{"verb":"clean"}"""");
        var second = OperationJournal.Append(dir, "phase", "run-1", """"{"to":"executing"}"""");

        Assert.Equal(1, first.Seq);
        Assert.Equal(OperationJournal.GenesisHash, first.PrevHash);
        Assert.Equal(2, second.Seq);
        Assert.Equal(first.Hash, second.PrevHash);
        Assert.NotEqual(first.Hash, second.Hash);

        var (ok, error) = OperationJournal.Verify(dir);
        Assert.True(ok, error);
    }

    [Fact]
    public void MissingJournalVerifiesAsEmpty()
    {
        var (ok, error) = OperationJournal.Verify(FreshDir());
        Assert.True(ok, error);
    }

    [Fact]
    public void DetectsATamperedLine()
    {
        var dir = FreshDir();
        OperationJournal.Append(dir, "intent", "run-1", """"{"verb":"clean"}"""");
        OperationJournal.Append(dir, "phase", "run-1", """"{"to":"executing"}"""");

        var path = Path.Combine(dir, OperationJournal.FileName);
        var lines = File.ReadAllLines(path);
        File.WriteAllLines(path, [lines[0].Replace("clean", "rmrf"), lines[1]]);

        var (ok, error) = OperationJournal.Verify(dir);
        Assert.False(ok);
        Assert.Contains("mismatch", error);
    }

    [Fact]
    public void DetectsADeletedLine()
    {
        var dir = FreshDir();
        OperationJournal.Append(dir, "intent", "run-1", """"{"a":1}"""");
        OperationJournal.Append(dir, "phase", "run-1", """"{"b":2}"""");

        var path = Path.Combine(dir, OperationJournal.FileName);
        File.WriteAllLines(path, [File.ReadAllLines(path)[1]]);

        var (ok, _) = OperationJournal.Verify(dir);
        Assert.False(ok);
    }

    [Fact]
    public void ReadsOneRunsRecordsOldestFirst()
    {
        var dir = FreshDir();
        OperationJournal.Append(dir, "intent", "run-1", """"{"a":1}"""");
        OperationJournal.Append(dir, "intent", "run-2", """"{"a":2}"""");
        OperationJournal.Append(dir, "phase", "run-1", """"{"b":1}"""");

        var records = OperationJournal.ReadRun(dir, "run-1");

        Assert.Equal(2, records.Count);
        Assert.Equal(1, records[0].Seq);
        Assert.Equal(3, records[1].Seq);
    }

    [Fact]
    public void DiscardsATornTailAndJournalsTheRecovery()
    {
        var dir = FreshDir();
        OperationJournal.Append(dir, "intent", "run-1", """"{"a":1}"""");
        OperationJournal.Append(dir, "phase", "run-1", """"{"b":2}"""");
        OperationJournal.Append(dir, "phase", "run-1", """"{"c":3}"""");

        // Crash mid-append: a partial fourth line with no trailing newline.
        var path = Path.Combine(dir, OperationJournal.FileName);
        File.AppendAllText(path, """"{"seq":4,"ts":"2026-10-18T12}"""");

        var (before, _) = OperationJournal.Verify(dir);
        Assert.False(before);

        var (ok, kept, dropped, normalized, error) = OperationJournal.TryDiscardTornTail(dir);
        Assert.True(ok, error);
        Assert.Equal(3, kept);
        Assert.Equal(1, dropped);
        Assert.False(normalized);

        var (after, afterError) = OperationJournal.Verify(dir);
        Assert.True(after, afterError);

        // The kept records are untouched and chained; the truncation is
        // itself a verifiable record, not a silent rewrite.
        var records = OperationJournal.ReadRun(dir, "run-1");
        Assert.Equal(3, records.Count);
        Assert.Equal(3, records[2].Seq);
        var lines = File.ReadAllLines(path);
        Assert.Equal(4, lines.Length);
        Assert.Contains("journal_recovered", lines[3]);

        // And the journal accepts appends again (it was bricked before).
        OperationJournal.Append(dir, "phase", "run-1", """"{"d":4}"""");
        var (final, finalError) = OperationJournal.Verify(dir);
        Assert.True(final, finalError);
    }

    [Fact]
    public void RefusesToTruncateMidFileCorruption()
    {
        var dir = FreshDir();
        OperationJournal.Append(dir, "intent", "run-1", """"{"a":1}"""");
        OperationJournal.Append(dir, "phase", "run-1", """"{"b":2}"""");
        OperationJournal.Append(dir, "phase", "run-1", """"{"c":3}"""");

        var path = Path.Combine(dir, OperationJournal.FileName);
        var lines = File.ReadAllLines(path);
        lines[1] = lines[1].Replace("\"seq\":2", "\"seq\":7");
        File.WriteAllLines(path, lines);
        var before = File.ReadAllBytes(path);

        var (ok, _, _, _, error) = OperationJournal.TryDiscardTornTail(dir);
        Assert.False(ok);
        Assert.Contains("not a torn tail", error);
        // Evidence preserved byte-for-byte.
        Assert.True(before.SequenceEqual(File.ReadAllBytes(path)));
    }

    [Fact]
    public void RestoresAMissingTrailingNewline()
    {
        var dir = FreshDir();
        OperationJournal.Append(dir, "intent", "run-1", """"{"a":1}"""");
        OperationJournal.Append(dir, "phase", "run-1", """"{"b":2}"""");

        // Crash after the full line landed but before its newline: Verify
        // still passes (the hazard is silent), but the next append would
        // glue onto the unterminated tail.
        var path = Path.Combine(dir, OperationJournal.FileName);
        var raw = File.ReadAllBytes(path);
        File.WriteAllBytes(path, raw[..^1]);

        var (silent, _) = OperationJournal.Verify(dir);
        Assert.True(silent);

        var (ok, kept, dropped, normalized, error) = OperationJournal.TryDiscardTornTail(dir);
        Assert.True(ok, error);
        Assert.Equal(2, kept);
        Assert.Equal(0, dropped);
        Assert.True(normalized);

        var (after, afterError) = OperationJournal.Verify(dir);
        Assert.True(after, afterError);
    }

    [Fact]
    public void AppendTerminatesAnUnterminatedTail()
    {
        var dir = FreshDir();
        OperationJournal.Append(dir, "intent", "run-1", """"{"a":1}"""");

        var path = Path.Combine(dir, OperationJournal.FileName);
        var raw = File.ReadAllBytes(path);
        File.WriteAllBytes(path, raw[..^1]);

        // No reconcile runs here: Append itself must separate, or the two
        // records glue into one corrupt line.
        OperationJournal.Append(dir, "phase", "run-1", """"{"b":2}"""");

        var (ok, error) = OperationJournal.Verify(dir);
        Assert.True(ok, error);
        Assert.Equal(2, OperationJournal.ReadRun(dir, "run-1").Count);
    }

    [Fact]
    public void CleanJournalRecoveryIsANoOp()
    {
        var dir = FreshDir();
        OperationJournal.Append(dir, "intent", "run-1", """"{"a":1}"""");
        OperationJournal.Append(dir, "phase", "run-1", """"{"b":2}"""");

        var path = Path.Combine(dir, OperationJournal.FileName);
        var before = File.ReadAllBytes(path);

        var (ok, kept, dropped, normalized, error) = OperationJournal.TryDiscardTornTail(dir);
        Assert.True(ok, error);
        Assert.Equal(2, kept);
        Assert.Equal(0, dropped);
        Assert.False(normalized);
        Assert.True(before.SequenceEqual(File.ReadAllBytes(path)));
    }
}
