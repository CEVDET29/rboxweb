using System.IO.Compression;
using System.Text;
using RboxAgent.Modules.Update;

namespace RboxAgent.Modules.Files
{
    public sealed class WriteRequest
    {
        public string? Path { get; set; }
        public string? Text { get; set; }
        /// <summary>lf | crlf (dosyanın özgün satır sonu korunur).</summary>
        public string? Eol { get; set; }
        public bool Bom { get; set; }
    }

    public sealed class FetchRequest
    {
        /// <summary>Sayfanın deposu (kullanici/depo); boşsa ajanın --repo değeri.</summary>
        public string? Repo { get; set; }
        /// <summary>true: var olan dosyaların da üzerine yaz; false: yalnızca eksikleri ekle.</summary>
        public bool Overwrite { get; set; }
    }

    public sealed class RenameRequest
    {
        public string? From { get; set; }
        public string? To { get; set; }
    }

    /// <summary>
    /// updateFiles klasörünün yönetimi (listele, düzenle, yükle, indir, sil, zip, GitHub'dan indir).
    /// Her yol klasörün İÇİNDE kalmak zorundadır. Ortak paket GitHub'daki "updatefiles" sürümünden gelir;
    /// klasör hiçbir yere gönderilmez (yalnızca kullanıcının tarayıcısıyla konuşur).
    /// </summary>
    internal static class FilesService
    {
        private const long MaxTextBytes = 2 * 1024 * 1024;
        private const string ReportName = "Güncelleme Raporu.txt";

        /// <summary>Metin dosyasında boş içerikle üzerine yazılmaması gereken adlar: adımlar cihaza boş dosya göndermesin.</summary>
        private static readonly string[] NoEmpty = UpdateService.EditableFiles;

        private static string Root
        {
            get
            {
                string r = Path.GetFullPath(UpdateService.WorkFolder);
                Directory.CreateDirectory(r);
                return r;
            }
        }

