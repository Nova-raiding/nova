using System;
using System.Collections.Generic;

namespace StoreNova.Connect
{
    // Packaging placeholder only. Production protocol handling remains disabled
    // until the executable is Authenticode-signed and requests are bound to the
    // installation instance. Do not add registry writes to this binary.
    internal static class Program
    {
        internal static bool IsSafeConnectUrl(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || value.Length > 2048 || value.Contains("\r") || value.Contains("\n")) return false;
            if (!Uri.TryCreate(value, UriKind.Absolute, out var url) || url.Scheme != "storenova" || url.Host != "connect"
                || (url.AbsolutePath != "" && url.AbsolutePath != "/") || !String.IsNullOrEmpty(url.Fragment)) return false;
            var allowed = new HashSet<string>(StringComparer.Ordinal) { "api_origin", "workspace", "request_id" };
            var found = new HashSet<string>(StringComparer.Ordinal);
            foreach (var pair in url.Query.TrimStart('?').Split('&'))
            {
                var parts = pair.Split(new[] {'='}, 2);
                var key = Uri.UnescapeDataString(parts[0]);
                if (!allowed.Contains(key) || !found.Add(key)) return false;
            }
            return found.SetEquals(allowed);
        }

        public static int Main(string[] args)
        {
            if (args.Length != 1 || !IsSafeConnectUrl(args[0])) return 78;
            Console.Error.WriteLine("STORE_NOVA_CONNECT_WINDOWS_NOT_PRODUCTION_READY");
            return 78;
        }
    }
}
