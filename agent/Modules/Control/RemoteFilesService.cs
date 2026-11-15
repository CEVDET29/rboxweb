using System.Collections.Concurrent;
using System.IO.Compression;
using RboxAgent.Modules.Files;
using RboxAgent.Modules.Update;

namespace RboxAgent.Modules.Control
{
    public sealed class RfRequest
    {
        public string Ip { get; set; } = "";
        public string? Path { get; set; }
        public string? To { get; set; }
        public List<string>? Paths { get; set; }
        public List<string>? Names { get; set; }
    }

    public sealed class RfItem
    {
        public string Path { get; set; } = "";
        public bool Dir { get; set; }
    }

    /// <summary>
    /// TTY panelinin dosya paneli (WPF RemoteFilesPanel karşılığı). İşlemler WPF ile aynı <see cref="RemoteFiles"/>
    /// sınıfındadır (SFTP; yetki yetmezse sudo). Cihaz başına tek bağlantı açık tutulur; 2 dk kullanılmazsa kapanır.
    /// Tarayıcıdan gelen dosyalar önce ajanın geçici klasörüne yazılıp oradan yüklenir; indirilenler geçici klasöre
    /// indirilip tek dosyaysa olduğu gibi, birden çoksa / klasörse zip olarak tarayıcıya gönderilir.
    /// </summary>
    public static class RemoteFilesService
    {
        private sealed class Session(RemoteFiles files)
        {
            public RemoteFiles Files { get; } = files;
            public DateTime LastUsed { get; set; } = DateTime.UtcNow;
        }

        private static readonly ConcurrentDictionary<string, Session> Sessions = new();
        private static readonly Timer Sweep = new(_ =>
        {
            foreach (var (ip, s) in Sessions)
                if (DateTime.UtcNow - s.LastUsed > TimeSpan.FromMinutes(2) && Sessions.TryRemove(ip, out var old)) old.Files.Dispose();
        }, null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));

        private static RemoteFiles Files(string ip)
        {
            var (user, pass) = UpdateService.Credentials()!.Value;
            var s = Sessions.GetOrAdd(ip, _ => new Session(new RemoteFiles(ip, user, pass, UpdateService.WorkFolder)));
            s.LastUsed = DateTime.UtcNow;
            return s.Files;
        }

        public static void Close(string ip)
        {
            if (Sessions.TryRemove(ip, out var s)) s.Files.Dispose();
        }

        private static string Need(string? s, string what) =>
            string.IsNullOrWhiteSpace(s) || !s.StartsWith('/') ? throw new ArgumentException($"Geçersiz {what}.") : s;

        public static async Task<object> ListAsync(RfRequest r, CancellationToken ct)
        {
            string path = Need(r.Path, "klasör yolu");
            var list = await Files(r.Ip).ListAsync(path, ct);
            return new
            {
                path,
                items = list.Select(e => new
                {
                    name = e.Name, path = e.FullPath, dir = e.IsDir, link = e.IsLink, size = e.Size,
                    mtime = e.Modified == default ? 0 : new DateTimeOffset(e.Modified).ToUnixTimeMilliseconds(), perms = e.Perms,
                }),
            };
        }

        /// <summary>Yol klasör mü (true), dosya mı (false), yok mu (null).</summary>
        public static async Task<object> StatAsync(RfRequest r, CancellationToken ct) =>
            new { dir = await Files(r.Ip).IsDirectoryAsync(Need(r.Path, "yol"), ct) };

        public static Task MkdirAsync(RfRequest r, CancellationToken ct) => Files(r.Ip).CreateFolderAsync(Need(r.Path, "yol"), ct);

        public static Task RenameAsync(RfRequest r, CancellationToken ct) =>
            Files(r.Ip).RenameAsync(Need(r.Path, "yol"), Need(r.To, "yeni yol"), ct);

        public static Task DeleteAsync(RfRequest r, CancellationToken ct)
        {
            var paths = (r.Paths ?? new()).Select(p => Need(p, "yol")).ToList();
            if (paths.Count == 0) throw new ArgumentException("Silinecek öğe yok.");
            return Files(r.Ip).DeleteAsync(paths, ct);
        }

