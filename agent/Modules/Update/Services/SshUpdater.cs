using Renci.SshNet;
using Renci.SshNet.Common;
using System.Text;

namespace RboxAgent.Modules.Update.Services
{
    internal class SshUpdater(string ip, string user, string pass, string workFolder, Func<string, string, Task> logger)
    {
        private readonly string _ip = ip;
        private readonly string _user = user;
        private readonly string _pass = pass;
        private readonly string _workFolder = workFolder;
        private readonly Func<string, string, Task> _log = logger; // (ip, message)

        // ── v4.8: cihaza özel geçici klasör ───────────────────────────────────
        // Paralel güncellemede her cihaz kendi SshUpdater örneğini kullanır.
        // Geçici dosyalar (satır sonu dönüştürülmüş kopyalar, üretilen metinler)
        // artık updateFiles içine DEĞİL, bu örneğe özel klasöre yazılır.
        // Aksi halde 13 iş parçacığı aynı "<dosya>.unix" yolunu yazıp okur ve
        // "The process cannot access the file ... used by another process" hatası alınır.
        private readonly string _tempRoot = Path.Combine(
            Path.GetTempPath(),
            "RasyoboxSSHUpdate",
            $"{SanitizeFileName(ip)}_{Guid.NewGuid():N}");

        private static string SanitizeFileName(string? name)
        {
            name ??= "device";
            foreach (char c in Path.GetInvalidFileNameChars())
                name = name.Replace(c, '_');
            return name.Length == 0 ? "device" : name;
        }

        /// <summary>Bu cihaza özel geçici klasörde benzersiz olmayan ama izole bir yol üretir.</summary>
        public string NewTempFilePath(string fileName)
        {
            Directory.CreateDirectory(_tempRoot);
            return Path.Combine(_tempRoot, SanitizeFileName(Path.GetFileName(fileName)));
        }

        /// <summary>Cihazın geçici klasörünü siler (güncelleme bitiminde çağrılır).</summary>
        public void CleanupTempFolder()
        {
            try
            {
                if (Directory.Exists(_tempRoot)) Directory.Delete(_tempRoot, true);
            }
            catch { /* ignore */ }
        }

        // SshUpdater.cs — class SshUpdater içine

        public async Task<bool> CopyTextContentWithSudoAsync(
            SshClient client,
            string content,
            string tempLocalName,
            string remoteTempPath,
            string sudoMoveCmd,
            string ip,
            CancellationToken ct)
        {
            // v4.8: geçici dosya cihaza özel klasöre yazılır (updateFiles kirlenmez, yarış yok)
            string tempPath = NewTempFilePath(tempLocalName);
            // Normalize newlines to LF and write UTF-8 (no BOM)
            content = content.Replace("\r\n", "\n").Replace("\r", "\n");
            if (!content.EndsWith("\n")) content += "\n";
            File.WriteAllText(tempPath, content, new System.Text.UTF8Encoding(false));
            try
            {
                return await CopyFileWithSudoAsync(client, tempPath, remoteTempPath, sudoMoveCmd, ip, ct, unixifyBeforeUpload: false);
            }
            finally
            {
                try { File.Delete(tempPath); } catch { /* ignore */ }
            }
        }
        public Task<(bool ok, string stdout, string stderr)> ExecuteSudoGetOutputAsync(
            SshClient client,
            string raw,
            string? ip,
            CancellationToken ct,
            int timeoutSeconds = 40)
        {
            return Task.Run<(bool ok, string stdout, string stderr)>(() =>
            {

                ct.ThrowIfCancellationRequested();
                string esc = EscapeForBashDoubleQuotes(raw);
                string cmdText = $"echo '{EscapeSingleQuotes(_pass)}' | sudo -S -p \"\" bash -lc \"{esc}\"";
                using var cmd = client.CreateCommand(cmdText);
                cmd.CommandTimeout = TimeSpan.FromSeconds(timeoutSeconds);
                Run(cmd, raw);
                bool ok = cmd.ExitStatus == 0;
                return (ok, cmd.Result ?? string.Empty, cmd.Error ?? string.Empty);
            }, ct);
        }        // SshUpdater.cs — class SshUpdater içine EKLE

