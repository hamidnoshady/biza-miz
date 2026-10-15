# CAFE_POS_PRINT_CONNECTOR_V3
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$AllowedOrigin,
    # Further legitimate Cafe POS origins (e.g. a tenant's old subdomain kept
    # alive as an alias after a rename). $AllowedOrigin remains the primary one.
    [string[]]$AllowedOrigins = @()
)

# Cafe POS Windows Print Connector (protocol v3)
# This file is downloaded and started by the one-click installer in Printer Settings.
# It intentionally uses only Windows PowerShell and built-in .NET APIs: no Node.js,
# npm, repository checkout, administrator account, or shared printer is required.
#
# This connector is the ONE hardware gateway for Windows. It owns both ways a
# restaurant's printers are reached:
#   - Windows printer queues (Printers & scanners), printed RAW through the
#     native winspool.drv API — the predictable path for USB thermal printers.
#   - Network ESC/POS printers, discovered by scanning this machine's local
#     IPv4 subnets for the raw-print port 9100 and printed over TCP.
# The app server renders documents; it never reaches restaurant hardware.
#
# Endpoints (loopback 127.0.0.1:9123 only; browser calls must carry one of the
# exact allowed origins):
#   GET  /health
#   GET  /printers/windows              → installed Windows print queues
#   POST /printers/network/discover     → sweep local /24s for port 9100
#   POST /printers/probe                { target } → is it answering?
#   POST /print/raw                     { target, dataBase64 } → deliver bytes
#   POST /print/page                    { target, dataBase64 } → silent Windows page (PNG)
# `target` is { type: "windows", systemName } or { type: "network", ip, port }.

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$Port = 9123
$MaxHeaderBytes = 65536
$MaxBodyBytes = 16777216
$InstallDirectory = Join-Path $env:LOCALAPPDATA "CafePOS\PrintConnector"
$PidPath = Join-Path $InstallDirectory "connector.pid"
$LegacyPidPath = Join-Path $InstallDirectory "agent.pid"
$LogPath = Join-Path $InstallDirectory "connector.log"

New-Item -ItemType Directory -Force -Path $InstallDirectory | Out-Null

function Write-ConnectorLog {
    param([string]$Message)
    try {
        $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
        Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
    } catch {
        # Printing must not fail merely because a log file is temporarily locked.
    }
}

function ConvertTo-NormalizedOrigin {
    # One canonical spelling per origin, on both sides of the comparison:
    # lowercase scheme and host, default port dropped, trailing slash removed.
    # Browsers send Origin headers in exactly this form; normalizing this way
    # means http://EXAMPLE.com:443/ and https://example.com never accidentally
    # miss, without ever widening the match to a different origin.
    param([string]$Value)
    try {
        $uri = [Uri]($Value.Trim().TrimEnd("/"))
        if (-not $uri.IsAbsoluteUri -or ($uri.Scheme -ne "https" -and $uri.Scheme -ne "http")) { return "" }
        $port = ""
        if (-not $uri.IsDefaultPort) { $port = ":" + $uri.Port }
        return ($uri.Scheme.ToLowerInvariant() + "://" + $uri.Host.ToLowerInvariant() + $port)
    } catch {
        return ""
    }
}

$primaryOrigin = ConvertTo-NormalizedOrigin -Value $AllowedOrigin
if ($primaryOrigin -eq "") {
    Write-ConnectorLog "Invalid allowed origin."
    exit 2
}
$originSet = @{}
$originSet[$primaryOrigin] = $true
$AllowedOriginList = @($primaryOrigin)
foreach ($extra in @($AllowedOrigins)) {
    $normalized = ConvertTo-NormalizedOrigin -Value ([string]$extra)
    if ($normalized -ne "" -and -not $originSet.ContainsKey($normalized)) {
        $originSet[$normalized] = $true
        $AllowedOriginList += $normalized
    }
}
$AllowedOrigin = $primaryOrigin

