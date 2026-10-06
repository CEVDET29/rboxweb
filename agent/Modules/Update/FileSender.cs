using System.Net.Sockets;
using System.Text;
using RboxAgent.Modules.Update.Core;
using RboxAgent.Modules.Update.Services;
using Renci.SshNet;
using Renci.SshNet.Common;

namespace RboxAgent.Modules.Update
{
    // NOT: Bu dosya WPF (RboxTools) ile web ajanında (RboxWeb/agent) aynıdır; yalnızca namespace farklıdır.

    /// <summary>Gönderilecek bir dosya: bilgisayardaki yolu ve hedef klasöre göre yolu ("alt/klasor/dosya.sh").</summary>
    public sealed record SendItem(string LocalPath, string RelativePath);

    public sealed class SendOptions
    {
        /// <summary>Cihazdaki hedef klasör (mutlak yol, ör. /home/pi). Yoksa oluşturulur.</summary>
        public string RemoteDir { get; set; } = "/home/pi";
        /// <summary>.sh dosyalarına chmod +x.</summary>
        public bool ChmodSh { get; set; } = true;
        /// <summary>Metin dosyalarında CRLF → LF ve UTF-8 BOM temizliği (Windows'ta yazılmış script Linux'ta çalışsın).</summary>
        public bool FixLineEndings { get; set; } = true;
    }

    /// <summary>
    /// "Dosya gönder": bilgisayardan seçilen dosya / klasörleri cihazda bir klasöre kopyalar.
    /// Dosyalar önce SFTP ile /tmp altındaki geçici klasöre yüklenir, sonra sudo ile hedefe kopyalanır
    /// (sistem klasörleri de yazılabilsin). Aynı adlı dosyaların üzerine yazılır.
    /// </summary>
    internal static class FileSender
    {
        /// <summary>Sık kullanılan hedef klasörler (arayüzdeki hazır liste).</summary>
        public static readonly string[] PresetDirs =
        {
            "/home/pi",
            "/home/pi/Desktop",
            "/var/www/consoleApps/publish",
            "/usr/local/bin",
            "/etc/systemd/system",
            "/tmp",
        };

        private static readonly HashSet<string> TextExtensions = new(StringComparer.OrdinalIgnoreCase)
        {
            ".sh", ".bash", ".service", ".timer", ".socket", ".mount", ".conf", ".cfg", ".ini", ".rules",
            ".py", ".env", ".desktop", ".txt", ".json", ".yml", ".yaml", ".local",
        };

        /// <summary>Seçilen dosya ve klasörleri tek tek dosyalara açar. Klasör, adıyla birlikte (alt klasörleriyle) gider.</summary>
        public static List<SendItem> Expand(IEnumerable<string> paths)
        {
            var list = new List<SendItem>();
            foreach (var p in paths)
            {
                if (File.Exists(p)) list.Add(new SendItem(p, Path.GetFileName(p)));
                else if (Directory.Exists(p))
                {
                    string root = Path.GetDirectoryName(Path.GetFullPath(p).TrimEnd('\\', '/')) ?? p;
                    foreach (var f in Directory.EnumerateFiles(p, "*", SearchOption.AllDirectories))
                        list.Add(new SendItem(f, Path.GetRelativePath(root, f).Replace('\\', '/')));
                }
            }
            // Aynı hedef yola iki dosya düşerse sonuncusu kalır
            return list.GroupBy(i => i.RelativePath, StringComparer.Ordinal).Select(g => g.Last()).ToList();
        }

        /// <summary>Hedef klasör geçerli mi? Hata metni ya da null.</summary>
        public static string? ValidateRemoteDir(string? dir)
        {
            dir = NormalizeRemoteDir(dir);
            if (dir.Length == 0) return "Cihazdaki hedef klasörü yazın (ör. /home/pi).";
            if (!dir.StartsWith('/')) return "Hedef klasör / ile başlamalı (ör. /home/pi).";
            if (dir == "/") return "Kök klasöre (/) kopyalanamaz; bir alt klasör yazın.";
            if (dir.Split('/').Any(s => s == "..")) return "Hedef klasörde \"..\" kullanılamaz.";
            if (dir.Any(char.IsControl)) return "Hedef klasörde geçersiz karakter var.";
            return null;
        }

        public static string NormalizeRemoteDir(string? dir)
        {
            string d = (dir ?? "").Trim().Replace('\\', '/');
            while (d.Contains("//")) d = d.Replace("//", "/");
            return d.Length > 1 ? d.TrimEnd('/') : d;
        }

        /// <summary>Gönderim öncesi kontrol: hata metni ya da null.</summary>
        public static string? Validate(IReadOnlyCollection<SendItem> items, SendOptions opt)
        {
            if (items.Count == 0) return "Gönderilecek dosya seçin.";
            if (items.Any(i => i.RelativePath.Split('/').Any(s => s is "" or "." or "..") || i.RelativePath.Any(char.IsControl)))
                return "Dosya adlarından biri geçersiz.";
            return ValidateRemoteDir(opt.RemoteDir);
        }

        public static string Describe(IReadOnlyCollection<SendItem> items)
        {
            long bytes = items.Sum(i => { try { return new FileInfo(i.LocalPath).Length; } catch { return 0L; } });
            return $"{items.Count} dosya, {FormatSize(bytes)}";
        }

        public static string FormatSize(long b) =>
            b >= 1 << 20 ? $"{b / 1048576.0:0.0} MB" : b >= 1024 ? $"{b / 1024.0:0} KB" : $"{b} B";

