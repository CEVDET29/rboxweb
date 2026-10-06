using System.Text.RegularExpressions;
using RboxAgent.Modules.Update.Core;

namespace RboxAgent.Modules.Update
{
    public sealed class SendRunRequest
    {
        public string? StageId { get; set; }
        public List<UpdTarget> Targets { get; set; } = new();
        public string? RemoteDir { get; set; }
        public bool ChmodSh { get; set; } = true;
        public bool FixLineEndings { get; set; } = true;
        public int Parallel { get; set; } = 10;
    }

    /// <summary>
    /// "Dosya gönder" (web): tarayıcıda seçilen dosyalar önce ajana yüklenir (geçici "sahne" klasörü),
    /// sonra işaretli cihazlara <see cref="FileSender"/> ile kopyalanır. Sahne klasörü iş bitince silinir.
    /// </summary>
    internal static class SendService
    {
        private static readonly string StageRoot = Path.Combine(Path.GetTempPath(), "RboxAgent-send");
        private static readonly Regex StageIdRx = new("^[0-9a-f]{32}$", RegexOptions.Compiled);

        private static string? StageDir(string? id) =>
            id != null && StageIdRx.IsMatch(id) ? Path.Combine(StageRoot, id) : null;

        /// <summary>Tek dosyayı sahneye yazar. <paramref name="relPath"/> "klasor/alt/dosya.sh" biçiminde.</summary>
        public static async Task<(bool ok, string? error)> StageFileAsync(string? id, string? relPath, Stream body)
        {
            string? dir = StageDir(id);
            if (dir == null) return (false, "Geçersiz yükleme kimliği.");
            string rel = (relPath ?? "").Replace('\\', '/').Trim('/');
            var parts = rel.Split('/');
            if (rel.Length == 0 || parts.Any(p => p is "" or "." or ".." || p.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0))
                return (false, "Geçersiz dosya adı: " + rel);

            string full = Path.GetFullPath(Path.Combine(dir, Path.Combine(parts)));
            if (!full.StartsWith(Path.GetFullPath(dir) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                return (false, "Geçersiz dosya adı.");

            if (!Directory.Exists(dir)) CleanupOld();
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            await using (var f = File.Create(full)) await body.CopyToAsync(f);
            return (true, null);
        }

        public static string? Validate(SendRunRequest r)
        {
            string? dir = StageDir(r.StageId);
            if (dir == null || !Directory.Exists(dir)) return "Gönderilecek dosya seçin.";
            if (r.Targets.Count == 0) return "Dosya göndermek için cihaz işaretleyin.";
            if (UpdateService.Credentials() == null) return "SSH kullanıcı adı ve şifre girin (üst banttaki SSH düğmesi).";
            return FileSender.Validate(Items(dir), Options(r));
        }

        private static List<SendItem> Items(string dir) =>
            Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)
                     .Select(f => new SendItem(f, Path.GetRelativePath(dir, f).Replace('\\', '/')))
                     .ToList();

        private static SendOptions Options(SendRunRequest r) => new()
        {
            RemoteDir = FileSender.NormalizeRemoteDir(r.RemoteDir),
            ChmodSh = r.ChmodSh,
            FixLineEndings = r.FixLineEndings,
        };

        /// <summary>
        /// Gönderim akışı. Olaylar toplu güncellemeyle aynı (start / targetStart / targetResult / progress / log / done),
        /// arayüz aynı işleyiciyle gösterir.
        /// </summary>
        public static async Task RunAsync(string runId, SendRunRequest req, NdjsonSink sink)
        {
            string dir = StageDir(req.StageId)!;
            var items = Items(dir);
            var opt = Options(req);
            var (user, pass) = UpdateService.Credentials()!.Value;
            var redact = UpdateService.MakeRedact(pass);
            var reporter = new UpdateService.Reporter(sink, redact);
            var logger = new FileReportLogger(reporter, UpdateService.WorkFolder) { Redact = s => redact(s) };

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(sink.Broken);
            using var registration = UpdateService.RegisterRun(runId, cts);
            var ct = cts.Token;
            int parallel = Math.Clamp(req.Parallel, 1, 100);
            int total = req.Targets.Count, done = 0, okCount = 0, failCount = 0;
            string what = FileSender.Describe(items);

            sink.Emit(new { type = "start", runId, total });
            reporter.Set("", $"Dosya gönderme başladı... ({what} → {opt.RemoteDir}, {total} cihaz)");
            await logger.BeginRunAsync(total, parallel, "DOSYA GÖNDER", $"{what}  →  {opt.RemoteDir}");

            try
            {
                using var sem = new SemaphoreSlim(parallel);
                await Task.WhenAll(req.Targets.Select(async t =>
                {
                    try { await sem.WaitAsync(ct); }
                    catch (OperationCanceledException)
                    {
                        sink.Emit(new { type = "targetCancelled", id = t.Id });
                        sink.Emit(new { type = "progress", done = Interlocked.Increment(ref done), total });
                        return;
                    }
                    try
                    {
                        sink.Emit(new { type = "targetStart", id = t.Id });
                        bool ok = await FileSender.SendAsync(t.Ip, user, pass, items, opt, logger, UpdateService.WorkFolder, ct);
                        sink.Emit(new { type = "targetResult", id = t.Id, ok });
                        Interlocked.Increment(ref ok ? ref okCount : ref failCount);
                        await logger.DeviceResultAsync(t.Ip, ok, "DOSYA GÖNDERME");
                    }
                    catch (OperationCanceledException)
                    {
                        sink.Emit(new { type = "targetResult", id = t.Id, ok = false });
                        await logger.DeviceResultAsync(t.Ip, null, "DOSYA GÖNDERME");
                    }
                    finally
                    {
                        sem.Release();
                        sink.Emit(new { type = "progress", done = Interlocked.Increment(ref done), total });
                    }
                }));
            }
            catch (Exception ex) { reporter.Set("", "Beklenmeyen hata: " + ex.Message, StatusKind.Error); }
            finally
            {
                bool cancelled = ct.IsCancellationRequested;
                await logger.EndRunAsync(okCount, failCount, total - okCount - failCount, cancelled);
                reporter.Set("", cancelled ? "Dosya gönderme iptal edildi." : $"Dosya gönderme bitti: {okCount} başarılı, {failCount} hatalı.",
                    cancelled ? StatusKind.Warn : failCount > 0 ? StatusKind.Error : StatusKind.Success);
                try { Directory.Delete(dir, true); } catch { }
                sink.Emit(new { type = "done", cancelled });
            }
        }

        public static void Discard(string? id)
        {
            if (StageDir(id) is { } dir) try { Directory.Delete(dir, true); } catch { }
        }

        /// <summary>Yarıda kalmış eski sahneleri (1 saatten eski) temizler.</summary>
        private static void CleanupOld()
        {
            try
            {
                if (!Directory.Exists(StageRoot)) return;
                foreach (var d in Directory.GetDirectories(StageRoot))
                    if (Directory.GetLastWriteTimeUtc(d) < DateTime.UtcNow.AddHours(-1))
                        try { Directory.Delete(d, true); } catch { }
            }
            catch { }
        }
    }
}