$createdNew = $false
$mutex = [System.Threading.Mutex]::new($true, "Local\CafePOSPrintConnector9123", [ref]$createdNew)
if (-not $createdNew) {
    Write-ConnectorLog "Another connector instance is already running."
    exit 0
}

$nativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class CafePosRawPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private class DOC_INFO_1
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName = "Cafe POS";
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile = null;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype = "RAW";
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool OpenPrinter(string printerName, out IntPtr printer, IntPtr defaults);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr printer);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int StartDocPrinter(IntPtr printer, int level, [In] DOC_INFO_1 info);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndDocPrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool AbortPrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool StartPagePrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndPagePrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool WritePrinter(IntPtr printer, IntPtr bytes, int count, out int written);

    private static void ThrowLastError(string operation)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }

    public static void Send(string printerName, byte[] data)
    {
        if (String.IsNullOrWhiteSpace(printerName)) throw new ArgumentException("Printer name is required.");
        if (data == null || data.Length == 0) throw new ArgumentException("Print data is empty.");

        IntPtr printer = IntPtr.Zero;
        IntPtr unmanaged = IntPtr.Zero;
        bool documentStarted = false;
        bool pageStarted = false;
        bool completed = false;

        try
        {
            if (!OpenPrinter(printerName, out printer, IntPtr.Zero)) ThrowLastError("OpenPrinter");
            if (StartDocPrinter(printer, 1, new DOC_INFO_1()) == 0) ThrowLastError("StartDocPrinter");
            documentStarted = true;
            if (!StartPagePrinter(printer)) ThrowLastError("StartPagePrinter");
            pageStarted = true;

            unmanaged = Marshal.AllocCoTaskMem(data.Length);
            Marshal.Copy(data, 0, unmanaged, data.Length);
            int offset = 0;
            while (offset < data.Length)
            {
                int written;
                IntPtr cursor = new IntPtr(unmanaged.ToInt64() + offset);
                if (!WritePrinter(printer, cursor, data.Length - offset, out written)) ThrowLastError(offset > 0 ? "WritePrinterPartial" : "WritePrinter");
                if (written <= 0) throw new Win32Exception("WritePrinter wrote zero bytes.");
                offset += written;
            }
            completed = true;
        }
        finally
        {
            if (unmanaged != IntPtr.Zero) Marshal.FreeCoTaskMem(unmanaged);
            if (pageStarted && completed) EndPagePrinter(printer);
            if (documentStarted)
            {
                if (completed) EndDocPrinter(printer);
                else AbortPrinter(printer);
            }
            if (printer != IntPtr.Zero) ClosePrinter(printer);
        }
    }
}
'@

try {
    Add-Type -TypeDefinition $nativeSource -Language CSharp
} catch {
    Write-ConnectorLog ("Could not load native Windows printer support: " + $_.Exception.Message)
    exit 3
}

function ConvertTo-JsonBytes {
    param($Value)
    $json = ConvertTo-Json -InputObject $Value -Depth 8 -Compress
    return [Text.Encoding]::UTF8.GetBytes($json)
}

