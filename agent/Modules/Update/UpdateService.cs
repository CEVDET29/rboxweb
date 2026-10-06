using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using Renci.SshNet;
using RboxAgent.Modules.Update.Core;
using RboxAgent.Modules.Update.Services;

namespace RboxAgent.Modules.Update
{
    public sealed record UpdTarget(int Id, string Ip, int? YatakId, string? Wlan0, string? Eth0);

    public sealed class UpdateRunRequest
    {
        public List<UpdTarget> Targets { get; set; } = new();
        public UpdateOptions Options { get; set; } = new();
        public int Parallel { get; set; } = 10;
    }

    public sealed class VersionRequest
    {
        public List<UpdTarget> Targets { get; set; } = new();
        public int Parallel { get; set; } = 10;
    }

    public sealed class TtyRequest
    {
        public string? Ip { get; set; }
        public string? Text { get; set; }
    }

    public sealed class SingleRequest
    {
        public string? TargetIp { get; set; }
        public bool DoYatak { get; set; }
        public int YatakId { get; set; }
        public bool DoServer { get; set; }
        public string? ServerIp { get; set; }
        public bool DoEth0 { get; set; }
        public string? Eth0Ip { get; set; }
        public string? Eth0Mask { get; set; }
        public bool DoWlan0 { get; set; }
        public string? Wlan0Ip { get; set; }
        public string? Wlan0Mask { get; set; }
    }

    /// <summary>Cihaz Güncelleme modülünün ajan tarafı (WPF'teki UpdateViewModel'in arayüzsüz karşılığı).</summary>
    internal static class UpdateService
    {
        /// <summary>WPF uygulamasının varsayılan kurulum yeri: varsa web sürümü de aynı updateFiles klasörünü kullanır.</summary>
        public const string WpfFolder = @"C:\Rasyomed\RboxTools\updateFiles";

        public static string DefaultFolder => Path.Combine(DataStore.Folder, "updateFiles");

        /// <summary>Komut satırı (--work) ya da agent.json ile sabitlenmiş klasör; en yüksek öncelik.</summary>
        public static string? ExplicitFolder { get; set; }

        /// <summary>
        /// Güncelleme dosyalarının (updateFiles) klasörü. Öncelik: --work / agent.json → arayüzden kaydedilen →
        /// WPF klasörü (C:\Rasyomed\RboxTools\updateFiles varsa) → %AppData%\RboxAgent\updateFiles.
        /// </summary>
        public static string WorkFolder
        {
            get
            {
                if (!string.IsNullOrWhiteSpace(ExplicitFolder)) return ExplicitFolder!;
                string? saved = DataStore.Settings.Update.WorkFolder;
                if (!string.IsNullOrWhiteSpace(saved)) return saved!;
                return Directory.Exists(WpfFolder) ? WpfFolder : DefaultFolder;
            }
        }

        public static string WorkSource =>
            !string.IsNullOrWhiteSpace(ExplicitFolder) ? "cli" :
            !string.IsNullOrWhiteSpace(DataStore.Settings.Update.WorkFolder) ? "saved" :
            Directory.Exists(WpfFolder) ? "wpf" : "default";

        /// <summary>Arayüzden klasör seçimi. Boş yol = otomatik. Komut satırıyla sabitlenmişse değiştirilemez.</summary>
        public static (bool ok, string message) SetWorkFolder(string? path)
        {
            if (!string.IsNullOrWhiteSpace(ExplicitFolder))
                return (false, "Klasör ajan komut satırında (--work / agent.json) sabitlenmiş; oradan değiştirin.");
            string p = (path ?? "").Trim();
            if (p.Length > 0)
            {
                if (!Path.IsPathRooted(p)) return (false, "Tam bir klasör yolu girin (ör. C:\\Rasyomed\\RboxTools\\updateFiles).");
                try { p = Path.GetFullPath(p); Directory.CreateDirectory(p); }
                catch (Exception ex) { return (false, "Klasör kullanılamıyor: " + ex.Message); }
            }
            DataStore.Settings.Update.WorkFolder = p.Length == 0 ? null : p;
            DataStore.Save();
            return (true, "");
        }

