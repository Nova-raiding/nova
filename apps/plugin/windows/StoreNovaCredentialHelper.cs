using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

record Request(string operation, string target, string account, string? data);

static class Program {
  const uint CRED_TYPE_GENERIC = 1;
  const uint CRED_PERSIST_LOCAL_MACHINE = 2;
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Credential {
    public uint Flags, Type; public string TargetName, Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist, AttributeCount; public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWrite(ref Credential credential, uint flags);
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError=true)] static extern void CredFree(IntPtr buffer);

  static int Main() {
    try {
      using var input = Console.OpenStandardInput(); using var memory = new System.IO.MemoryStream(); input.CopyTo(memory);
      if (memory.Length > 1024 * 1024) return 1;
      var request = JsonSerializer.Deserialize<Request>(memory.ToArray());
      if (request is null || (request.target != "com.storenova.merchant-mcp" && request.target != "com.storenova.installation-identity")
        || !System.Text.RegularExpressions.Regex.IsMatch(request.account, "^(?:[a-f0-9]{64}|current-installation)$")) return 1;
      var name = request.target + ":" + request.account;
      if (request.operation == "write") {
        if (String.IsNullOrEmpty(request.data)) return 1;
        var clear = Encoding.UTF8.GetBytes(request.data); var entropy = SHA256.HashData(Encoding.UTF8.GetBytes(name));
        var secret = ProtectedData.Protect(clear, entropy, DataProtectionScope.CurrentUser); Array.Clear(clear);
        var handle = GCHandle.Alloc(secret, GCHandleType.Pinned);
        try { var credential = new Credential { Type=CRED_TYPE_GENERIC, TargetName=name, CredentialBlobSize=(uint)secret.Length,
          CredentialBlob=handle.AddrOfPinnedObject(), Persist=CRED_PERSIST_LOCAL_MACHINE, UserName=request.account };
          return CredWrite(ref credential, 0) ? 0 : 1;
        } finally { Array.Clear(secret); handle.Free(); }
      }
      if (request.operation == "read" && CredRead(name, CRED_TYPE_GENERIC, 0, out var pointer)) {
        try { var credential = Marshal.PtrToStructure<Credential>(pointer); var encrypted = new byte[credential.CredentialBlobSize]; Marshal.Copy(credential.CredentialBlob, encrypted, 0, encrypted.Length);
          var entropy = SHA256.HashData(Encoding.UTF8.GetBytes(name)); var secret = ProtectedData.Unprotect(encrypted, entropy, DataProtectionScope.CurrentUser); Array.Clear(encrypted);
          Console.OpenStandardOutput().Write(secret, 0, secret.Length); Array.Clear(secret); return 0;
        } finally { CredFree(pointer); }
      }
    } catch { }
    return 1; // Deliberately never print credential values or native error details.
  }
}
