using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;

namespace RboxAgent.Modules.Tcp
{
    // NOT: Bu dosya WPF (RboxTools/Modules/Tcp) ile web ajanında (RboxWeb/agent/Modules/Tcp) aynıdır;
    // yalnızca namespace farklıdır. Birinde değişiklik yapınca diğerine de kopyalayın.

    /// <summary>Ekran satırının türü: bilgi, bağlantı geldi, bağlantı kapandı, veri, hata.</summary>
    public enum TcpLineKind { Info, Connect, Disconnect, Data, Error }

    /// <summary>
    /// Ekrana yazılacak bir olay. Veri satırında <see cref="Text"/> okunur metin (kontrol karakterleri &lt;VT&gt; gibi),
    /// <see cref="Hex"/> onaltılık döküm; diğer satırlarda Hex boştur.
    /// </summary>
    public sealed record TcpLine(long Seq, DateTime Time, string Remote, TcpLineKind Kind, string Text, string Hex, int Bytes);

    /// <summary>
    /// Bir TCP portunu dinler; gelen bağlantıları kabul edip gönderilen veriyi satır olarak (<see cref="Line"/>) bildirir.
    /// Karşı tarafa hiçbir şey göndermez. Durdurulunca dinleme ve açık bağlantıların hepsi kapanır.
    /// </summary>
    public sealed class TcpListenSession
    {
        public const int MaxClients = 64;
        private const int BufferSize = 8192;

        private readonly object _gate = new();
        private readonly HashSet<TcpClient> _clients = new();
        private TcpListener? _listener;
        private long _seq;
        private int _active;
        private int _total;
        private long _bytes;

        public TcpListenSession(int port, IPAddress bind)
        {
            Port = port;
            Bind = bind;
        }

        public int Port { get; }
        public IPAddress Bind { get; }
        public bool Running { get; private set; }
        public int ActiveConnections => Volatile.Read(ref _active);
        public int TotalConnections => Volatile.Read(ref _total);
        public long BytesReceived => Interlocked.Read(ref _bytes);

        /// <summary>Ekranda görünen dinleme adresi: "0.0.0.0:5000" ya da "172.16.154.10:5000".</summary>
        public string Endpoint => $"{Bind}:{Port}";

        public event Action<TcpLine>? Line;

        private void Emit(TcpLineKind kind, string remote, string text, string hex = "", int bytes = 0) =>
            Line?.Invoke(new TcpLine(Interlocked.Increment(ref _seq), DateTime.Now, remote, kind, text, hex, bytes));

        /// <summary>
        /// Portu açar. Açılamazsa (port kullanımda, izin yok) Türkçe hata metni döner ve dinleme başlamaz;
        /// açılırsa null döner, ardından <see cref="RunAsync"/> çağrılmalıdır.
        /// </summary>
        public string? TryStart()
        {
            if (Port is < 1 or > 65535) return "Port 1 ile 65535 arasında olmalı.";
            var l = new TcpListener(Bind, Port);
            // Aynı portu başka bir uygulama "paylaşımlı" açmış olsa bile ikinci dinleyici sessizce açılmasın
            l.ExclusiveAddressUse = true;
            try
            {
                l.Start(MaxClients);
            }
            catch (SocketException ex)
            {
                return ex.SocketErrorCode switch
                {
                    SocketError.AddressAlreadyInUse =>
                        $"{Port} portu başka bir uygulama tarafından kullanılıyor. Hangi uygulama olduğunu Port Kontrol'de görebilirsiniz.",
                    SocketError.AccessDenied =>
                        $"{Port} portu açılamadı: erişim reddedildi (port Windows tarafından ayrılmış ya da başka bir uygulama özel kullanıyor).",
                    SocketError.AddressNotAvailable => $"{Bind} adresi bu bilgisayarda yok.",
                    _ => $"{Port} portu açılamadı: {ex.Message}",
                };
            }
            _listener = l;
            Running = true;
            Emit(TcpLineKind.Info, "", $"{Endpoint} dinleniyor. Bağlantı bekleniyor…");
            return null;
        }