        /// <summary>Cihaza gönderilen, sık düzenlenen dosyalar (WPF'tekiyle aynı liste).</summary>
        public static readonly string[] EditableFiles = { "JsonSettings.txt", "serialdevices.json", "wpa_supplicant.txt", "dhcpcd.txt" };

        private static readonly ConcurrentDictionary<string, CancellationTokenSource> Runs = new();
        private static int _busy;   // toplu güncelleme ya da versiyon kontrolü sürerken 1

        public static bool Cancel(string runId)
        {
            if (!Runs.TryGetValue(runId, out var cts)) return false;
            try { cts.Cancel(); } catch (ObjectDisposedException) { }
            return true;
        }

        public static bool IsBusy => Volatile.Read(ref _busy) == 1;
        /// <summary>Başka modülün (Dosya gönder) akışını iptal edilebilir kayda ekler; Dispose kaydı siler.</summary>
        internal static IDisposable RegisterRun(string runId, CancellationTokenSource cts)
        {
            Runs[runId] = cts;
            return new RunRegistration(runId);
        }

        private sealed class RunRegistration(string runId) : IDisposable
        {
            public void Dispose() => Runs.TryRemove(runId, out _);
        }

        private static bool TryEnter() => Interlocked.CompareExchange(ref _busy, 1, 0) == 0;
        private static void Leave() => Volatile.Write(ref _busy, 0);

        /// <summary>SSH kullanıcı / parola (tüm modüller için ortak ayar). Boşsa null.</summary>
        public static (string user, string pass)? Credentials()
        {
            var s = DataStore.Settings.Ssh;
            string user = s.User.Trim();
            string pass = DataStore.Unprotect(s.PassProtected);
            return string.IsNullOrWhiteSpace(user) || pass.Length == 0 ? null : (user, pass);
        }

        // ── Yardımcılar ──────────────────────────────────────────────────

        private static string EscapeForDoubleQuotes(string s) =>
            s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("$", "\\$").Replace("`", "\\`");

        /// <summary>Ekrana / günlüğe giden metinde SSH parolası varsa "****" yapar (kabuk için kaçışlanmış biçimler dahil).</summary>
        internal static Func<string?, string> MakeRedact(string pass) => s =>
        {
            if (string.IsNullOrEmpty(s) || string.IsNullOrEmpty(pass)) return s ?? "";
            return s.Replace(EscapeForDoubleQuotes(pass), "****")
                    .Replace(pass.Replace("'", "'\\''"), "****")
                    .Replace(pass, "****");
        };

        internal sealed class Reporter : IStatusReporter
        {
            private readonly NdjsonSink _sink;
            private readonly Func<string?, string> _redact;
            public Reporter(NdjsonSink sink, Func<string?, string> redact) { _sink = sink; _redact = redact; }

            public void Set(string ip, string message, StatusKind kind = StatusKind.Info, string? timestamp = null) =>
                _sink.Emit(new
                {
                    type = "log",
                    time = timestamp ?? DateTime.Now.ToString("HH:mm:ss"),
                    ip = ip ?? "",
                    message = _redact(message),
                    kind = kind.ToString().ToLowerInvariant(),
                });
        }

        private static async Task<bool> IsSshReachableAsync(string ip, int port, int timeoutMs, CancellationToken ct)
        {
            try
            {
                using var tcp = new TcpClient();
                var conn = tcp.ConnectAsync(ip, port);
                var delay = Task.Delay(timeoutMs, ct);
                if (await Task.WhenAny(conn, delay) == delay) return false;
                ct.ThrowIfCancellationRequested();
                return tcp.Connected;
            }
            catch (OperationCanceledException) { throw; }
            catch { return false; }
        }

