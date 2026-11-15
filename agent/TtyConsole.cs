using System.Text;
using Renci.SshNet;
using RboxAgent.Modules.Update.Services;

namespace RboxAgent
{
    // NOT: Bu dosya WPF (RboxTools/Common) ile web ajanında (RboxWeb/agent) aynıdır; yalnızca namespace farklıdır.

    /// <summary>Bir sanal konsolun (tty1, tty2…) anlık görüntüsü.</summary>
    public sealed class TtyFrame
    {
        public int Tty { get; init; }
        public int Rows { get; init; }
        public int Cols { get; init; }
        public int CursorX { get; init; }
        public int CursorY { get; init; }
        /// <summary>Cihazın monitöründe o an görünen konsol (tty0/active), ör. 1. Bilinmiyorsa 0.</summary>
        public int ActiveTty { get; init; }
        /// <summary>Satır başına <see cref="Cols"/> karakter.</summary>
        public string[] Lines { get; init; } = Array.Empty<string>();
        /// <summary>Hücre başına VGA öznitelik baytı (Rows*Cols): bit 0-3 yazı rengi (3 = parlak), 4-6 zemin, 7 yanıp sönme.</summary>
        public byte[] Attrs { get; init; } = Array.Empty<byte>();
    }

    /// <summary>
    /// RasyoBOX cihazındaki sanal konsolu SSH üzerinden okur ve ona tuş gönderir.
    /// Okuma: /dev/vcsa&lt;n&gt; (boyut, imleç, renkler) + /dev/vcsu&lt;n&gt; (Unicode karakterler; yoksa vcsa'daki bayt).
    /// Yazma: TIOCSTI ile konsolun giriş kuyruğuna tuş koyar; klavyeden basılmış gibi işlenir (bash bind kısayolları dahil).
    /// Root (CAP_SYS_ADMIN) olarak çalıştığı için yeni kernel'lerdeki dev.tty.legacy_tiocsti=0 ayarı engel olmaz;
    /// monitörde görünen konsol değişmez. İkisi de sudo ister; cihazda python3 gerekir (Raspberry Pi OS'ta hazır).
    /// Tek SSH bağlantısı açık tutulur; çağrılar sıraya girer.
    /// </summary>
    public sealed class TtyConsole : IDisposable
    {
        private const string ReadPy = """
            import sys,base64,struct
            n=int(sys.argv[1])
            a=open('/dev/vcsa%d'%n,'rb').read()
            r,c,x,y=a[0],a[1],a[2],a[3]
            k=r*c
            ok=lambda v:(32<=v<127) or (160<=v<0xD800) or (0xE000<=v<0x10000)
            try:
                u=open('/dev/vcsu%d'%n,'rb').read()
                t=''.join(chr(v) if ok(v) else ' ' for v in struct.unpack('=%dI'%(len(u)//4),u)[:k])
            except Exception:
                t=''.join(chr(b) if 32<=b<127 else ' ' for b in a[4::2][:k])
            try: act=open('/sys/class/tty/tty0/active').read().strip()
            except Exception: act=''
            print(r,c,x,y,act)
            print(base64.b64encode(t.encode('utf-8')).decode())
            print(base64.b64encode(a[5::2][:k]).decode())
            """;

        private const string SendPy = """
            import sys,os,fcntl,termios,base64
            n=int(sys.argv[1]); d=base64.b64decode(sys.argv[2])
            fd=os.open('/dev/tty%d'%n,os.O_RDWR|os.O_NOCTTY)
            try:
                for i in range(len(d)): fcntl.ioctl(fd,termios.TIOCSTI,d[i:i+1])
            finally: os.close(fd)
            """;

