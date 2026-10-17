using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace Biza.SupportCompanion.Core;

/// <summary>
/// Issue #984 — DPAPI secret storage via direct P/Invoke. The
/// <c>System.Security.Cryptography.ProtectedData</c> package is deliberately
/// NOT referenced: the core library is base-framework-only so it runs with no
/// network and no restore, and these two crypt32 calls are all it needs.
/// Current-user scope only — the companion is a per-user install and its
/// secrets (device credential, enrollment state) must not roam to other
/// Windows accounts on the machine.
/// </summary>
public static class Dpapi
{
    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob
    {
        public int cbData;
        public IntPtr pbData;
    }

    [DllImport("crypt32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptProtectData(
        ref DataBlob dataIn,
        IntPtr dataDescr,
        IntPtr optionalEntropy,
        IntPtr reserved,
        IntPtr promptStruct,
        int flags,
        out DataBlob dataOut);

    [DllImport("crypt32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(
        ref DataBlob dataIn,
        IntPtr dataDescr,
        IntPtr optionalEntropy,
        IntPtr reserved,
        IntPtr promptStruct,
        int flags,
        out DataBlob dataOut);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr handle);

    /// <summary>
    /// Protects <paramref name="plaintext"/> for the current Windows user.
    /// Throws <see cref="CryptographicException"/> when DPAPI refuses.
    /// </summary>
    public static byte[] Protect(byte[] plaintext)
    {
        ArgumentNullException.ThrowIfNull(plaintext);
        if (plaintext.Length == 0)
        {
            throw new ArgumentException("DPAPI protects non-empty payloads only.", nameof(plaintext));
        }

        var pinned = GCHandle.Alloc(plaintext, GCHandleType.Pinned);
        try
        {
            var inBlob = new DataBlob { cbData = plaintext.Length, pbData = pinned.AddrOfPinnedObject() };
            if (!CryptProtectData(ref inBlob, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out var outBlob))
            {
                throw new CryptographicException(Marshal.GetLastWin32Error());
            }

            try
            {
                var cipher = new byte[outBlob.cbData];
                Marshal.Copy(outBlob.pbData, cipher, 0, outBlob.cbData);
                return cipher;
            }
            finally
            {
                LocalFree(outBlob.pbData);
            }
        }
        finally
        {
            pinned.Free();
        }
    }

    /// <summary>
    /// Unprotects a blob previously protected for the current Windows user.
    /// Throws <see cref="CryptographicException"/> for foreign or corrupted
    /// blobs — callers fail closed, they never fall back to plaintext.
    /// </summary>
    public static byte[] Unprotect(byte[] protectedBytes)
    {
        ArgumentNullException.ThrowIfNull(protectedBytes);
        if (protectedBytes.Length == 0)
        {
            throw new ArgumentException("DPAPI unprotects non-empty payloads only.", nameof(protectedBytes));
        }

        var pinned = GCHandle.Alloc(protectedBytes, GCHandleType.Pinned);
        try
        {
            var inBlob = new DataBlob { cbData = protectedBytes.Length, pbData = pinned.AddrOfPinnedObject() };
            if (!CryptUnprotectData(ref inBlob, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out var outBlob))
            {
                throw new CryptographicException(Marshal.GetLastWin32Error());
            }

            try
            {
                var plain = new byte[outBlob.cbData];
                Marshal.Copy(outBlob.pbData, plain, 0, outBlob.cbData);
                return plain;
            }
            finally
            {
                LocalFree(outBlob.pbData);
            }
        }
        finally
        {
            pinned.Free();
        }
    }
}