function Get-ObjectValue {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Find-HeaderEnd {
    param([byte[]]$Bytes)
    for ($index = 0; $index -le $Bytes.Length - 4; $index++) {
        if ($Bytes[$index] -eq 13 -and $Bytes[$index + 1] -eq 10 -and $Bytes[$index + 2] -eq 13 -and $Bytes[$index + 3] -eq 10) {
            return $index
        }
    }
    return -1
}

function Read-HttpRequest {
    param([Net.Sockets.NetworkStream]$Stream)

    $buffer = New-Object byte[] 8192
    $memory = New-Object IO.MemoryStream
    $headerEnd = -1

    while ($headerEnd -lt 0) {
        $read = $Stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) { throw "The client closed the connection before sending a request." }
        $memory.Write($buffer, 0, $read)
        if ($memory.Length -gt ($MaxHeaderBytes + $MaxBodyBytes)) { throw "The request is too large." }
        $headerEnd = Find-HeaderEnd -Bytes $memory.ToArray()
        if ($headerEnd -lt 0 -and $memory.Length -gt $MaxHeaderBytes) { throw "The request headers are too large." }
    }

    $allBytes = $memory.ToArray()
    $headerText = [Text.Encoding]::ASCII.GetString($allBytes, 0, $headerEnd)
    $lines = $headerText -split "`r`n"
    $requestParts = $lines[0] -split " "
    if ($requestParts.Length -lt 2) { throw "The HTTP request line is invalid." }

    $headers = @{}
    for ($index = 1; $index -lt $lines.Length; $index++) {
        $separator = $lines[$index].IndexOf(":")
        if ($separator -gt 0) {
            $name = $lines[$index].Substring(0, $separator).Trim().ToLowerInvariant()
            $headers[$name] = $lines[$index].Substring($separator + 1).Trim()
        }
    }

    $contentLength = 0
    if ($headers.ContainsKey("content-length")) {
        if (-not [int]::TryParse($headers["content-length"], [ref]$contentLength) -or $contentLength -lt 0 -or $contentLength -gt $MaxBodyBytes) {
            throw "The request body length is invalid."
        }
    }

    $bodyStart = $headerEnd + 4
    while (($allBytes.Length - $bodyStart) -lt $contentLength) {
        $read = $Stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) { throw "The client closed the connection before sending the request body." }
        $memory.Write($buffer, 0, $read)
        $allBytes = $memory.ToArray()
        if (($allBytes.Length - $bodyStart) -gt $MaxBodyBytes) { throw "The request body is too large." }
    }

    $body = ""
    if ($contentLength -gt 0) {
        $body = [Text.Encoding]::UTF8.GetString($allBytes, $bodyStart, $contentLength)
    }

    return [PSCustomObject]@{
        Method = $requestParts[0].ToUpperInvariant()
        Path = $requestParts[1].Split("?")[0]
        Headers = $headers
        Body = $body
    }
}

function Write-HttpResponse {
    param(
        [Net.Sockets.NetworkStream]$Stream,
        [int]$Status,
        [byte[]]$Body,
        [string]$RequestOrigin = "",
        [string]$ContentType = "application/json; charset=utf-8"
    )

    if ($null -eq $Body) { $Body = New-Object byte[] 0 }
    $statusText = switch ($Status) {
        200 { "OK" }
        204 { "No Content" }
        400 { "Bad Request" }
        403 { "Forbidden" }
        404 { "Not Found" }
        409 { "Conflict" }
        413 { "Payload Too Large" }
        500 { "Internal Server Error" }
        502 { "Bad Gateway" }
        default { "Error" }
    }

    $header = "HTTP/1.1 $Status $statusText`r`n" +
              "Content-Type: $ContentType`r`n" +
              "Content-Length: $($Body.Length)`r`n" +
              "Cache-Control: no-store`r`n" +
              "Access-Control-Allow-Private-Network: true`r`n" +
              "Vary: Origin`r`n"
    if ($RequestOrigin -and $originSet.ContainsKey($RequestOrigin)) {
        $header += "Access-Control-Allow-Origin: $RequestOrigin`r`n" +
                   "Access-Control-Allow-Methods: GET, POST, OPTIONS`r`n" +
                   "Access-Control-Allow-Headers: Content-Type`r`n"
    }
    $header += "Connection: close`r`n`r`n"

    $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
    $Stream.Flush()
}

function Write-JsonResponse {
    param(
        [Net.Sockets.NetworkStream]$Stream,
        [int]$Status,
        $Value,
        [string]$RequestOrigin = ""
    )
    Write-HttpResponse -Stream $Stream -Status $Status -Body (ConvertTo-JsonBytes -Value $Value) -RequestOrigin $RequestOrigin
}