        private static readonly string ReadB64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(ReadPy.Replace("\r", "")));
        private static readonly string SendB64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(SendPy.Replace("\r", "")));

        private readonly SshUpdater _ssh;
        private readonly SemaphoreSlim _gate = new(1, 1);
        private SshClient? _client;
        private bool _disposed;

        public string Ip { get; }
        public DateTime LastUsed { get; private set; } = DateTime.UtcNow;

        public TtyConsole(string ip, string user, string pass, string workFolder)
        {
            Ip = ip;
            _ssh = new SshUpdater(ip, user, pass, workFolder, (_, _) => Task.CompletedTask);
        }

        public async Task<TtyFrame> ReadAsync(int tty, CancellationToken ct = default)
        {
            CheckTty(tty);
            var output = await RunAsync($"echo {ReadB64} | base64 -d | python3 - {tty}", ct);
            var rows = output.Replace("\r", "").Split('\n', StringSplitOptions.RemoveEmptyEntries);
            if (rows.Length < 3) throw new InvalidOperationException("Konsol okunamadı (beklenmeyen çıktı).");
            var head = rows[^3].Split(' ', StringSplitOptions.RemoveEmptyEntries);
            int r = int.Parse(head[0]), c = int.Parse(head[1]);
            int active = head.Length > 4 && head[4].StartsWith("tty") && int.TryParse(head[4][3..], out var a) ? a : 0;
            var text = Encoding.UTF8.GetString(Convert.FromBase64String(rows[^2]));
            var attrs = Convert.FromBase64String(rows[^1]);
            var lines = new string[r];
            for (int i = 0; i < r; i++)
            {
                int start = i * c;
                lines[i] = start >= text.Length ? new string(' ', c)
                    : text.Substring(start, Math.Min(c, text.Length - start)).PadRight(c);
            }
            return new TtyFrame
            {
                Tty = tty, Rows = r, Cols = c, CursorX = int.Parse(head[2]), CursorY = int.Parse(head[3]),
                ActiveTty = active, Lines = lines, Attrs = attrs,
            };
        }

        /// <summary>Baytları konsolun girişine koyar (ör. "ls\r", Alt+R = ESC 'r').</summary>
        public async Task SendAsync(int tty, byte[] data, CancellationToken ct = default)
        {
            CheckTty(tty);
            if (data.Length == 0) return;
            if (data.Length > 4096) throw new ArgumentException("En fazla 4096 bayt gönderilebilir.");
            await RunAsync($"echo {SendB64} | base64 -d | python3 - {tty} {Convert.ToBase64String(data)}", ct);
        }

        private static void CheckTty(int tty)
        {
            if (tty < 1 || tty > 12) throw new ArgumentOutOfRangeException(nameof(tty), "tty 1-12 olmalı.");
        }

        private async Task<string> RunAsync(string command, CancellationToken ct)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            await _gate.WaitAsync(ct);
            try
            {
                LastUsed = DateTime.UtcNow;
                if (_client is not { IsConnected: true })
                {
                    _client?.Dispose();
                    _client = null;
                    try { _client = await _ssh.ConnectAsync(ct, 5); }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        throw new InvalidOperationException(ex switch
                        {
                            Renci.SshNet.Common.SshAuthenticationException => "SSH kullanıcı adı / şifresi kabul edilmedi.",
                            Renci.SshNet.Common.SshOperationTimeoutException or System.Net.Sockets.SocketException or TimeoutException
                                => "Cihaza ulaşılamıyor (SSH bağlantısı zaman aşımına uğradı).",
                            _ => "SSH bağlanamadı: " + _ssh.Redact(ex.Message),
                        }, ex);
                    }
                    if (!_client.IsConnected) throw new InvalidOperationException("SSH bağlanamadı.");
                }
                var (ok, stdout, stderr) = await _ssh.ExecuteSudoGetOutputAsync(_client, command, Ip, ct, 15);
                if (!ok) throw new InvalidOperationException(Explain(_ssh.Redact(stderr).Trim()));
                return stdout;
            }
            catch (Exception) when (_client is { IsConnected: false })
            {
                _client.Dispose();
                _client = null;
                throw;
            }
            finally
            {
                _gate.Release();
            }
        }

        private static string Explain(string err)
        {
            if (err.Contains("python3: command not found") || err.Contains("python3: not found")) return "Cihazda python3 yok.";
            if (err.Contains("Input/output error") || err.Contains("Errno 5")) return "Kernel konsola tuş göndermeye izin vermedi (TIOCSTI).";
            if (err.Contains("No such file") && err.Contains("/dev/")) return "Bu konsol cihazda yok.";
            if (err.Contains("incorrect password") || err.Contains("Sorry, try again")) return "sudo şifresi hatalı.";
            if (err.Length > 300) err = "…" + err[^300..];
            return err.Length > 0 ? err : "Komut başarısız.";
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try { _client?.Dispose(); } catch { /* ignore */ }
            _ssh.CleanupTempFolder();
        }
    }
}