        // ── Toplu güncelleme ─────────────────────────────────────────────

        /// <summary>false: başka bir toplu işlem sürüyor.</summary>
        public static bool TryBegin() => TryEnter();
        public static void End() => Leave();

        public static async Task RunUpdateAsync(string runId, UpdateRunRequest req, NdjsonSink sink)
        {
            var (user, pass) = Credentials()!.Value;
            var redact = MakeRedact(pass);
            var reporter = new Reporter(sink, redact);
            var logger = new FileReportLogger(reporter, WorkFolder) { Redact = s => redact(s) };
            // Adımların doğrudan ekrana yazdığı mesajlar (SSH bağlanamadı vb.) rapora da düşsün
            var coordinator = new UpdateCoordinator(WorkFolder, logger.Tee(reporter), logger);

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(sink.Broken);
            Runs[runId] = cts;
            var ct = cts.Token;
            int parallel = Math.Clamp(req.Parallel, 1, 100);
            int total = req.Targets.Count, done = 0, okCount = 0, failCount = 0;

            sink.Emit(new { type = "start", runId, total });
            reporter.Set("", $"Güncelleme başladı... ({total} cihaz, {parallel} paralel)");
            await logger.BeginRunAsync(total, parallel);

            void Progress() => sink.Emit(new { type = "progress", done = Interlocked.Increment(ref done), total });

            try
            {
                using var sem = new SemaphoreSlim(parallel);
                await Task.WhenAll(req.Targets.Select(async t =>
                {
                    try { await sem.WaitAsync(ct); }
                    catch (OperationCanceledException)
                    {
                        sink.Emit(new { type = "targetCancelled", id = t.Id });
                        Progress();
                        return;
                    }
                    try
                    {
                        if (ct.IsCancellationRequested) { sink.Emit(new { type = "targetCancelled", id = t.Id }); return; }
                        sink.Emit(new { type = "targetStart", id = t.Id });
                        bool ok = await coordinator.UpdateSingleIpAsync(t.Ip, user, pass, req.Options, t.YatakId, Blank(t.Wlan0), Blank(t.Eth0), ct);
                        sink.Emit(new { type = "targetResult", id = t.Id, ok });
                        bool? result = ok ? true : ct.IsCancellationRequested ? null : false;
                        if (result == true) Interlocked.Increment(ref okCount);
                        else if (result == false) Interlocked.Increment(ref failCount);
                        await logger.DeviceResultAsync(t.Ip, result);
                    }
                    catch (OperationCanceledException)
                    {
                        sink.Emit(new { type = "targetResult", id = t.Id, ok = false });
                        await logger.DeviceResultAsync(t.Ip, null);
                    }
                    catch (Exception ex)
                    {
                        sink.Emit(new { type = "targetResult", id = t.Id, ok = false });
                        Interlocked.Increment(ref failCount);
                        await logger.LogAsync(t.Ip, "Hata: " + ex.Message, StatusKind.Error);
                        await logger.DeviceResultAsync(t.Ip, false);
                    }
                    finally
                    {
                        sem.Release();
                        Progress();
                    }
                }));
            }
            catch (Exception ex)
            {
                reporter.Set("", "Beklenmeyen hata: " + ex.Message, StatusKind.Error);
            }
            finally
            {
                bool cancelled = ct.IsCancellationRequested;
                Runs.TryRemove(runId, out _);
                await logger.EndRunAsync(okCount, failCount, total - okCount - failCount, cancelled);
                reporter.Set("", cancelled ? "Güncelleme iptal edildi." : "Güncelleme tamamlandı.",
                    cancelled ? StatusKind.Warn : StatusKind.Success);
                sink.Emit(new { type = "done", cancelled });
            }
        }

        private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

        // ── Versiyon kontrol ─────────────────────────────────────────────

