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
  const int MAX_REQUEST_BYTES = 1024 * 1024;
  const int MAX_CREDENTIAL_BLOB_BYTES = 2560;
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
      using var input = Console.OpenStandardInput();
      using var memory = new System.IO.MemoryStream();
      var buffer = new byte[4096];
      byte[]? requestBytes = null;
      Request? request;
      try {
        int count;
        while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
          if (memory.Length + count > MAX_REQUEST_BYTES) return 1;
          memory.Write(buffer, 0, count);
        }
        requestBytes = memory.ToArray();
        request = JsonSerializer.Deserialize<Request>(requestBytes);
      } finally {
        if (requestBytes is not null) Array.Clear(requestBytes);
        if (memory.TryGetBuffer(out var contents)) Array.Clear(contents.Array!, contents.Offset, contents.Count);
        Array.Clear(buffer);
      }
      if (request is null || (request.target != "com.storenova.merchant-mcp" && request.target != "com.storenova.installation-identity")
        || !System.Text.RegularExpressions.Regex.IsMatch(request.account, "^(?:[a-f0-9]{64}|current-installation)$")) return 1;
      var name = request.target + ":" + request.account;
      if (request.operation == "write") {
        if (String.IsNullOrEmpty(request.data)) return 1;
        var clear = Encoding.UTF8.GetBytes(request.data); var entropy = SHA256.HashData(Encoding.UTF8.GetBytes(name));
        byte[] secret;
        try { secret = ProtectedData.Protect(clear, entropy, DataProtectionScope.CurrentUser); }
        finally { Array.Clear(clear); }
        if (secret.Length > MAX_CREDENTIAL_BLOB_BYTES) { Array.Clear(secret); return 1; }
        var handle = default(GCHandle);
        try { handle = GCHandle.Alloc(secret, GCHandleType.Pinned);
          var credential = new Credential { Type=CRED_TYPE_GENERIC, TargetName=name, CredentialBlobSize=(uint)secret.Length,
          CredentialBlob=handle.AddrOfPinnedObject(), Persist=CRED_PERSIST_LOCAL_MACHINE, UserName=request.account };
          if (CredWrite(ref credential, 0)) return 0;
          Diagnostic("CredWrite", Marshal.GetLastPInvokeError());
          return 1;
        } finally { Array.Clear(secret); if (handle.IsAllocated) handle.Free(); }
      }
      if (request.operation == "read" && CredRead(name, CRED_TYPE_GENERIC, 0, out var pointer)) {
        try { var credential = Marshal.PtrToStructure<Credential>(pointer);
          if (credential.CredentialBlobSize == 0 || credential.CredentialBlobSize > MAX_CREDENTIAL_BLOB_BYTES || credential.CredentialBlob == IntPtr.Zero) return 1;
          var encrypted = new byte[credential.CredentialBlobSize];
          try { Marshal.Copy(credential.CredentialBlob, encrypted, 0, encrypted.Length);
            var entropy = SHA256.HashData(Encoding.UTF8.GetBytes(name)); var secret = ProtectedData.Unprotect(encrypted, entropy, DataProtectionScope.CurrentUser);
            try { Console.OpenStandardOutput().Write(secret, 0, secret.Length); return 0; }
            finally { Array.Clear(secret); }
          } finally { Array.Clear(encrypted); }
        } finally { CredFree(pointer); }
      }
    } catch (Exception error) { Diagnostic(error.GetType().Name, 0); }
    return 1; // Never print credential values.
  }

  static void Diagnostic(string operation, int code) {
    if (Environment.GetEnvironmentVariable("GITHUB_ACTIONS") == "true")
      Console.Error.WriteLine($"Credential helper {operation} failed (Win32 {code}).");
  }
}