function Get-WindowsPrinters {
    $items = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction Stop)
    foreach ($printer in $items) {
        $name = [string]$printer.Name
        [PSCustomObject]@{
            name = $name
            systemName = $name
            driver = [string]$printer.DriverName
            port = [string]$printer.PortName
            isDefault = [bool]$printer.Default
            status = [string]$printer.PrinterStatus
            likelyThermal = [bool]($name -match "(?i)(thermal|receipt|pos|xp-|rp-|tm-|80mm|58mm)")
        }
    }
}

function Get-LocalSubnets {
    # The IPv4 /24 prefixes this machine actually sits on, excluding loopback
    # and link-local addresses — the ranges worth sweeping for printers.
    $prefixes = @{}
    $interfaces = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()
    foreach ($interface in $interfaces) {
        try {
            if ($interface.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback) { continue }
            if (-not ($interface.Supports([System.Net.NetworkInformation.NetworkInterfaceComponent]::IPv4))) { continue }
            $properties = $interface.GetIPProperties()
            foreach ($address in $properties.UnicastAddresses) {
                if ($address.Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }
                $ip = $address.Address.ToString()
                if ($ip -eq "127.0.0.1") { continue }
                if ($ip -like "169.254.*") { continue }
                $parts = $ip.Split(".")
                if ($parts.Length -ne 4) { continue }
                $prefixes[($parts[0] + "." + $parts[1] + "." + $parts[2])] = $true
            }
        } catch {
            # One unreachable adapter must not abort the whole sweep.
        }
    }
    return @($prefixes.Keys)
}

function Find-NetworkPrinters {
    # Sweep each local /24 for an open raw-print port (9100), in bounded
    # windows of parallel TCP connects with a short per-window deadline, so
    # the scan finishes in a couple of seconds without opening 254 sockets at
    # once. Results are deduplicated by construction (one IP, one port) and
    # sorted by latency.
    param(
        [int]$TargetPort = 9100,
        [int]$TimeoutMs = 400,
        [int]$Concurrency = 64
    )

    $subnets = Get-LocalSubnets
    if ($subnets.Count -eq 0) { return @() }

    $targets = New-Object System.Collections.Generic.List[string]
    foreach ($subnet in $subnets) {
        for ($host = 1; $host -le 254; $host++) {
            $targets.Add("$subnet.$host")
        }
    }

    $found = New-Object System.Collections.Generic.List[object]
    $total = $targets.Count
    for ($index = 0; $index -lt $total; $index += $Concurrency) {
        $batch = New-Object System.Collections.Generic.List[object]
        $end = [Math]::Min($index + $Concurrency - 1, $total - 1)
        for ($i = $index; $i -le $end; $i++) {
            $ip = $targets[$i]
            $client = New-Object Net.Sockets.TcpClient
            $entry = [PSCustomObject]@{
                Ip = $ip
                Client = $client
                Watch = [System.Diagnostics.Stopwatch]::StartNew()
                ConnectTask = $null
            }
            try {
                $entry.ConnectTask = $client.ConnectAsync($ip, $TargetPort)
                $batch.Add($entry)
            } catch {
                try { $client.Dispose() } catch {}
            }
        }

        $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
        while ([DateTime]::UtcNow -lt $deadline) {
            $pending = $false
            foreach ($entry in $batch) {
                if ($entry.Client.Connected) { continue }
                if ($entry.ConnectTask -and $entry.ConnectTask.IsCompleted) { continue }
                $pending = $true
            }
            if (-not $pending) { break }
            Start-Sleep -Milliseconds 20
        }

        foreach ($entry in $batch) {
            try {
                if ($entry.Client.Connected) {
                    $entry.Watch.Stop()
                    $found.Add([PSCustomObject]@{
                        ip = $entry.Ip
                        port = $TargetPort
                        latencyMs = [int]$entry.Watch.ElapsedMilliseconds
                    })
                }
            } catch {} finally {
                try { $entry.Client.Dispose() } catch {}
            }
        }
    }

    return @($found | Sort-Object -Property latencyMs)
}