        public static async Task RunVersionAsync(string runId, VersionRequest req, NdjsonSink sink)
        {
            var (user, pass) = Credentials()!.Value;
            var redact = MakeRedact(pass);
            var reporter = new Reporter(sink, redact);
            var logger = new FileReportLogger(reporter, WorkFolder) { Redact = s => redact(s) };

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(sink.Broken);
            Runs[runId] = cts;
            var ct = cts.Token;
            int parallel = Math.Clamp(req.Parallel, 1, 100);
            int total = req.Targets.Count, done = 0;

            sink.Emit(new { type = "start", runId, total });
            reporter.Set("", $"Versiyon kontrolü başladı... ({total} cihaz, {parallel} paralel)");

            void Ver(int id, string text, string sev) => sink.Emit(new { type = "version", id, text, sev });

            try
            {
                using var sem = new SemaphoreSlim(parallel);
                await Task.WhenAll(req.Targets.Select(async t =>
                {
                    try { await sem.WaitAsync(ct); }
                    catch (OperationCanceledException) { return; }
                    try
                    {
                        if (ct.IsCancellationRequested) return;
                        string ip = t.Ip;
                        Ver(t.Id, "Kontrol...", "info");

                        if (!await IsSshReachableAsync(ip, 22, 3000, ct)) { Ver(t.Id, "SSH yok", "muted"); return; }

                        var updater = new SshUpdater(ip, user, pass, WorkFolder, logger.LogAsync);
                        try
                        {
                            using var client = await Task.Run(() => updater.Connect(5), ct);
                            if (!client.IsConnected) { Ver(t.Id, "SSH bağlanamadı", "muted"); return; }

                            var (ok, stdout, _) = await updater.ExecuteSudoGetOutputAsync(client,
                                "dotnet /var/www/consoleApps/publish/SerialWorkerServiceVol61.dll --version", ip, ct, 5);

                            string text = ok ? (stdout?.Trim() is { Length: > 0 } s ? s : "(boş)") : "Hata";
                            Ver(t.Id, text, ok ? "ok" : "error");
                            reporter.Set(ip, ok ? "Versiyon: " + text : "Versiyon okunamadı.", ok ? StatusKind.Success : StatusKind.Error);
                        }
                        finally { updater.CleanupTempFolder(); }
                    }
                    catch (OperationCanceledException) { Ver(t.Id, "İptal", "muted"); }
                    catch (Exception ex) { Ver(t.Id, "Hata: " + redact(ex.Message), "error"); }
                    finally
                    {
                        sem.Release();
                        sink.Emit(new { type = "progress", done = Interlocked.Increment(ref done), total });
                    }
                }));
                if (ct.IsCancellationRequested) reporter.Set("", "Versiyon kontrolü iptal edildi.", StatusKind.Warn);
            }
            finally
            {
                Runs.TryRemove(runId, out _);
                sink.Emit(new { type = "done", cancelled = ct.IsCancellationRequested });
            }
        }

        // ── TTY mesajı ───────────────────────────────────────────────────

        public static async Task<(bool ok, string message)> SendTtyAsync(string ip, string text)
        {
            var (user, pass) = Credentials()!.Value;
            try
            {
                var b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(text + "\n"));
                bool ok = await Task.Run(() =>
                {
                    using var ssh = new SshClient(ip, user, pass);
                    ssh.ConnectionInfo.Timeout = TimeSpan.FromSeconds(10);
                    ssh.Connect();
                    string pwdEsc = EscapeForDoubleQuotes(pass);
                    string cmd = $"echo \"{pwdEsc}\" | sudo -S bash -lc " +
                                 $"'echo \"{b64}\" | base64 -d | tee /dev/tty0 > /dev/null " +
                                 $"|| echo \"{b64}\" | base64 -d | tee /dev/tty1 > /dev/null'";
                    var res = ssh.RunCommand(cmd);
                    ssh.Disconnect();
                    return res.ExitStatus == 0;
                });
                return (ok, ok ? "TTY'ye yazıldı." : "Komut başarısız.");
            }
            // Zaman aşımı mesajı komut metnini (şifre dahil) içerir; kendi mesajımızı yaz
            catch (Renci.SshNet.Common.SshOperationTimeoutException) { return (false, "Hata: TTY komutu zaman aşımına uğradı."); }
            catch (Exception ex) { return (false, "Hata: " + MakeRedact(pass)(ex.Message)); }
        }