        private (bool ok, string stdout, string stderr) RunSudoOnce(
            SshClient client, string cmd, TimeSpan timeout, bool noPromptFirst)
        {
            string Esc(string s) => EscapeForBashDoubleQuotes(s);

            // 1) Önce -n ile dene (parola istemesin, hemen hata dönsün)
            if (noPromptFirst)
            {
                using var c = client.CreateCommand($"sudo -n bash -lc \"{Esc(cmd)}\"");
                c.CommandTimeout = timeout;
                Run(c, cmd);
                if (c.ExitStatus == 0)
                    return (true, c.Result ?? string.Empty, c.Error ?? string.Empty);

                // Sadece parola istediği için düştüyse fallback yapalım;
                // Debian'da mesaj "a password is required".
                if (!string.IsNullOrEmpty(c.Error) &&
                    c.Error.IndexOf("a password is required", StringComparison.OrdinalIgnoreCase) < 0)
                {
                    return (false, c.Result ?? string.Empty, c.Error ?? string.Empty);
                }
            }

            // 2) Parola ile (-S) deneyelim
            using var cc = client.CreateCommand(
                $"echo '{EscapeSingleQuotes(_pass)}' | sudo -S -p \"\" bash -lc \"{Esc(cmd)}\"");
            cc.CommandTimeout = timeout;
            Run(cc, cmd);
            bool ok = cc.ExitStatus == 0;
            return (ok, cc.Result ?? string.Empty, cc.Error ?? string.Empty);
        }

        // Birden çok komutu ayrı ayrı çalıştır ve çıktıları topla
        public (bool ok, string combinedOut, string combinedErr) RunSudoMany(
            SshClient client, IEnumerable<string> cmds, TimeSpan perCmdTimeout, bool noPromptFirst)
        {
            var sbOut = new StringBuilder();
            var sbErr = new StringBuilder();
            foreach (var cmd in cmds)
            {
                var (ok, so, se) = RunSudoOnce(client, cmd, perCmdTimeout, noPromptFirst);
                if (!string.IsNullOrEmpty(so)) sbOut.AppendLine(so.TrimEnd());
                if (!string.IsNullOrEmpty(se)) sbErr.AppendLine(se.TrimEnd());
                if (!ok) return (false, sbOut.ToString(), sbErr.ToString());
            }
            return (true, sbOut.ToString(), sbErr.ToString());
        }
        public SshClient Connect(int timeoutSeconds = 5)
        {
            var connInfo = new PasswordConnectionInfo(_ip, _user, _pass)
            {
                Timeout = TimeSpan.FromSeconds(timeoutSeconds)
            };

            var client = new SshClient(connInfo);

            try
            {
                client.Connect();
            }
            catch (SshOperationTimeoutException ex)
            {
                client.Dispose();
                // Zaman aşımını daha okunur bir hata olarak yukarı fırlatıyoruz
                throw new SshConnectionException(
                    $"SSH bağlantı zaman aşımına uğradı ({timeoutSeconds * 1000} ms).",
                    ex);
            }

            if (!client.IsConnected)
            {
                client.Dispose();
                //throw new SshConnectionException("Bağlantı kurulamadı (IsConnected=false).");
            }

            return client;
        }

