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

        var first = OperationJournal.Append(dir, "intent", "run-1", """{"verb":"clean"}""");
        var second = OperationJournal.Append(dir, "phase", "run-1", """{"to":"executing"}""");

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
        OperationJournal.Append(dir, "intent", "run-1", """{"verb":"clean"}""");
        OperationJournal.Append(dir, "phase", "run-1", """{"to":"executing"}""");

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
        OperationJournal.Append(dir, "intent", "run-1", """{"a":1}""");
        OperationJournal.Append(dir, "phase", "run-1", """{"b":2}""");

        var path = Path.Combine(dir, OperationJournal.FileName);
        File.WriteAllLines(path, [File.ReadAllLines(path)[1]]);

        var (ok, _) = OperationJournal.Verify(dir);
        Assert.False(ok);
    }

    [Fact]
    public void ReadsOneRunsRecordsOldestFirst()
    {
        var dir = FreshDir();
        OperationJournal.Append(dir, "intent", "run-1", """{"a":1}""");
        OperationJournal.Append(dir, "intent", "run-2", """{"a":2}""");
        OperationJournal.Append(dir, "phase", "run-1", """{"b":1}""");

        var records = OperationJournal.ReadRun(dir, "run-1");

        Assert.Equal(2, records.Count);
        Assert.Equal(1, records[0].Seq);
        Assert.Equal(3, records[1].Seq);
    }
}
