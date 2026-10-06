using RboxAgent.Modules.Update.Services;
using Renci.SshNet;
using Renci.SshNet.Common;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;

namespace RboxAgent.Modules.Update.Core
{
    // ─────────────────────────────────────────────────────────────────────────
    //  CronServiceAction  —  cron servisine yapılacak işlem (v4.1)
    // ─────────────────────────────────────────────────────────────────────────
    public enum CronServiceAction
    {
        None,    // Dokunma — adım çalışmaz
        Enable,  // systemctl enable --now cron.service
        Disable  // systemctl disable --now cron.service
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  AutologinAction  —  tty1 konsol autologin ayarı (v4.4)
    // ─────────────────────────────────────────────────────────────────────────
    public enum AutologinAction
    {
        None,    // Dokunma — adım çalışmaz
        Enable,  // autologin.conf oluştur (pi kullanıcısı ile otomatik giriş)
        Disable  // autologin.conf sil (tty1'de login ekranı)
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  ConspyAction  —  conspy kurulum yöntemi (v4.6)
    // ─────────────────────────────────────────────────────────────────────────
    public enum ConspyAction
    {
        None,     // Kurma — adım çalışmaz
        Apt,      // apt-get update + install (internet gerekir)
        Offline   // /home/pi altındaki .deb paketinden dpkg ile kur
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  UpdateOptions  —  hangi adımların çalışacağını tutar
    // ─────────────────────────────────────────────────────────────────────────
    public sealed class UpdateOptions
    {
        public bool Dll { get; set; }
        public bool RcLocal { get; set; }
        public bool Dhcpcd { get; set; }
        public bool WpaSupplicant { get; set; }
        public bool Service { get; set; }
        public bool Crontab { get; set; }
        public bool JsonSettings { get; set; }
        public bool Cleanup { get; set; }
        /// <summary>/var/www/consoleApps/publish altındaki hatalı "\Logs", "Logs" klasörleri ve "\Logs\ServiceLog_*.txt" dosyaları.</summary>
        public bool BadLogsCleanup { get; set; }
        public bool ExpandFs { get; set; }
        public bool RebootAfter { get; set; }
        public bool BashRc { get; set; }
        public bool Profile { get; set; }
        public bool NetStatusBanner { get; set; }
        public bool RasyoClean { get; set; }
        public bool NetBannerLogin { get; set; }
        public bool CreateNetStatusBannerService { get; set; }
        public bool InstallNanoRc { get; set; }
        public bool SwHelpLogService { get; set; }
        public bool WifiMonitorService { get; set; }

        // RasyoBOX web arayüzü kurulumu — rasyobox-v9.tar.gz (v4.5)
        public bool WebServer { get; set; }

        // serialdevices.json → /var/www/consoleApps/publish/ (v4.7)
        public bool SerialDevices { get; set; }

        // JsonSettings adımına özel — satır bazlı override
        public int? YatakIdOverride { get; set; }

        // Per-row dhcpcd overrides (ListView wlan0/eth0 sütunlarindan gelir)
        public string? Wlan0IpOverride { get; set; }
        public string? Eth0IpOverride { get; set; }

        // wlan0 icin per-interface mask + gateway
        // null  = checkbox secili degil (mevcut satira dokunma / CIDR yazma)
        // ""    = checkbox secili ama textbox bos (CIDR yazma / routers sil)
        // deger = checkbox secili ve textbox dolu
        public string? Wlan0Mask { get; set; }
        public string? Wlan0Gateway { get; set; }

        // eth0 icin ayni semantik
        public string? Eth0Mask { get; set; }
        public string? Eth0Gateway { get; set; }

        // IP güncellendikten sonra servisleri yeniden başlat
        public bool RestartDhcpcd { get; set; }
        public bool RestartWpa { get; set; }

        // cron servisi enable/disable (v4.1)
        public CronServiceAction CronService { get; set; } = CronServiceAction.None;

        // tty1 konsol autologin enable/disable (v4.4)
        public AutologinAction Autologin { get; set; } = AutologinAction.None;

        // conspy kurulum yöntemi: kurma / apt-get / çevrimdışı .deb (v4.6)
        public ConspyAction Conspy { get; set; } = ConspyAction.None;

        /// <summary>
        /// v4.2: Paralel güncellemede her cihaz kendi kopyasını kullanır.
        /// Override alanları (YatakId/Wlan0/Eth0) cihaza özel olduğundan
        /// paylaşılan nesnede yarış oluşmasın diye shallow copy yeterlidir
        /// (tüm alanlar değer tipi veya immutable string).
        /// </summary>
        public UpdateOptions Clone() => (UpdateOptions)MemberwiseClone();
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  IUpdateStep  —  her güncelleme adımı bu arayüzü uygular
    // ─────────────────────────────────────────────────────────────────────────
    internal interface IUpdateStep
    {
        /// <summary>Bu adım çalışacak mı?</summary>
        bool ShouldRun(UpdateOptions opt);

        /// <summary>Adımı çalıştır; false dönerse zincir kırılır.</summary>
        Task<bool> RunAsync(StepContext ctx);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  StepContext  —  adımlara geçilen ortak bağlam
    // ─────────────────────────────────────────────────────────────────────────
    internal sealed class StepContext
    {
        public string Ip { get; }
        public SshClient Client { get; }
        public SshUpdater Updater { get; }
        public UpdateOptions Opt { get; }
        public CancellationToken Ct { get; }
        public IAppLogger Logger { get; }
        public IStatusReporter Status { get; }
        public string WorkFolder { get; }

        public StepContext(string ip, SshClient client, SshUpdater updater,
                           UpdateOptions opt, CancellationToken ct,
                           IAppLogger logger, IStatusReporter status, string workFolder)
        {
            Ip = ip; Client = client; Updater = updater; Opt = opt; Ct = ct;
            Logger = logger; Status = status; WorkFolder = workFolder;
        }

        public string LocalPath(string relative) => Path.Combine(WorkFolder, relative);
        public bool LocalExists(string relative) => File.Exists(LocalPath(relative));
        public string? FindFirst(params string[] candidates)
            => candidates.FirstOrDefault(c => File.Exists(LocalPath(c)));
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  DhcpcdHelper  —  dhcpcd.conf upsert mantığı (Tab1 ve Tab2 paylaşır)
    // ─────────────────────────────────────────────────────────────────────────
    public static class DhcpcdHelper
    {
        public static string NormalizeToLf(string text)
        {
            text ??= string.Empty;
            return text.Replace("\r\n", "\n").Replace("\r", "\n");
        }

        /// <summary>
        /// dhcpcd.conf içinde belirtilen interface bloğunu upsert eder.
        ///
        /// mask semantiği:
        ///   null  = checkbox seçili değil → mevcut CIDR KORUNUR (sadece IP değişir)
        ///   ""    = checkbox seçili, textbox boş → CIDR SİLİNİR (ip_address=IP yazılır)
        ///   dolu  = checkbox seçili, textbox dolu → CIDR güncellenir (ip_address=IP/CIDR)
        ///
        /// gateway semantiği:
        ///   null  = checkbox seçili değil → mevcut static routers satırı KORUNUR
        ///   ""    = checkbox seçili, textbox boş → static routers SİLİNİR
        ///   dolu  = checkbox seçili, textbox dolu → static routers güncellenir
        /// </summary>
        public static string UpsertDhcpcdInterface(
            string text, string interfaceName, string ip,
            string? mask = null, string? gateway = null)
        {
            text = NormalizeToLf(text);

            // ip_address satırını oluşturan yerel fonksiyon.
            // existingCidr: regex ile bloktaki mevcut /XX değeri (ya da null).
            string BuildIpLine(string? existingCidr)
            {
                if (mask == null)
                {
                    // Checkbox seçili değil → mevcut CIDR'ı koru
                    return string.IsNullOrEmpty(existingCidr)
                        ? $"static ip_address={ip}"
                        : $"static ip_address={ip}/{existingCidr}";
                }
                if (mask == "")
                {
                    // Checkbox seçili, boş → CIDR'ı kaldır
                    return $"static ip_address={ip}";
                }
                // Checkbox seçili, değer var → yeni CIDR
                return TryParseMaskOrCidr(mask, out int cidr, out _) && cidr > 0
                    ? $"static ip_address={ip}/{cidr}"
                    : $"static ip_address={ip}";
            }

            string pattern = $@"(?ms)^interface\s+{Regex.Escape(interfaceName)}\b.*?(?=^interface\s+|\z)";
            var rx = new Regex(pattern, RegexOptions.Multiline);

            if (rx.IsMatch(text))
            {
                return rx.Replace(text, m =>
                {
                    // Bloktaki mevcut CIDR'ı çek (mask==null ise kullanılacak)
                    var cidrMatch = Regex.Match(m.Value,
                        @"^static\s+ip_address\s*=\s*[\d.]+/(\d+)",
                        RegexOptions.Multiline | RegexOptions.IgnoreCase);
                    string? existingCidr = cidrMatch.Success ? cidrMatch.Groups[1].Value : null;

                    string ipLine = BuildIpLine(existingCidr);

                    var lines = m.Value.Replace("\r\n", "\n").Split('\n').ToList();
                    var kept = new List<string>();
                    bool inserted = false;

                    foreach (string raw in lines)
                    {
                        string line = raw.TrimEnd();
                        if (string.IsNullOrWhiteSpace(line)) continue;

                        if (Regex.IsMatch(line,
                            $@"^interface\s+{Regex.Escape(interfaceName)}\b", RegexOptions.IgnoreCase))
                        {
                            kept.Add($"interface {interfaceName}");
                            kept.Add(ipLine);
                            if (!string.IsNullOrEmpty(gateway))
                                kept.Add($"static routers={gateway}");
                            inserted = true;
                            continue;
                        }

                        // Eski ip_address satırını her zaman at (yenisi üstte eklendi)
                        if (Regex.IsMatch(line, @"^static\s+ip_address\s*=", RegexOptions.IgnoreCase))
                            continue;

                        // Eski routers satırı:
                        if (Regex.IsMatch(line, @"^static\s+routers\s*=", RegexOptions.IgnoreCase))
                        {
                            if (gateway == null) kept.Add(line); // koru
                            // else: "" veya dolu → eski satırı at
                            continue;
                        }

                        kept.Add(line);
                    }

                    if (!inserted)
                    {
                        kept.Insert(0, $"interface {interfaceName}");
                        kept.Insert(1, ipLine);
                        if (!string.IsNullOrEmpty(gateway))
                            kept.Insert(2, $"static routers={gateway}");
                    }

                    return string.Join("\n", kept) + "\n\n";
                }, 1);
            }

            // Blok yoksa sona ekle — mevcut CIDR yok, null → sadece IP yaz
            string newIpLine = BuildIpLine(null);
            if (!text.EndsWith("\n")) text += "\n";
            string block = $"\ninterface {interfaceName}\n{newIpLine}\n";
            if (!string.IsNullOrEmpty(gateway))
                block += $"static routers={gateway}\n";
            return text + block;
        }

        public static bool TryParseMaskOrCidr(string value, out int cidr, out string error)
        {
            cidr = 0;
            error = string.Empty;
            value = (value ?? string.Empty).Trim();

            if (int.TryParse(value, out int direct))
            {
                if (direct is >= 0 and <= 32) { cidr = direct; return true; }
                error = "CIDR 0-32 aralığında olmalı."; return false;
            }

            if (!IsValidIp(value)) { error = "Maske biçimi hatalı."; return false; }

            int[] parts = value.Split('.').Select(int.Parse).ToArray();
            int mask = 0;
            foreach (int part in parts) mask = (mask << 8) | part;

            bool zeroSeen = false;
            int count = 0;
            for (int i = 31; i >= 0; i--)
            {
                bool bit = ((mask >> i) & 1) == 1;
                if (bit) { if (zeroSeen) { error = "Ağ maskesi bitleri kesintisiz 1 olmalı."; return false; } count++; }
                else { zeroSeen = true; }
            }
            cidr = count; return true;
        }

