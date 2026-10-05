using RboxAgent.Modules.Update.Core;
using System;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;


namespace RboxAgent.Modules.Update
{
    // NOT: Bu dosya WPF (RboxTools) ile web ajanında (RboxWeb/agent) aynıdır; yalnızca namespace farklıdır.

    public interface IAppLogger
    {
        Task LogAsync(string ip, string message);                  // UI + dosya (Info)
        Task LogAsync(string ip, string message, StatusKind kind); // UI + dosya (renkli) — v4.2
        Task AppendAsync(string rawLine); // sadece dosya
        string LogFilePath { get; }
    }


    /// <summary>
    /// "Güncelleme Raporu.txt": her satır türüne göre işaretlenir (✔ BAŞARILI / ✖ HATA / ⚠ UYARI / ℹ BİLGİ),
    /// her toplu güncelleme bir başlık bloğuyla başlar, her cihazın sonucu ve en sonda bir özet yazılır.
    /// Dosya UTF-8 (BOM'lu) yazılır; Notepad++ ve Not Defteri Türkçe karakterleri ve işaretleri doğru gösterir.
    /// </summary>
    public sealed class FileReportLogger : IAppLogger
    {
        private readonly IStatusReporter _status;
        private readonly string _folder;

        // v4.2: paralel güncellemede aynı anda tek yazıcı — satır kaybını önler
        private readonly SemaphoreSlim _fileLock = new(1, 1);

        public string LogFilePath { get; }

        /// <summary>
        /// v5.1: rapor dosyasına yazılmadan önce metinden şifreyi temizler (ör. "****").
        /// Arayüz atar; atanmazsa metin olduğu gibi yazılır.
        /// </summary>
        public Func<string, string>? Redact { get; set; }

        private const string Rule = "════════════════════════════════════════════════════════════════════════════";
        private const string ThinRule = "────────────────────────────────────────────────────────────────────────────";
        private const string Legend = "İşaretler:  ✔ BAŞARILI   ✖ HATA   ⚠ UYARI   ℹ BİLGİ";


        public FileReportLogger(IStatusReporter status, string workFolder)
        {
            _status = status;
            _folder = workFolder ?? throw new ArgumentNullException(nameof(workFolder));
            Directory.CreateDirectory(_folder);
            LogFilePath = Path.Combine(_folder, "Güncelleme Raporu.txt");
        }


        // Not: overload olarak kalmalı (optional parametre olursa
        // Func<string,string,Task> delegate dönüşümü bozulur — SshUpdater ctor).
        public Task LogAsync(string ip, string message)
            => LogAsync(ip, message, StatusKind.Info);


        public async Task LogAsync(string ip, string message, StatusKind kind)
        {
            // Adımların çoğu sonucu "Info" olarak yazar ("... kopyalandı." / "... hatası: ..."); türü metinden çıkar
            if (kind == StatusKind.Info) kind = Classify(message);
            await AppendAsync(FormatLine(ip, message, kind));
            _status?.Set(ip ?? string.Empty, message, kind);
        }

        /// <summary>
        /// Güncelleme adımlarına verilecek durum bildiricisi: ekrana yazdığı her şeyi rapora da yazar.
        /// (SSH'a bağlanılamadı, zaman aşımı gibi mesajlar yalnızca ekrana gidiyordu.)
        /// </summary>
        public IStatusReporter Tee(IStatusReporter inner) => new TeeReporter(this, inner);

        private sealed class TeeReporter : IStatusReporter
        {
            private readonly FileReportLogger _log;
            private readonly IStatusReporter _inner;
            public TeeReporter(FileReportLogger log, IStatusReporter inner) { _log = log; _inner = inner; }

            public void Set(string ip, string message, StatusKind kind = StatusKind.Info, string? timestamp = null)
            {
                if (kind == StatusKind.Info) kind = Classify(message);
                _inner.Set(ip, message, kind, timestamp);
                _ = _log.AppendAsync(FormatLine(ip, message, kind));
            }
        }

        /// <summary>Toplu güncellemenin başı: tarih, cihaz sayısı ve işaretlerin açıklaması.</summary>
        public Task BeginRunAsync(int deviceCount, int parallel) =>
            AppendAsync(string.Join(Environment.NewLine,
                "",
                Rule,
                $"  GÜNCELLEME  ·  {DateTime.Now:dd.MM.yyyy HH:mm:ss}  ·  {deviceCount} cihaz, {parallel} paralel",
                $"  {Legend}",
                Rule));