function Send-NetworkBytes {
    param([string]$Address, [int]$TargetPort, [byte[]]$Bytes)
    $client = New-Object Net.Sockets.TcpClient
    try {
        $connect = $client.ConnectAsync($Address, $TargetPort)
        if (-not $connect.Wait(5000) -or -not $client.Connected) { throw "The printer connection timed out." }
        $stream = $client.GetStream()
        try {
            $stream.WriteTimeout = 15000
            try {
                $stream.Write($Bytes, 0, $Bytes.Length)
                $stream.Flush()
            } catch {
                throw ("write_ambiguous: " + $_.Exception.Message)
            }
        } finally {
            $stream.Dispose()
        }
    } finally {
        $client.Dispose()
    }
}

function Get-PrintTarget {
    # `target` is the one shape every operation addresses a printer with:
    #   { type: "windows", systemName }  or  { type: "network", ip, port }.
    param($Payload)

    $target = Get-ObjectValue -Object $Payload -Name "target"
    if ($null -eq $target) { throw "The printer target is missing." }
    $typeValue = Get-ObjectValue -Object $target -Name "type"
    $type = if ($typeValue) { [string]$typeValue } else { "" }

    if ($type -eq "windows") {
        $name = [string](Get-ObjectValue -Object $target -Name "systemName")
        if ([string]::IsNullOrWhiteSpace($name)) { throw "The Windows printer name is missing." }
        return [PSCustomObject]@{ Type = "windows"; SystemName = $name; Ip = $null; Port = 0 }
    }
    if ($type -eq "network") {
        $address = [string](Get-ObjectValue -Object $target -Name "ip")
        if ([string]::IsNullOrWhiteSpace($address)) { throw "The printer address is missing." }
        $portValue = Get-ObjectValue -Object $target -Name "port"
        $targetPort = if ($portValue) { [int]$portValue } else { 9100 }
        if ($targetPort -lt 1 -or $targetPort -gt 65535) { throw "The printer port is invalid." }
        return [PSCustomObject]@{ Type = "network"; SystemName = $null; Ip = $address; Port = $targetPort }
    }
    throw "This printer connection is not supported by the Windows connector."
}

function Describe-Target {
    param($Target)
    if ($Target.Type -eq "windows") { return ("windows queue '" + $Target.SystemName + "'") }
    return ("network " + $Target.Ip + ":" + $Target.Port)
}

function Test-PrintTarget {
    param($Target)

    if ($Target.Type -eq "windows") {
        $found = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction Stop | Where-Object { $_.Name -eq $Target.SystemName }).Count -gt 0
        $detail = if ($found) { $Target.SystemName } else { "printer_not_found" }
        return [PSCustomObject]@{ reachable = $found; detail = $detail }
    }

    $client = New-Object Net.Sockets.TcpClient
    try {
        $connect = $client.ConnectAsync($Target.Ip, $Target.Port)
        $connected = $connect.Wait(5000) -and $client.Connected
        $detail = if ($connected) { ($Target.Ip + ":" + $Target.Port) } else { "timeout" }
        return [PSCustomObject]@{ reachable = $connected; detail = $detail }
    } finally {
        $client.Dispose()
    }
}

function ConvertFrom-Base64PrintData {
    param($Payload)
    $encoded = Get-ObjectValue -Object $Payload -Name "dataBase64"
    if (-not $encoded) { throw "Print data is missing." }
    try {
        [byte[]]$bytes = [Convert]::FromBase64String([string]$encoded)
    } catch {
        throw "Print data is invalid."
    }
    if ($bytes.Length -eq 0) { throw "Print data is empty." }
    return ,$bytes
}