        /// <summary>
        /// Metin dosyaları için CRLF→LF dönüştürülmüş geçici bir kopya üretir.
        /// v4.8: kopya artık kaynak dosyanın yanına (<c>updateFiles\&lt;dosya&gt;.unix</c>) değil,
        /// bu cihaza özel geçici klasöre yazılır. Metin dosyası değilse <c>null</c> döner.
        /// </summary>
        private string? PrepareUnixLocalCopyIfText(string localPath)
        {
            string name = Path.GetFileName(localPath).ToLowerInvariant();
            // SshUpdater.cs — PrepareUnixLocalCopyIfText(...)
            bool textLike =
                name.EndsWith(".txt", StringComparison.OrdinalIgnoreCase) ||
                name.EndsWith(".service", StringComparison.OrdinalIgnoreCase) ||
                name.EndsWith(".conf", StringComparison.OrdinalIgnoreCase) ||
                name.EndsWith(".sh", StringComparison.OrdinalIgnoreCase) ||
                name.EndsWith(".py", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(name, ".bashrc", StringComparison.Ordinal) ||
                string.Equals(name, ".profile", StringComparison.Ordinal) ||
                name == "rclocal.txt" || name == "wpa_supplicant.txt" || name == "dhcpcd.txt" ||
                name.EndsWith(".bash", StringComparison.OrdinalIgnoreCase) ||
                name == "crontab.txt" || name == "jsonsettings.txt";
            
            if (!textLike) return null;

            string text = File.ReadAllText(localPath);
            text = text.Replace("\r\n", "\n").Replace("\r", "\n");
            if (!text.EndsWith("\n")) text += "\n";

            // v4.8: cihaza özel geçici yol — paralel güncellemede dosya kilidi oluşmaz
            string unixPath = NewTempFilePath(Path.GetFileName(localPath) + ".unix");
            File.WriteAllText(unixPath, text, new System.Text.UTF8Encoding(false));
            return unixPath;
        }

        public async Task<bool> CopyFileWithSudoAsync(
            SshClient client,
            string localName,
            string remoteTempPath,
            string sudoMoveCmd,
            string ip,
            CancellationToken ct,
            bool unixifyBeforeUpload = false)
        {
            ct.ThrowIfCancellationRequested();

            string originalLocalPath = Path.Combine(_workFolder, localName);
            if (!File.Exists(originalLocalPath))
            {
                await _log(ip, $"{localName} bulunamadı. Güncelleme iptal edildi.");
                return false;
            }

            // v4.8: dönüştürülmüş kopya cihaza özel geçici klasöre yazılır ve sonunda silinir
            string? tempCopy = null;
            if (unixifyBeforeUpload)
            {
                try
                {
                    tempCopy = PrepareUnixLocalCopyIfText(originalLocalPath);
                }
                catch (Exception ex)
                {
                    await _log(ip, $"{localName} satır sonu dönüştürme hatası: {ex.Message}");
                    return false;
                }
            }
            string toUpload = tempCopy ?? originalLocalPath;

            try
            {
                try
                {
                    using SftpClient sftp = new(client.ConnectionInfo);
                    sftp.Connect();
                    using (var fs = File.OpenRead(toUpload))
                    {
                        await Task.Run(() => sftp.UploadFile(fs, remoteTempPath, true), ct);
                    }
                    sftp.Disconnect();
                }
                catch (Exception ex)
                {
                    await _log(ip, $"SFTP yükleme hatası: {ex.Message}");
                    return false;
                }

                (bool ok, string message) = await ExecuteSudoChainAsync(client, [sudoMoveCmd], ip, ct);
                if (!ok)
                {
                    await _log(ip, $"Kopyalama/taşıma hatası: {message}");
                    return false;
                }

                // v5.1: başarı burada loglanmaz — her adım kendi özet satırını yazar. Aksi halde
                // "X başarıyla güncellendi." + "X kopyalandı." çift satırı çıkıyor, aynı dosyayı
                // birden çok hedefe kopyalayan adımlarda (.nanorc → 3 hedef) satır tekrar ediyordu.
                return true;
            }
            finally
            {
                if (tempCopy != null)
                {
                    try { File.Delete(tempCopy); } catch { /* ignore */ }
                }
            }
        }
        
       

        public Task<bool> CopyTextFileWithSudoAsync(
            SshClient client,
            string localName,
            string remoteTempPath,
            string sudoMoveCmd,
            string ip,
            CancellationToken ct)
            => CopyFileWithSudoAsync(client, localName, remoteTempPath, sudoMoveCmd, ip, ct, unixifyBeforeUpload: true);

        public Task<(bool ok, string message)> ExecuteSudoChainAsync(
            SshClient client,
            IEnumerable<string> commands,
            string? ip,
            CancellationToken ct)
        {
            return Task.Run<(bool ok, string message)>(() =>
            {
                foreach (string raw in commands)
                {
                    ct.ThrowIfCancellationRequested();

                    string esc = EscapeForBashDoubleQuotes(raw);
                    string cmdText = $"echo '{EscapeSingleQuotes(_pass)}' | sudo -S -p \"\" bash -lc \"{esc}\"";

                    using var cmd = client.CreateCommand(cmdText);
                    cmd.CommandTimeout = TimeSpan.FromSeconds(40);
                    Run(cmd, raw);
                    if (cmd.ExitStatus != 0)
                    {
                        string err = cmd.Error ?? "Bilinmeyen hata";
                        return (false, $"Komut: {raw} | Hata: {err}");
                    }
                }
                return (true, "OK");
            }, ct);
        }

        // ── v5.1: şifre sızıntısı önlemi ──────────────────────────────────────
        // Komut metni "echo '<şifre>' | sudo -S ..." içeriyor. SSH.NET zaman aşımında istisna
        // mesajına komut metnini olduğu gibi koyuyor ("Command '...' timed out"); bu mesaj
        // tabloya, günlüğe ve rapor dosyasına düşüp şifreyi açığa çıkarıyordu. Tüm komutlar
        // buradan çalışır: zaman aşımı şifresiz bir mesajla, diğer SSH hataları maskelenerek fırlatılır.

        /// <summary>Komutu çalıştırır; hata mesajında şifre olmamasını garanti eder.</summary>
        private void Run(SshCommand cmd, string description)
        {
            try
            {
                cmd.Execute();
            }
            catch (SshOperationTimeoutException)
            {
                throw new SshOperationTimeoutException(
                    $"Komut zaman aşımına uğradı ({cmd.CommandTimeout.TotalSeconds:0} sn): {Redact(description)}");
            }
            catch (SshException ex) when (ContainsSecret(ex.Message))
            {
                throw new SshException(Redact(ex.Message));
            }
        }

        private bool ContainsSecret(string? s) =>
            !string.IsNullOrEmpty(_pass) && s != null
            && (s.Contains(_pass, StringComparison.Ordinal) || s.Contains(EscapeSingleQuotes(_pass), StringComparison.Ordinal));

        /// <summary>Metindeki şifreyi (ve kabuk için kaçışlanmış halini) "****" ile değiştirir.</summary>
        public string Redact(string? s)
        {
            if (string.IsNullOrEmpty(s) || string.IsNullOrEmpty(_pass)) return s ?? "";
            return s.Replace(EscapeSingleQuotes(_pass), "****").Replace(_pass, "****");
        }

        private static string EscapeForBashDoubleQuotes(string? s)
            => (s ?? string.Empty)
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("$", "\\$")
                .Replace("`", "\\`");

        private static string EscapeSingleQuotes(string? s)
            => s == null ? "" : s.Replace("'", "'\\''");

        // SshUpdater.cs (yeni) — basit satırsonu/BOM temizliği
        private static string NormalizeTextForUnix(string text)
        {
            if (string.IsNullOrEmpty(text)) return "\n";
            // UTF-8 BOM temizle
            if (text.Length >= 1 && text[0] == '\uFEFF') text = text.Substring(1);
            // CRLF -> LF
            text = text.Replace("\r\n", "\n").Replace("\r", "\n");
            // sonda tek LF
            if (!text.EndsWith("\n")) text += "\n";
            return text;
        }

        // SshUpdater.cs (yeni) — uzak uca here-doc ile bir metni yaz & güvenli kur
        public async Task<(bool ok, string msg)> InstallTextAsAsync(
            SshClient client,
            string ip,
            string text,
            string remoteTargetPath,
            string ownerGroup, // ör: "pi:pi" veya "root:root"
            string mode,       // ör: "0644" veya "0755"
            CancellationToken ct)
        {
            string normalized = NormalizeTextForUnix(text);
            // Geçici dosya
            string tmp = "/tmp/__push.txt";

            // 1) Here-doc ile içerik bas
            var (ok1, m1) = await ExecuteSudoChainAsync(client,
            [$"bash -lc 'cat > {tmp} <<\"__EOF__\"{"\n"}{normalized}__EOF__'"], ip, ct);
            if (!ok1) return (false, "here-doc yazılamadı: " + m1);

            // 2) install ile hedefe taşı + izinler
            var (ok2, m2) = await ExecuteSudoChainAsync(client,
            [$"install -m {mode} -o {ownerGroup.Split(':')[0]} -g {ownerGroup.Split(':')[1]} {tmp} {remoteTargetPath}"], ip, ct);
            if (!ok2) return (false, "install başarısız: " + m2);

            // 3) sözdizimi kontrolü (bash kendi dosyalarını da -n ile kabul eder)
            var (ok3, m3) = await ExecuteSudoChainAsync(client, new[]
            {
                $"bash -n {remoteTargetPath}"}, ip, ct);
            if (!ok3) return (false, $"{remoteTargetPath} syntax HATA: {m3}");

            return (true, "OK");
        }
    }
}
