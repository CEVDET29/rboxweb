using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;

namespace RboxAgent
{
    /// <summary>
    /// Komut satırı ve agent.json:
    ///   --origin https://kullanici.github.io   izinli web adresi (birden fazla kez verilebilir)
    ///   --port 47800                           başlangıç portu
    ///   --token ABC123                         sabit kod (geliştirme için; verilmezse her açılışta rastgele)
    ///   --site &lt;klasör&gt;                        arayüzü ajandan da sun (varsayılan: exe'nin yanındaki "site")
    ///   --no-browser                           tarayıcıyı otomatik açma
    /// </summary>
    internal sealed class AgentOptions
    {
        public int Port { get; private set; } = 47800;
        public string Token { get; private set; } = NewToken();
        public List<string> AllowedOrigins { get; } = new();
        public string? SiteFolder { get; private set; }
        public bool OpenBrowser { get; private set; } = true;
        public string? OpenUrl { get; private set; }
        /// <summary>Cihaz Güncelleme dosyalarının klasörü (updateFiles). Boşsa %AppData%\RboxAgent\updateFiles.</summary>
        public string? WorkFolder { get; private set; }

        public static AgentOptions Parse(string[] args)
        {
            var o = new AgentOptions();

            // agent.json: exe'nin yanında ya da veri klasöründe
            foreach (string dir in new[] { AppContext.BaseDirectory, DataStore.Folder })
            {
                string f = Path.Combine(dir, "agent.json");
                if (!File.Exists(f)) continue;
                try
                {
                    var cfg = JsonSerializer.Deserialize<FileConfig>(File.ReadAllText(f), new JsonSerializerOptions(JsonSerializerDefaults.Web));
                    if (cfg == null) continue;
                    if (cfg.Port is int p) o.Port = p;
                    if (cfg.AllowedOrigins != null) o.AllowedOrigins.AddRange(cfg.AllowedOrigins);
                    if (!string.IsNullOrWhiteSpace(cfg.OpenUrl)) o.OpenUrl = cfg.OpenUrl;
                    if (!string.IsNullOrWhiteSpace(cfg.WorkFolder)) o.WorkFolder = cfg.WorkFolder;
                }
                catch { /* bozuk dosya yok sayılır */ }
            }

            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                string? Next() => i + 1 < args.Length ? args[++i] : null;
                switch (a)
                {
                    case "--origin": if (Next() is { } og) o.AllowedOrigins.Add(og.TrimEnd('/')); break;
                    case "--port": if (int.TryParse(Next(), out int p)) o.Port = p; break;
                    case "--token": if (Next() is { } t) o.Token = t; break;
                    case "--site": o.SiteFolder = Next(); break;
                    case "--open": o.OpenUrl = Next(); break;
                    case "--work": o.WorkFolder = Next(); break;
                    case "--no-browser": o.OpenBrowser = false; break;
                }
            }

            if (o.SiteFolder == null)
            {
                string local = Path.Combine(AppContext.BaseDirectory, "site");
                if (Directory.Exists(local)) o.SiteFolder = local;
            }
            return o;
        }

        // Karışan karakterler (0/O, 1/I) yok: gözle okunup yazılırken hata olmasın.
        private static string NewToken()
        {
            const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
            var chars = new char[6];
            for (int i = 0; i < chars.Length; i++) chars[i] = alphabet[RandomNumberGenerator.GetInt32(alphabet.Length)];
            return new string(chars, 0, 3) + "-" + new string(chars, 3, 3);
        }

        private sealed class FileConfig
        {
            public int? Port { get; set; }
            public List<string>? AllowedOrigins { get; set; }
            public string? OpenUrl { get; set; }
            public string? WorkFolder { get; set; }
        }
    }

    internal static class Program
    {
        private static async Task<int> Main(string[] args)
        {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            Console.Title = "RasyoBOX Ajan";

            var opts = AgentOptions.Parse(args);
            if (!string.IsNullOrWhiteSpace(opts.WorkFolder)) RboxAgent.Modules.Update.UpdateService.ExplicitFolder = Path.GetFullPath(opts.WorkFolder);
            var server = new AgentServer(opts);
            try { server.Start(); }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("Ajan başlatılamadı: " + ex.Message);
                Console.ResetColor();
                Console.ReadKey();
                return 1;
            }

            string self = $"http://127.0.0.1:{server.Port}/";
            Console.WriteLine();
            Console.WriteLine("  RasyoBOX Ajan çalışıyor  ·  " + self);
            Console.WriteLine("  ------------------------------------------------");
            Console.Write("  Bağlantı kodu:  ");
            Console.ForegroundColor = ConsoleColor.Black;
            Console.BackgroundColor = ConsoleColor.Yellow;
            Console.Write($"  {opts.Token}  ");
            Console.ResetColor();
            Console.WriteLine();
            Console.WriteLine();
            Console.WriteLine("  Tarayıcı kodla birlikte açılır ve kendiliğinden bağlanır. Bağlanmazsa bu kodu sayfaya yazın.");
            Console.WriteLine("  Ajan her açılışta yeni kod üretir.");
            Console.WriteLine("  Verilerin (ayarlar, şifreli parolalar): " + DataStore.Folder);
            if (opts.AllowedOrigins.Count == 0 && opts.SiteFolder == null)
                Console.WriteLine("  UYARI: izinli web adresi yok. --origin https://kullanici.github.io ile başlatın.");
            Console.WriteLine("  Kapatmak için bu pencereyi kapatın (Ctrl+C).");
            Console.WriteLine();

            string? open = opts.OpenUrl ?? (opts.SiteFolder != null ? self : null);
            if (opts.OpenBrowser && open != null)
            {
                // Kod adresin "#" kısmında gider: sunucuya/GitHub'a gönderilmez, sayfa okuyup kendiliğinden bağlanır.
                if (!open.Contains('#')) open += "#code=" + opts.Token;
                try { Process.Start(new ProcessStartInfo(open) { UseShellExecute = true }); } catch { }
            }

            await server.RunAsync();
            return 0;
        }
    }
}