function Handle-Request {
    param([Net.Sockets.NetworkStream]$Stream, $Request)

    $origin = if ($Request.Headers.ContainsKey("origin")) { ConvertTo-NormalizedOrigin -Value ([string]$Request.Headers["origin"]) } else { "" }
    $originAllowed = ($origin -ne "") -and $originSet.ContainsKey($origin)

    if ($Request.Method -eq "OPTIONS") {
        if (-not $originAllowed) {
            Write-JsonResponse -Stream $Stream -Status 403 -Value @{ ok = $false; error = "origin_forbidden" } -RequestOrigin $origin
        } else {
            Write-HttpResponse -Stream $Stream -Status 204 -Body (New-Object byte[] 0) -RequestOrigin $origin
        }
        return
    }

    # A no-Origin health request is useful to the installer itself. Every browser
    # operation, including browser health checks, is restricted to the exact POS origin.
    if ($Request.Path -eq "/health" -and $Request.Method -eq "GET" -and (-not $origin -or $originAllowed)) {
        $spoolerStatus = "unknown"
        try { $spoolerStatus = [string](Get-Service -Name Spooler -ErrorAction Stop).Status } catch { }
        Write-JsonResponse -Stream $Stream -Status 200 -Value @{
            ok = $true
            service = "cafe-pos-print-connector"
            version = 3
            release = "3.2.0"
            platform = "windows"
            allowedOrigin = $AllowedOrigin
            allowedOrigins = $AllowedOriginList
            printSubsystem = @{
                # The native winspool bridge is loaded before the listener starts,
                # so a health answer already implies it; the spooler service state
                # is the part that can still degrade at runtime.
                winspool = "ready"
                networkDiscovery = "ready"
                spooler = $spoolerStatus
            }
        } -RequestOrigin $origin
        return
    }

    if (-not $originAllowed) {
        Write-JsonResponse -Stream $Stream -Status 403 -Value @{ ok = $false; error = "origin_forbidden" } -RequestOrigin $origin
        return
    }

    if ($Request.Path -eq "/printers/windows" -and $Request.Method -eq "GET") {
        try {
            $printers = @(Get-WindowsPrinters)
            Write-JsonResponse -Stream $Stream -Status 200 -Value @{ ok = $true; printers = $printers } -RequestOrigin $origin
        } catch {
            Write-ConnectorLog ("Windows printer enumeration failed: " + $_.Exception.Message)
            Write-JsonResponse -Stream $Stream -Status 502 -Value @{ ok = $false; error = "print_failed"; detail = $_.Exception.Message } -RequestOrigin $origin
        }
        return
    }

    if ($Request.Path -eq "/printers/network/discover" -and $Request.Method -eq "POST") {
        try {
            $printers = @(Find-NetworkPrinters)
            Write-ConnectorLog ("Network discovery: found " + $printers.Count + " printer(s).")
            Write-JsonResponse -Stream $Stream -Status 200 -Value @{ ok = $true; printers = $printers } -RequestOrigin $origin
        } catch {
            Write-ConnectorLog ("Network discovery failed: " + $_.Exception.Message)
            Write-JsonResponse -Stream $Stream -Status 502 -Value @{ ok = $false; error = "print_failed"; detail = $_.Exception.Message } -RequestOrigin $origin
        }
        return
    }

    if ($Request.Path -eq "/printers/probe" -and $Request.Method -eq "POST") {
        $target = $null
        try {
            $payload = ConvertFrom-Json -InputObject $Request.Body
            $target = Get-PrintTarget -Payload $payload
        } catch {
            Write-JsonResponse -Stream $Stream -Status 400 -Value @{ ok = $false; error = "invalid_target"; detail = $_.Exception.Message } -RequestOrigin $origin
            return
        }
        try {
            $probe = Test-PrintTarget -Target $target
            if (-not $probe.reachable) {
                Write-ConnectorLog ("Probe failed for " + (Describe-Target $target) + ": " + $probe.detail)
            }
            Write-JsonResponse -Stream $Stream -Status 200 -Value @{ ok = $true; reachable = $probe.reachable; detail = $probe.detail } -RequestOrigin $origin
        } catch {
            Write-ConnectorLog ("Probe error for " + (Describe-Target $target) + ": " + $_.Exception.Message)
            Write-JsonResponse -Stream $Stream -Status 502 -Value @{ ok = $false; error = "print_failed"; detail = $_.Exception.Message } -RequestOrigin $origin
        }
        return
    }

    if ($Request.Path -eq "/print/raw" -and $Request.Method -eq "POST") {
        $target = $null
        try {
            $payload = ConvertFrom-Json -InputObject $Request.Body
            $target = Get-PrintTarget -Payload $payload
        } catch {
            Write-JsonResponse -Stream $Stream -Status 400 -Value @{ ok = $false; error = "invalid_target"; detail = $_.Exception.Message } -RequestOrigin $origin
            return
        }
        try {
            [byte[]]$bytes = ConvertFrom-Base64PrintData -Payload $payload
        } catch {
            Write-JsonResponse -Stream $Stream -Status 400 -Value @{ ok = $false; error = "invalid_target"; detail = $_.Exception.Message } -RequestOrigin $origin
            return
        }
        try {
            if ($target.Type -eq "windows") {
                $queue = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $target.SystemName }) | Select-Object -First 1
                if ($null -ne $queue -and ($queue.WorkOffline -eq $true -or [int]$queue.PrinterStatus -eq 7)) { throw "printer_offline" }
                [CafePosRawPrinter]::Send($target.SystemName, $bytes)
            } else {
                Send-NetworkBytes -Address $target.Ip -TargetPort $target.Port -Bytes $bytes
            }
            Write-ConnectorLog ("Printed " + $bytes.Length + " bytes to " + (Describe-Target $target))
            Write-JsonResponse -Stream $Stream -Status 200 -Value @{ ok = $true } -RequestOrigin $origin
        } catch {
            $message = $_.Exception.Message
            Write-ConnectorLog ("Print failed for " + (Describe-Target $target) + ": " + $message)
            $errorCode = "print_failed"
            $ambiguous = $true
            if ($message -match "write_ambiguous|WritePrinterPartial") {
                $errorCode = "job_timeout"
                $ambiguous = $true
            } elseif ($message -match "WritePrinter") {
                $errorCode = "print_failed"
                $ambiguous = $true
            } elseif ($target.Type -eq "windows") {
                if ($message -match "OpenPrinter|printer name|Invalid printer|printer_not_found") { $errorCode = "printer_not_found"; $ambiguous = $false }
                elseif ($message -match "printer_offline|WorkOffline") { $errorCode = "printer_offline"; $ambiguous = $false }
                elseif ($message -match "StartDocPrinter|StartPagePrinter") { $errorCode = "spooler_rejected"; $ambiguous = $false }
            } else {
                if ($message -match "timed out|refused|unreachable|No such host") { $errorCode = "network_unreachable"; $ambiguous = $false }
            }
            Write-JsonResponse -Stream $Stream -Status 502 -Value @{ ok = $false; error = $errorCode; ambiguous = $ambiguous; detail = $message } -RequestOrigin $origin
        }
        return
    }

    if ($Request.Path -eq "/print/page" -and $Request.Method -eq "POST") {
        $temp = $null
        $image = $null
        $doc = $null
        try {
            $payload = ConvertFrom-Json -InputObject $Request.Body
            $target = Get-PrintTarget -Payload $payload
            if ($target.Type -ne "windows") { throw "incompatible_printer" }
            [byte[]]$bytes = ConvertFrom-Base64PrintData -Payload $payload
            $queue = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $target.SystemName }) | Select-Object -First 1
            if ($null -ne $queue -and ($queue.WorkOffline -eq $true -or [int]$queue.PrinterStatus -eq 7)) { throw "printer_offline" }
            $temp = Join-Path $env:TEMP ("eshobe-page-" + [guid]::NewGuid().ToString("n") + ".png")
            [IO.File]::WriteAllBytes($temp, $bytes)
            Add-Type -AssemblyName System.Drawing
            $image = [System.Drawing.Image]::FromFile($temp)
            $doc = New-Object System.Drawing.Printing.PrintDocument
            $doc.PrinterSettings.PrinterName = $target.SystemName
            if (-not $doc.PrinterSettings.IsValid) { throw "printer_not_found" }
            $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
            $doc.DocumentName = "Eshobe"
            $script:pageImage = $image
            $script:pageOffset = 0
            $doc.add_PrintPage({
                param($sender, $e)
                $bounds = $e.MarginBounds
                $scale = $bounds.Width / $script:pageImage.Width
                $slice = [Math]::Max(1, [int]($bounds.Height / $scale))
                $take = [Math]::Min($slice, $script:pageImage.Height - $script:pageOffset)
                $destH = [Math]::Min($bounds.Height, [int]($take * $scale))
                $e.Graphics.DrawImage($script:pageImage, (New-Object System.Drawing.Rectangle($bounds.X, $bounds.Y, $bounds.Width, $destH)), (New-Object System.Drawing.Rectangle(0, $script:pageOffset, $script:pageImage.Width, $take)), [System.Drawing.GraphicsUnit]::Pixel)
                $script:pageOffset += $take
                $e.HasMorePages = $script:pageOffset -lt $script:pageImage.Height
            })
            try {
                $doc.Print()
            } catch {
                throw ("print_document_ambiguous: " + $_.Exception.Message)
            }
            Write-ConnectorLog ("Page handed off to " + $target.SystemName)
            Write-JsonResponse -Stream $Stream -Status 200 -Value @{ ok = $true } -RequestOrigin $origin
        } catch {
            $msg = $_.Exception.Message
            Write-ConnectorLog ("Page print failed: " + $msg)
            $code = "print_failed"
            $ambiguous = $true
            if ($msg -match "incompatible_printer") { $code = "incompatible_printer"; $ambiguous = $false }
            elseif ($msg -match "printer_not_found|Invalid printer") { $code = "printer_not_found"; $ambiguous = $false }
            elseif ($msg -match "printer_offline|WorkOffline") { $code = "printer_offline"; $ambiguous = $false }
            elseif ($msg -match "Print data is|The printer target|The Windows printer name") { $code = "invalid_printer"; $ambiguous = $false }
            Write-JsonResponse -Stream $Stream -Status 502 -Value @{ ok = $false; error = $code; ambiguous = $ambiguous; detail = $msg } -RequestOrigin $origin
        } finally {
            if ($null -ne $image) { try { $image.Dispose() } catch {} }
            if ($null -ne $doc) { try { $doc.Dispose() } catch {} }
            if ($null -ne $temp) { Remove-Item -LiteralPath $temp -ErrorAction SilentlyContinue }
        }
        return
    }

    Write-JsonResponse -Stream $Stream -Status 404 -Value @{ ok = $false; error = "not_found" } -RequestOrigin $origin
}

