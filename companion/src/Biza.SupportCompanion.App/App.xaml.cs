using System.IO;
using System.Windows;
using Biza.SupportCompanion.Core;

namespace Biza.SupportCompanion.App;

/// <summary>
/// Single instance per desktop session: the first instance owns the mutex
/// and a link listener; later instances (protocol activations) drop their
/// URLs in the link dir, pulse the event, and exit. The maintenance gate —
/// not this mutex — serializes repair work across sessions.
/// </summary>
public partial class App : Application
{
    private const string MutexName = "BizaSupportCompanion.SingleInstance";
    private const string LinkEventName = "BizaSupportCompanion.LinkArrived";
    private const string LinkDirName = "BizaSupportCompanion.links";

    private Mutex? _instance;
    private Thread? _linkThread;
    private volatile bool _linkStop;
    private EventWaitHandle? _linkEvent;

    protected override void OnStartup(StartupEventArgs e)
    {
        bool first;
        try
        {
            _instance = new Mutex(true, MutexName, out first);
        }
        catch (AbandonedMutexException)
        {
            // The previous holder crashed holding it: this instance owns it.
            first = true;
            try
            {
                _instance = Mutex.OpenExisting(MutexName);
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                _instance = new Mutex(true, MutexName, out first);
            }
        }

        if (!first)
        {
            ForwardLinks(e.Args);
            Shutdown();
            return;
        }

        base.OnStartup(e);
        StartLinkListener();
        foreach (var url in LinkUrls(e.Args))
        {
            DeliverLink(url);
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _linkStop = true;
        try
        {
            _linkEvent?.Set();
        }
        catch (ObjectDisposedException)
        {
        }

        _instance?.Dispose();
        _instance = null;
        _linkEvent?.Dispose();
        _linkEvent = null;
        base.OnExit(e);
    }

    private static string LinkDir() => Path.Combine(Path.GetTempPath(), LinkDirName);

    private static IEnumerable<string> LinkUrls(string[] args)
    {
        // Protocol activations arrive as URLs; shell spawns use --ticket.
        // Both funnel into link handling so behavior stays uniform.
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            if (arg.StartsWith(SupportProtocol.Scheme + ":", StringComparison.OrdinalIgnoreCase))
            {
                yield return arg;
            }
            else if (string.Equals(arg, "--ticket", StringComparison.OrdinalIgnoreCase) &&
                i + 1 < args.Length)
            {
                i += 1;
                yield return SupportProtocol.TicketLink(args[i]);
            }
        }
    }

    private static void ForwardLinks(string[] args)
    {
        var urls = LinkUrls(args).ToList();
        if (urls.Count == 0)
        {
            return;
        }

        try
        {
            Directory.CreateDirectory(LinkDir());
            foreach (var url in urls)
            {
                File.WriteAllText(Path.Combine(LinkDir(), Guid.NewGuid().ToString("N") + ".link"), url);
            }

            using var pulse = EventWaitHandle.OpenExisting(LinkEventName);
            pulse.Set();
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException ||
            ex is WaitHandleCannotBeOpenedException || ex is ArgumentException)
        {
            // The first instance will poll the dir anyway on focus; a lost
            // pulse only delays delivery.
        }
    }

    private void StartLinkListener()
    {
        try
        {
            _linkEvent = new EventWaitHandle(false, EventResetMode.AutoReset, LinkEventName);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
            _linkEvent = null;
            return;
        }

        _linkThread = new Thread(LinkLoop) { IsBackground = true, Name = "companion-link-listener" };
        _linkThread.Start();
    }

    private void LinkLoop()
    {
        var handle = _linkEvent;
        while (!_linkStop)
        {
            try
            {
                handle?.WaitOne(TimeSpan.FromSeconds(1));
            }
            catch (ObjectDisposedException)
            {
                return;
            }

            if (_linkStop)
            {
                return;
            }

            foreach (var url in DrainLinkDir())
            {
                DeliverLink(url);
            }
        }
    }

    private static List<string> DrainLinkDir()
    {
        var urls = new List<string>();
        string[] files;
        try
        {
            if (!Directory.Exists(LinkDir()))
            {
                return urls;
            }

            files = Directory.GetFiles(LinkDir(), "*.link");
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
        {
            return urls;
        }

        foreach (var file in files)
        {
            try
            {
                var url = File.ReadAllText(file).Trim();
                File.Delete(file);
                if (url.Length > 0)
                {
                    urls.Add(url);
                }
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException)
            {
                // A second instance may still be writing it; next sweep.
            }
        }

        return urls;
    }

    private void DeliverLink(string url)
    {
        try
        {
            Dispatcher.InvokeAsync(() =>
            {
                if (MainWindow is MainWindow window)
                {
                    window.HandleDeepLink(url);
                }
            });
        }
        catch (TaskCanceledException)
        {
        }
    }
}