        /// <summary>İstemcinin verdiği göreli yolu klasörün içinde tam yola çevirir; dışarı çıkan yol hata verir.</summary>
        public static string Resolve(string? rel)
        {
            if (string.IsNullOrWhiteSpace(rel)) throw new InvalidOperationException("Dosya yolu boş.");
            rel = rel.Replace('/', '\\').Trim().TrimStart('\\');
            if (rel.Contains(':') || rel.Contains("..")) throw new InvalidOperationException("Geçersiz dosya yolu.");
            string root = Root;
            string full = Path.GetFullPath(Path.Combine(root, rel));
            if (!full.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Geçersiz dosya yolu.");
            return full;
        }

        private static string Rel(string full) =>
            Path.GetRelativePath(Root, full).Replace('\\', '/');

        /// <summary>İlk 8 KB'ta NUL baytı yoksa metin sayılır (tar.gz, dll, deb ikili).</summary>
        private static bool LooksText(string full, long size)
        {
            if (size > MaxTextBytes) return false;
            try
            {
                using var fs = File.OpenRead(full);
                var buf = new byte[(int)Math.Min(8192, size)];
                int n = fs.Read(buf, 0, buf.Length);
                for (int i = 0; i < n; i++) if (buf[i] == 0) return false;
                return true;
            }
            catch { return false; }
        }

        public static object List()
        {
            string root = Root;
            var files = new DirectoryInfo(root).EnumerateFiles("*", SearchOption.AllDirectories)
                .OrderBy(f => Rel(f.FullName), StringComparer.OrdinalIgnoreCase)
                .Select(f => new
                {
                    path = Rel(f.FullName),
                    size = f.Length,
                    modified = f.LastWriteTime.ToString("dd.MM.yyyy HH:mm"),
                    text = LooksText(f.FullName, f.Length),
                    report = f.Name.Equals(ReportName, StringComparison.OrdinalIgnoreCase),
                }).ToList();
            return new
            {
                folder = root,
                source = UpdateService.WorkSource,
                wpfFolder = UpdateService.WpfFolder,
                wpfExists = Directory.Exists(UpdateService.WpfFolder),
                defaultFolder = UpdateService.DefaultFolder,
                editable = NoEmpty,
                files,
            };
        }

        // ── Okuma / yazma ────────────────────────────────────────────────

        public static (bool ok, string? error, object? data) Read(string? rel)
        {
            string full;
            try { full = Resolve(rel); } catch (Exception ex) { return (false, ex.Message, null); }
            if (!File.Exists(full)) return (false, "Dosya bulunamadı.", null);
            var info = new FileInfo(full);
            if (info.Length > MaxTextBytes) return (false, "Dosya 2 MB'tan büyük; tarayıcıda düzenlenemez. İndirip düzenleyin.", null);

            byte[] bytes = File.ReadAllBytes(full);
            if (Array.IndexOf(bytes, (byte)0) >= 0) return (false, "İkili dosya; tarayıcıda düzenlenemez.", null);

            bool bom = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF;
            string text;
            try
            {
                text = new UTF8Encoding(false, throwOnInvalidBytes: true).GetString(bytes, bom ? 3 : 0, bytes.Length - (bom ? 3 : 0));
            }
            catch (DecoderFallbackException)
            {
                // ANSI (ör. eski Not Defteri) olabilir: bozmadan kaydedemeyiz, düzenlemeyi reddet
                return (false, "Dosya UTF-8 değil; kaydederken Türkçe karakterler bozulabilir. İndirip bir metin düzenleyicide düzenleyin.", null);
            }

            string eol = text.Contains("\r\n") ? "crlf" : "lf";
            return (true, null, new { path = Rel(full), text = text.Replace("\r\n", "\n"), eol, bom, size = info.Length });
        }

        public static (bool ok, string? error) Write(WriteRequest r)
        {
            string full;
            try { full = Resolve(r.Path); } catch (Exception ex) { return (false, ex.Message); }
            string text = r.Text ?? "";

            string name = Path.GetFileName(full);
            if (NoEmpty.Contains(name, StringComparer.OrdinalIgnoreCase) && string.IsNullOrWhiteSpace(text))
                return (false, $"{name} boş kaydedilemez: güncelleme cihaza boş dosya göndermesin.");

            text = text.Replace("\r\n", "\n");
            if (string.Equals(r.Eol, "crlf", StringComparison.OrdinalIgnoreCase)) text = text.Replace("\n", "\r\n");
            var bytes = new List<byte>();
            if (r.Bom) bytes.AddRange(new byte[] { 0xEF, 0xBB, 0xBF });
            bytes.AddRange(new UTF8Encoding(false).GetBytes(text));

            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            string tmp = full + ".rboxtmp";
            File.WriteAllBytes(tmp, bytes.ToArray());
            File.Move(tmp, full, overwrite: true);
            return (true, null);
        }

        // ── Yükleme / silme / yeniden adlandırma ─────────────────────────

        public static async Task<(bool ok, int status, string? error)> UploadAsync(string? rel, Stream body, bool overwrite)
        {
            string full;
            try { full = Resolve(rel); } catch (Exception ex) { return (false, 400, ex.Message); }
            if (File.Exists(full) && !overwrite) return (false, 409, "Bu adla bir dosya zaten var.");

            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            string tmp = full + ".rboxtmp";
            try
            {
                await using (var fs = File.Create(tmp)) await body.CopyToAsync(fs);
                File.Move(tmp, full, overwrite: true);
                return (true, 200, null);
            }
            catch (Exception ex)
            {
                try { File.Delete(tmp); } catch { }
                return (false, 500, "Yüklenemedi: " + ex.Message);
            }
        }

        public static (bool ok, string? error) Delete(string? rel)
        {
            string full;
            try { full = Resolve(rel); } catch (Exception ex) { return (false, ex.Message); }
            if (!File.Exists(full)) return (false, "Dosya bulunamadı.");
            File.Delete(full);
            // Boşalan alt klasörleri temizle (kök klasöre dokunma)
            string root = Root.TrimEnd('\\');
            for (string? d = Path.GetDirectoryName(full); d != null && d.Length > root.Length; d = Path.GetDirectoryName(d))
            {
                if (Directory.EnumerateFileSystemEntries(d).Any()) break;
                try { Directory.Delete(d); } catch { break; }
            }
            return (true, null);
        }

        public static (bool ok, string? error) Rename(RenameRequest r)
        {
            string from, to;
            try { from = Resolve(r.From); to = Resolve(r.To); } catch (Exception ex) { return (false, ex.Message); }
            if (!File.Exists(from)) return (false, "Dosya bulunamadı.");
            if (File.Exists(to)) return (false, "Bu adla bir dosya zaten var.");
            Directory.CreateDirectory(Path.GetDirectoryName(to)!);
            File.Move(from, to);
            return (true, null);
        }

        // ── İndirme / zip ────────────────────────────────────────────────

        public static string? ResolveExisting(string? rel)
        {
            try { string f = Resolve(rel); return File.Exists(f) ? f : null; } catch { return null; }
        }

        /// <summary>Tüm klasörü zip olarak akıtır. Hastaneye özel rapor dosyası (günlük) pakete girmez.</summary>
        public static async Task WriteZipAsync(Stream output)
        {
            string root = Root;
            using var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true);
            foreach (var f in new DirectoryInfo(root).EnumerateFiles("*", SearchOption.AllDirectories))
            {
                if (f.Name.Equals(ReportName, StringComparison.OrdinalIgnoreCase)) continue;
                var entry = zip.CreateEntry(Rel(f.FullName), CompressionLevel.Fastest);
                await using var es = entry.Open();
                await using var fs = new FileStream(f.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                await fs.CopyToAsync(es);
            }
        }

        /// <summary>Zip'i klasöre açar (var olan dosyaların üzerine yazar). Klasör dışına çıkan girdiler (zip-slip) reddedilir.</summary>
        public static async Task<(bool ok, string? error, int count)> ImportZipAsync(Stream body)
        {
            string tmp = Path.Combine(Path.GetTempPath(), $"rboxfiles_{Guid.NewGuid():N}.zip");
            try
            {
                await using (var fs = File.Create(tmp)) await body.CopyToAsync(fs);
                var r = ExtractZip(tmp, overwrite: true);
                return (r.ok, r.error, r.added);
            }
            finally { try { File.Delete(tmp); } catch { } }
        }

        /// <summary>
        /// Zip'i klasöre açar. overwrite=false ise var olan dosyalar atlanır (hastaneye göre düzenlenmiş JsonSettings vb. korunur).
        /// Tüm girdiler tek bir "updateFiles/" klasöründeyse o önek atılır. Önce hepsi doğrulanır: biri geçersizse hiçbir şey yazılmaz.
        /// </summary>
        private static (bool ok, string? error, int added, int skipped) ExtractZip(string zipPath, bool overwrite)
        {
            try
            {
                using var zip = ZipFile.OpenRead(zipPath);
                var entries = zip.Entries
                    .Where(e => !(e.FullName.EndsWith('/') || e.FullName.EndsWith('\\') || e.Name.Length == 0))
                    .ToList();
                if (entries.Count == 0) return (false, "Zip içinde dosya yok.", 0, 0);

                const string prefix = "updateFiles/";
                bool strip = entries.All(e => e.FullName.Replace('\\', '/').StartsWith(prefix, StringComparison.OrdinalIgnoreCase));

                var plan = new List<(ZipArchiveEntry entry, string dest)>();
                foreach (var e in entries)
                {
                    string name = e.FullName.Replace('\\', '/');
                    if (strip) name = name[prefix.Length..];
                    plan.Add((e, Resolve(name)));
                }

                int added = 0, skipped = 0;
                foreach (var (entry, dest) in plan)
                {
                    if (!overwrite && File.Exists(dest)) { skipped++; continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                    entry.ExtractToFile(dest, overwrite: true);
                    added++;
                }
                return (true, null, added, skipped);
            }
            catch (InvalidDataException) { return (false, "Geçerli bir zip dosyası değil.", 0, 0); }
            catch (InvalidOperationException ex) { return (false, "Zip reddedildi: " + ex.Message, 0, 0); }
            catch (Exception ex) { return (false, "İçe aktarılamadı: " + ex.Message, 0, 0); }
        }

        // ── GitHub'dan indirme ───────────────────────────────────────────

        /// <summary>Ajanın başlatıldığı depo (--repo); sayfa kendi deposunu da gönderebilir.</summary>
        public static string? Repo { get; set; }

        public const string ReleaseTag = "updatefiles";
        public const string PackageName = "updateFiles.zip";

        public static bool IsRepo(string? s) =>
            s != null && System.Text.RegularExpressions.Regex.IsMatch(s, @"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$");

        /// <summary>Klasör yok ya da içinde hiç dosya yok.</summary>
        public static bool IsEmpty()
        {
            try
            {
                string r = Path.GetFullPath(UpdateService.WorkFolder);
                return !Directory.Exists(r) || !Directory.EnumerateFiles(r, "*", SearchOption.AllDirectories).Any();
            }
            catch { return false; }
        }

        private static readonly SemaphoreSlim FetchLock = new(1, 1);

        /// <summary>
        /// github.com/&lt;depo&gt;/releases/download/updatefiles/updateFiles.zip paketini indirip klasöre açar.
        /// Adres sabittir; yalnızca depo adı değişir (doğrulanmış biçimde).
        /// </summary>
        public static async Task<(bool ok, string? error, int added, int skipped)> FetchFromGitHubAsync(string? repo, bool overwrite)
        {
            repo = IsRepo(repo) ? repo : Repo;
            if (repo == null) return (false, "GitHub deposu bilinmiyor (ajanı sayfadaki komutla başlatın).", 0, 0);
            if (!await FetchLock.WaitAsync(0)) return (false, "İndirme zaten sürüyor.", 0, 0);

            string url = $"https://github.com/{repo}/releases/download/{ReleaseTag}/{PackageName}";
            // Yalnızca test için (start-agent.ps1 -ZipUrl gibi): paketi başka bir adresten al
            if (Environment.GetEnvironmentVariable("RBOX_UPDATEFILES_URL") is { Length: > 0 } testUrl) url = testUrl;
            string tmp = Path.Combine(Path.GetTempPath(), $"rboxfiles_{Guid.NewGuid():N}.zip");
            try
            {
                using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(3) };
                http.DefaultRequestHeaders.UserAgent.ParseAdd("RboxAgent");
                using var res = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
                if (res.StatusCode == System.Net.HttpStatusCode.NotFound)
                    return (false, $"GitHub'da paket yok: {repo} deposunda \"{ReleaseTag}\" sürümüne {PackageName} yüklenmemiş.", 0, 0);
                if (!res.IsSuccessStatusCode) return (false, $"GitHub yanıtı: {(int)res.StatusCode} {res.ReasonPhrase}", 0, 0);

                await using (var fs = File.Create(tmp)) await res.Content.CopyToAsync(fs);
                return ExtractZip(tmp, overwrite);
            }
            catch (TaskCanceledException) { return (false, "GitHub'a bağlanırken zaman aşımı.", 0, 0); }
            catch (HttpRequestException ex) { return (false, "GitHub'a ulaşılamadı: " + ex.Message, 0, 0); }
            finally
            {
                try { File.Delete(tmp); } catch { }
                FetchLock.Release();
            }
        }
    }
}