$listener = $null
try {
    Set-Content -LiteralPath $PidPath -Value $PID -Encoding ASCII
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    $originCountNote = if ($AllowedOriginList.Count -gt 1) { " (+" + ($AllowedOriginList.Count - 1) + " more origin(s))" } else { "" }
    Write-ConnectorLog ("Connector v3 (release 3.2.0) started on 127.0.0.1:" + $Port + " for " + $AllowedOrigin + $originCountNote + ".")

    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $client.ReceiveTimeout = 20000
            $client.SendTimeout = 20000
            $stream = $client.GetStream()
            try {
                $request = Read-HttpRequest -Stream $stream
                Handle-Request -Stream $stream -Request $request
            } catch {
                Write-ConnectorLog ("Request failed: " + $_.Exception.Message)
                try {
                    Write-JsonResponse -Stream $stream -Status 400 -Value @{ ok = $false; error = "invalid_request" }
                } catch {}
            } finally {
                $stream.Dispose()
            }
        } finally {
            $client.Dispose()
        }
    }
} catch {
    Write-ConnectorLog ("Connector stopped: " + $_.Exception.Message)
    exit 4
} finally {
    if ($null -ne $listener) { $listener.Stop() }
    Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    if ($null -ne $mutex) {
        try { $mutex.ReleaseMutex() } catch {}
        $mutex.Dispose()
    }
}
