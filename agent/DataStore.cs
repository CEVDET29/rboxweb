using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RboxAgent
{
    /// <summary>
    /// Ajanın kalıcı veri klasörü (%AppData%\RboxAgent) ve ayar dosyası.
    /// Parolalar Windows DPAPI ile bu kullanıcıya özel şifrelenir; tarayıcıya asla geri gönderilmez.
    /// </summary>
    public static class DataStore
    {
        public static readonly string Folder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "RboxAgent");

        private static readonly string SettingsFile = Path.Combine(Folder, "settings.json");
        private static readonly object Gate = new();
        private static AgentSettings? _settings;

        public static AgentSettings Settings
        {
            get
            {
                lock (Gate) return _settings ??= Load();
            }
        }

        private static AgentSettings Load()
        {
            try
            {
                if (File.Exists(SettingsFile))
                    return JsonSerializer.Deserialize<AgentSettings>(File.ReadAllText(SettingsFile)) ?? new AgentSettings();
            }
            catch { /* bozuk dosya → varsayılanlar */ }
            return new AgentSettings();
        }

        public static void Save()
        {
            lock (Gate)
            {
                try
                {
                    Directory.CreateDirectory(Folder);
                    File.WriteAllText(SettingsFile,
                        JsonSerializer.Serialize(_settings ?? new AgentSettings(), new JsonSerializerOptions { WriteIndented = true }));
                }
                catch { /* ayar kaydedilemezse ajan çalışmaya devam etsin */ }
            }
        }

        public static string? Protect(string? plain)
        {
            if (string.IsNullOrEmpty(plain)) return null;
            byte[] enc = ProtectedData.Protect(Encoding.UTF8.GetBytes(plain), null, DataProtectionScope.CurrentUser);
            return Convert.ToBase64String(enc);
        }

        public static string Unprotect(string? protectedText)
        {
            if (string.IsNullOrEmpty(protectedText)) return "";
            try
            {
                byte[] dec = ProtectedData.Unprotect(Convert.FromBase64String(protectedText), null, DataProtectionScope.CurrentUser);
                return Encoding.UTF8.GetString(dec);
            }
            catch { return ""; }
        }
    }

    public sealed class AgentSettings
    {
        public PingSettings Ping { get; set; } = new();
    }

    public sealed class PingSettings
    {
        public string SshUser { get; set; } = "pi";
        public string? SshPassProtected { get; set; }

        public bool CheckSsh { get; set; }
        public bool CheckMac { get; set; }
        public bool CheckVendor { get; set; }
        public bool SshMacFallback { get; set; }

        public int Concurrency { get; set; } = 16;
        public int PingTimeoutMs { get; set; } = 1000;
        public int TcpTimeoutMs { get; set; } = 1000;
        public int SshTimeoutMs { get; set; } = 2500;
        public int MonitorIntervalMin { get; set; } = 5;
    }
}