        // ── Tek cihaz: JsonSettings / dhcpcd ─────────────────────────────

        public static string? ValidateSingle(SingleRequest r)
        {
            static bool Ipv4(string? ip)
            {
                if (string.IsNullOrWhiteSpace(ip)) return false;
                var p = ip.Trim().Split('.');
                return p.Length == 4 && p.All(x => x.Length is > 0 and <= 3 && x.All(char.IsDigit) && int.Parse(x) <= 255);
            }

            if (!Ipv4(r.TargetIp)) return "Geçerli bir hedef cihaz IP adresi girin.";
            if (!r.DoYatak && !r.DoServer && !r.DoEth0 && !r.DoWlan0) return "En az bir alan seçin.";
            if (r.DoServer && !Ipv4(r.ServerIp)) return "Server IP geçersiz.";
            if (r.DoEth0 && !Ipv4(r.Eth0Ip)) return "eth0 IP adresi geçersiz.";
            if (r.DoWlan0 && !Ipv4(r.Wlan0Ip)) return "wlan0 IP adresi geçersiz.";
            if (r.DoEth0 && !DhcpcdHelper.TryParseMaskOrCidr((r.Eth0Mask ?? "").Trim(), out _, out string e1)) return $"eth0 ağ maskesi geçersiz: {e1}";
            if (r.DoWlan0 && !DhcpcdHelper.TryParseMaskOrCidr((r.Wlan0Mask ?? "").Trim(), out _, out string e2)) return $"wlan0 ağ maskesi geçersiz: {e2}";
            return null;
        }

        public static async Task RunSingleAsync(SingleRequest r, NdjsonSink sink)
        {
            var (user, pass) = Credentials()!.Value;
            var redact = MakeRedact(pass);
            string targetIp = r.TargetIp!.Trim();
            // SshUpdater'ın kendi mesajları da (bağlantı, sudo vb.) bu günlüğe düşsün
            var logger = new FileReportLogger(new Reporter(sink, redact), WorkFolder) { Redact = s => redact(s) };

            void Log(string message, StatusKind kind = StatusKind.Info) =>
                sink.Emit(new
                {
                    type = "log",
                    time = DateTime.Now.ToString("HH:mm:ss"),
                    ip = "",
                    message = redact(message),
                    kind = kind.ToString().ToLowerInvariant(),
                });

            bool success = false;
            try
            {
                Log($"SSH bağlantısı kuruluyor: {targetIp}");
                var updater = new SshUpdater(targetIp, user, pass, WorkFolder, logger.LogAsync);
                try
                {
                    using var client = await Task.Run(() => updater.Connect(8));
                    if (!client.IsConnected) { Log("SSH bağlantısı başarısız.", StatusKind.Error); return; }

                    if ((r.DoYatak || r.DoServer) && !await UpdateJsonSettingsAsync(client, updater, targetIp, r, Log)) return;
                    if ((r.DoEth0 || r.DoWlan0) && !await UpdateDhcpcdAsync(client, updater, targetIp, r, Log)) return;

                    Log("İşlem tamamlandı.", StatusKind.Success);
                    success = true;
                }
                finally { updater.CleanupTempFolder(); }
            }
            catch (Exception ex) { Log("Hata: " + ex.Message, StatusKind.Error); }
            finally { sink.Emit(new { type = "done", ok = success }); }
        }