        /// <summary>Bir cihazın sonucu (cihazın kayıtlarının hemen altına, ayırıcı çizgiyle).</summary>
        public Task DeviceResultAsync(string ip, bool? ok)
        {
            string text = ok switch
            {
                true => $"✔ {ip}  →  GÜNCELLEME BAŞARILI",
                false => $"✖ {ip}  →  GÜNCELLEME BAŞARISIZ",
                null => $"⚠ {ip}  →  İPTAL EDİLDİ",
            };
            return AppendAsync($"{Time()}  {text}{Environment.NewLine}{ThinRule}");
        }

        /// <summary>Toplu güncellemenin sonu: başarılı / hatalı / iptal sayıları.</summary>
        public Task EndRunAsync(int ok, int failed, int cancelled, bool wasCancelled)
        {
            string state = wasCancelled ? "⚠ İPTAL EDİLDİ" : failed > 0 ? "✖ HATALI CİHAZ VAR" : "✔ TÜMÜ BAŞARILI";
            return AppendAsync(string.Join(Environment.NewLine,
                Rule,
                $"  SONUÇ  ·  {DateTime.Now:dd.MM.yyyy HH:mm:ss}  ·  {state}",
                $"  ✔ {ok} başarılı    ✖ {failed} hatalı    ⚠ {cancelled} iptal",
                Rule,
                ""));
        }


        public async Task AppendAsync(string rawLine)
        {
            if (!string.IsNullOrEmpty(rawLine) && Redact != null) rawLine = Redact(rawLine);
            await _fileLock.WaitAsync();
            try
            {
                // Yeni dosyaya BOM yazılır: Notepad++ ve Not Defteri UTF-8 olduğunu kesin anlasın (✔ ✖ ⚠ ve Türkçe harfler)
                bool isNew = !File.Exists(LogFilePath) || new FileInfo(LogFilePath).Length == 0;
                using var sw = new StreamWriter(LogFilePath, append: true, new UTF8Encoding(isNew));
                if (!string.IsNullOrEmpty(rawLine))
                    await sw.WriteLineAsync(rawLine);
                else
                    await sw.WriteLineAsync();
            }
            catch { /* disk dolu v.b. hatalarını sessiz geç */ }
            finally { _fileLock.Release(); }
        }


        // ── Biçim ────────────────────────────────────────────────────

        private static string Time() => DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");

        public static string Badge(StatusKind kind) => kind switch
        {
            StatusKind.Success => "✔ BAŞARILI",
            StatusKind.Error => "✖ HATA    ",
            StatusKind.Warn => "⚠ UYARI   ",
            _ => "ℹ BİLGİ   ",
        };

        /// <summary>"2026-10-05 14:22:01  ✔ BAŞARILI  172.16.154.10    Bağlantı başarılı." — çok satırlı mesajın devamı hizalı girintilenir.</summary>
        private static string FormatLine(string? ip, string? message, StatusKind kind)
        {
            string head = $"{Time()}  {Badge(kind)}  {(ip ?? "").PadRight(15)}  ";
            var lines = (message ?? "").Replace("\r\n", "\n").Split('\n');
            if (lines.Length == 1) return head + lines[0];
            string indent = new(' ', head.Length);
            return head + string.Join(Environment.NewLine + indent, lines);
        }

        private static readonly CultureInfo Tr = new("tr-TR");

        // "-amadı / -emedi / -amaz": yapılamadı, kopyalanamadı, yüklenemedi, okunamadı, bulunamadı...
        private static readonly Regex CouldNot = new(@"\w(?:ama|eme)(?:dı|di|z)\b", RegexOptions.Compiled);
        private static readonly Regex Done = new(
            @"başarılı|başarıyla|tamamlandı|kopyalandı|uygulandı|güncellendi|yüklendi|başlatıldı|oluşturuldu|kuruldu|temizlendi|planlandı|kaydedildi|yazıldı|(?:enable|source|restart) edildi",
            RegexOptions.Compiled);

        /// <summary>Türü belirtilmemiş ("Info") mesajın türünü metinden tahmin eder.</summary>
        public static StatusKind Classify(string? message)
        {
            if (string.IsNullOrWhiteSpace(message)) return StatusKind.Info;
            string m = message.ToLower(Tr);
            if (m.Contains("iptal")) return StatusKind.Warn;
            if (m.Contains("hata") || m.Contains("başarısız") || m.Contains("kritik") || m.Contains("zaman aşımı")) return StatusKind.Error;
            if (CouldNot.IsMatch(m)) return m.Contains("devam") || m.Contains("atlandı") ? StatusKind.Warn : StatusKind.Error;
            if (m.Contains("atlandı") || Regex.IsMatch(m, @"\byok\b")) return StatusKind.Warn;
            if (Done.IsMatch(m)) return StatusKind.Success;
            return StatusKind.Info;
        }
    }
}
