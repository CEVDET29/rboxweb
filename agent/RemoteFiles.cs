using System.Globalization;
using System.IO;
using System.Text;
using Renci.SshNet;
using Renci.SshNet.Common;
using Renci.SshNet.Sftp;
using RboxAgent.Modules.Update.Services;

namespace RboxAgent
{
    // NOT: Bu dosya WPF (RboxTools/Common) ile web ajanında (RboxWeb/agent) aynıdır; yalnızca namespace farklıdır.
    /// <summary>Uzak dizindeki bir öğe (dosya, klasör ya da bağlantı).</summary>
    public sealed class RemoteEntry
    {
        public string Name { get; init; } = "";
        public string FullPath { get; init; } = "";
        public bool IsDir { get; init; }
        public bool IsLink { get; init; }
        public long Size { get; init; }
        public DateTime Modified { get; init; }
        /// <summary>"drwxr-xr-x" biçiminde izinler.</summary>
        public string Perms { get; init; } = "";

        public string SizeText => IsDir ? "" : FormatSize(Size);
        public string ModifiedText => Modified == default ? "" : Modified.ToString("dd.MM.yyyy HH:mm", CultureInfo.InvariantCulture);
        /// <summary>Segoe MDL2 glifi: klasör, bağlantı, dosya.</summary>
        public string Glyph => IsDir ? "" : IsLink ? "" : "";

        private static readonly CultureInfo Tr = CultureInfo.GetCultureInfo("tr-TR");

        public static string FormatSize(long b) => b switch
        {
            < 1024 => $"{b} B",
            < 1024 * 1024 => (b / 1024.0).ToString("0.#", Tr) + " KB",
            < 1024L * 1024 * 1024 => (b / 1024.0 / 1024).ToString("0.#", Tr) + " MB",
            _ => (b / 1024.0 / 1024 / 1024).ToString("0.##", Tr) + " GB",
        };
    }

    /// <summary>
    /// RasyoBOX cihazında dosya işlemleri (TTY penceresinin dosya paneli). Listeleme ve aktarım SFTP ile, SSH
    /// kullanıcısı olarak yapılır; yetki yetmezse (ör. /etc altına yazma, root'a ait dosya) aynı işlem sudo ile
    /// yeniden denenir (SSH şifresiyle). Tek SSH + SFTP bağlantısı açık tutulur; çağrılar sıraya girer.
    /// </summary>
    public sealed class RemoteFiles : IDisposable
    {
        private readonly SshUpdater _ssh;
        private readonly string _user;
        private readonly SemaphoreSlim _gate = new(1, 1);
        private SshClient? _client;
        private SftpClient? _sftp;
        private bool _disposed;

        public string Ip { get; }
        /// <summary>Bilgisayardaki updateFiles klasörü (yükleme penceresi burada açılır).</summary>
        public string WorkFolder { get; }

        public RemoteFiles(string ip, string user, string pass, string workFolder)
        {
            Ip = ip;
            WorkFolder = workFolder;
            _user = user;
            _ssh = new SshUpdater(ip, user, pass, workFolder, (_, _) => Task.CompletedTask);
        }

        // ── Yol yardımcıları ─────────────────────────────────────────

        public static string Combine(string dir, string name) => dir.EndsWith('/') ? dir + name : dir + "/" + name;

        public static string Parent(string path)
        {
            var p = path.TrimEnd('/');
            int i = p.LastIndexOf('/');
            return i <= 0 ? "/" : p[..i];
        }

        /// <summary>"/", "/etc", "/home" gibi kök ya da tek düzeyli klasörler silinemez / taşınamaz (güvenlik).</summary>
        public static bool IsProtected(string path)
        {
            var p = path.Trim().TrimEnd('/');
            return p.Length == 0 || p.Count(c => c == '/') <= 1;
        }

