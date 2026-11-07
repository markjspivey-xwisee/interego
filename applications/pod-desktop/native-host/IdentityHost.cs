// A console executable deliberately independent of Electron's GUI/stdin handling.
// Windows 10/11, CLR 4.x; compiled with the inbox .NET Framework C# compiler.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32;

internal static class IdentityHost
{
    private const int MaxFrame = 64 * 1024;
    private const int MaxHttp = 128 * 1024;
    private const string Failure = "This local identity request could not be completed. Open Interego and try again.";
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly Regex Id = new Regex(@"\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z", RegexOptions.CultureInvariant);
    private static readonly Regex Origin = new Regex(@"\Achrome-extension://[a-p]{32}/?\z", RegexOptions.CultureInvariant);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxHttp, RecursionLimit = 24 };

    private sealed class Context : IDisposable
    {
        internal string ConnectionId;
        internal string SessionId;
        internal string Url;
        internal byte[] Secret;
        public void Dispose() { if (Secret != null) Array.Clear(Secret, 0, Secret.Length); }
    }

    private static int Main(string[] args)
    {
        // Fixed-key, read-only registration inspection. Neither registry values
        // nor request-selected registry locations enter the response.
        if (args.Length > 0 && args[0] == "--registration-status")
        {
            if (args.Length != 1) return 1;
            try
            {
                byte[] request = ReadBounded(Console.OpenStandardInput(), 4096);
                try
                {
                    Dictionary<string, object> registrationInput = Parse(request);
                    ExactKeys(registrationInput, "manifestPath");
                    string expected = BoundedString(registrationInput["manifestPath"], 4096);
                    if (!Regex.IsMatch(expected, @"\A[A-Za-z]:\\", RegexOptions.CultureInvariant)
                        || expected.StartsWith(@"\\", StringComparison.Ordinal)
                        || !String.Equals(Path.GetFileName(expected), "com.interego.identity.json", StringComparison.Ordinal)
                        || !String.Equals(Path.GetFullPath(expected), expected, StringComparison.OrdinalIgnoreCase)) return 1;
                    Dictionary<string, object> result = Record("version", 1,
                        "chrome", ReadBrowserRegistration(@"Software\Google\Chrome\NativeMessagingHosts\com.interego.identity", expected),
                        "edge", ReadBrowserRegistration(@"Software\Microsoft\Edge\NativeMessagingHosts\com.interego.identity", expected));
                    Console.Out.Write(Json.Serialize(result));
                    Console.Out.Flush();
                    return 0;
                }
                finally { Array.Clear(request, 0, request.Length); }
            }
            catch { return 1; }
        }

        // Protection mode has no Native Messaging framing and never accepts a secret in argv.
        if (args.Length == 1 && args[0] == "--protect-ticket")
        {
            try
            {
                byte[] plaintext = ReadBounded(Console.OpenStandardInput(), 4096);
                byte[] protectedBytes = null;
                byte[] secret = null;
                try
                {
                    Dictionary<string, object> ticket = Parse(plaintext);
                    ValidateTicket(ticket, out secret);
                    protectedBytes = ProtectedData.Protect(plaintext, null, DataProtectionScope.CurrentUser);
                    Console.Out.Write(Convert.ToBase64String(protectedBytes));
                    Console.Out.Flush();
                    return 0;
                }
                finally
                {
                    Array.Clear(plaintext, 0, plaintext.Length);
                    if (secret != null) Array.Clear(secret, 0, secret.Length);
                    if (protectedBytes != null) Array.Clear(protectedBytes, 0, protectedBytes.Length);
                }
            }
            catch { return 1; }
        }

        Stream input = Console.OpenStandardInput();
        Stream output = Console.OpenStandardOutput();
        Context context = null;
        bool linking = false;
        string channel = Guid.NewGuid().ToString("D");
        string browserOrigin;
        string dataDir;
        try { ParseArguments(args, out browserOrigin, out dataDir); }
        catch { WriteError(output, null); return 1; }

        try
        {
            while (true)
            {
                byte[] frame;
                try { frame = ReadFrame(input); }
                catch { WriteError(output, null); return 1; }
                if (frame == null) break;
                string browserId = null;
                try
                {
                    Dictionary<string, object> message = Parse(frame);
                    object candidate;
                    if (message.TryGetValue("id", out candidate) && IsId(candidate)) browserId = (string)candidate;
                    string operation;
                    Dictionary<string, object> arguments;
                    ValidateMessage(message, out operation, out arguments);
                    if (operation == "start") linking = Regex.IsMatch((string)arguments["handoffCode"], @"\Ainterego-link:v1:[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\z", RegexOptions.CultureInvariant);
                    if (context == null) context = LoadContext(dataDir);
                    Dictionary<string, object> result = Exchange(context, browserOrigin, channel, operation, arguments, linking);
                    Dictionary<string, object> reply = Record("version", 1, "id", browserId, "ok", result["ok"]);
                    if ((bool)result["ok"]) reply.Add("value", result["value"]);
                    else reply.Add("error", Failure);
                    WriteFrame(output, reply);
                }
                catch { WriteError(output, browserId); }
                finally { Array.Clear(frame, 0, frame.Length); }
            }
            return 0;
        }
        catch { return 1; }
        finally
        {
            // connectNative's port lifetime is also the approval/channel lifetime.
            if (context != null)
            {
                try { Exchange(context, browserOrigin, channel, "close", new Dictionary<string, object>(), linking); }
                catch { /* Shutdown cannot write a second, unsolicited browser response. */ }
                context.Dispose();
            }
        }
    }

    private static string ReadBrowserRegistration(string subkey, string expected)
    {
        try
        {
            using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64))
            using (RegistryKey key = root.OpenSubKey(subkey, false))
                return RegistrationState(key, expected);
        }
        catch { return "unavailable"; }
    }

    // The test assembly supplies only its own isolated RegistryKey. Release
    // command dispatch above always selects the two fixed browser keys.
    internal static string RegistrationState(RegistryKey key, string expected)
    {
        try
        {
            if (key == null) return "absent";
            bool hasDefault = false;
            foreach (string name in key.GetValueNames()) if (name.Length == 0) hasDefault = true;
            if (!hasDefault) return "absent";
            // GetValue can return its default for unsupported native kinds too.
            // Establish presence and type before asking for the string payload.
            if (key.GetValueKind(String.Empty) != RegistryValueKind.String) return "wrong-type";
            object missing = new object();
            object value = key.GetValue(String.Empty, missing, RegistryValueOptions.DoNotExpandEnvironmentNames);
            if (Object.ReferenceEquals(value, missing)) return "unavailable";
            string path = value as string;
            if (path == null) return "unavailable";
            if (path.Length == 0) return "foreign";
            return String.Equals(path, expected, StringComparison.OrdinalIgnoreCase) ? "matching" : "foreign";
        }
        catch { return "unavailable"; }
    }

    private static void ParseArguments(string[] args, out string browserOrigin, out string dataDir)
    {
        browserOrigin = null;
        dataDir = Environment.GetEnvironmentVariable("INTEREGO_POD_DATA_DIR");
        bool explicitDirectory = false;
        bool parentWindow = false;
        for (int i = 0; i < args.Length; i++)
        {
            string arg = args[i];
            if (Origin.IsMatch(arg) && browserOrigin == null) browserOrigin = arg.TrimEnd('/');
            else if (arg == "--pod-data-dir" && !explicitDirectory && i + 1 < args.Length)
            {
                dataDir = args[++i];
                explicitDirectory = true;
            }
            else if (!parentWindow && Regex.IsMatch(arg, @"\A--parent-window=[0-9]{1,20}\z", RegexOptions.CultureInvariant)) parentWindow = true;
            else throw new InvalidDataException();
        }
        if (browserOrigin == null) throw new InvalidDataException();
        if (String.IsNullOrEmpty(dataDir)) dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Interego");
        if (!Path.IsPathRooted(dataDir) || dataDir.StartsWith(@"\\", StringComparison.Ordinal)) throw new InvalidDataException();
        dataDir = Path.GetFullPath(dataDir);
    }

    private static Context LoadContext(string dataDir)
    {
        string directory = Path.Combine(dataDir, "identity-browser");
        byte[] protectedBytes = CanonicalBase64(Utf8.GetString(ReadFile(Path.Combine(directory, "ticket.bin"), 16 * 1024)), null);
        byte[] plaintext = null;
        byte[] secret = null;
        try
        {
            plaintext = ProtectedData.Unprotect(protectedBytes, null, DataProtectionScope.CurrentUser);
            if (plaintext.Length > 4096) throw new InvalidDataException();
            Dictionary<string, object> ticket = Parse(plaintext);
            ValidateTicket(ticket, out secret);
            Dictionary<string, object> endpoint = Parse(ReadFile(Path.Combine(directory, "endpoint.json"), 4096));
            ExactKeys(endpoint, "version", "url", "sessionId");
            if (!VersionOne(endpoint["version"]) || !IsId(endpoint["sessionId"]) || !(endpoint["url"] is string)) throw new InvalidDataException();
            string url = (string)endpoint["url"];
            Match match = Regex.Match(url, @"\Ahttp://127\.0\.0\.1:([1-9][0-9]{0,4})/identity-browser\z", RegexOptions.CultureInvariant);
            if (!match.Success || Int32.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture) > 65535) throw new InvalidDataException();
            Context result = new Context { ConnectionId = (string)ticket["connectionId"], SessionId = (string)endpoint["sessionId"], Url = url, Secret = secret };
            secret = null;
            return result;
        }
        finally
        {
            Array.Clear(protectedBytes, 0, protectedBytes.Length);
            if (plaintext != null) Array.Clear(plaintext, 0, plaintext.Length);
            if (secret != null) Array.Clear(secret, 0, secret.Length);
        }
    }

    private static void ValidateTicket(Dictionary<string, object> ticket, out byte[] secret)
    {
        secret = null;
        ExactKeys(ticket, "version", "connectionId", "secret");
        if (!VersionOne(ticket["version"]) || !IsId(ticket["connectionId"])) throw new InvalidDataException();
        secret = CanonicalBase64(ticket["secret"], 32);
    }

    private static void ValidateMessage(Dictionary<string, object> message, out string operation, out Dictionary<string, object> arguments)
    {
        if (!message.ContainsKey("version") || !VersionOne(message["version"]) || !message.ContainsKey("id") || !IsId(message["id"])
            || !message.ContainsKey("operation") || !(message["operation"] is string)) throw new InvalidDataException();
        operation = (string)message["operation"];
        if (operation == "start")
        {
            ExactKeys(message, "version", "id", "operation", "relayOrigin", "handoffCode");
            arguments = Record("relayOrigin", BoundedString(message["relayOrigin"], 2048), "handoffCode", BoundedString(message["handoffCode"], 2048));
        }
        else if (operation == "poll" || operation == "cancel")
        {
            ExactKeys(message, "version", "id", "operation", "requestId", "receipt");
            if (!IsId(message["requestId"])) throw new InvalidDataException();
            arguments = Record("requestId", message["requestId"], "receipt", BoundedString(message["receipt"], 2048));
        }
        else throw new InvalidDataException();
    }

    private static Dictionary<string, object> Exchange(Context context, string origin, string channel, string operation, Dictionary<string, object> arguments, bool linking)
    {
        string requestId = Guid.NewGuid().ToString("D");
        long issuedAt = (DateTime.UtcNow.Ticks - 621355968000000000L) / TimeSpan.TicksPerMillisecond;
        Dictionary<string, object> body = Record("issuedAt", issuedAt, "browserOrigin", origin, "channel", channel, "operation", operation, "arguments", arguments);
        byte[] payload = Utf8.GetBytes(Json.Serialize(Seal(context, requestId, body)));
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(context.Url);
        request.Method = "POST";
        request.ContentType = "application/json";
        request.Accept = "application/json";
        request.ContentLength = payload.Length;
        request.Proxy = null;
        request.AllowAutoRedirect = false;
        request.Timeout = linking ? 60000 : 15000;
        request.ReadWriteTimeout = linking ? 60000 : 15000;
        request.KeepAlive = false;
        request.ServicePoint.Expect100Continue = false;
        // HttpWebRequest's header and stream timeouts are separate. Keep the
        // link-only outer ceiling absolute even when both phases make progress.
        System.Threading.Timer deadline = linking ? new System.Threading.Timer(_ => { try { request.Abort(); } catch { } }, null, 60000, System.Threading.Timeout.Infinite) : null;
        try
        {
            using (Stream stream = request.GetRequestStream()) stream.Write(payload, 0, payload.Length);
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                if (response.StatusCode != HttpStatusCode.OK || response.ContentLength > MaxHttp
                    || response.ContentType == null || !response.ContentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
                byte[] bytes;
                using (Stream stream = response.GetResponseStream()) bytes = ReadBounded(stream, MaxHttp);
                Dictionary<string, object> result = Open(context, requestId, Parse(bytes));
                object ok;
                if (!result.TryGetValue("ok", out ok) || !(ok is bool)) throw new InvalidDataException();
                if ((bool)ok) ExactKeys(result, "ok", "value");
                else ExactKeys(result, "ok", "error");
                return result;
            }
        }
        finally { if (deadline != null) deadline.Dispose(); Array.Clear(payload, 0, payload.Length); request.Abort(); }
    }

    private static Dictionary<string, object> Seal(Context context, string requestId, object value)
    {
        byte[] key = DeriveKey(context, "request");
        byte[] nonce = new byte[12];
        using (RandomNumberGenerator rng = RandomNumberGenerator.Create()) rng.GetBytes(nonce);
        byte[] tag = new byte[16];
        byte[] plaintext = Utf8.GetBytes(Json.Serialize(value));
        try
        {
            byte[] ciphertext = AesGcm(true, key, nonce, Aad(context, requestId, "request"), plaintext, tag);
            return Record("version", 1, "connectionId", context.ConnectionId, "sessionId", context.SessionId, "requestId", requestId,
                "nonce", Convert.ToBase64String(nonce), "ciphertext", Convert.ToBase64String(ciphertext), "tag", Convert.ToBase64String(tag));
        }
        finally { Array.Clear(key, 0, key.Length); Array.Clear(plaintext, 0, plaintext.Length); }
    }

    private static Dictionary<string, object> Open(Context context, string requestId, Dictionary<string, object> envelope)
    {
        ExactKeys(envelope, "version", "connectionId", "sessionId", "requestId", "nonce", "ciphertext", "tag");
        if (!VersionOne(envelope["version"]) || !Object.Equals(envelope["connectionId"], context.ConnectionId)
            || !Object.Equals(envelope["sessionId"], context.SessionId) || !Object.Equals(envelope["requestId"], requestId)) throw new InvalidDataException();
        byte[] key = DeriveKey(context, "response");
        byte[] plaintext = null;
        try
        {
            plaintext = AesGcm(false, key, CanonicalBase64(envelope["nonce"], 12), Aad(context, requestId, "response"),
                CanonicalBase64(envelope["ciphertext"], null), CanonicalBase64(envelope["tag"], 16));
            if (plaintext.Length > MaxFrame) throw new InvalidDataException();
            return Parse(plaintext);
        }
        finally { Array.Clear(key, 0, key.Length); if (plaintext != null) Array.Clear(plaintext, 0, plaintext.Length); }
    }

    // RFC 5869, a single SHA-256 expansion block. Salt/info match agent-protocol.ts byte for byte.
    private static byte[] DeriveKey(Context context, string direction)
    {
        byte[] prk;
        using (HMACSHA256 extract = new HMACSHA256(Utf8.GetBytes(context.SessionId))) prk = extract.ComputeHash(context.Secret);
        try
        {
            byte[] info = Utf8.GetBytes("interego.local-agent/v1:" + direction + "\x01");
            using (HMACSHA256 expand = new HMACSHA256(prk)) return expand.ComputeHash(info);
        }
        finally { Array.Clear(prk, 0, prk.Length); }
    }

    private static byte[] Aad(Context context, string requestId, string direction)
    {
        return Utf8.GetBytes(Json.Serialize(new string[] { "interego.local-agent/v1", direction, context.ConnectionId, context.SessionId, requestId }));
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AuthInfo
    {
        internal uint cbSize;
        internal uint dwInfoVersion;
        internal IntPtr pbNonce;
        internal uint cbNonce;
        internal IntPtr pbAuthData;
        internal uint cbAuthData;
        internal IntPtr pbTag;
        internal uint cbTag;
        internal IntPtr pbMacContext;
        internal uint cbMacContext;
        internal uint cbAAD;
        internal ulong cbData;
        internal uint dwFlags;
    }

    [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)]
    private static extern int BCryptOpenAlgorithmProvider(out IntPtr algorithm, string id, string implementation, uint flags);
    [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)]
    private static extern int BCryptSetProperty(IntPtr algorithm, string property, byte[] input, int length, uint flags);
    [DllImport("bcrypt.dll")]
    private static extern int BCryptGenerateSymmetricKey(IntPtr algorithm, out IntPtr key, IntPtr keyObject, int keyObjectLength, byte[] secret, int secretLength, uint flags);
    [DllImport("bcrypt.dll")]
    private static extern int BCryptEncrypt(IntPtr key, byte[] input, int inputLength, ref AuthInfo info, IntPtr iv, int ivLength, byte[] output, int outputLength, out int resultLength, uint flags);
    [DllImport("bcrypt.dll")]
    private static extern int BCryptDecrypt(IntPtr key, byte[] input, int inputLength, ref AuthInfo info, IntPtr iv, int ivLength, byte[] output, int outputLength, out int resultLength, uint flags);
    [DllImport("bcrypt.dll")]
    private static extern int BCryptDestroyKey(IntPtr key);
    [DllImport("bcrypt.dll")]
    private static extern int BCryptCloseAlgorithmProvider(IntPtr algorithm, uint flags);

    private static void CheckStatus(int status) { if (status != 0) throw new CryptographicException(); }

    private static byte[] AesGcm(bool encrypt, byte[] keyBytes, byte[] nonce, byte[] aad, byte[] input, byte[] tag)
    {
        IntPtr algorithm = IntPtr.Zero;
        IntPtr key = IntPtr.Zero;
        GCHandle noncePin = new GCHandle();
        GCHandle aadPin = new GCHandle();
        GCHandle tagPin = new GCHandle();
        byte[] output = new byte[input.Length];
        try
        {
            CheckStatus(BCryptOpenAlgorithmProvider(out algorithm, "AES", null, 0));
            byte[] mode = Encoding.Unicode.GetBytes("ChainingModeGCM\0");
            CheckStatus(BCryptSetProperty(algorithm, "ChainingMode", mode, mode.Length, 0));
            // CNG owns its key object when NULL/zero is supplied (Windows 7 and later).
            CheckStatus(BCryptGenerateSymmetricKey(algorithm, out key, IntPtr.Zero, 0, keyBytes, keyBytes.Length, 0));
            noncePin = GCHandle.Alloc(nonce, GCHandleType.Pinned);
            aadPin = GCHandle.Alloc(aad, GCHandleType.Pinned);
            tagPin = GCHandle.Alloc(tag, GCHandleType.Pinned);
            AuthInfo info = new AuthInfo { cbSize = (uint)Marshal.SizeOf(typeof(AuthInfo)), dwInfoVersion = 1,
                pbNonce = noncePin.AddrOfPinnedObject(), cbNonce = (uint)nonce.Length,
                pbAuthData = aadPin.AddrOfPinnedObject(), cbAuthData = (uint)aad.Length,
                pbTag = tagPin.AddrOfPinnedObject(), cbTag = (uint)tag.Length };
            int written;
            int status = encrypt
                ? BCryptEncrypt(key, input, input.Length, ref info, IntPtr.Zero, 0, output, output.Length, out written, 0)
                : BCryptDecrypt(key, input, input.Length, ref info, IntPtr.Zero, 0, output, output.Length, out written, 0);
            CheckStatus(status);
            if (written != input.Length) throw new CryptographicException();
            return output;
        }
        catch { Array.Clear(output, 0, output.Length); throw; }
        finally
        {
            if (noncePin.IsAllocated) noncePin.Free();
            if (aadPin.IsAllocated) aadPin.Free();
            if (tagPin.IsAllocated) tagPin.Free();
            if (key != IntPtr.Zero) BCryptDestroyKey(key);
            if (algorithm != IntPtr.Zero) BCryptCloseAlgorithmProvider(algorithm, 0);
        }
    }

    private static Dictionary<string, object> Parse(byte[] bytes)
    {
        Dictionary<string, object> value = Json.DeserializeObject(Utf8.GetString(bytes)) as Dictionary<string, object>;
        if (value == null) throw new InvalidDataException();
        return value;
    }

    private static bool VersionOne(object value) { return value is int && (int)value == 1; }
    private static bool IsId(object value) { return value is string && Id.IsMatch((string)value); }

    private static string BoundedString(object value, int limit)
    {
        string text = value as string;
        if (String.IsNullOrEmpty(text) || text.Length > limit) throw new InvalidDataException();
        foreach (char character in text) if (Char.IsControl(character)) throw new InvalidDataException();
        return text;
    }

    private static byte[] CanonicalBase64(object value, int? length)
    {
        string text = value as string;
        if (text == null || text.Length > MaxHttp) throw new InvalidDataException();
        byte[] bytes = Convert.FromBase64String(text);
        if (Convert.ToBase64String(bytes) != text || (length.HasValue && bytes.Length != length.Value)) throw new InvalidDataException();
        return bytes;
    }

    private static void ExactKeys(Dictionary<string, object> record, params string[] names)
    {
        if (record.Count != names.Length) throw new InvalidDataException();
        foreach (string name in names) if (!record.ContainsKey(name)) throw new InvalidDataException();
    }

    private static Dictionary<string, object> Record(params object[] pairs)
    {
        Dictionary<string, object> record = new Dictionary<string, object>();
        for (int i = 0; i < pairs.Length; i += 2) record.Add((string)pairs[i], pairs[i + 1]);
        return record;
    }

    private static byte[] ReadFile(string path, int max)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
        using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) return ReadBounded(stream, max);
    }

    private static byte[] ReadBounded(Stream stream, int max)
    {
        using (MemoryStream result = new MemoryStream())
        {
            byte[] buffer = new byte[4096];
            int read;
            while ((read = stream.Read(buffer, 0, Math.Min(buffer.Length, max + 1 - (int)result.Length))) != 0)
            {
                result.Write(buffer, 0, read);
                if (result.Length > max) throw new InvalidDataException();
            }
            return result.ToArray();
        }
    }

    private static byte[] ReadFrame(Stream input)
    {
        byte[] header = new byte[4];
        int first = input.ReadByte();
        if (first == -1) return null;
        header[0] = (byte)first;
        ReadExactly(input, header, 1, 3);
        uint length = (uint)(header[0] | header[1] << 8 | header[2] << 16 | header[3] << 24);
        if (length == 0 || length > MaxFrame) throw new InvalidDataException();
        byte[] frame = new byte[(int)length];
        ReadExactly(input, frame, 0, frame.Length);
        return frame;
    }

    private static void ReadExactly(Stream input, byte[] bytes, int offset, int count)
    {
        while (count > 0)
        {
            int read = input.Read(bytes, offset, count);
            if (read == 0) throw new EndOfStreamException();
            offset += read;
            count -= read;
        }
    }

    private static void WriteError(Stream output, string id)
    {
        WriteFrame(output, Record("version", 1, "id", id, "ok", false, "error", Failure));
    }

    private static void WriteFrame(Stream output, object value)
    {
        byte[] bytes = Utf8.GetBytes(Json.Serialize(value));
        if (bytes.Length == 0 || bytes.Length > MaxFrame) throw new InvalidDataException();
        uint length = (uint)bytes.Length;
        byte[] header = new byte[] { (byte)length, (byte)(length >> 8), (byte)(length >> 16), (byte)(length >> 24) };
        output.Write(header, 0, header.Length);
        output.Write(bytes, 0, bytes.Length);
        output.Flush();
    }
}