        /// <summary>İptal edilene kadar bağlantı kabul eder; iptalde her şeyi kapatıp "Durduruldu" yazar (istisna fırlatmaz).</summary>
        public async Task RunAsync(CancellationToken ct)
        {
            var listener = _listener ?? throw new InvalidOperationException("Önce TryStart çağrılmalı.");
            using var reg = ct.Register(() =>
            {
                try { listener.Stop(); } catch { }
                lock (_gate) foreach (var c in _clients) try { c.Close(); } catch { }
            });

            var readers = new List<Task>();
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    TcpClient client;
                    try { client = await listener.AcceptTcpClientAsync(ct); }
                    catch (OperationCanceledException) { break; }
                    catch (ObjectDisposedException) { break; }
                    catch (SocketException) when (ct.IsCancellationRequested) { break; }
                    catch (SocketException ex)
                    {
                        Emit(TcpLineKind.Error, "", "Bağlantı kabul edilemedi: " + ex.Message);
                        continue;
                    }

                    string remote = client.Client.RemoteEndPoint is IPEndPoint ep ? Format(ep) : "?";
                    lock (_gate)
                    {
                        if (_clients.Count >= MaxClients)
                        {
                            Emit(TcpLineKind.Error, remote, $"Bağlantı reddedildi: aynı anda en fazla {MaxClients} bağlantı.");
                            client.Close();
                            continue;
                        }
                        _clients.Add(client);
                    }
                    Interlocked.Increment(ref _active);
                    Interlocked.Increment(ref _total);
                    Emit(TcpLineKind.Connect, remote, $"Bağlandı ({ActiveConnections} açık bağlantı)");
                    readers.RemoveAll(t => t.IsCompleted);
                    readers.Add(ReadClientAsync(client, remote, ct));
                }
            }
            finally
            {
                try { listener.Stop(); } catch { }
                lock (_gate) foreach (var c in _clients) try { c.Close(); } catch { }
                try { await Task.WhenAll(readers); } catch { }
                Emit(TcpLineKind.Info, "", $"Durduruldu. Toplam {TotalConnections} bağlantı, {FormatBytes(BytesReceived)} alındı.");
                // Son satırdan sonra: "durdu" görüldüğünde son satır kesin yayımlanmış olur
                Running = false;
            }
        }

        private async Task ReadClientAsync(TcpClient client, string remote, CancellationToken ct)
        {
            long got = 0;
            string reason = "Bağlantı kapandı";
            // Bölünmüş çok baytlı UTF-8 karakterleri parçalar arasında doğru birleşsin diye bağlantı başına bir çözücü
            var decoder = new UTF8Encoding(false, false).GetDecoder();
            var buf = new byte[BufferSize];
            var chars = new char[BufferSize + 8];
            try
            {
                using var stream = client.GetStream();
                while (true)
                {
                    int n = await stream.ReadAsync(buf, ct);
                    if (n == 0) { reason = "Karşı taraf bağlantıyı kapattı"; break; }
                    got += n;
                    Interlocked.Add(ref _bytes, n);
                    int cn = decoder.GetChars(buf, 0, n, chars, 0, flush: false);
                    Emit(TcpLineKind.Data, remote, Printable(chars, cn), HexDump(buf, n), n);
                }
            }
            catch (OperationCanceledException) { reason = "Dinleme durduruldu"; }
            catch (Exception) when (ct.IsCancellationRequested) { reason = "Dinleme durduruldu"; }
            catch (IOException ex) when (ex.InnerException is SocketException se)
            {
                reason = se.SocketErrorCode == SocketError.ConnectionReset ? "Bağlantı karşı taraftan kesildi" : "Bağlantı hatası: " + se.Message;
            }
            catch (Exception ex) { reason = "Bağlantı hatası: " + ex.Message; }
            finally
            {
                lock (_gate) _clients.Remove(client);
                try { client.Close(); } catch { }
                Interlocked.Decrement(ref _active);
                Emit(TcpLineKind.Disconnect, remote, $"{reason} ({FormatBytes(got)} alındı, {ActiveConnections} açık bağlantı)");
            }
        }

        // ── Biçimlendirme ────────────────────────────────────────────────────

        private static readonly string[] CtrlNames =
        {
            "NUL", "SOH", "STX", "ETX", "EOT", "ENQ", "ACK", "BEL", "BS", "TAB", "LF", "VT", "FF", "CR", "SO", "SI",
            "DLE", "DC1", "DC2", "DC3", "DC4", "NAK", "SYN", "ETB", "CAN", "EM", "SUB", "ESC", "FS", "GS", "RS", "US",
        };

        /// <summary>
        /// Okunur metin: satır sonları (CR, LF, CRLF) alt satıra geçer, sekme korunur, diğer kontrol karakterleri
        /// &lt;VT&gt; &lt;FS&gt; &lt;STX&gt; gibi adıyla yazılır (HL7 / MLLP çerçeveleri görünsün).
        /// </summary>
        public static string Printable(char[] chars, int count)
        {
            var sb = new StringBuilder(count + 16);
            for (int i = 0; i < count; i++)
            {
                char c = chars[i];
                if (c == '\r')
                {
                    sb.Append('\n');
                    if (i + 1 < count && chars[i + 1] == '\n') i++;
                }
                else if (c == '\n' || c == '\t') sb.Append(c);
                else if (c < 0x20) sb.Append('<').Append(CtrlNames[c]).Append('>');
                else if (c == 0x7F) sb.Append("<DEL>");
                else sb.Append(c);
            }
            // Parçanın sonundaki tek satır sonu ekranda boş satır bırakmasın
            if (sb.Length > 0 && sb[^1] == '\n') sb.Length--;
            return sb.ToString();
        }

        /// <summary>Satır başına 16 bayt: "0000  0B 4D 53 48 …  .MSH…" biçiminde onaltılık döküm.</summary>
        public static string HexDump(byte[] data, int count)
        {
            var sb = new StringBuilder(count * 4 + 16);
            for (int off = 0; off < count; off += 16)
            {
                if (off > 0) sb.Append('\n');
                int n = Math.Min(16, count - off);
                sb.Append(off.ToString("X4")).Append("  ");
                for (int i = 0; i < 16; i++)
                {
                    if (i < n) sb.Append(data[off + i].ToString("X2")).Append(' ');
                    else sb.Append("   ");
                    if (i == 7) sb.Append(' ');
                }
                sb.Append(' ');
                for (int i = 0; i < n; i++)
                {
                    byte b = data[off + i];
                    sb.Append(b is >= 0x20 and < 0x7F ? (char)b : '.');
                }
            }
            return sb.ToString();
        }

        public static string FormatBytes(long n) => n switch
        {
            < 1024 => $"{n} bayt",
            < 1024 * 1024 => $"{n / 1024.0:0.#} KB",
            _ => $"{n / (1024.0 * 1024):0.#} MB",
        };

        private static string Format(IPEndPoint ep)
        {
            var a = ep.Address.IsIPv4MappedToIPv6 ? ep.Address.MapToIPv4() : ep.Address;
            return $"{a}:{ep.Port}";
        }

        /// <summary>Dinlenebilecek adresler: önce "0.0.0.0" (tüm ağ kartları), sonra bu bilgisayarın IPv4 adresleri.</summary>
        public static IReadOnlyList<(string Address, string Label)> LocalAddresses()
        {
            var list = new List<(string, string)> { ("0.0.0.0", "Tüm ağ kartları (0.0.0.0)") };
            try
            {
                foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (nic.OperationalStatus != OperationalStatus.Up) continue;
                    foreach (var ua in nic.GetIPProperties().UnicastAddresses)
                    {
                        if (ua.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                        string ip = ua.Address.ToString();
                        if (list.Any(x => x.Item1 == ip)) continue;
                        list.Add((ip, IPAddress.IsLoopback(ua.Address) ? $"{ip} (yalnızca bu bilgisayar)" : $"{ip} · {nic.Name}"));
                    }
                }
            }
            catch (NetworkInformationException) { }
            return list;
        }

        /// <summary>Kullanıcının seçtiği / yazdığı adres; boş ya da geçersizse tüm ağ kartları.</summary>
        public static IPAddress ParseBind(string? text) =>
            IPAddress.TryParse((text ?? "").Trim(), out var ip) && ip.AddressFamily == AddressFamily.InterNetwork ? ip : IPAddress.Any;
    }
}