        private static bool IsValidIp(string? ip)
        {
            if (string.IsNullOrWhiteSpace(ip)) return false;
            if (!Regex.IsMatch(ip, @"^(?:\d{1,3}\.){3}\d{1,3}$")) return false;
            return ip.Split('.').Select(int.Parse).All(p => p is >= 0 and <= 255);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Adım Sınıfları
    // ─────────────────────────────────────────────────────────────────────────

    internal sealed class CleanupStep : IUpdateStep
    {
        public bool ShouldRun(UpdateOptions o) => o.Cleanup;
        public async Task<bool> RunAsync(StepContext x)
        {
            var cmds = new[]
            {
                "command -v journalctl >/dev/null 2>&1 && journalctl --vacuum-time=1s || true",
                "command -v journalctl >/dev/null 2>&1 && journalctl --rotate || true",
                "command -v apt >/dev/null 2>&1 && apt clean || true",
                "[ -d /var/log ] && find /var/log -type f -name '*.log' -exec truncate -s 0 {} + || true",
                "[ -d /var/log ] && find /var/log -type f -name '*.1'   -exec truncate -s 0 {} + || true",
                "[ -d /var/log ] && find /var/log -type f -name '*.old' -exec truncate -s 0 {} + || true",
                "[ -f /var/log/wtmp ]    && : > /var/log/wtmp    || true",
                "[ -f /var/log/btmp ]    && : > /var/log/btmp    || true",
                "[ -f /var/log/lastlog ] && : > /var/log/lastlog || true",
                "[ -d /var/tmp ] && rm -rf /var/tmp/* || true",
                "[ -d /tmp ]     && rm -rf /tmp/*     || true",
                "[ -d /usr/share/dotnet/sdk/3.1.302 ] && rm -rf /usr/share/dotnet/sdk/3.1.302 || true",
                "[ -d /usr/share/dotnet/packs/Microsoft.NETCore.App.Ref/3.1.0 ] && rm -rf /usr/share/dotnet/packs/Microsoft.NETCore.App.Ref/3.1.0 || true"
            };
            var (ok, msg) = await x.Updater.ExecuteSudoChainAsync(x.Client, cmds, x.Ip, x.Ct);
            await x.Logger.LogAsync(x.Ip, ok ? "Gereksiz dosyalar temizlendi." : $"Temizlik hatası: {msg}");
            return ok;
        }
    }

    /// <summary>
    /// "Hatalı Log'ları temizle": eski SerialWorker sürümleri Windows yolu ("\Logs\...") kullandığı için
    /// /var/www/consoleApps/publish altında adı ters bölülü klasör ve dosyalar oluşuyordu. Silinenler:
    /// "\Logs" ve "Logs" klasörleri (içleriyle) ve adı "\Logs\ServiceLog_*.txt" olan dosyalar.
    /// Doğru log klasörü "Log" ve diğer dosyalara dokunulmaz.
    /// </summary>
    internal sealed class BadLogsCleanupStep : IUpdateStep
    {
        private const string Dir = "/var/www/consoleApps/publish";

        public bool ShouldRun(UpdateOptions o) => o.BadLogsCleanup;

        public async Task<bool> RunAsync(StepContext x)
        {
            // find -name kalıbında ters bölü kaçış karakteridir: '\\' = tek ters bölü (dosya adındaki "\")
            string script =
                $"cd {Dir} 2>/dev/null || {{ echo 'YOK'; exit 0; }}; " +
                @"n=$(find . -maxdepth 1 -type f -name '\\Logs\\ServiceLog_*.txt' | wc -l); " +
                @"find . -maxdepth 1 -type f -name '\\Logs\\ServiceLog_*.txt' -delete; " +
                @"d=''; for x in '\Logs' 'Logs'; do if [ -d ""./$x"" ] && [ ! -L ""./$x"" ]; then rm -rf -- ""./$x"" && d=""$d $x""; fi; done; " +
                @"echo ""$n|$d""";

            var (ok, stdout, stderr) = await x.Updater.ExecuteSudoGetOutputAsync(x.Client, script, x.Ip, x.Ct, 60);
            string res = (stdout ?? "").Trim().Split('\n').LastOrDefault()?.Trim() ?? "";
            if (!ok)
            {
                await x.Logger.LogAsync(x.Ip, $"Hatalı Log'lar temizlenemedi: {(string.IsNullOrWhiteSpace(stderr) ? res : stderr.Trim())}", StatusKind.Warn);
                return true;   // bilgi amaçlı temizlik; diğer adımları durdurmaz
            }
            if (res == "YOK")
            {
                await x.Logger.LogAsync(x.Ip, $"Hatalı Log temizliği: {Dir} klasörü yok, atlandı.", StatusKind.Warn);
                return true;
            }

            var parts = res.Split('|');
            int files = int.TryParse(parts[0].Trim(), out int n) ? n : 0;
            string dirs = parts.Length > 1 ? parts[1].Trim() : "";
            if (files == 0 && dirs.Length == 0)
                await x.Logger.LogAsync(x.Ip, "Hatalı Log temizliği: silinecek \\Logs / Logs klasörü ya da \\Logs\\ServiceLog_*.txt dosyası yok.");
            else
                await x.Logger.LogAsync(x.Ip,
                    $"Hatalı Log'lar temizlendi: {files} \\Logs\\ServiceLog_*.txt dosyası" +
                    (dirs.Length > 0 ? $", klasör: {string.Join(", ", dirs.Split(' ', StringSplitOptions.RemoveEmptyEntries))}" : "") +
                    " silindi.", StatusKind.Success);
            return true;
        }
    }

    /// <summary>
    /// net-status-banner@tty1.service kurulumu (tty1'e ağ bilgisi banner'ı basan oneshot servis).
    ///
    /// <para>v5.1: <c>enable --now</c> ikiye ayrıldı. Önce <c>enable</c> (açılışta çalışsın),
    /// sonra script cihazda varsa <c>start</c>. Başlatma hatası artık zinciri kırmıyor: banner
    /// yalnızca bilgi ekranı, oysa önceden bu hata cihazın kalan tüm adımlarını (ör. DLL
    /// güncellemesi) iptal ediyordu.</para>
    ///
    /// <para>Başlatılamazsa sebep loglanır. systemd sonucu (Result / ExecMainStatus) ve script'in
    /// systemd ortamında izlemeli (<c>bash -x</c>) çalıştırılmasının son satırları yazılır. Script
    /// stderr'i tty1'e yazdığı için hata metni journal'da görünmez; bu yüzden ayrıca çalıştırılır.</para>
    /// </summary>
    internal sealed class NetStatusBannerServiceStep : IUpdateStep
    {
        private const string Unit = "net-status-banner@tty1.service";
        private const string ScriptPath = "/usr/local/bin/net_status_banner.sh";

        public bool ShouldRun(UpdateOptions o) => o.CreateNetStatusBannerService;

        public async Task<bool> RunAsync(StepContext x)
        {
            try
            {
                string? rel = x.FindFirst(Unit, Path.Combine("Resources", Unit));
                if (rel == null)
                {
                    await x.Logger.LogAsync(x.Ip, $"{Unit} updateFiles klasöründe bulunamadı — adım atlandı.", StatusKind.Warn);
                    return true;
                }

                bool copied = await x.Updater.CopyTextFileWithSudoAsync(
                    x.Client, rel, $"/tmp/{Unit}",
                    $"install -m 0644 -o root -g root /tmp/{Unit} /etc/systemd/system/{Unit}",
                    x.Ip, x.Ct);
                if (!copied)
                {
                    await x.Logger.LogAsync(x.Ip, $"{Unit} cihaza kopyalanamadı — adım atlandı.", StatusKind.Warn);
                    return true;
                }

                // Açılışta çalışsın; önceki başarısız denemenin "failed" durumu da temizlenir
                var (enableOk, enableMsg) = await x.Updater.ExecuteSudoChainAsync(x.Client, new[]
                {
                    "systemctl daemon-reload",
                    $"systemctl reset-failed {Unit} 2>/dev/null || true",
                    $"systemctl enable {Unit}"
                }, x.Ip, x.Ct);
                if (!enableOk)
                {
                    await x.Logger.LogAsync(x.Ip, $"{Unit} enable edilemedi: {enableMsg}", StatusKind.Warn);
                    return true;
                }

                // Script yoksa başlatma 203/EXEC ile düşer; denemeden açıkça söyle
                var (scriptOk, _, _) = await x.Updater.ExecuteSudoGetOutputAsync(
                    x.Client, $"test -x {ScriptPath}", x.Ip, x.Ct, 10);
                if (!scriptOk)
                {
                    await x.Logger.LogAsync(x.Ip,
                        $"{Unit} enable edildi ama başlatılmadı: {ScriptPath} cihazda yok ya da çalıştırılabilir değil. " +
                        "\"net_status_banner.sh\" seçeneğini de işaretleyin.", StatusKind.Warn);
                    return true;
                }

                var (startOk, _) = await x.Updater.ExecuteSudoChainAsync(x.Client, new[]
                {
                    $"systemctl start {Unit}"
                }, x.Ip, x.Ct);

                if (startOk)
                {
                    await x.Logger.LogAsync(x.Ip, $"{Unit} kuruldu, enable edildi ve çalıştırıldı.", StatusKind.Success);
                    return true;
                }

                await x.Logger.LogAsync(x.Ip,
                    $"{Unit} enable edildi ama çalıştırılamadı (diğer adımlar devam ediyor). {await DiagnoseAsync(x)}",
                    StatusKind.Warn);
                return true;
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                await x.Logger.LogAsync(x.Ip, $"{Unit} adımı hata verdi, atlandı: {ex.Message}", StatusKind.Warn);
                return true; // banner zinciri kırmaz
            }
        }

        /// <summary>Servis neden çalışmadı? systemd sonucu + script'in hata veren son satırları.</summary>
        private static async Task<string> DiagnoseAsync(StepContext x)
        {
            // Ör. "Result=exit-code ExecMainCode=1 ExecMainStatus=1"
            //     203 = script bulunamadı/çalıştırılamadı, 209 = tty açılamadı, 1/2/127 = script içinde hata
            var (_, show, _) = await x.Updater.ExecuteSudoGetOutputAsync(x.Client,
                $"systemctl show -p Result -p ExecMainCode -p ExecMainStatus {Unit} | tr '\\n' ' '",
                x.Ip, x.Ct, 15);

            // Servisle aynı ortam: systemd PATH'i, stdin yok, tty yok (çıktı bize gelir).
            // bash -x her komutu "+ ..." olarak basar; script "set -e" ile durduysa hata veren komut en sondadır.
            var (_, trace, _) = await x.Updater.ExecuteSudoGetOutputAsync(x.Client,
                "env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin NB_NO_READ=1 " +
                $"bash -x {ScriptPath} </dev/null 2>&1 | tail -n 6; echo \"script cikis kodu: ${{PIPESTATUS[0]}}\"",
                x.Ip, x.Ct, 40);

            string systemd = string.IsNullOrWhiteSpace(show) ? "" : $"systemd: {show.Trim()}";
            string lines = string.Join(" | ", (trace ?? "").Replace("\r\n", "\n").Split('\n')
                                                   .Select(l => l.Trim()).Where(l => l.Length > 0));
            return $"{systemd} || script (bash -x son satırlar): {(lines.Length > 0 ? lines : "(çıktı yok)")}";
        }
    }

    internal sealed class NanoRcStep : IUpdateStep
    {
        public bool ShouldRun(UpdateOptions o) => o.InstallNanoRc;
        public async Task<bool> RunAsync(StepContext x)
        {
            string? rel = x.FindFirst(".nanorc", Path.Combine("Resources", ".nanorc"), "nanorc");
            string content = rel != null
                ? await File.ReadAllTextAsync(x.LocalPath(rel), x.Ct)
                : "# Rasyobox nano\nset linenumbers\nset constantshow\n";

            content = content.Replace("\r\n", "\n").Replace("\r", "\n");
            if (!content.EndsWith("\n")) content += "\n";

            // v4.8: geçici dosya cihaza özel klasöre yazılır — daha önce paralel
            // güncellemede tüm cihazlar aynı %TEMP%\.nanorc.rasyobox dosyasını paylaşıyordu.
            string tmp = x.Updater.NewTempFilePath(".nanorc.rasyobox");
            await File.WriteAllTextAsync(tmp, content, new UTF8Encoding(false), x.Ct);

            async Task<bool> Copy(string dest)
                => await x.Updater.CopyTextFileWithSudoAsync(x.Client, tmp,
                    "/tmp/.nanorc.rasyobox", $"install -m 0644 -o root -g root /tmp/.nanorc.rasyobox {dest}",
                    x.Ip, x.Ct);

            bool ok = await Copy("/etc/nanorc") & await Copy("/root/.nanorc") & await Copy("/home/pi/.nanorc");
            try { File.Delete(tmp); } catch { }

            await x.Logger.LogAsync(x.Ip,
                ok ? ".nanorc kuruldu (/etc/nanorc, /root/.nanorc, /home/pi/.nanorc)." : ".nanorc kurulamadı.",
                ok ? StatusKind.Success : StatusKind.Error);
            return ok;
        }
    }

    internal sealed class RcLocalStep : IUpdateStep
    {
        public bool ShouldRun(UpdateOptions o) => o.RcLocal;
        public async Task<bool> RunAsync(StepContext x)
        {
            await x.Updater.ExecuteSudoChainAsync(x.Client, new[] { "killall -9 dotnet" }, x.Ip, x.Ct);

            bool copied = await x.Updater.CopyTextFileWithSudoAsync(
                x.Client, "rclocal.txt", "/tmp/rc.local",
                "[ -f /etc/rc.local ] && cp -a /etc/rc.local /etc/rc.local.bak.$(date +%s) || true " +
                "&& cp /tmp/rc.local /etc/rc.local && chown root:root /etc/rc.local && chmod 755 /etc/rc.local",
                x.Ip, x.Ct);
            if (!copied) return false;

            var (ok, msg) = await x.Updater.ExecuteSudoChainAsync(x.Client, new[]
            {
                "sed -i 's/\\r$//' /etc/rc.local",
                "grep -q '^#!' /etc/rc.local || sed -i '1i #!/bin/sh -e' /etc/rc.local",
                "grep -q '^exit 0$' /etc/rc.local || printf '\\nexit 0\\n' >> /etc/rc.local",
                "chmod 755 /etc/rc.local",
                "systemctl daemon-reload || true",
                "systemctl enable rc-local.service || systemctl enable rc-local || true",
                "systemctl restart rc-local.service || systemctl start rc-local || true"
            }, x.Ip, x.Ct);

            await x.Logger.LogAsync(x.Ip, ok ? "rc.local uygulandı." : $"rc.local hatası: {msg}");
            return ok;
        }
    }

    internal sealed class BashRcStep : IUpdateStep
    {
        public bool ShouldRun(UpdateOptions o) => o.BashRc;
        public async Task<bool> RunAsync(StepContext x)
        {
            string? rel = x.FindFirst(".bashrc", ".bashrc.txt");
            if (rel == null) { await x.Logger.LogAsync(x.Ip, ".bashrc yerelde yok, atlandı."); return true; }

            bool ok = await x.Updater.CopyTextFileWithSudoAsync(
                x.Client, rel, "/tmp/bashrc.pi",
                "install -m 0644 -o pi -g pi /tmp/bashrc.pi /home/pi/.bashrc", x.Ip, x.Ct);

            if (ok)
            {
                var res = await x.Updater.ExecuteSudoChainAsync(x.Client, new[]
                {
                    "sudo -u pi -H bash -lc 'bash -n /home/pi/.bashrc'",
                    "sudo -u pi -H bash -lc 'source ~/.bashrc >/dev/null 2>&1; echo __OK__'"
                }, x.Ip, x.Ct);
                await x.Logger.LogAsync(x.Ip, res.ok ? ".bashrc kopyalandı ve source edildi." : ".bashrc source edilemedi.");
            }
            else
            {
                x.Status.Set(x.Ip, ".bashrc kopyalanamadı (devam).", StatusKind.Warn);
            }
            return true; // bu adım zinciri kırmaz
        }
    }

    internal sealed class ProfileStep : IUpdateStep
    {
        public bool ShouldRun(UpdateOptions o) => o.Profile;
        public async Task<bool> RunAsync(StepContext x)
        {
            string? rel = x.FindFirst(".profile", ".profile.txt");
            if (rel == null) { await x.Logger.LogAsync(x.Ip, ".profile yerelde yok, atlandı."); return true; }

            bool ok = await x.Updater.CopyTextFileWithSudoAsync(
                x.Client, rel, "/tmp/profile.pi",
                "install -m 0644 -o pi -g pi /tmp/profile.pi /home/pi/.profile", x.Ip, x.Ct);
            await x.Logger.LogAsync(x.Ip, ok ? ".profile kopyalandı." : ".profile kopyalanamadı (devam).");
            return true;
        }
    }

    internal sealed class NetStatusBannerShStep : IUpdateStep
    {
        public bool ShouldRun(UpdateOptions o) => o.NetStatusBanner;
        public async Task<bool> RunAsync(StepContext x)
        {
            if (!x.LocalExists("net_status_banner.sh"))
            { await x.Logger.LogAsync(x.Ip, "net_status_banner.sh yok, atlandı."); return true; }

            bool ok = await x.Updater.CopyTextFileWithSudoAsync(
                x.Client, "net_status_banner.sh", "/tmp/net_status_banner.sh",
                "install -m 0755 -o root -g root /tmp/net_status_banner.sh /usr/local/bin/net_status_banner.sh",
                x.Ip, x.Ct);
            await x.Logger.LogAsync(x.Ip, ok ? "net_status_banner.sh kopyalandı." : "Kopyalanamadı (devam).");
            return true;
        }
    }

    internal sealed class SwHelpLogServiceStep : IUpdateStep
    {
        public bool ShouldRun(UpdateOptions o) => o.SwHelpLogService;
        public async Task<bool> RunAsync(StepContext x)
        {
            string? swRel = x.FindFirst("sw.bash", Path.Combine("Resources", "sw.bash"));
            if (swRel == null) { await x.Logger.LogAsync(x.Ip, "sw.bash yerelde yok."); return false; }

            bool ok = await x.Updater.CopyTextFileWithSudoAsync(x.Client, swRel, "/tmp/sw.bash",
                "install -m 0755 -o root -g root /tmp/sw.bash /usr/local/bin/sw", x.Ip, x.Ct);
            if (!ok) return false;

            foreach (var (localFile, remoteFile, dest) in new[]
            {
                ("serialworker.service",        "/tmp/serialworker.service",        "/etc/systemd/system/serialworker.service"),
                ("serialworker-serial.service", "/tmp/serialworker-serial.service", "/etc/systemd/system/serialworker-serial.service"),
            })
            {
                string? rel = x.FindFirst(localFile, Path.Combine("Resources", localFile));
                if (rel == null) { await x.Logger.LogAsync(x.Ip, $"{localFile} yerelde yok."); return false; }

                ok = await x.Updater.CopyTextFileWithSudoAsync(x.Client, rel, remoteFile,
                    $"install -m 0644 -o root -g root {remoteFile} {dest}", x.Ip, x.Ct);
                if (!ok) return false;
            }

            var (reloadOk, reloadMsg) = await x.Updater.ExecuteSudoChainAsync(x.Client, new[]
            {
                "command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload || true",
                "systemd-analyze verify /etc/systemd/system/serialworker.service /etc/systemd/system/serialworker-serial.service || true"
            }, x.Ip, x.Ct);

            await x.Logger.LogAsync(x.Ip, reloadOk ? "sw-help & log servisler kopyalandı." : $"daemon-reload hatası: {reloadMsg}");
            return reloadOk;
        }
    }

    internal sealed class WifiMonitorStep : IUpdateStep
    {
        public bool ShouldRun(UpdateOptions o) => o.WifiMonitorService;
        public async Task<bool> RunAsync(StepContext x)
        {
            var files = new[]
            {
                ("wifi_monitor.conf",    "/tmp/wifi_monitor.conf",    "install -m 0644 -o root -g root /tmp/wifi_monitor.conf /etc/wifi_monitor.conf"),
                ("wifi_monitor.py",      "/tmp/wifi_monitor.py",      "install -m 0755 -o root -g root /tmp/wifi_monitor.py /usr/local/bin/wifi_monitor.py"),
                ("wifi-monitor.service", "/tmp/wifi-monitor.service", "install -m 0644 -o root -g root /tmp/wifi-monitor.service /etc/systemd/system/wifi-monitor.service"),
            };

            foreach (var (local, tmp, cmd) in files)
            {
                string? rel = x.FindFirst(local, Path.Combine("Resources", local));
                if (rel == null) { await x.Logger.LogAsync(x.Ip, $"{local} yerelde yok."); return false; }

                bool ok = await x.Updater.CopyTextFileWithSudoAsync(x.Client, rel, tmp, cmd, x.Ip, x.Ct);
                if (!ok) return false;
                await x.Logger.LogAsync(x.Ip, $"{local} kopyalandı.");
            }

            var (reloadOk, reloadMsg) = await x.Updater.ExecuteSudoChainAsync(x.Client, new[]
            {
                "command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload || true",
                "systemd-analyze verify /etc/systemd/system/wifi-monitor.service || true",
                "command -v systemctl >/dev/null 2>&1 && systemctl enable --now wifi-monitor.service || true",
                "command -v systemctl >/dev/null 2>&1 && systemctl restart wifi-monitor.service || true",
                "command -v systemctl >/dev/null 2>&1 && systemctl status --no-pager -l wifi-monitor.service | head -n 20 || true"
            }, x.Ip, x.Ct);

            await x.Logger.LogAsync(x.Ip,
                reloadOk ? "wifi-monitor.service kuruldu (enable+start OK)." : $"wifi-monitor enable/start hatası: {reloadMsg}",
                reloadOk ? StatusKind.Success : StatusKind.Warn);
            return reloadOk;
        }
    }

    internal sealed class RasyoCleanStep : IUpdateStep
    {
        public bool ShouldRun(UpdateOptions o) => o.RasyoClean;
        public async Task<bool> RunAsync(StepContext x)
        {
            if (!x.LocalExists("rasyoclean.sh")) { await x.Logger.LogAsync(x.Ip, "rasyoclean.sh yok, atlandı."); return true; }
            bool ok = await x.Updater.CopyTextFileWithSudoAsync(x.Client, "rasyoclean.sh", "/tmp/rasyoclean.sh",
                "install -m 0755 -o root -g root /tmp/rasyoclean.sh /usr/local/bin/rasyoclean.sh", x.Ip, x.Ct);
            await x.Logger.LogAsync(x.Ip, ok ? "rasyoclean.sh kopyalandı." : "Kopyalanamadı (devam).");
            return true;
        }
    }

    internal sealed class NetBannerLoginStep : IUpdateStep
    {
        public bool ShouldRun(UpdateOptions o) => o.NetBannerLogin;
        public async Task<bool> RunAsync(StepContext x)
        {
            if (!x.LocalExists("net_banner_login.sh")) { await x.Logger.LogAsync(x.Ip, "net_banner_login.sh yok, atlandı."); return true; }
            await x.Updater.ExecuteSudoChainAsync(x.Client, new[] { "mkdir -p /etc/profile.d" }, x.Ip, x.Ct);
            bool ok = await x.Updater.CopyTextFileWithSudoAsync(x.Client, "net_banner_login.sh", "/tmp/net_banner_login.sh",
                "install -m 0644 -o root -g root /tmp/net_banner_login.sh /etc/profile.d/net_banner_login.sh", x.Ip, x.Ct);
            await x.Logger.LogAsync(x.Ip, ok ? "net_banner_login.sh kopyalandı." : "Kopyalanamadı (devam).");
            return true;
        }
    }

    /// <summary>
    /// ListView wlan0/eth0 sütunlarından gelen per-row IP'leri dhcpcd.conf'a yazar.
    /// Mevcut dosyayı okuyup ilgili interface bloğunu upsert eder — dosya tamamen değiştirilmez.
    /// </summary>
    internal sealed class PerRowDhcpcdStep : IUpdateStep
    {
        public bool ShouldRun(UpdateOptions o) =>
            !string.IsNullOrEmpty(o.Wlan0IpOverride) || !string.IsNullOrEmpty(o.Eth0IpOverride);

        public async Task<bool> RunAsync(StepContext x)
        {
            const string remotePath = "/etc/dhcpcd.conf";
            const string destCmd =
                "[ -f /etc/dhcpcd.conf ] && cp -a /etc/dhcpcd.conf /etc/dhcpcd.conf.bak.$(date +%s) || true " +
                "&& install -m 0644 -o root -g root /tmp/dhcpcd.conf /etc/dhcpcd.conf";

            var (okRead, stdout, stderr) = await x.Updater.ExecuteSudoGetOutputAsync(
                x.Client, $"cat {remotePath}", x.Ip, x.Ct, 10);

            if (!okRead)
            {
                await x.Logger.LogAsync(x.Ip, "dhcpcd.conf okunamadı: " +
                    (string.IsNullOrWhiteSpace(stderr) ? "Bilinmeyen hata" : stderr.Trim()));
                return false;
            }

            string conf = stdout ?? string.Empty;

            if (!string.IsNullOrEmpty(x.Opt.Wlan0IpOverride))
            {
                conf = DhcpcdHelper.UpsertDhcpcdInterface(
                    conf, "wlan0", x.Opt.Wlan0IpOverride,
                    x.Opt.Wlan0Mask,
                    x.Opt.Wlan0Gateway);

                string maskInfo = x.Opt.Wlan0Mask == null ? "(mask dokunulmadı)"
                                   : x.Opt.Wlan0Mask == "" ? "(CIDR kaldırıldı)"
                                   : $"mask={x.Opt.Wlan0Mask}";
                string gatewayInfo = x.Opt.Wlan0Gateway == null ? "(gw dokunulmadı)"
                                   : x.Opt.Wlan0Gateway == "" ? "(gw kaldırıldı)"
                                   : $"gw={x.Opt.Wlan0Gateway}";
                await x.Logger.LogAsync(x.Ip, $"wlan0 -> {x.Opt.Wlan0IpOverride}  {maskInfo}  {gatewayInfo}");
            }

            if (!string.IsNullOrEmpty(x.Opt.Eth0IpOverride))
            {
                conf = DhcpcdHelper.UpsertDhcpcdInterface(
                    conf, "eth0", x.Opt.Eth0IpOverride,
                    x.Opt.Eth0Mask,
                    x.Opt.Eth0Gateway);

                string maskInfo = x.Opt.Eth0Mask == null ? "(mask dokunulmadı)"
                                   : x.Opt.Eth0Mask == "" ? "(CIDR kaldırıldı)"
                                   : $"mask={x.Opt.Eth0Mask}";
                string gatewayInfo = x.Opt.Eth0Gateway == null ? "(gw dokunulmadı)"
                                   : x.Opt.Eth0Gateway == "" ? "(gw kaldırıldı)"
                                   : $"gw={x.Opt.Eth0Gateway}";
                await x.Logger.LogAsync(x.Ip, $"eth0 -> {x.Opt.Eth0IpOverride}  {maskInfo}  {gatewayInfo}");
            }

            bool okWrite = await x.Updater.CopyTextContentWithSudoAsync(
                x.Client, conf, $"dhcpcd_{x.Ip}.conf", "/tmp/dhcpcd.conf", destCmd, x.Ip, x.Ct);

            if (!okWrite)
            {
                await x.Logger.LogAsync(x.Ip, "dhcpcd.conf yazılamadı (per-row).");
                return false;
            }

            await x.Logger.LogAsync(x.Ip, "dhcpcd.conf güncellendi (per-row).", StatusKind.Success);

            // ── dhcpcd.service restart ────────────────────────────────────────
            if (x.Opt.RestartDhcpcd)
            {
                var (okDhcpd, msgDhcpd) = await x.Updater.ExecuteSudoChainAsync(x.Client,
                    new[] { "systemctl restart dhcpcd.service" }, x.Ip, x.Ct);

                await x.Logger.LogAsync(x.Ip, okDhcpd
                    ? "dhcpcd.service restart edildi."
                    : $"dhcpcd.service restart hatası: {msgDhcpd}");

                // 2 saniye bekle, güncel IP adreslerini göster
                var (_, ipOut, _) = await x.Updater.ExecuteSudoGetOutputAsync(x.Client,
                    "sleep 2 && ip -4 addr show wlan0 2>/dev/null; ip -4 addr show eth0 2>/dev/null",
                    x.Ip, x.Ct, 15);

                if (!string.IsNullOrWhiteSpace(ipOut))
                    await x.Logger.LogAsync(x.Ip, "Güncel IP adresleri:\n" + ipOut.Trim());
            }

            // ── wpa_supplicant.service restart ───────────────────────────────
            if (x.Opt.RestartWpa)
            {
                var (okWpa, msgWpa) = await x.Updater.ExecuteSudoChainAsync(x.Client,
                    new[] { "systemctl restart wpa_supplicant.service" }, x.Ip, x.Ct);

                await x.Logger.LogAsync(x.Ip, okWpa
                    ? "wpa_supplicant.service restart edildi."
                    : $"wpa_supplicant.service restart hatası: {msgWpa}");
            }

            return true;
        }
    }

    internal sealed class DhcpcdStep : IUpdateStep
    {
        public bool ShouldRun(UpdateOptions o) => o.Dhcpcd;
        public async Task<bool> RunAsync(StepContext x)
        {
            bool ok = await x.Updater.CopyTextFileWithSudoAsync(x.Client, "dhcpcd.txt", "/tmp/dhcpcd.conf",
                "cp /tmp/dhcpcd.conf /etc/dhcpcd.conf && chown root:root /etc/dhcpcd.conf && chmod 644 /etc/dhcpcd.conf",
                x.Ip, x.Ct);
            if (ok) await x.Logger.LogAsync(x.Ip, "dhcpcd.conf kopyalandı.");
            return ok;
        }
    }

    internal sealed class WpaSupplicantStep : IUpdateStep
    {
        public bool ShouldRun(UpdateOptions o) => o.WpaSupplicant;
        public async Task<bool> RunAsync(StepContext x)
        {
            bool copied = await x.Updater.CopyTextFileWithSudoAsync(
                x.Client, "wpa_supplicant.txt", "/tmp/wpa_supplicant.conf",
                "[ -f /etc/wpa_supplicant/wpa_supplicant.conf ] && cp -a /etc/wpa_supplicant/wpa_supplicant.conf " +
                "/etc/wpa_supplicant/wpa_supplicant.conf.bak.$(date +%s) || true " +
                "&& cp /tmp/wpa_supplicant.conf /etc/wpa_supplicant/wpa_supplicant.conf " +
                "&& chown root:root /etc/wpa_supplicant/wpa_supplicant.conf && chmod 600 /etc/wpa_supplicant/wpa_supplicant.conf",
                x.Ip, x.Ct);
            if (!copied) return false;

            var (ok, msg) = await x.Updater.ExecuteSudoChainAsync(x.Client, new[]
            {
                "sed -i 's/\\r$//' /etc/wpa_supplicant/wpa_supplicant.conf",
                "chown root:root /etc/wpa_supplicant/wpa_supplicant.conf",
                "chmod 600 /etc/wpa_supplicant/wpa_supplicant.conf",
                "systemctl daemon-reload || true",
                "(systemctl restart wpa_supplicant@wlan0 || systemctl restart wpa_supplicant || wpa_cli -i wlan0 reconfigure) || true"
            }, x.Ip, x.Ct);
            await x.Logger.LogAsync(x.Ip, ok ? "wpa_supplicant uygulandı." : $"wpa_supplicant hatası: {msg}");
            return ok;
        }
    }

    internal sealed class SerialWorkerServiceStep : IUpdateStep
    {
        public bool ShouldRun(UpdateOptions o) => o.Service;
        public async Task<bool> RunAsync(StepContext x)
        {
            bool copied = await x.Updater.CopyTextFileWithSudoAsync(
                x.Client, "serialworker_service.txt", "/tmp/serialworker.service",
                "cp /tmp/serialworker.service /etc/systemd/system/serialworker.service " +
                "&& chown root:root /etc/systemd/system/serialworker.service && chmod 644 /etc/systemd/system/serialworker.service",
                x.Ip, x.Ct);
            if (!copied) return false;

            var (ok, msg) = await x.Updater.ExecuteSudoChainAsync(x.Client, new[]
            {
                "command -v systemctl >/dev/null 2>&1 && systemctl daemon-reexec || true",
                "command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload || true",
                "command -v systemctl >/dev/null 2>&1 && systemctl enable serialworker.service || true",
                "command -v systemctl >/dev/null 2>&1 && systemctl start serialworker.service || true"
            }, x.Ip, x.Ct);

            if (!ok && IsSudoBroken(msg))
            {
                x.Status.Set(x.Ip, "KRİTİK: sudo bozuk, fiziksel erişim gerekli.", StatusKind.Error);
                return false;
            }

            await x.Logger.LogAsync(x.Ip, ok ? "serialworker.service başlatıldı." : $"Servis başlatılamadı: {msg}");
            if (!ok) return false;

            var (logOk, _) = await x.Updater.ExecuteSudoChainAsync(x.Client, new[]
            {
                "mkdir -p /var/www/consoleApps/publish/Logs",
                "chown -R pi:pi /var/www/consoleApps/publish/Logs",
                "chmod -R 775 /var/www/consoleApps/publish/Logs"
            }, x.Ip, x.Ct);
            await x.Logger.LogAsync(x.Ip, logOk ? "Logs klasörü oluşturuldu." : "Logs izinleri uygulanamadı.");
            return logOk;
        }
        private static bool IsSudoBroken(string s) =>
            s.IndexOf("owned by uid", StringComparison.OrdinalIgnoreCase) >= 0 ||
            s.IndexOf("setuid bit", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    internal sealed class CrontabStep : IUpdateStep
    {
        public bool ShouldRun(UpdateOptions o) => o.Crontab;
        public async Task<bool> RunAsync(StepContext x)
        {
            bool ok = await x.Updater.CopyTextFileWithSudoAsync(x.Client, "crontab.txt", "/tmp/rasyobox_cron.txt",
                "crontab /tmp/rasyobox_cron.txt", x.Ip, x.Ct);
            await x.Logger.LogAsync(x.Ip, ok ? "Crontab yüklendi." : "Crontab yüklenemedi.");
            return ok;
        }
    }

    /// <summary>
    /// v4.1 — Cron servisini enable/disable eder.
    /// Enable:  açılışta otomatik + hemen başlat
    /// Disable: açılışta kapalı + hemen durdur
    ///
    /// <para>v5.1: cron'un native unit'inin yanında /etc/init.d/cron betiği de var. Bu yüzden
    /// <c>systemctl enable/disable</c>, SysV bağlarını senkronlamak için <c>update-rc.d</c>'yi (perl)
    /// çağırıyor. Cihazda perl bozuksa (ör. <c>syntax error at .../perl-base/strict.pm</c>) komut düşüyor,
    /// <c>--now</c> kısmı da hiç çalışmıyordu (servis açık kalıyordu). Artık:</para>
    /// <list type="number">
    /// <item>Açılış ayarı ile başlat/durdur ayrı komutlar. Biri düşse de diğeri yapılır.</item>
    /// <item>Açılış ayarı SysV tarafında düşerse SysV senkronu atlanarak yeniden denenir
    ///   (<c>SYSTEMCTL_SKIP_SYSV=1</c>; o da desteklenmiyorsa native wants bağlantısı elle).
    ///   systemd açılışta native unit'i kullanır, SysV bağları yalnızca eski init içindir.</item>
    /// <item>Başarı, komut çıkış kodlarına değil gerçek duruma (is-enabled / is-active) göre belirlenir.</item>
    /// <item>Perl bozuksa bozuk dosyalar (<c>dpkg --verify perl-base</c>) ayrıca uyarı olarak loglanır.</item>
    /// </list>
    /// </summary>
    internal sealed class CronServiceStep : IUpdateStep
    {
        private const string Unit = "cron.service";
        private const string WantsLink = "/etc/systemd/system/multi-user.target.wants/" + Unit;

        public bool ShouldRun(UpdateOptions o) => o.CronService != CronServiceAction.None;

        public async Task<bool> RunAsync(StepContext x)
        {
            bool enable = x.Opt.CronService == CronServiceAction.Enable;
            string action = enable ? "enable" : "disable";

            // 1) Açılış ayarı (enable için önce olası mask kaldırılır)
            string first = enable ? $"systemctl unmask {Unit} 2>/dev/null; systemctl enable {Unit}" : $"systemctl disable {Unit}";
            var (bootOk, bootMsg) = await x.Updater.ExecuteSudoChainAsync(x.Client, new[] { first }, x.Ip, x.Ct);

            string note = "";
            if (!bootOk && IsSysvFailure(bootMsg))
            {
                // SysV senkronunu atla: önce systemctl'in kendi anahtarıyla, desteklenmiyorsa native bağlantıyı elle kur/kaldır
                string manual = enable
                    ? $"[ -f /lib/systemd/system/{Unit} ] && ln -sf /lib/systemd/system/{Unit} {WantsLink} && systemctl daemon-reload"
                    : $"rm -f {WantsLink} && systemctl daemon-reload";
                (bootOk, _) = await x.Updater.ExecuteSudoChainAsync(x.Client, new[]
                {
                    $"SYSTEMCTL_SKIP_SYSV=1 systemctl {action} {Unit} || {{ {manual}; }}"
                }, x.Ip, x.Ct);
                note = " (update-rc.d çalışmadığı için SysV senkronu atlandı)";
                await LogBrokenPerlAsync(x);
            }

            // 2) Hemen başlat / durdur — açılış ayarından bağımsız
            var (nowOk, nowMsg) = await x.Updater.ExecuteSudoChainAsync(x.Client, new[]
            {
                $"systemctl {(enable ? "start" : "stop")} {Unit}"
            }, x.Ip, x.Ct);

            // 3) Gerçek durum
            var (_, stateOut, _) = await x.Updater.ExecuteSudoGetOutputAsync(x.Client,
                $"echo \"is-enabled: $(systemctl is-enabled {Unit} 2>&1); is-active: $(systemctl is-active {Unit} 2>&1)\"",
                x.Ip, x.Ct, 10);

            var m = Regex.Match(stateOut ?? "", @"is-enabled:\s*(\S+);\s*is-active:\s*(\S+)");
            string enabledState = m.Success ? m.Groups[1].Value : "";
            string activeState = m.Success ? m.Groups[2].Value : "";
            bool reached = enable
                ? enabledState == "enabled" && activeState == "active"
                : (enabledState is "disabled" or "masked") && activeState != "active";

            string state = string.IsNullOrWhiteSpace(stateOut) ? "" : $" [{stateOut.Trim()}]";
            if (reached)
            {
                await x.Logger.LogAsync(x.Ip, $"cron servisi {action} edildi.{note}{state}", StatusKind.Success);
                return true;
            }

            string why = !bootOk ? $"açılış ayarı: {Kisalt(bootMsg)}" : !nowOk ? $"{(enable ? "başlatma" : "durdurma")}: {Kisalt(nowMsg)}" : "durum beklenen gibi değil";
            await x.Logger.LogAsync(x.Ip, $"cron servisi {action} edilemedi — {why}{state}", StatusKind.Error);
            return false;
        }

        /// <summary>Hata SysV uyumluluk katmanından mı (systemd-sysv-install / update-rc.d / perl)?</summary>
        private static bool IsSysvFailure(string msg) =>
            msg.Contains("systemd-sysv-install", StringComparison.Ordinal)
            || msg.Contains("update-rc.d", StringComparison.Ordinal);

        /// <summary>
        /// update-rc.d perl hatasıyla düştüyse perl'ün kendisi bozuktur (çoğunlukla SD kart / dosya sistemi bozulması).
        /// Bu durum apt/dpkg'yi de etkiler; hangi dosyaların bozulduğunu (dpkg --verify, perl gerektirmez) logla.
        /// </summary>
        private static async Task LogBrokenPerlAsync(StepContext x)
        {
            var (perlOk, _, _) = await x.Updater.ExecuteSudoGetOutputAsync(x.Client, "perl -e 'use strict; 1'", x.Ip, x.Ct, 15);
            if (perlOk) return;

            var (_, verify, _) = await x.Updater.ExecuteSudoGetOutputAsync(x.Client,
                "dpkg --verify perl-base 2>&1 | head -n 5", x.Ip, x.Ct, 60);
            string files = string.Join(" | ", (verify ?? "").Replace("\r\n", "\n").Split('\n')
                                                   .Select(l => l.Trim()).Where(l => l.Length > 0));

            await x.Logger.LogAsync(x.Ip,
                "UYARI: cihazda perl çalışmıyor (sistem dosyası bozuk; SD kart / dosya sistemi bozulması olabilir). " +
                "apt/dpkg kurulumları ve update-rc.d kullanan işlemler de etkilenir. " +
                $"Bozuk dosyalar (dpkg --verify perl-base): {(files.Length > 0 ? files : "tespit edilemedi")}. " +
                "Onarım: sudo apt-get install --reinstall perl-base (internet gerekir); SD kartın durumu da kontrol edilmeli.",
                StatusKind.Warn);
        }

        private static string Kisalt(string? s)
        {
            if (string.IsNullOrWhiteSpace(s)) return "(çıktı yok)";
            var satirlar = s.Replace("\r\n", "\n").Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).ToArray();
            return string.Join(" | ", satirlar.Skip(Math.Max(0, satirlar.Length - 3)));
        }
    }

    /// <summary>
    /// v4.4 — tty1 konsolunda otomatik giriş (autologin) ayarı.
    /// Disable: /etc/systemd/system/getty@tty1.service.d/autologin.conf silinir,
    ///          drop-in klasörü boş kaldıysa kaldırılır, daemon-reload + getty@tty1 restart.
    ///          Böylece reboot beklemeden tty1 login ekranına döner.
    /// Enable:  autologin.conf yeniden oluşturulur (UID 1000 kullanıcısı, yoksa pi).
    /// </summary>
    internal sealed class AutologinStep : IUpdateStep
    {
        private const string DropInDir = "/etc/systemd/system/getty@tty1.service.d";
        private const string ConfPath = DropInDir + "/autologin.conf";

        public bool ShouldRun(UpdateOptions o) => o.Autologin != AutologinAction.None;

        public async Task<bool> RunAsync(StepContext x)
        {
            bool enable = x.Opt.Autologin == AutologinAction.Enable;

            string[] cmds = enable
                ? new[]
                {
                    $"mkdir -p {DropInDir}",
                    // UID 1000 kullanıcısını bul (yoksa pi); %%I printf'te literal %I üretir
                    "u=$(getent passwd 1000 | cut -d: -f1); [ -z \"$u\" ] && u=pi; " +
                    "printf '[Service]\\nExecStart=\\nExecStart=-/sbin/agetty --autologin %s --noclear %%I $TERM\\n' " +
                    $"\"$u\" > {ConfPath}",
                    $"chmod 0644 {ConfPath}",
                    "systemctl daemon-reload"
                }
                : new[]
                {
                    $"rm -f {ConfPath}",
                    // klasör boşsa temizle, doluysa dokunma
                    $"rmdir --ignore-fail-on-non-empty {DropInDir} 2>/dev/null || true",
                    "systemctl daemon-reload"
                };

            var (ok, msg) = await x.Updater.ExecuteSudoChainAsync(x.Client, cmds, x.Ip, x.Ct);

            if (!ok)
            {
                await x.Logger.LogAsync(x.Ip,
                    $"autologin {(enable ? "açılamadı" : "kapatılamadı")}: {msg}", StatusKind.Error);
                return false;
            }

            // getty@tty1'i yeniden başlat — reboot beklemeden etkili olsun.
            // Başarısız olması adımı düşürmez (unit maskeli/pasif olabilir), sadece loglanır.
            var (restartOk, restartMsg) = await x.Updater.ExecuteSudoChainAsync(x.Client, new[]
            {
                "systemctl restart getty@tty1.service"
            }, x.Ip, x.Ct);

            // Doğrulama: conf dosyası gerçekten var mı / yok mu + getty durumu
            var (_, stateOut, _) = await x.Updater.ExecuteSudoGetOutputAsync(x.Client,
                $"echo \"autologin.conf: $([ -f {ConfPath} ] && echo var || echo yok); " +
                "getty@tty1: $(systemctl is-active getty@tty1.service 2>&1)\"",
                x.Ip, x.Ct, 10);

            string state = string.IsNullOrWhiteSpace(stateOut) ? "" : $" [{stateOut.Trim()}]";
            string restartNote = restartOk ? "" : $" (getty@tty1 yeniden başlatılamadı: {restartMsg})";

            await x.Logger.LogAsync(x.Ip,
                enable ? $"tty1 autologin açıldı.{state}{restartNote}"
                       : $"tty1 autologin kapatıldı.{state}{restartNote}",
                StatusKind.Success);
            return true;
        }
    }

    internal sealed class JsonSettingsStep : IUpdateStep
    {
        public bool ShouldRun(UpdateOptions o) => o.JsonSettings;
        public async Task<bool> RunAsync(StepContext x)
        {
            const string dest = "cp /tmp/JsonSettings.json /var/www/consoleApps/publish/JsonSettings.json " +
                                "&& chown root:root /var/www/consoleApps/publish/JsonSettings.json " +
                                "&& chmod 644 /var/www/consoleApps/publish/JsonSettings.json";

            if (x.Opt.YatakIdOverride.HasValue)
            {
                string tmpl = x.LocalPath("JsonSettings.txt");
                if (!File.Exists(tmpl))
                {
                    await x.Logger.LogAsync(x.Ip, "JsonSettings.txt bulunamadı. Güncelleme iptal edildi.", StatusKind.Error);
                    return false;
                }
                string js = Regex.Replace(File.ReadAllText(tmpl),
                    @"(""YatakId""\s*:\s*)\d+", m => $"{m.Groups[1].Value}{x.Opt.YatakIdOverride.Value}");

                bool ok = await x.Updater.CopyTextContentWithSudoAsync(
                    x.Client, js, $"JsonSettings_{x.Ip}.txt", "/tmp/JsonSettings.json", dest, x.Ip, x.Ct);
                if (ok) await x.Logger.LogAsync(x.Ip, $"JsonSettings.json güncellendi (YatakId={x.Opt.YatakIdOverride.Value}).");
                return ok;
            }
            else
            {
                bool ok = await x.Updater.CopyTextFileWithSudoAsync(
                    x.Client, "JsonSettings.txt", "/tmp/JsonSettings.json", dest, x.Ip, x.Ct);
                if (ok) await x.Logger.LogAsync(x.Ip, "JsonSettings.json güncellendi.");
                return ok;
            }
        }
    }

    /// <summary>
    /// v4.7 — <c>serialdevices.json</c> kopyalama.
    ///
    /// <para>updateFiles klasöründeki <c>serialdevices.json</c> SFTP ile /tmp'ye yüklenir,
    /// oradan <c>install</c> ile <c>/var/www/consoleApps/publish/serialdevices.json</c>
    /// olarak (root:root, 0644) yerine konur — JsonSettings.json ile aynı sahiplik/izin.</para>
    ///
    /// <para>Dosya Türkçe karakter içerdiğinden <b>ikili (binary)</b> yüklenir; satır sonu
    /// dönüşümü yapılmaz (JSON için gereksiz, kodlamayı bozma riski var).</para>
    ///
    /// <para>Dosya yerelde yoksa ya da kopyalama başarısız olursa adım yalnızca loglar ve
    /// <c>true</c> döner — [[adım hatası zinciri kırar]] kuralı gereği cihazın kalan
    /// adımları iptal olmasın diye tüm gövde try/catch içinde.</para>
    /// </summary>
    internal sealed class SerialDevicesStep : IUpdateStep
    {
        private const string JsonName   = "serialdevices.json";
        private const string RemoteDir  = "/var/www/consoleApps/publish";
        private const string RemoteFile = RemoteDir + "/" + JsonName;
        private const string RemoteTemp = "/tmp/" + JsonName;

        public bool ShouldRun(UpdateOptions o) => o.SerialDevices;

        public async Task<bool> RunAsync(StepContext x)
        {
            try
            {
                if (!x.LocalExists(JsonName))
                {
                    await x.Logger.LogAsync(x.Ip,
                        $"{JsonName} updateFiles klasöründe bulunamadı — adım atlandı.",
                        StatusKind.Error);
                    return true; // zincir kırılmaz
                }

                string move =
                    $"mkdir -p {RemoteDir} && " +
                    $"install -m 0644 -o root -g root {RemoteTemp} {RemoteFile} && " +
                    $"rm -f {RemoteTemp}";

                bool ok = await x.Updater.CopyFileWithSudoAsync(
                    x.Client, JsonName, RemoteTemp, move, x.Ip, x.Ct,
                    unixifyBeforeUpload: false);

                if (!ok)
                {
                    await x.Logger.LogAsync(x.Ip,
                        $"{JsonName} cihaza kopyalanamadı.", StatusKind.Error);
                    return true;
                }

                // Doğrulama: hedefteki dosyanın izin/boyut satırı
                var (_, verify, _) = await x.Updater.ExecuteSudoGetOutputAsync(
                    x.Client, $"ls -l {RemoteFile} 2>&1 | tail -n 1", x.Ip, x.Ct, 20);

                string detail = string.IsNullOrWhiteSpace(verify) ? "" : $" [{verify.Trim()}]";
                await x.Logger.LogAsync(x.Ip,
                    $"{JsonName} → {RemoteDir}/{detail}", StatusKind.Success);
                return true;
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                await x.Logger.LogAsync(x.Ip,
                    $"{JsonName} adımı hata verdi: {ex.Message}", StatusKind.Error);
                return true; // zincir kırılmaz
            }
        }
    }

    /// <summary>
    /// conspy kurulumu — iki yöntem (v4.6).
    ///
    /// <para><b>Apt:</b> internet gerektirir. İnternet yoksa <c>apt-get update</c> ad
    /// çözümlemesi/bağlantı beklerken 40 sn'lik komut zaman aşımını aşıyor ve SSH.NET
    /// istisna fırlatıyordu; bu istisna dışarıdaki <c>catch</c>'e düşüp o cihazın
    /// KALAN TÜM ADIMLARINI iptal ediyordu (v4.5 ve öncesi). Artık önce kısa bir
    /// internet testi yapılıyor, ayrıca tüm adım try/catch içinde — hiçbir koşulda
    /// zincir kırılmıyor.</para>
    ///
    /// <para><b>Offline:</b> cihazdaki <c>/home/pi/conspy_1.16-1_armhf.deb</c> dosyasından
    /// <c>dpkg -i</c> ile kurar. Dosya cihazda yoksa updateFiles klasöründeki kopyası
    /// SFTP ile gönderilir; iki yerde de yoksa uyarı verilip adım atlanır.</para>
    /// </summary>
    internal sealed class ConspyStep : IUpdateStep
    {
        private const string DebName   = "conspy_1.16-1_armhf.deb";
        private const string RemoteDeb = "/home/pi/" + DebName;

        public bool ShouldRun(UpdateOptions o) => o.Conspy != ConspyAction.None;

        public async Task<bool> RunAsync(StepContext x)
        {
            try
            {
                if (x.Opt.Conspy == ConspyAction.Offline)
                    await RunOfflineAsync(x);
                else
                    await RunAptAsync(x);
            }
            catch (OperationCanceledException) { throw; }   // iptal yukarı gitmeli
            catch (Exception ex)
            {
                // Zaman aşımı vb. — asla zinciri kırma.
                await x.Logger.LogAsync(x.Ip,
                    $"conspy adımı hata verdi, atlandı: {ex.Message}", StatusKind.Error);
            }

            return true; // conspy hiçbir durumda zinciri kırmaz
        }

        // ── apt-get ile (internet gerekir) ────────────────────────────────────
        private static async Task RunAptAsync(StepContext x)
        {
            // Önce hızlı bir internet testi: apt'ye hiç girmeden karar ver.
            // Zaman aşımına düşmesin diye kısa süreli ve düşük timeout'lu.
            var (netOk, _, _) = await x.Updater.ExecuteSudoGetOutputAsync(x.Client,
                "getent hosts deb.debian.org >/dev/null 2>&1 || getent hosts archive.raspberrypi.org >/dev/null 2>&1",
                x.Ip, x.Ct, 15);

            if (!netOk)
            {
                await x.Logger.LogAsync(x.Ip,
                    "conspy atlandı: cihaz internete çıkamıyor (ad çözümlemesi başarısız). " +
                    "\"çevrimdışı (.deb)\" seçeneğini kullanabilirsiniz.", StatusKind.Warn);
                return;
            }

            var (ok, so, err) = await x.Updater.ExecuteSudoGetOutputAsync(x.Client,
                "( apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y -o DPkg::Lock::Timeout=120 conspy ) 2>&1",
                x.Ip, x.Ct, 180);

            await x.Logger.LogAsync(x.Ip,
                ok ? $"conspy kuruldu (apt-get).{await SurumAsync(x)}"
                   : $"conspy kurulamadı (apt-get): {Kisalt(so + "\n" + err)}",
                ok ? StatusKind.Success : StatusKind.Error);
        }

        // ── çevrimdışı .deb ile ───────────────────────────────────────────────
        private static async Task RunOfflineAsync(StepContext x)
        {
            // 1) Paket cihazda duruyor mu?
            var (varMi, _, _) = await x.Updater.ExecuteSudoGetOutputAsync(
                x.Client, $"test -f {RemoteDeb}", x.Ip, x.Ct, 15);

            if (!varMi)
            {
                // 2) Yoksa updateFiles'tan göndermeyi dene
                string? rel = x.FindFirst(DebName, Path.Combine("Resources", DebName));
                if (rel == null)
                {
                    await x.Logger.LogAsync(x.Ip,
                        $"conspy atlandı: {DebName} ne cihazda ({RemoteDeb}) ne de updateFiles klasöründe bulundu.",
                        StatusKind.Warn);
                    return;
                }

                await x.Logger.LogAsync(x.Ip,
                    $"{DebName} cihazda yok, updateFiles'tan gönderiliyor...");

                bool gonderildi = await x.Updater.CopyFileWithSudoAsync(
                    x.Client, rel, "/tmp/" + DebName,
                    $"install -m 0644 -o pi -g pi /tmp/{DebName} {RemoteDeb} && rm -f /tmp/{DebName}",
                    x.Ip, x.Ct, unixifyBeforeUpload: false);

                if (!gonderildi)
                {
                    await x.Logger.LogAsync(x.Ip,
                        $"conspy atlandı: {DebName} cihaza kopyalanamadı.", StatusKind.Error);
                    return;
                }
            }

            // 3) Kur. dpkg internet istemez; bağımlılık eksikse hatayı loglarız.
            //    dpkg kilit beklemez: apt-daily vb. kilidi tutuyorsa anında düşer.
            //    Bu yüzden kilit hatasında 5 sn arayla en fazla 2 dk yeniden denenir.
            // 2>&1: dpkg'nin hata metni stdout'a gelir — loglanacak olan o
            var (ok, so, err) = await x.Updater.ExecuteSudoGetOutputAsync(x.Client,
                $"for i in $(seq 1 24); do out=$(dpkg -i {RemoteDeb} 2>&1); rc=$?; " +
                "case \"$out\" in *locked*) sleep 5;; *) break;; esac; done; " +
                "echo \"$out\"; exit $rc",
                x.Ip, x.Ct, 180);

            await x.Logger.LogAsync(x.Ip,
                ok ? $"conspy kuruldu (çevrimdışı .deb).{await SurumAsync(x)}"
                   : $"conspy kurulamadı (çevrimdışı .deb): {Kisalt(so + "\n" + err)}",
                ok ? StatusKind.Success : StatusKind.Error);
        }

        /// <summary>Kurulum sonrası doğrulama: conspy gerçekten çalışıyor mu?</summary>
        private static async Task<string> SurumAsync(StepContext x)
        {
            var (_, so, _) = await x.Updater.ExecuteSudoGetOutputAsync(x.Client,
                "command -v conspy >/dev/null 2>&1 && echo \"conspy: $(dpkg-query -W -f='${Version}' conspy 2>/dev/null)\" || echo 'conspy: bulunamadı'",
                x.Ip, x.Ct, 15);
            return string.IsNullOrWhiteSpace(so) ? "" : $" [{so.Trim()}]";
        }

        private static string Kisalt(string? s)
        {
            if (string.IsNullOrWhiteSpace(s)) return "(çıktı yok)";
            var satirlar = s.Replace("\r\n", "\n").Split('\n')
                            .Select(l => l.Trim()).Where(l => l.Length > 0).ToArray();
            return string.Join(" | ", satirlar.Skip(Math.Max(0, satirlar.Length - 5)));
        }
    }

    internal sealed class DllStep : IUpdateStep
    {
        public bool ShouldRun(UpdateOptions o) => o.Dll;
        public async Task<bool> RunAsync(StepContext x)
        {
            await x.Updater.ExecuteSudoChainAsync(x.Client, new[]
            {
                "systemctl disable serialworker.service || true",
                "systemctl stop serialworker.service || true"
            }, x.Ip, x.Ct);

            bool copyOk = await x.Updater.CopyFileWithSudoAsync(
                x.Client, "SerialWorkerServiceVol61.dll", "/tmp/SerialWorkerServiceVol61.dll",
                "install -m 0644 -o root -g root /tmp/SerialWorkerServiceVol61.dll /var/www/consoleApps/publish/SerialWorkerServiceVol61.dll",
                x.Ip, x.Ct, unixifyBeforeUpload: false);

            if (!copyOk) { x.Status.Set(x.Ip, "DLL kopyalanamadı.", StatusKind.Error); return false; }
            await x.Logger.LogAsync(x.Ip, "DLL kopyalandı.");

            await x.Updater.ExecuteSudoChainAsync(x.Client, new[]
            {
                "mkdir -p /var/www/consoleApps/publish",
                "chattr -i -R /var/www/consoleApps/publish 2>/dev/null || true",
                "mount | grep ' / ' | grep -q '(ro' && mount -o remount,rw / || true",
                "groupadd -f deploy",
                "id -nG pi | tr ' ' '\\n' | grep -qx deploy || usermod -aG deploy pi",
                "chgrp -R deploy /var/www/consoleApps/publish",
                "find /var/www/consoleApps/publish -type d -exec chmod 2775 {} +",
                "find /var/www/consoleApps/publish -type f -exec chmod 0664 {} +",
                "command -v setfacl >/dev/null 2>&1 && setfacl -R -m  u:pi:rwx,g:deploy:rwx /var/www/consoleApps/publish || true",
                "command -v setfacl >/dev/null 2>&1 && setfacl -R -d -m u:pi:rwx,g:deploy:rwx /var/www/consoleApps/publish || true",
                "sudo -u pi -H bash -lc 'touch /var/www/consoleApps/publish/__wtest && rm -f /var/www/consoleApps/publish/__wtest'"
            }, x.Ip, x.Ct);

            var (enableOk, enableMsg) = await x.Updater.ExecuteSudoChainAsync(x.Client, new[]
            {
                "systemctl daemon-reexec || true",
                "systemctl daemon-reload || true",
                "systemctl enable serialworker.service",
                "systemctl start serialworker.service"
            }, x.Ip, x.Ct);

            await x.Logger.LogAsync(x.Ip,
                enableOk ? "DLL güncellendi, serialworker.service başlatıldı." : $"Servis başlatılamadı: {enableMsg}",
                enableOk ? StatusKind.Success : StatusKind.Error);
            return enableOk;
        }
    }

    /// <summary>
    /// v4.5 — RasyoBOX web arayüzü kurulumu.
    /// updateFiles altındaki <c>rasyobox-*.tar.gz</c> arşivi cihazın /home/pi klasörüne
    /// yüklenir, açılır, <c>sudo bash install.sh</c> çalıştırılır; işlem bitince
    /// hem arşiv hem de açılan klasör silinir (kurulum dosyaları
    /// /opt/rasyobox altına kopyalandığı için kaynağa gerek kalmaz).
    /// Hata durumunda zincir kırılmaz — yalnızca loglanır.
    ///
    /// <para>v4.9 — arşiv adı ve arşiv içindeki klasör adı artık sürümden bağımsız:
    /// dosya adı kalıpla (<c>rasyobox-*.tar.gz</c>) bulunur, en yüksek sürüm seçilir;
    /// uzak tarafta <c>install.sh</c> hangi klasördeyse orada çalıştırılır.</para>
    /// </summary>
    internal sealed class WebServerStep : IUpdateStep
    {
        // v4.9: sabit "rasyobox-v9.tar.gz" yerine kalıp. v9 / v12 / v1.2 / v2.0.1 hepsi eşleşir.
        private const string ArchivePattern = "rasyobox-*.tar.gz";
        private const string RemoteHome     = "/home/pi";
        private const string RemotePkgDir   = RemoteHome + "/rasyobox_pkg";  // arşivin açıldığı geçici klasör
        private const string LegacyDir      = RemoteHome + "/rasyobox";      // v4.8 ve öncesinin bıraktığı klasör

        // install.sh curl ile kendi kendini test ediyor; 40 sn'lik varsayılan yetmez.
        private const int InstallTimeoutSeconds = 300;

        public bool ShouldRun(UpdateOptions o) => o.WebServer;

        public async Task<bool> RunAsync(StepContext x)
        {
            // 1) Arşiv yerelde var mı? (kalıba uyanlar arasından en yüksek sürüm)
            string? rel = FindNewestArchive(x);
            if (rel == null)
            {
                await x.Logger.LogAsync(x.Ip,
                    $"{ArchivePattern} kalıbına uyan arşiv updateFiles klasöründe bulunamadı — web server adımı atlandı.",
                    StatusKind.Error);
                return true; // zincir kırılmaz
            }

            string archiveName  = Path.GetFileName(rel);
            string remoteArchive = $"{RemoteHome}/{archiveName}";
            await x.Logger.LogAsync(x.Ip, $"Web server arşivi: {archiveName}");

            // 1b) v5.1: install.sh ayar dosyası geçersiz JSON ise kurulumu durduruyor ama sebebi
            //     gizliyor (python hatası 2>/dev/null). Arşivi boşuna göndermeden aynı kontrolü yapıp
            //     sebebi (satır/sütun, kodlama, boş dosya) açıkça logla.
            string? settingsProblem = await CheckSettingsJsonAsync(x);
            if (settingsProblem != null)
            {
                await x.Logger.LogAsync(x.Ip,
                    $"Web server kurulmadı: cihazdaki {SettingsJson} geçerli JSON değil — {settingsProblem}. " +
                    "install.sh bu durumda kurulumu durduruyor. Dosyayı düzeltin ya da \"JsonSettings\" seçeneğiyle " +
                    "yeniden yazın (dikkat: şablondaki ServerIp de yazılır).",
                    StatusKind.Error);
                return true; // zincir kırılmaz
            }

            // 1c) v5.1: install.sh'in sertifika adımı "mktemp -d" ile /tmp'de klasör açıyor; açamazsa
            //     yalnızca "Gecici dizin acilamadi" diyor. Aynı işlemi deneyip gerçek hatayı
            //     (disk dolu / salt okunur / /tmp yok / G/Ç hatası) ve boş alanı logla.
            string? tmpProblem = await CheckTempDirAsync(x);
            if (tmpProblem != null)
            {
                await x.Logger.LogAsync(x.Ip,
                    $"Web server kurulmadı: cihazda geçici klasör açılamıyor — {tmpProblem}. " +
                    "install.sh TLS sertifikasını bu yüzden üretemez.",
                    StatusKind.Error);
                return true; // zincir kırılmaz
            }

            // 2) SFTP ile /tmp'ye yükle, oradan /home/pi'ye taşı (sahip pi:pi)
            bool copied = await x.Updater.CopyFileWithSudoAsync(
                x.Client, rel, "/tmp/" + archiveName,
                $"install -m 0644 -o pi -g pi '/tmp/{archiveName}' '{remoteArchive}' && rm -f '/tmp/{archiveName}'",
                x.Ip, x.Ct, unixifyBeforeUpload: false);

            if (!copied)
            {
                await x.Logger.LogAsync(x.Ip,
                    $"{archiveName} cihaza kopyalanamadı — web server kurulumu yapılmadı.", StatusKind.Error);
                return true;
            }

            // 3) Aç ve kur.
            //    ( ... ) 2>&1  : TÜM zincirin (tar dahil) hata çıktısı tek kanala düşsün.
            //                    Aksi halde tar'ın uyarıları ayrı gelip install.sh'in
            //                    asıl çıktısını log'da geriye itiyordu.
            //    --warning=no-timestamp : cihaz saati geride olduğunda tar her dosya için
            //                    "time stamp ... in the future" uyarısı basıyor; sadece gürültü.
            //    -m            : dosyalara arşivdeki (ileri tarihli) mtime yerine şimdiki zaman.
            //    </dev/null    : install.sh port çakışmasında soru sorabiliyor, beklemesin.
            //    v4.9: arşiv ayrı bir klasöre açılır ve install.sh aranarak bulunur —
            //          arşivin kök klasörü "rasyobox" da olsa "rasyobox-v12" de olsa çalışır.
            string install =
                $"( rm -rf {RemotePkgDir} && mkdir -p {RemotePkgDir} && " +
                $"tar --warning=no-timestamp -xzmf '{remoteArchive}' -C {RemotePkgDir} && " +
                $"d=$(find {RemotePkgDir} -maxdepth 3 -type f -name install.sh | head -n1) && " +
                $"{{ [ -n \"$d\" ] || {{ echo 'HATA: arsivde install.sh bulunamadi'; exit 1; }}; }} && " +
                $"cd \"$(dirname \"$d\")\" && bash install.sh </dev/null ) 2>&1";

            var (ok, stdout, stderr) = await x.Updater.ExecuteSudoGetOutputAsync(
                x.Client, install, x.Ip, x.Ct, InstallTimeoutSeconds);

            // stdout zaten her şeyi içeriyor; stderr yine de boş değilse sona eklenir.
            string output = StripAnsi(((stdout ?? "") + "\n" + (stderr ?? "")).Trim());
            bool finished = output.Contains("Kurulum tamamlandi", StringComparison.OrdinalIgnoreCase);

            // 4) Kurulum başarılı da olsa olmasa da kaynak dosyaları temizle
            //    (v4.9: eski sürümlerin bıraktığı ~/rasyobox klasörü de siliniyor)
            string targets = $"{RemotePkgDir} {LegacyDir} '{remoteArchive}'";
            var (_, leftOver, _) = await x.Updater.ExecuteSudoGetOutputAsync(x.Client,
                $"rm -rf {targets}; " +
                $"echo \"kalan: $(ls -d {targets} 2>/dev/null | tr '\\n' ' ')\"",
                x.Ip, x.Ct, 30);

            // 5) Servis durumu + erişim adresi
            var (_, stateOut, _) = await x.Updater.ExecuteSudoGetOutputAsync(x.Client,
                "echo \"rasyobox-web: $(systemctl is-active rasyobox-web 2>&1)/" +
                "$(systemctl is-enabled rasyobox-web 2>&1); adres: http://$(hostname -I | cut -d' ' -f1)\"",
                x.Ip, x.Ct, 20);

            string state = string.IsNullOrWhiteSpace(stateOut) ? "" : $" [{stateOut.Trim()}]";

            // "kalan:" satırının sonunda hiçbir yol yoksa temizlik başarılı demektir.
            string leftTrim = (leftOver ?? "").Trim();
            bool nothingLeft = leftTrim.Length == 0 || leftTrim.EndsWith("kalan:", StringComparison.Ordinal);
            string cleaned = nothingLeft ? " (kaynak dosyalar silindi)" : $" ({leftTrim})";

            if (ok && finished)
            {
                await x.Logger.LogAsync(x.Ip,
                    $"Web server kuruldu.{state}{cleaned}", StatusKind.Success);
            }
            else
            {
                // Hata satırlarını (install.sh bunları ✗ ile basıyor) öne al; sonra son satırlar.
                string errLines = Errors(output);
                string detail = string.IsNullOrEmpty(errLines)
                    ? Tail(output, 10)
                    : $"{errLines} || son satırlar: {Tail(output, 6)}";

                await x.Logger.LogAsync(x.Ip,
                    $"Web server kurulumu tamamlanamadı.{state}{cleaned} Çıktı: {detail}",
                    StatusKind.Error);
            }

            return true; // hata olsa da zincir devam eder
        }

        // ── v5.1: ayar dosyası ön kontrolü ───────────────────────────────────
        private const string SettingsJson = "/var/www/consoleApps/publish/JsonSettings.json";

        // install.sh ile aynı okuma (utf-8-sig + json), ama hatayı tek satırda açıklar.
        // Tek tırnak kullanılmaz: komut bash -c '...' içinde çalışır.
        private const string SettingsCheckPy =
            "import json,sys\n" +
            "p=sys.argv[1]\n" +
            "try:\n" +
            "    raw=open(p,\"rb\").read()\n" +
            "except FileNotFoundError:\n" +
            "    print(\"YOK\"); sys.exit(0)\n" +
            "if not raw.strip():\n" +
            "    print(\"dosya bos (%d bayt)\" % len(raw)); sys.exit(1)\n" +
            "try:\n" +
            "    txt=raw.decode(\"utf-8-sig\")\n" +
            "except UnicodeDecodeError as e:\n" +
            "    print(\"UTF-8 degil: %d. baytta 0x%02x (dosya ANSI / Windows-1254 kaydedilmis olabilir)\" % (e.start, raw[e.start])); sys.exit(1)\n" +
            "try:\n" +
            "    json.loads(txt)\n" +
            "except json.JSONDecodeError as e:\n" +
            "    lines=txt.splitlines()\n" +
            "    bad=lines[e.lineno-1].strip()[:80] if 0 < e.lineno <= len(lines) else \"\"\n" +
            "    print(\"%s (satir %d, sutun %d): %s\" % (e.msg, e.lineno, e.colno, bad)); sys.exit(1)\n" +
            "print(\"OK\")\n";

        /// <summary>null: dosya geçerli ya da yok (install.sh yoksa yalnızca uyarır). Aksi halde sorunun açıklaması.</summary>
        private static async Task<string?> CheckSettingsJsonAsync(StepContext x)
        {
            var (ok, stdout, stderr) = await x.Updater.ExecuteSudoGetOutputAsync(x.Client,
                $"python3 -c '{SettingsCheckPy}' {SettingsJson} 2>&1", x.Ip, x.Ct, 20);

            string outText = (stdout ?? "").Trim();
            if (ok && (outText.EndsWith("OK", StringComparison.Ordinal) || outText.EndsWith("YOK", StringComparison.Ordinal)))
                return null;

            string detail = outText.Length > 0 ? outText : (stderr ?? "").Trim();
            // Olası login çıktısı vb. önde kalmasın: son satır açıklamadır
            string last = detail.Replace("\r\n", "\n").Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.Length > 0) ?? "";
            return last.Length > 0 ? last : "kontrol çalıştırılamadı";
        }

        /// <summary>null: /tmp'de klasör açılabiliyor. Aksi halde mktemp hatası + /tmp durumu + boş alan.</summary>
        private static async Task<string?> CheckTempDirAsync(StepContext x)
        {
            var (ok, stdout, _) = await x.Updater.ExecuteSudoGetOutputAsync(x.Client,
                "d=$(env -u TMPDIR mktemp -d 2>&1) && rmdir \"$d\" && echo TMP_OK || " +
                "echo \"mktemp: $d | /tmp: $(ls -ld /tmp 2>&1) | $(mount | grep -E ' on / | on /tmp ' | sed 's/ type / /' | tr '\\n' ';') | " +
                "bos alan: $(df -Ph /tmp 2>&1 | awk 'NR==2{print $4\" (\"$5\" dolu)\"}'), inode: $(df -Pi /tmp 2>&1 | awk 'NR==2{print $5\" dolu\"}')\"",
                x.Ip, x.Ct, 20);

            string outText = (stdout ?? "").Trim();
            if (ok && outText.EndsWith("TMP_OK", StringComparison.Ordinal)) return null;
            string last = outText.Replace("\r\n", "\n").Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.Length > 0) ?? "";
            return last.Length > 0 ? last : "kontrol çalıştırılamadı";
        }

        // ── v4.9: sürümden bağımsız arşiv seçimi ─────────────────────────────
        //  updateFiles (ve varsa Resources) içinde "rasyobox-*.tar.gz" kalıbına uyan
        //  dosyalar taranır, en yüksek sürümlü olan seçilir. Sürüm karşılaştırması
        //  dosya adındaki sayı gruplarına göre yapılır: v9 < v12, v1.2 < v1.10,
        //  v2 < v2.0.1. Sürümler eşitse dosya tarihi yeni olan, o da eşitse ada göre
        //  son gelen seçilir. Dönen değer WorkFolder'a göre göreli yoldur.

        /// <summary>Kabuk komutuna güvenle gömülebilen dosya adları (tırnak/boşluk yok).</summary>
        private static readonly Regex SafeArchiveName = new(@"^[A-Za-z0-9._+-]+$", RegexOptions.Compiled);
        private static readonly Regex NumberGroups = new(@"\d+", RegexOptions.Compiled);

        private static string? FindNewestArchive(StepContext x)
        {
            try
            {
                var found = new List<string>();   // WorkFolder'a göre göreli yollar

                foreach (string sub in new[] { "", "Resources" })
                {
                    string dir = sub.Length == 0 ? x.WorkFolder : Path.Combine(x.WorkFolder, sub);
                    if (!Directory.Exists(dir)) continue;

                    foreach (string full in Directory.EnumerateFiles(dir, ArchivePattern, SearchOption.TopDirectoryOnly))
                    {
                        string name = Path.GetFileName(full);
                        if (!SafeArchiveName.IsMatch(name)) continue;   // boşluk/tırnak içeren adı atla
                        found.Add(sub.Length == 0 ? name : Path.Combine(sub, name));
                    }
                }

                if (found.Count == 0) return null;
                if (found.Count == 1) return found[0];

                found.Sort((a, b) =>
                {
                    int c = CompareVersion(VersionKey(Path.GetFileName(b)), VersionKey(Path.GetFileName(a)));
                    if (c != 0) return c;                                  // yüksek sürüm önce
                    c = SafeWriteTime(x, b).CompareTo(SafeWriteTime(x, a));
                    if (c != 0) return c;                                  // yeni dosya önce
                    return string.Compare(b, a, StringComparison.OrdinalIgnoreCase);
                });
                return found[0];
            }
            catch
            {
                return null;   // klasör okunamıyorsa adım atlanır, zincir kırılmaz
            }
        }

        private static DateTime SafeWriteTime(StepContext x, string rel)
        {
            try { return File.GetLastWriteTimeUtc(x.LocalPath(rel)); }
            catch { return DateTime.MinValue; }
        }

        /// <summary>Dosya adındaki sayı gruplarını sürüm parçaları olarak çıkarır. "rasyobox-v1.2.tar.gz" → [1, 2]</summary>
        private static long[] VersionKey(string fileName)
        {
            string s = fileName;
            if (s.EndsWith(".tar.gz", StringComparison.OrdinalIgnoreCase)) s = s[..^7];
            return NumberGroups.Matches(s)
                               .Select(m => long.TryParse(m.Value, out long v) ? v : 0L)
                               .ToArray();
        }

        /// <summary>Sürüm parçalarını soldan sağa karşılaştırır; eksik parça -1 sayılır (v2 &lt; v2.0.1).</summary>
        private static int CompareVersion(long[] a, long[] b)
        {
            int n = Math.Max(a.Length, b.Length);
            for (int i = 0; i < n; i++)
            {
                long ai = i < a.Length ? a[i] : -1;
                long bi = i < b.Length ? b[i] : -1;
                if (ai != bi) return ai.CompareTo(bi);
            }
            return 0;
        }

        /// <summary>install.sh renkli çıktı basıyor; ANSI kaçış dizilerini temizler.</summary>
        private static string StripAnsi(string s)
            => string.IsNullOrEmpty(s) ? "" : Regex.Replace(s, @"\x1B\[[0-9;]*[A-Za-z]", "");

        /// <summary>install.sh hata satırlarını "✗" işaretinden yakalar (en fazla 4 tane).</summary>
        private static string Errors(string s)
        {
            if (string.IsNullOrWhiteSpace(s)) return "";
            var hits = s.Replace("\r\n", "\n").Split('\n')
                        .Select(l => l.Trim())
                        .Where(l => l.StartsWith("✗", StringComparison.Ordinal))
                        .Take(4)
                        .ToArray();
            return string.Join(" | ", hits);
        }

        /// <summary>Log satırı şişmesin diye çıktının son N dolu satırı.</summary>
        private static string Tail(string s, int lines)
        {
            if (string.IsNullOrWhiteSpace(s)) return "(çıktı yok)";
            var parts = s.Replace("\r\n", "\n").Split('\n')
                         .Select(l => l.Trim())
                         .Where(l => l.Length > 0)
                         .ToArray();
            return string.Join(" | ", parts.Skip(Math.Max(0, parts.Length - lines)));
        }
    }

