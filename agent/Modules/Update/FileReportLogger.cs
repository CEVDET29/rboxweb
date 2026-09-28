using RboxAgent.Modules.Update.Core;
using System;
using System.IO;
using System.Threading.Tasks;


namespace RboxAgent.Modules.Update
{
    public interface IAppLogger
    {
        Task LogAsync(string ip, string message);                  // UI + dosya (Info)
        Task LogAsync(string ip, string message, StatusKind kind); // UI + dosya (renkli) — v4.2
        Task AppendAsync(string rawLine); // sadece dosya
        string LogFilePath { get; }
    }


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
            string line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss}\t{ip}\t{message}";
            await AppendAsync(line);
            _status?.Set(ip ?? string.Empty, message, kind);
        }


        public async Task AppendAsync(string rawLine)
        {
            if (!string.IsNullOrEmpty(rawLine) && Redact != null) rawLine = Redact(rawLine);
            await _fileLock.WaitAsync();
            try
            {
                using var sw = new StreamWriter(LogFilePath, append: true);
                if (!string.IsNullOrEmpty(rawLine))
                    await sw.WriteLineAsync(rawLine);
                else
                    await sw.WriteLineAsync();
            }
            catch { /* disk dolu v.b. hatalarını sessiz geç */ }
            finally { _fileLock.Release(); }
        }
    }
}