        private static async Task<bool> UpdateJsonSettingsAsync(SshClient client, SshUpdater updater, string ip, SingleRequest r,
                                                                 Action<string, StatusKind> log)
        {
            const string remotePath = "/var/www/consoleApps/publish/JsonSettings.json";
            var (okRead, stdout, stderr) = await updater.ExecuteSudoGetOutputAsync(client, $"cat {remotePath}", ip, CancellationToken.None, 10);
            if (!okRead)
            {
                log("JsonSettings.json okunamadı: " + (string.IsNullOrWhiteSpace(stderr) ? "Bilinmeyen hata" : stderr.Trim()), StatusKind.Error);
                return false;
            }

            string json = stdout ?? string.Empty;
            if (string.IsNullOrWhiteSpace(json)) { log("JsonSettings.json boş geldi.", StatusKind.Error); return false; }

            if (r.DoYatak)
            {
                string yatakId = r.YatakId.ToString();
                if (Regex.IsMatch(json, "\"YatakId\"\\s*:\\s*\\d+", RegexOptions.IgnoreCase))
                    json = Regex.Replace(json, "(\"YatakId\"\\s*:\\s*)\\d+", m => m.Groups[1].Value + yatakId, RegexOptions.IgnoreCase);
                else { log("JsonSettings.json içinde YatakId alanı bulunamadı.", StatusKind.Error); return false; }
                log("YatakId güncellenecek: " + yatakId, StatusKind.Info);
            }

            if (r.DoServer)
            {
                string serverIp = (r.ServerIp ?? "").Trim();
                if (Regex.IsMatch(json, "\"ServerIp\"\\s*:\\s*\"[^\"]*\"", RegexOptions.IgnoreCase))
                    json = Regex.Replace(json, "(\"ServerIp\"\\s*:\\s*\")([^\"]*)(\")", m => m.Groups[1].Value + serverIp + m.Groups[3].Value, RegexOptions.IgnoreCase);
                else { log("JsonSettings.json içinde ServerIp alanı bulunamadı.", StatusKind.Error); return false; }
                log("ServerIp güncellenecek: " + serverIp, StatusKind.Info);
            }

            const string destCmd = "[ -f /var/www/consoleApps/publish/JsonSettings.json ] && cp -a /var/www/consoleApps/publish/JsonSettings.json /var/www/consoleApps/publish/JsonSettings.json.bak.$(date +%s) || true && install -m 0644 -o root -g root /tmp/JsonSettings.json /var/www/consoleApps/publish/JsonSettings.json";
            bool okWrite = await updater.CopyTextContentWithSudoAsync(client, json, $"JsonSettings_{ip}.json", "/tmp/JsonSettings.json", destCmd, ip, CancellationToken.None);
            log(okWrite ? "JsonSettings.json güncellendi." : "JsonSettings.json güncellenemedi.", okWrite ? StatusKind.Success : StatusKind.Error);
            return okWrite;
        }