    internal sealed class ExpandFsRebootStep : IUpdateStep
    {
        public bool ShouldRun(UpdateOptions o) => o.ExpandFs || o.RebootAfter;
        public async Task<bool> RunAsync(StepContext x)
        {
            if (x.Opt.ExpandFs)
            {
                var (ok, msg) = await x.Updater.ExecuteSudoChainAsync(x.Client,
                    new[] { "raspi-config --expand-rootfs" }, x.Ip, x.Ct);
                await x.Logger.LogAsync(x.Ip, ok ? "RootFS genişletme uygulandı." : $"RootFS hatası: {msg}");
                if (!ok) return false;
            }

            const string delayed = "command -v systemd-run >/dev/null 2>&1 " +
                "&& systemd-run --unit=rasyobox-delayed-reboot --on-active=3s /usr/bin/systemctl reboot " +
                "|| nohup sh -c 'sleep 3; systemctl reboot' >/dev/null 2>&1 &";
            var (rebootOk, rebootMsg) = await x.Updater.ExecuteSudoChainAsync(x.Client, new[] { delayed }, x.Ip, x.Ct);
            await x.Logger.LogAsync(x.Ip, rebootOk ? "Reboot 3 sn sonra planlandı." : $"Reboot planlanamadı: {rebootMsg}");
            return rebootOk;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  UpdateCoordinator  —  adım zincirini çalıştırır
    // ─────────────────────────────────────────────────────────────────────────
    public sealed class UpdateCoordinator
    {
        private readonly string _workFolder;
        private readonly IStatusReporter _status;
        private readonly IAppLogger _logger;

        // Adım sırası — yeni özellik eklemek için sadece buraya bir satır ekle
        private static readonly IUpdateStep[] Steps =
        {
            new CleanupStep(),
            new BadLogsCleanupStep(),
            new NanoRcStep(),
            new RcLocalStep(),
            new BashRcStep(),
            new ProfileStep(),
            new NetStatusBannerShStep(),
            new NetStatusBannerServiceStep(), // script'ten sonra: enable --now onu çalıştırır
            new SwHelpLogServiceStep(),
            new WifiMonitorStep(),
            new RasyoCleanStep(),
            new NetBannerLoginStep(),
            new DhcpcdStep(),
            new PerRowDhcpcdStep(),      // ListView wlan0/eth0 sütunlarından per-row güncelleme
            new WpaSupplicantStep(),
            new SerialWorkerServiceStep(),
            new CrontabStep(),
            new CronServiceStep(),       // v4.1: cron servisi enable/disable
            new AutologinStep(),         // v4.4: tty1 autologin enable/disable
            new JsonSettingsStep(),
            new SerialDevicesStep(),     // v4.7: serialdevices.json → /var/www/consoleApps/publish
            new ConspyStep(),
            new DllStep(),
            new WebServerStep(),         // v4.5: RasyoBOX web arayüzü (rasyobox-v9.tar.gz)
            new ExpandFsRebootStep(),
        };

        public UpdateCoordinator(string workFolder, IStatusReporter status, IAppLogger logger)
        {
            _workFolder = workFolder ?? throw new ArgumentNullException(nameof(workFolder));
            _status = status ?? throw new ArgumentNullException(nameof(status));
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        }

        public async Task<bool> UpdateSingleIpAsync(
            string ip, string user, string pass,
            UpdateOptions opt, int? yatakIdOverride,
            string? wlan0IpOverride, string? eth0IpOverride,
            CancellationToken ct)
        {
            // v4.2: paralel çağrılarda paylaşılan nesneyi değiştirme — kopya üzerinde çalış
            opt = opt.Clone();
            opt.YatakIdOverride = yatakIdOverride;
            opt.Wlan0IpOverride = wlan0IpOverride;
            opt.Eth0IpOverride = eth0IpOverride;
            var updater = new SshUpdater(ip, user, pass, _workFolder, _logger.LogAsync);

            try
            {
                await _logger.LogAsync(ip, "Bağlanılıyor...");
                ct.ThrowIfCancellationRequested();

                if (!await HasSshBannerAsync(ip))
                {
                    _status.Set(ip, "SSH banner alınamadı — sshd cevap vermiyor.", StatusKind.Error);
                    return false;
                }

                SshClient client;
                try { client = await Task.Run(() => updater.Connect(), ct); }
                catch (SshOperationTimeoutException)
                {
                    _status.Set(ip, "SSH zaman aşımı.", StatusKind.Error); return false;
                }
                catch (Exception ex)
                {
                    HandleSshConnectError(ex, ip); return false;
                }

                if (!client.IsConnected)
                {
                    _status.Set(ip, "SSH bağlantısı başarısız.", StatusKind.Error); return false;
                }

                using (client)
                {
                    // v4.2: tek çağrı — LogAsync zaten UI'a da yazar (çift satır düzeltmesi)
                    await _logger.LogAsync(ip, "Bağlantı başarılı.", StatusKind.Success);

                    var ctx = new StepContext(ip, client, updater, opt, ct,
                                             _logger, _status, _workFolder);

                    foreach (var step in Steps)
                    {
                        if (!step.ShouldRun(opt)) continue;
                        ct.ThrowIfCancellationRequested();

                        bool ok = await step.RunAsync(ctx);
                        if (!ok) return false;
                    }

                    await _logger.LogAsync(ip, "Güncelleme başarıyla tamamlandı.", StatusKind.Success);
                    return true;
                }
            }
            catch (OperationCanceledException)
            {
                await _logger.LogAsync(ip, "Güncelleme iptal edildi.", StatusKind.Warn);
                return false;
            }
            catch (Exception ex)
            {
                await _logger.LogAsync(ip, $"Hata: {ex.Message}", StatusKind.Error);
                return false;
            }
            finally
            {
                // v4.8: cihaza özel geçici klasörü temizle
                updater.CleanupTempFolder();
            }
        }

        // ── Yardımcılar ───────────────────────────────────────────────────────

        private void HandleSshConnectError(Exception ex, string host)
        {
            string msg = ex is SshAuthenticationException ? "SSH kimlik doğrulama hatası." :
                         ex is SocketException se ? $"Ağ hatası ({se.SocketErrorCode})." :
                         ex is SshOperationTimeoutException ? "SSH zaman aşımı." :
                         ex is SshConnectionException ? "SSH bağlantı kurulamadı." :
                         $"SSH hatası: {ex.Message}";
            _status.Set(host, msg, StatusKind.Error); // FileReportLogger.Tee: rapora da yazılır
        }

        private static async Task<bool> HasSshBannerAsync(string host, int port = 22, int timeoutMs = 1500)
        {
            try
            {
                using var c = new TcpClient();
                var conn = c.ConnectAsync(host, port);
                var delay = Task.Delay(timeoutMs);
                if (await Task.WhenAny(conn, delay) != conn || !c.Connected) return false;

                using var s = c.GetStream();
                s.ReadTimeout = timeoutMs;
                var buf = new byte[128];
                int n = await s.ReadAsync(buf, 0, buf.Length);
                return n > 0 && Encoding.ASCII.GetString(buf, 0, n).StartsWith("SSH-");
            }
            catch { return false; }
        }
    }
}