        /// <summary>Kabukta tek tırnaklı argüman.</summary>
        public static string Q(string s) => "'" + s.Replace("'", "'\\''") + "'";

        // ── İşlemler ─────────────────────────────────────────────────

        /// <summary>Klasörün içeriği: klasörler önde, ada göre. "." ve ".." yok.</summary>
        public Task<List<RemoteEntry>> ListAsync(string path, CancellationToken ct) => RunAsync(async (client, sftp) =>
        {
            List<RemoteEntry> list;
            try
            {
                list = await Task.Run(() => sftp.ListDirectory(path).Where(f => f.Name is not ("." or "..")).Select(f => FromSftp(sftp, f)).ToList(), ct);
            }
            catch (SftpPermissionDeniedException)
            {
                // Okuma izni yok (ör. /root): sudo ile find
                var (ok, so, se) = await _ssh.ExecuteSudoGetOutputAsync(client,
                    $"find {Q(path)} -mindepth 1 -maxdepth 1 -printf '%y|%Y|%s|%T@|%M|%f\\n'", Ip, ct, 30);
                if (!ok) throw new InvalidOperationException(Explain(se));
                list = so.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => FromFind(path, l)).OfType<RemoteEntry>().ToList();
            }
            catch (SftpPathNotFoundException) { throw new InvalidOperationException($"Klasör bulunamadı: {path}"); }
            return list.OrderByDescending(e => e.IsDir).ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase).ToList();
        }, ct);

        /// <summary>Yolun klasör olup olmadığı (yol kutusuna yazılan için). Yoksa null.</summary>
        public Task<bool?> IsDirectoryAsync(string path, CancellationToken ct) => RunAsync(async (client, sftp) =>
        {
            try { return (bool?)await Task.Run(() => sftp.Get(path).IsDirectory, ct); }
            catch (SftpPathNotFoundException) { return null; }
            catch (SftpPermissionDeniedException)
            {
                var (_, so, _) = await _ssh.ExecuteSudoGetOutputAsync(client, $"if [ -d {Q(path)} ]; then echo D; elif [ -e {Q(path)} ]; then echo F; fi", Ip, ct, 15);
                return so.Trim() switch { "D" => true, "F" => false, _ => (bool?)null };
            }
        }, ct);

        public Task DeleteAsync(IReadOnlyList<string> paths, CancellationToken ct) => RunAsync(async (client, _) =>
        {
            foreach (var p in paths)
                if (IsProtected(p)) throw new InvalidOperationException($"{p} korumalı bir klasör, silinemez.");
            await ShellAsync(client, "rm -rf -- " + string.Join(" ", paths.Select(Q)), ct);
            return true;
        }, ct);

        public Task CreateFolderAsync(string path, CancellationToken ct) => RunAsync(async (client, _) =>
        {
            await ShellAsync(client, $"if [ -e {Q(path)} ]; then echo 'Bu adda bir öğe zaten var.' >&2; exit 3; fi; mkdir -- {Q(path)}", ct);
            return true;
        }, ct);

        public Task RenameAsync(string from, string to, CancellationToken ct) => RunAsync(async (client, _) =>
        {
            if (IsProtected(from)) throw new InvalidOperationException($"{from} korumalı bir klasör, adı değiştirilemez.");
            await ShellAsync(client, $"if [ -e {Q(to)} ]; then echo 'Bu adda bir öğe zaten var.' >&2; exit 3; fi; mv -- {Q(from)} {Q(to)}", ct);
            return true;
        }, ct);

        /// <summary>Hedef klasörde bu adlar var mı (yükleme öncesi üzerine yazma sorusu için).</summary>
        public Task<List<string>> ExistingAsync(string dir, IEnumerable<string> names, CancellationToken ct) => RunAsync(async (_, sftp) =>
        {
            var found = new List<string>();
            foreach (var n in names)
                if (await Task.Run(() => { try { return sftp.Exists(Combine(dir, n)); } catch (SftpPermissionDeniedException) { return false; } }, ct))
                    found.Add(n);
            return found;
        }, ct);

        /// <summary>
        /// Bilgisayardaki dosya / klasörleri uzak klasöre yükler (var olanın üzerine yazar). Yazma izni yoksa önce
        /// /tmp altına yüklenir, sonra sudo ile kopyalanır.
        /// </summary>
        public Task UploadAsync(IReadOnlyList<string> localPaths, string remoteDir, IProgress<string>? progress, CancellationToken ct) => RunAsync(async (client, sftp) =>
        {
            try
            {
                foreach (var lp in localPaths) await UploadOneAsync(sftp, lp, remoteDir, progress, ct);
            }
            catch (SftpPermissionDeniedException)
            {
                string tmp = $"/tmp/rbx-upload-{Guid.NewGuid():N}";
                await Task.Run(() => sftp.CreateDirectory(tmp), ct);
                try
                {
                    foreach (var lp in localPaths) await UploadOneAsync(sftp, lp, tmp, progress, ct);
                    progress?.Report("sudo ile kopyalanıyor…");
                    var (ok, _, se) = await _ssh.ExecuteSudoGetOutputAsync(client,
                        $"cp -rf --no-preserve=ownership {Q(tmp)}/. {Q(remoteDir)}/", Ip, ct, 120);
                    if (!ok) throw new InvalidOperationException(Explain(se));
                }
                finally
                {
                    await Task.Run(() => { try { using var c = client.CreateCommand($"rm -rf -- {Q(tmp)}"); c.Execute(); } catch { /* ignore */ } });
                }
            }
            return true;
        }, ct);

        private static async Task UploadOneAsync(SftpClient sftp, string localPath, string remoteDir, IProgress<string>? progress, CancellationToken ct)
        {
            string name = Path.GetFileName(localPath.TrimEnd('\\', '/'));
            string target = Combine(remoteDir, name);
            if (Directory.Exists(localPath))
            {
                await Task.Run(() => { if (!sftp.Exists(target)) sftp.CreateDirectory(target); }, ct);
                foreach (var e in Directory.EnumerateFileSystemEntries(localPath))
                    await UploadOneAsync(sftp, e, target, progress, ct);
                return;
            }
            long total = new FileInfo(localPath).Length;
            await Task.Run(() =>
            {
                using var fs = File.OpenRead(localPath);
                sftp.UploadFile(fs, target, true, done =>
                {
                    ct.ThrowIfCancellationRequested();
                    progress?.Report(Percent(name, (long)done, total));
                });
            }, ct);
        }

        /// <summary>
        /// Uzak dosya / klasörleri bilgisayardaki klasöre indirir. Okuma izni olmayan öğe (ör. root'a ait)
        /// sudo ile /tmp'ye kopyalanıp oradan indirilir.
        /// </summary>
        public Task DownloadAsync(IReadOnlyList<RemoteEntry> entries, string localDir, IProgress<string>? progress, CancellationToken ct) => RunAsync(async (client, sftp) =>
        {
            foreach (var e in entries) await DownloadOneAsync(client, sftp, e.FullPath, e.IsDir, localDir, progress, ct);
            return true;
        }, ct);

        private async Task DownloadOneAsync(SshClient client, SftpClient sftp, string remote, bool isDir, string localDir, IProgress<string>? progress, CancellationToken ct)
        {
            string trimmed = remote.TrimEnd('/');
            string name = trimmed[(trimmed.LastIndexOf('/') + 1)..];
            string target = Path.Combine(localDir, SafeLocalName(name));
            if (isDir)
            {
                Directory.CreateDirectory(target);
                List<ISftpFile> items;
                try { items = await Task.Run(() => sftp.ListDirectory(remote).Where(f => f.Name is not ("." or "..")).ToList(), ct); }
                catch (SftpPermissionDeniedException) { await SudoDownloadAsync(client, sftp, remote, true, target, progress, ct); return; }
                foreach (var f in items) await DownloadOneAsync(client, sftp, f.FullName, f.IsDirectory, target, progress, ct);
                return;
            }
            try { await DownloadFileAsync(sftp, remote, target, name, progress, ct); }
            catch (SftpPermissionDeniedException) { await SudoDownloadAsync(client, sftp, remote, false, target, progress, ct); }
        }

        private async Task SudoDownloadAsync(SshClient client, SftpClient sftp, string remote, bool isDir, string target, IProgress<string>? progress, CancellationToken ct)
        {
            string tmp = $"/tmp/rbx-dl-{Guid.NewGuid():N}";
            var (ok, _, se) = await _ssh.ExecuteSudoGetOutputAsync(client,
                $"cp -rL -- {Q(remote)} {Q(tmp)} && chown -R {Q(_user)} {Q(tmp)} && chmod -R u+rwX {Q(tmp)}", Ip, ct, 120);
            if (!ok) throw new InvalidOperationException(Explain(se));
            try
            {
                if (isDir)
                {
                    var items = await Task.Run(() => sftp.ListDirectory(tmp).Where(f => f.Name is not ("." or "..")).ToList(), ct);
                    foreach (var f in items) await DownloadOneAsync(client, sftp, f.FullName, f.IsDirectory, target, progress, ct);
                }
                else await DownloadFileAsync(sftp, tmp, target, Path.GetFileName(target), progress, ct);
            }
            finally
            {
                await Task.Run(() => { try { using var c = client.CreateCommand($"rm -rf -- {Q(tmp)}"); c.Execute(); } catch { /* ignore */ } });
            }
        }

        private static Task DownloadFileAsync(SftpClient sftp, string remote, string target, string name, IProgress<string>? progress, CancellationToken ct) => Task.Run(() =>
        {
            long total = sftp.GetAttributes(remote).Size;
            string part = target + ".part";
            try
            {
                using (var fs = File.Create(part))
                    sftp.DownloadFile(remote, fs, done =>
                    {
                        ct.ThrowIfCancellationRequested();
                        progress?.Report(Percent(name, (long)done, total));
                    });
                File.Move(part, target, true);
            }
            catch
            {
                try { File.Delete(part); } catch { /* ignore */ }
                throw;
            }
        }, ct);

        // ── Yardımcılar ──────────────────────────────────────────────

        private static string Percent(string name, long done, long total) =>
            total > 0 ? $"{name} · %{Math.Min(100, done * 100 / total)}" : name;

        private static string SafeLocalName(string name)
        {
            foreach (var c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
            return name.Length == 0 ? "_" : name;
        }

        private static RemoteEntry FromSftp(SftpClient sftp, ISftpFile f)
        {
            bool isDir = f.IsDirectory, isLink = f.IsSymbolicLink;
            if (isLink)
            {
                try { isDir = sftp.Get(f.FullName).IsDirectory; } catch { /* kırık bağlantı */ }
            }
            return new RemoteEntry
            {
                Name = f.Name, FullPath = f.FullName, IsDir = isDir, IsLink = isLink, Size = f.Length,
                Modified = f.LastWriteTime, Perms = PermString(f, isLink),
            };
        }

        private static string PermString(ISftpFile f, bool isLink)
        {
            var sb = new StringBuilder(10);
            sb.Append(isLink ? 'l' : f.IsDirectory ? 'd' : '-');
            sb.Append(f.OwnerCanRead ? 'r' : '-').Append(f.OwnerCanWrite ? 'w' : '-').Append(f.OwnerCanExecute ? 'x' : '-');
            sb.Append(f.GroupCanRead ? 'r' : '-').Append(f.GroupCanWrite ? 'w' : '-').Append(f.GroupCanExecute ? 'x' : '-');
            sb.Append(f.OthersCanRead ? 'r' : '-').Append(f.OthersCanWrite ? 'w' : '-').Append(f.OthersCanExecute ? 'x' : '-');
            return sb.ToString();
        }

        /// <summary>find -printf '%y|%Y|%s|%T@|%M|%f' satırı.</summary>
        private static RemoteEntry? FromFind(string dir, string line)
        {
            var p = line.Split('|', 6);
            if (p.Length < 6) return null;
            double.TryParse(p[3], NumberStyles.Float, CultureInfo.InvariantCulture, out double t);
            return new RemoteEntry
            {
                Name = p[5], FullPath = Combine(dir, p[5]), IsLink = p[0] == "l", IsDir = p[1] == "d",
                Size = long.TryParse(p[2], out long s) ? s : 0,
                Modified = t > 0 ? DateTimeOffset.FromUnixTimeMilliseconds((long)(t * 1000)).LocalDateTime : default,
                Perms = p[4],
            };
        }

        /// <summary>Komutu SSH kullanıcısı olarak çalıştırır; yetki hatasında sudo ile yeniden dener.</summary>
        private async Task ShellAsync(SshClient client, string command, CancellationToken ct)
        {
            var (code, err) = await Task.Run(() =>
            {
                using var c = client.CreateCommand(command);
                c.CommandTimeout = TimeSpan.FromSeconds(60);
                c.Execute();
                return (c.ExitStatus ?? -1, c.Error ?? "");
            }, ct);
            if (code == 0) return;
            if (!err.Contains("Permission denied") && !err.Contains("Operation not permitted"))
                throw new InvalidOperationException(Explain(err));
            var (ok, _, se) = await _ssh.ExecuteSudoGetOutputAsync(client, command, Ip, ct, 60);
            if (!ok) throw new InvalidOperationException(Explain(se));
        }

        private string Explain(string err)
        {
            err = _ssh.Redact(err).Trim();
            if (err.Contains("incorrect password") || err.Contains("Sorry, try again")) return "sudo şifresi hatalı.";
            if (err.Contains("No such file")) return "Dosya ya da klasör bulunamadı.";
            if (err.Contains("No space left")) return "Cihazda yer kalmadı.";
            if (err.Length > 300) err = "…" + err[^300..];
            return err.Length > 0 ? err : "İşlem başarısız.";
        }

        private async Task<T> RunAsync<T>(Func<SshClient, SftpClient, Task<T>> work, CancellationToken ct)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            await _gate.WaitAsync(ct);
            try
            {
                if (_client is not { IsConnected: true } || _sftp is not { IsConnected: true })
                {
                    try { _sftp?.Dispose(); } catch { /* ignore */ }
                    try { _client?.Dispose(); } catch { /* ignore */ }
                    _sftp = null; _client = null;
                    try
                    {
                        _client = await _ssh.ConnectAsync(ct, 5);
                        var sftp = new SftpClient(_client.ConnectionInfo);
                        await sftp.ConnectAsync(ct);
                        _sftp = sftp;
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        throw new InvalidOperationException(ex switch
                        {
                            SshAuthenticationException => "SSH kullanıcı adı / şifresi kabul edilmedi.",
                            SshOperationTimeoutException or System.Net.Sockets.SocketException or TimeoutException
                                => "Cihaza ulaşılamıyor (SSH bağlantısı zaman aşımına uğradı).",
                            _ => "SSH bağlanamadı: " + _ssh.Redact(ex.Message),
                        }, ex);
                    }
                }
                return await work(_client!, _sftp!);
            }
            catch (SshConnectionException ex) { throw new InvalidOperationException("Bağlantı koptu: " + _ssh.Redact(ex.Message), ex); }
            finally
            {
                _gate.Release();
            }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try { _sftp?.Dispose(); } catch { /* ignore */ }
            try { _client?.Dispose(); } catch { /* ignore */ }
            _ssh.CleanupTempFolder();
        }
    }
}
