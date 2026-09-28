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

    public sealed class RenameRequest
    {
        public string? From { get; set; }
        public string? To { get; set; }
    }

    /// <summary>
    /// updateFiles klasörünün yönetimi (listele, düzenle, yükle, indir, sil, zip). Her yol klasörün İÇİNDE kalmak zorundadır.
    /// Hastaneye özel içerik olduğu için bu klasör hiçbir yere gönderilmez; yalnızca kullanıcının tarayıcısıyla konuşur.
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
                using var zip = ZipFile.OpenRead(tmp);

                // Önce hepsini doğrula: bir girdi bile geçersizse hiçbir şey yazılmaz
                var plan = new List<(ZipArchiveEntry entry, string dest)>();
                foreach (var e in zip.Entries)
                {
                    if (e.FullName.EndsWith('/') || e.FullName.EndsWith('\\') || e.Name.Length == 0) continue;
                    plan.Add((e, Resolve(e.FullName)));
                }
                if (plan.Count == 0) return (false, "Zip içinde dosya yok.", 0);

                foreach (var (entry, dest) in plan)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                    entry.ExtractToFile(dest, overwrite: true);
                }
                return (true, null, plan.Count);
            }
            catch (InvalidDataException) { return (false, "Geçerli bir zip dosyası değil.", 0); }
            catch (InvalidOperationException ex) { return (false, "Zip reddedildi: " + ex.Message, 0); }
            catch (Exception ex) { return (false, "İçe aktarılamadı: " + ex.Message, 0); }
            finally { try { File.Delete(tmp); } catch { } }
        }
    }
}
