// Executed only on the GitHub-hosted Windows CI runner. Never use product keys.
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

internal static class NativeIdentityRegistrationFixture
{
    private static string stage = "initialization";
    private static int checks;

    [DllImport("advapi32.dll", EntryPoint = "RegSetValueExW", CharSet = CharSet.Unicode)]
    private static extern int SetRawValue(SafeRegistryHandle key, string valueName, uint reserved, uint kind, byte[] data, uint size);

    private static void Expect(bool value, string label)
    {
        stage = label;
        if (!value) throw new InvalidOperationException("fixture assertion");
        checks++;
    }

    private static int Main()
    {
        // Both the Vitest launcher and this executable independently refuse a
        // local Windows account, even if someone runs the compiled fixture.
        if (Environment.OSVersion.Platform != PlatformID.Win32NT
            || !String.Equals(Environment.GetEnvironmentVariable("GITHUB_ACTIONS"), "true", StringComparison.OrdinalIgnoreCase)
            || !String.Equals(Environment.GetEnvironmentVariable("CI"), "true", StringComparison.OrdinalIgnoreCase)
            || !String.Equals(Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT"), "github-hosted", StringComparison.Ordinal))
        {
            Console.Error.WriteLine("Disposable registry fixture requires GitHub-hosted Windows CI.");
            return 3;
        }

        const string prefix = @"Software\Interego-CI-Fixtures\NativeIdentityRegistration\";
        string testPath = prefix + Guid.NewGuid().ToString("D");
        string manifest = Path.Combine(Path.GetTempPath(), "interego-registration-fixture", "com.interego.identity.json");
        int result = 0;
        try
        {
            Expect(IdentityHost.RegistrationState(null, manifest) == "absent", "missing-key");
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(testPath))
            {
                Expect(key != null, "create-disposable-key");
                Expect(IdentityHost.RegistrationState(key, manifest) == "absent", "existing-key-no-default");
                key.SetValue("named-fixture-sentinel", "retained", RegistryValueKind.String);
                Expect(IdentityHost.RegistrationState(key, manifest) == "absent", "named-value-is-not-default");
                key.SetValue("", manifest, RegistryValueKind.String);
                Expect(IdentityHost.RegistrationState(key, manifest) == "matching", "matching-string");
                Expect(IdentityHost.RegistrationState(key, manifest.ToUpperInvariant()) == "matching", "case-insensitive-exact-string");

                // This is the old NSIS DeleteRegValue state: subkey exists,
                // default is absent, and reg.exe still exits successfully.
                key.DeleteValue("", false);
                using (Process query = Process.Start(new ProcessStartInfo
                {
                    FileName = "reg.exe", Arguments = "query \"" + key.Name + "\" /ve",
                    UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true, RedirectStandardError = true
                }))
                {
                    bool exited = query.WaitForExit(5000);
                    if (!exited) query.Kill();
                    Expect(exited, "reg-query-exits");
                    query.StandardOutput.ReadToEnd(); query.StandardError.ReadToEnd();
                    Expect(query.ExitCode == 0, "reg-query-missing-default-success");
                }
                Expect(Array.IndexOf(key.GetValueNames(), "") < 0, "default-really-absent-after-delete");
                Expect(IdentityHost.RegistrationState(key, manifest) == "absent", "legacy-deleted-default-repairable");
                Expect((string)key.GetValue("named-fixture-sentinel") == "retained", "named-value-preserved");

                foreach (string foreign in new string[] { "", "(value not set)", manifest + " ", Path.Combine(Path.GetTempPath(), "other.json") })
                {
                    key.SetValue("", foreign, RegistryValueKind.String);
                    Expect(IdentityHost.RegistrationState(key, manifest) == "foreign", "foreign-string-not-absence");
                }
                key.SetValue("", manifest, RegistryValueKind.ExpandString);
                Expect(IdentityHost.RegistrationState(key, manifest) == "wrong-type", "expand-string-refused");
                key.SetValue("", 0, RegistryValueKind.DWord);
                Expect(IdentityHost.RegistrationState(key, manifest) == "wrong-type", "dword-refused");
                key.SetValue("", new string[] { manifest }, RegistryValueKind.MultiString);
                Expect(IdentityHost.RegistrationState(key, manifest) == "wrong-type", "multistring-refused");
                key.SetValue("", new byte[] { 0, 1, 2 }, RegistryValueKind.Binary);
                Expect(IdentityHost.RegistrationState(key, manifest) == "wrong-type", "binary-refused");
                key.SetValue("", new byte[] { 0, 1, 2 }, RegistryValueKind.None);
                Expect(IdentityHost.RegistrationState(key, manifest) == "wrong-type", "none-refused");
                // REG_RESOURCE_LIST (8) is not a .NET RegistryValueKind. It has
                // no link semantics and is written only to this disposable key.
                byte[] raw = new byte[] { 0, 0, 0, 0 };
                Expect(SetRawValue(key.Handle, "", 0, 8, raw, (uint)raw.Length) == 0, "write-unsupported-native-kind");
                Expect(key.GetValueKind("") == RegistryValueKind.Unknown, "unsupported-native-kind-is-present");
                Expect(IdentityHost.RegistrationState(key, manifest) == "wrong-type", "unsupported-native-kind-refused");
            }
            RegistryKey disposed = Registry.CurrentUser.OpenSubKey(testPath, false);
            Expect(disposed != null, "open-disposable-key"); disposed.Close();
            Expect(IdentityHost.RegistrationState(disposed, manifest) == "unavailable", "disposed-access-fails-closed");
        }
        catch
        {
            Console.Error.WriteLine("Disposable registry fixture failed at " + stage + ".");
            result = 1;
        }
        finally
        {
            // The only writable registry address is the fresh GUID child above.
            try
            {
                if (!testPath.StartsWith(prefix, StringComparison.Ordinal) || testPath.Length != prefix.Length + 36)
                    throw new InvalidOperationException("fixture cleanup address");
                Registry.CurrentUser.DeleteSubKeyTree(testPath, false);
            }
            catch { Console.Error.WriteLine("Disposable registry fixture cleanup failed."); result = 1; }
        }
        if (result == 0) Console.WriteLine("Disposable native registration fixture: " + checks.ToString(CultureInfo.InvariantCulture) + " checks passed.");
        return result;
    }
}