        /// <summary>Tek cihaza gönderir. Sonuç rapora ve ekrana <paramref name="log"/> üzerinden yazılır.</summary>
        public static async Task<bool> SendAsync(string ip, string user, string pass, IReadOnlyList<SendItem> items,
                                                 SendOptions opt, IAppLogger log, string workFolder, CancellationToken ct)
        {
            string dest = NormalizeRemoteDir(opt.RemoteDir);
            var updater = new SshUpdater(ip, user, pass, workFolder, log.LogAsync);
            string tmp = $"/tmp/rbox-send-{Guid.NewGuid():N}";
            SshClient? client = null;
            try
            {
                await log.LogAsync(ip, "Bağlanılıyor...");
                try { client = await Task.Run(() => updater.Connect(8), ct); }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex)
                {
                    string msg = ex is SshAuthenticationException ? "SSH kimlik doğrulama hatası." :
                                 ex is SocketException se ? $"Ağ hatası ({se.SocketErrorCode})." :
                                 ex is SshOperationTimeoutException ? "SSH zaman aşımı." :
                                 $"SSH bağlantı hatası: {ex.Message}";
                    await log.LogAsync(ip, msg, StatusKind.Error);
                    return false;
                }

                // 1) Geçici klasöre yükle (pi kullanıcısı olarak)
                await log.LogAsync(ip, $"{Describe(items)} yükleniyor → {dest}");
                var shFiles = new List<string>();
                await Task.Run(() =>
                {
                    using var sftp = new SftpClient(client.ConnectionInfo);
                    sftp.Connect();
                    try
                    {
                        var made = new HashSet<string>(StringComparer.Ordinal);
                        void MkDirs(string remoteDir)
                        {
                            string cur = "";
                            foreach (var part in remoteDir.Split('/', StringSplitOptions.RemoveEmptyEntries))
                            {
                                cur += "/" + part;
                                if (made.Add(cur) && !sftp.Exists(cur)) sftp.CreateDirectory(cur);
                            }
                        }

                        foreach (var item in items)
                        {
                            ct.ThrowIfCancellationRequested();
                            string remote = $"{tmp}/{item.RelativePath}";
                            MkDirs(remote[..remote.LastIndexOf('/')]);
                            using var data = OpenForUpload(item.LocalPath, opt.FixLineEndings);
                            sftp.UploadFile(data, remote, true);
                            if (opt.ChmodSh && item.RelativePath.EndsWith(".sh", StringComparison.OrdinalIgnoreCase))
                                shFiles.Add(item.RelativePath);
                        }
                    }
                    finally { sftp.Disconnect(); }
                }, ct);

                // 2) sudo ile hedefe kopyala (üzerine yazar), .sh dosyalarını çalıştırılabilir yap
                var cmds = new List<string>
                {
                    $"mkdir -p {Q(dest)}",
                    $"cp -rf {Q(tmp)}/. {Q(dest)}/",
                };
                cmds.AddRange(shFiles.Select(rel => $"chmod +x {Q(dest + "/" + rel)}"));
                var (ok, message) = await updater.ExecuteSudoChainAsync(client, cmds, ip, ct);
                if (!ok)
                {
                    await log.LogAsync(ip, $"Hedef klasöre kopyalanamadı: {message}", StatusKind.Error);
                    return false;
                }

                string extra = shFiles.Count > 0 ? $" ({shFiles.Count} .sh çalıştırılabilir yapıldı)" : "";
                await log.LogAsync(ip, $"{items.Count} dosya {dest} klasörüne kopyalandı.{extra}", StatusKind.Success);
                return true;
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                await log.LogAsync(ip, $"Dosya gönderilemedi: {ex.Message}", StatusKind.Error);
                return false;
            }
            finally
            {
                if (client != null)
                {
                    // Geçici klasörü temizle (iptal edilse de)
                    try { await updater.ExecuteSudoChainAsync(client, new[] { $"rm -rf {Q(tmp)}" }, ip, CancellationToken.None); } catch { }
                    try { client.Dispose(); } catch { }
                }
                updater.CleanupTempFolder();
            }
        }

        /// <summary>Metin dosyasıysa (uzantı ya da "#!" ile başlıyorsa) CRLF → LF ve BOM temizlenmiş içerik; değilse dosyanın kendisi.</summary>
        private static Stream OpenForUpload(string path, bool fixLineEndings)
        {
            if (!fixLineEndings) return File.OpenRead(path);
            var info = new FileInfo(path);
            bool text = TextExtensions.Contains(info.Extension);
            if (!text && info.Extension.Length == 0 && info.Length is > 2 and < 4 << 20)
            {
                using var fs = File.OpenRead(path);
                text = fs.ReadByte() == '#' && fs.ReadByte() == '!';
            }
            if (!text || info.Length > 16 << 20) return File.OpenRead(path);

            byte[] b = File.ReadAllBytes(path);
            int start = b.Length >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF ? 3 : 0;
            var outp = new MemoryStream(b.Length);
            for (int i = start; i < b.Length; i++)
            {
                if (b[i] == '\r' && i + 1 < b.Length && b[i + 1] == '\n') continue;
                outp.WriteByte(b[i]);
            }
            outp.Position = 0;
            return outp;
        }

        /// <summary>Kabukta tek tırnaklı argüman ('...').</summary>
        private static string Q(string s) => "'" + s.Replace("'", "'\\''") + "'";
    }
}