        /// <summary>Klasörde zaten olan adlar (üzerine yazma sorusu için).</summary>
        public static async Task<object> ExistingAsync(RfRequest r, CancellationToken ct) =>
            new { names = await Files(r.Ip).ExistingAsync(Need(r.Path, "klasör yolu"), (r.Names ?? new()).Select(SafeName), ct) };

        /// <summary>Tarayıcıdan gelen tek dosyayı uzak klasöre yükler (varsa üzerine yazar).</summary>
        public static async Task UploadAsync(string ip, string? dir, string? name, Stream body, CancellationToken ct)
        {
            string remoteDir = Need(dir, "klasör yolu");
            string n = SafeName(name);
            string tmp = Path.Combine(Path.GetTempPath(), "rbx-up-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tmp);
            try
            {
                string local = Path.Combine(tmp, n);
                await using (var fs = File.Create(local)) await body.CopyToAsync(fs, ct);
                await Files(ip).UploadAsync(new[] { local }, remoteDir, null, ct);
            }
            finally { TryDelete(tmp); }
        }

        /// <summary>Ajanın updateFiles klasöründeki dosyaları (göreli yollar) uzak klasöre yükler.</summary>
        public static Task UploadFromWorkAsync(RfRequest r, CancellationToken ct)
        {
            var locals = new List<string>();
            foreach (var rel in r.Names ?? new())
                locals.Add(FilesService.ResolveExisting(rel) ?? throw new ArgumentException($"updateFiles içinde bulunamadı: {rel}"));
            if (locals.Count == 0) throw new ArgumentException("Yüklenecek dosya seçilmedi.");
            return Files(r.Ip).UploadAsync(locals, Need(r.Path, "klasör yolu"), null, ct);
        }

        /// <summary>
        /// Öğeleri geçici klasöre indirir. Tek dosyaysa o dosya, değilse zip döner. Dönen klasör (Temp) çağıran
        /// tarafından gönderimden sonra silinir.
        /// </summary>
        public static async Task<(string file, string name, string temp)> DownloadAsync(string ip, List<RfItem> items, CancellationToken ct)
        {
            if (items.Count == 0) throw new ArgumentException("İndirilecek öğe seçilmedi.");
            var entries = items.Select(i => new RemoteEntry { FullPath = Need(i.Path, "yol"), IsDir = i.Dir, Name = LastPart(i.Path) }).ToList();
            string tmp = Path.Combine(Path.GetTempPath(), "rbx-dl-" + Guid.NewGuid().ToString("N"));
            string dl = Path.Combine(tmp, "d");
            Directory.CreateDirectory(dl);
            try
            {
                await Files(ip).DownloadAsync(entries, dl, null, ct);
                if (entries.Count == 1 && !entries[0].IsDir && Directory.GetFiles(dl) is [var only])
                    return (only, Path.GetFileName(only), tmp);
                string zipName = (entries.Count == 1 ? entries[0].Name : "dosyalar") + ".zip";
                string zip = Path.Combine(tmp, zipName);
                ZipFile.CreateFromDirectory(dl, zip, CompressionLevel.Fastest, false);
                return (zip, zipName, tmp);
            }
            catch
            {
                TryDelete(tmp);
                throw;
            }
        }

        public static void TryDelete(string dir)
        {
            try { Directory.Delete(dir, true); } catch { /* ignore */ }
        }

        private static string LastPart(string p)
        {
            var t = p.TrimEnd('/');
            return t[(t.LastIndexOf('/') + 1)..];
        }

        /// <summary>Uzak tarafta tek klasör düzeyinde ad: '/' ve kontrol karakterleri olamaz.</summary>
        private static string SafeName(string? name)
        {
            var n = (name ?? "").Trim();
            if (n.Length == 0 || n is "." or ".." || n.Contains('/') || n.Contains('\\') || n.Any(char.IsControl))
                throw new ArgumentException($"Geçersiz dosya adı: {name}");
            return n;
        }
    }
}
