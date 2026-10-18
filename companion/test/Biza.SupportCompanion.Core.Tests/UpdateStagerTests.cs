using System.IO;
using System.Security.Cryptography;
using System.Text;

using Biza.SupportCompanion.Core;

using Xunit;

namespace Biza.SupportCompanion.Core.Tests;

/// <summary>
/// The self-update trust chain: only manifest-matching bytes stage, any
/// mismatch wipes the staging dir, and the apply script only ever moves
/// verified files over a writable install dir.
/// </summary>
public sealed class UpdateStagerTests
{
    private static string FreshDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), "biza-stager-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static UpdateFile Entry(string path, byte[] bytes)
    {
        return new UpdateFile(path, bytes.LongLength, Convert.ToHexStringLower(SHA256.HashData(bytes)));
    }

    [Fact]
    public void StagesVerifiedFilesIncludingSubdirs()
    {
        var root = FreshDir();
        var staging = Path.Combine(root, "staging");
        var app = Encoding.UTF8.GetBytes("fake-companion-exe-bytes");
        var dll = Encoding.UTF8.GetBytes("fake-lib-bytes");
        var files = new List<UpdateFile> { Entry("BizaSupportCompanion.exe", app), Entry("lib/helper.dll", dll) };
        var store = new Dictionary<string, byte[]> { ["BizaSupportCompanion.exe"] = app, ["lib/helper.dll"] = dll };

        var ok = UpdateStager.TryStage(staging, files, f => store[f.Path], out var staged, out var error);

        Assert.True(ok, error);
        Assert.Equal(2, staged.Count);
        Assert.Equal(app, File.ReadAllBytes(Path.Combine(staging, "BizaSupportCompanion.exe")));
        Assert.Equal(dll, File.ReadAllBytes(Path.Combine(staging, "lib", "helper.dll")));
    }

    [Fact]
    public void SizeMismatchRefusesAndWipesStaging()
    {
        var root = FreshDir();
        var staging = Path.Combine(root, "staging");
        var bytes = Encoding.UTF8.GetBytes("short");
        var entry = new UpdateFile("app.exe", bytes.LongLength + 1, Convert.ToHexStringLower(SHA256.HashData(bytes)));

        var ok = UpdateStager.TryStage(staging, [entry], _ => bytes, out _, out var error);

        Assert.False(ok);
        Assert.Contains("size mismatch", error);
        Assert.False(Directory.Exists(staging));
    }

    [Fact]
    public void HashMismatchRefusesAndWipesStaging()
    {
        var root = FreshDir();
        var staging = Path.Combine(root, "staging");
        var bytes = Encoding.UTF8.GetBytes("tampered-bytes!");
        var entry = new UpdateFile("app.exe", bytes.LongLength, new string('0', 64));

        var ok = UpdateStager.TryStage(staging, [entry], _ => bytes, out _, out var error);

        Assert.False(ok);
        Assert.Contains("hash mismatch", error);
        Assert.False(Directory.Exists(staging));
    }

    [Fact]
    public void FetchFailuresRefuseAndWipeStaging()
    {
        var root = FreshDir();
        var good = Encoding.UTF8.GetBytes("good-bytes");

        var nullOk = UpdateStager.TryStage(
            Path.Combine(root, "s1"), [Entry("app.exe", good)], _ => null, out _, out var nullError);
        Assert.False(nullOk);
        Assert.Contains("fetch", nullError);
        Assert.False(Directory.Exists(Path.Combine(root, "s1")));

        var throwOk = UpdateStager.TryStage(
            Path.Combine(root, "s2"), [Entry("app.exe", good)],
            _ => throw new IOException("socket died"), out _, out var throwError);
        Assert.False(throwOk);
        Assert.Contains("fetch", throwError);
        Assert.False(Directory.Exists(Path.Combine(root, "s2")));
    }

    [Fact]
    public void OversizeManifestsRefuseBeforeAnyFetch()
    {
        var root = FreshDir();
        var calls = 0;
        var huge = new UpdateFile("big.bin", UpdateStager.MaxTotalBytes + 1, new string('0', 64));

        var ok = UpdateStager.TryStage(
            Path.Combine(root, "staging"), [huge],
            _ => { calls++; return null; }, out _, out var error);

        Assert.False(ok);
        Assert.Equal(0, calls);
        Assert.Contains("cap", error);
    }

    [Fact]
    public void UnsafePathsRefuse()
    {
        var root = FreshDir();
        var bytes = Encoding.UTF8.GetBytes("x");
        var evil = new UpdateFile("../evil.exe", bytes.LongLength, Convert.ToHexStringLower(SHA256.HashData(bytes)));

        var ok = UpdateStager.TryStage(
            Path.Combine(root, "staging"), [evil], _ => bytes, out _, out var error);

        Assert.False(ok);
        Assert.Contains("unsafe", error);
    }

    [Fact]
    public void ApplyScriptWaitsMovesAndRestarts()
    {
        var root = FreshDir();
        var staging = Path.Combine(root, "staging");
        var target = Path.Combine(root, "install");
        Directory.CreateDirectory(Path.Combine(staging, "lib"));
        Directory.CreateDirectory(target);
        File.WriteAllText(Path.Combine(staging, "BizaSupportCompanion.exe"), "exe");
        File.WriteAllText(Path.Combine(staging, "lib", "helper.dll"), "dll");
        var files = new List<UpdateFile>
        {
            new("BizaSupportCompanion.exe", 3, new string('0', 64)),
            new("lib/helper.dll", 3, new string('1', 64)),
        };

        var ok = UpdateStager.TryWriteApplyScript(
            staging, files, target, ownPid: 4242, "BizaSupportCompanion.exe",
            out var scriptPath, out var error);

        Assert.True(ok, error);
        var script = File.ReadAllText(scriptPath);
        Assert.Contains("4242", script);
        Assert.Contains("tasklist", script);
        Assert.Contains("BizaSupportCompanion.exe", script);
        Assert.Contains("mkdir", script);
        Assert.Contains("move /y", script);
        Assert.Contains(target, script);
    }

    [Fact]
    public void ApplyScriptRefusesUnwritableOrIncompleteTargets()
    {
        var root = FreshDir();
        var staging = Path.Combine(root, "staging");
        Directory.CreateDirectory(staging);
        File.WriteAllText(Path.Combine(staging, "app.exe"), "exe");
        var files = new List<UpdateFile> { new("app.exe", 3, new string('0', 64)), new("missing.dll", 3, new string('1', 64)) };

        Assert.False(UpdateStager.TryWriteApplyScript(
            staging, files, Path.Combine(root, "no-such-dir"), 1, "app.exe", out _, out var missingError));
        Assert.Contains("does not exist", missingError);

        var target = Path.Combine(root, "install");
        Directory.CreateDirectory(target);
        Assert.False(UpdateStager.TryWriteApplyScript(
            staging, files, target, 1, "app.exe", out _, out var incompleteError));
        Assert.Contains("incomplete", incompleteError);

        var fileAsTarget = Path.Combine(root, "file.txt");
        File.WriteAllText(fileAsTarget, "not a dir");
        Assert.False(UpdateStager.TryWriteApplyScript(
            staging, [files[0]], fileAsTarget, 1, "app.exe", out _, out var fileError));
        Assert.True(fileError.Contains("does not exist") || fileError.Contains("writable"), fileError);
    }
}