        private static async Task<bool> UpdateDhcpcdAsync(SshClient client, SshUpdater updater, string ip, SingleRequest r,
                                                           Action<string, StatusKind> log)
        {
            const string remotePath = "/etc/dhcpcd.conf";
            var (okRead, stdout, stderr) = await updater.ExecuteSudoGetOutputAsync(client, $"cat {remotePath}", ip, CancellationToken.None, 10);
            if (!okRead)
            {
                log("dhcpcd.conf okunamadı: " + (string.IsNullOrWhiteSpace(stderr) ? "Bilinmeyen hata" : stderr.Trim()), StatusKind.Error);
                return false;
            }

            string conf = stdout ?? string.Empty;

            if (r.DoEth0)
            {
                conf = DhcpcdHelper.UpsertDhcpcdInterface(conf, "eth0", (r.Eth0Ip ?? "").Trim(), (r.Eth0Mask ?? "").Trim());
                log($"eth0 -> {(r.Eth0Ip ?? "").Trim()}  mask={(r.Eth0Mask ?? "").Trim()}", StatusKind.Info);
            }

            if (r.DoWlan0)
            {
                conf = DhcpcdHelper.UpsertDhcpcdInterface(conf, "wlan0", (r.Wlan0Ip ?? "").Trim(), (r.Wlan0Mask ?? "").Trim());
                log($"wlan0 -> {(r.Wlan0Ip ?? "").Trim()}  mask={(r.Wlan0Mask ?? "").Trim()}", StatusKind.Info);
            }

            const string destCmd = "[ -f /etc/dhcpcd.conf ] && cp -a /etc/dhcpcd.conf /etc/dhcpcd.conf.bak.$(date +%s) || true && install -m 0644 -o root -g root /tmp/dhcpcd.conf /etc/dhcpcd.conf";
            bool okWrite = await updater.CopyTextContentWithSudoAsync(client, conf, $"dhcpcd_{ip}.conf", "/tmp/dhcpcd.conf", destCmd, ip, CancellationToken.None);
            if (!okWrite) { log("dhcpcd.conf yazılamadı.", StatusKind.Error); return false; }

            var (okRestart, msgRestart) = await updater.ExecuteSudoChainAsync(client, new[]
            {
                "systemctl restart dhcpcd || service dhcpcd restart || true"
            }, ip, CancellationToken.None);

            log(okRestart ? "dhcpcd.conf güncellendi." : $"dhcpcd restart uyarısı: {msgRestart}", okRestart ? StatusKind.Success : StatusKind.Warn);
            return true;
        }

        // ── Dosyalar: bilgi ve "sunucuda aç" ─────────────────────────────

        public static object Info()
        {
            Directory.CreateDirectory(WorkFolder);
            var files = new DirectoryInfo(WorkFolder).EnumerateFiles()
                .OrderBy(f => f.Name, StringComparer.OrdinalIgnoreCase)
                .Select(f => new { name = f.Name, size = f.Length, modified = f.LastWriteTime.ToString("dd.MM.yyyy HH:mm") }).ToList();
            return new
            {
                workFolder = WorkFolder,
                source = WorkSource,
                wpfFolder = WpfFolder,
                wpfExists = Directory.Exists(WpfFolder),
                defaultFolder = DefaultFolder,
                editable = EditableFiles,
                files,
            };
        }

        /// <summary>Dosyayı / klasörü SUNUCUDA açar (AnyDesk'te ekranda görünür). Yalnızca izinli adlar.</summary>
        public static (bool ok, string message) OpenOnServer(string kind, string? name)
        {
            try
            {
                Directory.CreateDirectory(WorkFolder);
                switch (kind)
                {
                    case "folder":
                        Process.Start(new ProcessStartInfo(WorkFolder) { UseShellExecute = true });
                        return (true, "");
                    case "report":
                    {
                        string p = Path.Combine(WorkFolder, "Güncelleme Raporu.txt");
                        if (!File.Exists(p)) return (false, "Rapor dosyası bulunamadı.");
                        OpenInEditor(p);
                        return (true, "");
                    }
                    case "file":
                    {
                        if (name == null || !EditableFiles.Contains(name, StringComparer.OrdinalIgnoreCase)) return (false, "İzin verilmeyen dosya.");
                        string p = Path.Combine(WorkFolder, name);
                        if (!File.Exists(p)) return (false, $"{name} updateFiles klasöründe yok.");
                        OpenInEditor(p);
                        return (true, "");
                    }
                }
                return (false, "Bilinmeyen istek.");
            }
            catch (Exception ex) { return (false, "Açılamadı: " + ex.Message); }
        }

        /// <summary>Notepad++ → Windows'un .txt varsayılanı → Not Defteri (WPF ile aynı <see cref="TextEditorLauncher"/>).</summary>
        private static void OpenInEditor(string path) => TextEditorLauncher.Open(path);
    }
}
