using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace RboxAgent.Modules.Tcp
{
    // NOT: Bu dosya WPF (RboxTools/Modules/Tcp) ile web ajanında (RboxWeb/agent/Modules/Tcp) aynıdır;
    // yalnızca namespace farklıdır. Birinde değişiklik yapınca diğerine de kopyalayın.

    /// <summary>Ekran satırının türü: bilgi, bağlantı açıldı, bağlantı kapandı, veri, hata.</summary>
    public enum TcpLineKind { Info, Connect, Disconnect, Data, Error }

    /// <summary>Gelen veriden çıkarılan bir JSON değeri: biçimlendirilmiş metin ya da (geçersizse) ham metin + hata.</summary>
    public sealed record TcpJson(string Text, string? Error);

    /// <summary>
    /// Ekrana yazılacak bir olay. Veri satırında <see cref="Text"/> okunur metin (kontrol karakterleri &lt;VT&gt; gibi),
    /// <see cref="Hex"/> onaltılık döküm; <see cref="Json"/> bu parçayla tamamlanan JSON değerleri (yoksa null).
    /// </summary>
    public sealed record TcpLine(long Seq, DateTime Time, string Remote, TcpLineKind Kind, string Text, string Hex, int Bytes,
        IReadOnlyList<TcpJson>? Json = null);

    /// <summary>
    /// TCP oturumu (dinleyici ya da istemci). Gelen veriyi satır olarak (<see cref="Line"/>) bildirir;
    /// karşı tarafa hiçbir şey göndermez. Önce <see cref="TryStart"/>, sonra <see cref="RunAsync"/> çağrılır.
    /// </summary>
    public abstract class TcpSession
    {
        private const int BufferSize = 8192;

        private long _seq;
        protected int _active;
        protected int _total;
        private long _bytes;

        public bool Running { get; protected set; }
        public int ActiveConnections => Volatile.Read(ref _active);
        public int TotalConnections => Volatile.Read(ref _total);
        public long BytesReceived => Interlocked.Read(ref _bytes);

        /// <summary>Ekranda görünen adres: dinleyicide "0.0.0.0:5000", istemcide bağlanılan "sunucu:port".</summary>
        public abstract string Endpoint { get; }

        public event Action<TcpLine>? Line;

        /// <summary>Başlatılabilir mi? Değilse Türkçe hata metni döner (port kullanımda, adres geçersiz…).</summary>
        public abstract string? TryStart();

        /// <summary>İptal edilene kadar çalışır; iptalde her şeyi kapatıp "Durduruldu" yazar (istisna fırlatmaz).</summary>
        public abstract Task RunAsync(CancellationToken ct);

        protected void Emit(TcpLineKind kind, string remote, string text, string hex = "", int bytes = 0, IReadOnlyList<TcpJson>? json = null) =>
            Line?.Invoke(new TcpLine(Interlocked.Increment(ref _seq), DateTime.Now, remote, kind, text, hex, bytes, json));

        protected void EmitStopped() =>
            Emit(TcpLineKind.Info, "", $"Durduruldu. Toplam {TotalConnections} bağlantı, {FormatBytes(BytesReceived)} alındı.");

        /// <summary>
        /// Bağlantı kapanana kadar okur ve her parçayı veri satırı olarak yayımlar. Kapanış nedenini, alınan bayt
        /// sayısını ve yarım kalmış JSON (varsa) bilgisini döner.
        /// </summary>
        protected async Task<(string Reason, long Got, TcpJson? Tail)> ReadLoopAsync(TcpClient client, string remote, CancellationToken ct)
        {
            long got = 0;
            string reason = "Bağlantı kapandı";
            // Bölünmüş çok baytlı UTF-8 karakterleri parçalar arasında doğru birleşsin diye bağlantı başına bir çözücü
            var decoder = new UTF8Encoding(false, false).GetDecoder();
            var json = new JsonAssembler();
            var buf = new byte[BufferSize];
            var chars = new char[BufferSize + 8];
            try
            {
                var stream = client.GetStream();
                while (true)
                {
                    int n = await stream.ReadAsync(buf, ct);
                    if (n == 0) { reason = "Karşı taraf bağlantıyı kapattı"; break; }
                    got += n;
                    Interlocked.Add(ref _bytes, n);
                    int cn = decoder.GetChars(buf, 0, n, chars, 0, flush: false);
                    var found = json.Push(chars, cn);
                    Emit(TcpLineKind.Data, remote, Printable(chars, cn), HexDump(buf, n), n, found);
                }
            }
            catch (OperationCanceledException) { reason = "Durduruldu"; }
            catch (Exception) when (ct.IsCancellationRequested) { reason = "Durduruldu"; }
            catch (IOException ex) when (ex.InnerException is SocketException se)
            {
                reason = se.SocketErrorCode == SocketError.ConnectionReset ? "Bağlantı karşı taraftan kesildi" : "Bağlantı hatası: " + se.Message;
            }
            catch (Exception ex) { reason = "Bağlantı hatası: " + ex.Message; }
            return (reason, got, json.Flush());
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

        protected static string Format(EndPoint? ep)
        {
            if (ep is not IPEndPoint ip) return "?";
            var a = ip.Address.IsIPv4MappedToIPv6 ? ip.Address.MapToIPv4() : ip.Address;
            return $"{a}:{ip.Port}";
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

    /// <summary>Bir TCP portunu dinler; bağlanan her cihazın gönderdiği veriyi yazar.</summary>
    public sealed class TcpListenSession : TcpSession
    {
        public const int MaxClients = 64;

        private readonly object _gate = new();
        private readonly HashSet<TcpClient> _clients = new();
        private TcpListener? _listener;

        public TcpListenSession(int port, IPAddress bind)
        {
            Port = port;
            Bind = bind;
        }

        public int Port { get; }
        public IPAddress Bind { get; }
        public override string Endpoint => $"{Bind}:{Port}";

        public override string? TryStart()
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

        public override async Task RunAsync(CancellationToken ct)
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

                    string remote = Format(client.Client.RemoteEndPoint);
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
                    readers.Add(ServeAsync(client, remote, ct));
                }
            }
            finally
            {
                try { listener.Stop(); } catch { }
                lock (_gate) foreach (var c in _clients) try { c.Close(); } catch { }
                try { await Task.WhenAll(readers); } catch { }
                EmitStopped();
                // Son satırdan sonra: "durdu" görüldüğünde son satır kesin yayımlanmış olur
                Running = false;
            }
        }

        private async Task ServeAsync(TcpClient client, string remote, CancellationToken ct)
        {
            var (reason, got, tail) = await ReadLoopAsync(client, remote, ct);
            lock (_gate) _clients.Remove(client);
            try { client.Close(); } catch { }
            Interlocked.Decrement(ref _active);
            if (reason == "Durduruldu") reason = "Dinleme durduruldu";
            Emit(TcpLineKind.Disconnect, remote, $"{reason} ({FormatBytes(got)} alındı, {ActiveConnections} açık bağlantı)",
                json: tail == null ? null : new[] { tail });
        }
    }

    /// <summary>İstemci modunda bir cihazın bağlantı durumu.</summary>
    public enum TcpHostState { Connecting, Connected, Failed }

    public sealed record TcpHostStatus(string Host, TcpHostState State, string? Error);

    /// <summary>
    /// İstemci: listedeki her cihaza (sunucu) aynı porttan aynı anda bağlanır ve gelen veriyi yazar. Bağlantı
    /// kurulamazsa ya da koparsa durdurulana kadar birkaç saniyede bir yeniden dener; aynı hata her denemede
    /// tekrar yazılmaz. Çalışırken cihaz eklenip çıkarılabilir.
    /// </summary>
    public sealed class TcpConnectSession : TcpSession
    {
        public const int ConnectTimeoutMs = 5000;
        public const int RetryDelayMs = 3000;
        public const int MaxHosts = 256;

        private sealed class HostRun
        {
            public required CancellationTokenSource Cts;
            public TcpHostState State = TcpHostState.Connecting;
            public string? Error;
            public Task? Loop;
        }

        private readonly object _gate = new();
        private readonly Dictionary<string, HostRun> _hosts = new(StringComparer.OrdinalIgnoreCase);
        private readonly List<string> _initial;
        private CancellationToken _ct;

        public TcpConnectSession(IEnumerable<string> hosts, int port)
        {
            _initial = hosts.Select(h => (h ?? "").Trim()).Where(h => h.Length > 0)
                            .Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            Port = port;
        }

        public int Port { get; }
        public int HostCount { get { lock (_gate) return _hosts.Count; } }
        public override string Endpoint => $"{HostCount} cihaz · port {Port}";

        /// <summary>Cihazların anlık bağlantı durumu (listede nokta rengi).</summary>
        public IReadOnlyList<TcpHostStatus> Hosts()
        {
            lock (_gate) return _hosts.Select(h => new TcpHostStatus(h.Key, h.Value.State, h.Value.Error)).ToList();
        }

        public override string? TryStart()
        {
            if (Port is < 1 or > 65535) return "Port 1 ile 65535 arasında olmalı.";
            if (_initial.Count == 0) return "Bağlanılacak cihaz yok. Excel yükleyin ya da listeye IP ekleyin.";
            if (_initial.Count > MaxHosts) return $"En fazla {MaxHosts} cihaza aynı anda bağlanılabilir.";
            var bad = _initial.FirstOrDefault(h => !IsValidHost(h));
            if (bad != null) return $"Geçersiz IP: {bad}";
            Running = true;
            return null;
        }

        /// <summary>Noktalı dörtlü IPv4 (ör. 172.16.154.12).</summary>
        public static bool IsValidHost(string host) =>
            IPAddress.TryParse(host, out var ip) && ip.AddressFamily == AddressFamily.InterNetwork && host.Count(c => c == '.') == 3;

        public override async Task RunAsync(CancellationToken ct)
        {
            _ct = ct;
            Emit(TcpLineKind.Info, "", $"{_initial.Count} cihaza {Port} portundan bağlanılıyor…");
            lock (_gate) foreach (var h in _initial) StartHost(h);
            try { await Task.Delay(Timeout.Infinite, ct); }
            catch (OperationCanceledException) { }
            finally
            {
                Task[] loops;
                lock (_gate) loops = _hosts.Values.Select(h => h.Loop).OfType<Task>().ToArray();
                try { await Task.WhenAll(loops); } catch { }
                EmitStopped();
                Running = false;
            }
        }

        /// <summary>Çalışırken cihaz ekler (hemen bağlanmaya başlar). Zaten varsa ya da geçersizse false.</summary>
        public bool AddHost(string host)
        {
            host = (host ?? "").Trim();
            if (!IsValidHost(host) || !Running || _ct.IsCancellationRequested) return false;
            lock (_gate)
            {
                if (_hosts.ContainsKey(host) || _hosts.Count >= MaxHosts) return false;
                StartHost(host);
            }
            return true;
        }

        /// <summary>Çalışırken cihazı çıkarır (bağlantısı kapanır).</summary>
        public bool RemoveHost(string host)
        {
            HostRun? run;
            lock (_gate)
            {
                if (!_hosts.Remove((host ?? "").Trim(), out run)) return false;
            }
            run.Cts.Cancel();
            return true;
        }

        private void StartHost(string host)   // _gate kilidi altında çağrılır
        {
            var run = new HostRun { Cts = CancellationTokenSource.CreateLinkedTokenSource(_ct) };
            _hosts[host] = run;
            run.Loop = Task.Run(() => HostLoopAsync(host, run, run.Cts.Token));
        }

        private async Task HostLoopAsync(string host, HostRun run, CancellationToken ct)
        {
            string target = $"{host}:{Port}";
            bool failureShown = false;
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    // Erişilemeyen cihaz yeniden denenirken "bağlanamadı" olarak kalır (listedeki nokta yanıp sönmesin)
                    if (run.State != TcpHostState.Failed) run.State = TcpHostState.Connecting;
                    using var client = new TcpClient();
                    string? error = null;
                    try
                    {
                        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                        timeout.CancelAfter(ConnectTimeoutMs);
                        try { await client.ConnectAsync(host, Port, timeout.Token); }
                        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                        {
                            error = $"zaman aşımı ({ConnectTimeoutMs / 1000} sn içinde yanıt yok)";
                        }
                    }
                    catch (OperationCanceledException) { break; }
                    catch (SocketException ex)
                    {
                        error = ex.SocketErrorCode switch
                        {
                            SocketError.ConnectionRefused => "bağlantı reddedildi (bu portu dinleyen yok)",
                            SocketError.HostUnreachable or SocketError.NetworkUnreachable => "adrese ulaşılamıyor",
                            SocketError.TimedOut => "zaman aşımı",
                            _ => ex.Message,
                        };
                    }
                    if (ct.IsCancellationRequested) break;

                    if (error == null)
                    {
                        failureShown = false;
                        run.State = TcpHostState.Connected;
                        run.Error = null;
                        Interlocked.Increment(ref _active);
                        Interlocked.Increment(ref _total);
                        Emit(TcpLineKind.Connect, target, "Bağlandı");
                        using (ct.Register(() => { try { client.Close(); } catch { } }))
                        {
                            var (reason, got, tail) = await ReadLoopAsync(client, target, ct);
                            Interlocked.Decrement(ref _active);
                            run.State = TcpHostState.Connecting;
                            Emit(TcpLineKind.Disconnect, target,
                                $"{reason} ({FormatBytes(got)} alındı)" + (ct.IsCancellationRequested ? "" : $"; {RetryDelayMs / 1000} sn sonra yeniden bağlanılacak"),
                                json: tail == null ? null : new[] { tail });
                        }
                        if (ct.IsCancellationRequested) break;
                    }
                    else
                    {
                        run.State = TcpHostState.Failed;
                        // Erişilemeyen cihaz her denemede ekrana yazılmasın: ilk hatada ve hata değişince bir kez
                        if (!failureShown || run.Error != error)
                            Emit(TcpLineKind.Error, target, $"Bağlanılamadı: {error}. {RetryDelayMs / 1000} sn'de bir yeniden denenecek.");
                        failureShown = true;
                        run.Error = error;
                    }

                    try { await Task.Delay(RetryDelayMs, ct); }
                    catch (OperationCanceledException) { break; }
                }
            }
            finally
            {
                // Oturum sürerken bitti: listeden çıkarıldı
                if (!_ct.IsCancellationRequested) Emit(TcpLineKind.Info, target, "Listeden çıkarıldı; bağlantı kapatıldı.");
            }
        }
    }

    /// <summary>
    /// Akan metinden JSON nesne / dizilerini ayıklar. TCP veriyi rastgele parçalara böldüğü için durum parçalar
    /// arasında korunur: bir nesne birkaç parçada gelebilir, bir parçada birkaç nesne olabilir (NDJSON, art arda).
    /// Nesne dışındaki karakterler (MLLP çerçevesi, satır sonu, düz metin) yok sayılır.
    /// </summary>
    public sealed class JsonAssembler
    {
        public const int MaxLength = 1 << 20;

        private readonly StringBuilder _buf = new();
        private int _depth;
        private bool _inString, _escape;

        /// <summary>Parçayı işler; bu parçayla tamamlanan JSON değerlerini döner (yoksa null).</summary>
        public List<TcpJson>? Push(char[] chars, int count)
        {
            List<TcpJson>? found = null;
            for (int i = 0; i < count; i++)
            {
                char c = chars[i];
                if (_depth == 0)
                {
                    if (c != '{' && c != '[') continue;    // değer dışındaki karakterler
                    _buf.Clear();
                    _buf.Append(c);
                    _depth = 1;
                    _inString = _escape = false;
                    continue;
                }

                _buf.Append(c);
                if (_inString)
                {
                    if (_escape) _escape = false;
                    else if (c == '\\') _escape = true;
                    else if (c == '"') _inString = false;
                }
                else if (c == '"') _inString = true;
                else if (c == '{' || c == '[') _depth++;
                else if ((c == '}' || c == ']') && --_depth == 0)
                {
                    (found ??= new()).Add(JsonText.Format(_buf.ToString()));
                    _buf.Clear();
                }

                if (_buf.Length > MaxLength)
                {
                    (found ??= new()).Add(new TcpJson(_buf.ToString(0, 200) + "…",
                        $"JSON {MaxLength / 1024} KB'tan uzun ya da kapanmıyor; yok sayıldı."));
                    _buf.Clear();
                    _depth = 0;
                }
            }
            return found;
        }

        /// <summary>Bağlantı kapanırken yarım kalan değer (varsa) hata olarak döner.</summary>
        public TcpJson? Flush()
        {
            if (_depth == 0 || _buf.Length == 0) return null;
            var tail = new TcpJson(_buf.ToString(), "Bağlantı kapandı; JSON tamamlanmadı.");
            _buf.Clear();
            _depth = 0;
            return tail;
        }
    }

    public static class JsonText
    {
        /// <summary>
        /// Doğrular ve 2 boşlukla girintiler. Sayılar ve metinler olduğu gibi kalır (yeniden yazılmaz, hassasiyet kaybı yok).
        /// Geçersizse ham metin ve hata mesajı döner.
        /// </summary>
        public static TcpJson Format(string json)
        {
            try
            {
                using var _ = JsonDocument.Parse(json);
            }
            catch (JsonException ex)
            {
                string where = ex.LineNumber is { } ln && ex.BytePositionInLine is { } bp ? $" (satır {ln + 1}, konum {bp + 1})" : "";
                return new TcpJson(json, "Geçerli JSON değil" + where + ".");
            }
            return new TcpJson(Indent(json), null);
        }

        private static string Indent(string json)
        {
            var sb = new StringBuilder(json.Length * 2);
            int depth = 0;
            bool inString = false, escape = false;
            void NewLine() => sb.Append('\n').Append(' ', depth * 2);

            for (int i = 0; i < json.Length; i++)
            {
                char c = json[i];
                if (inString)
                {
                    sb.Append(c);
                    if (escape) escape = false;
                    else if (c == '\\') escape = true;
                    else if (c == '"') inString = false;
                    continue;
                }
                switch (c)
                {
                    case '"': inString = true; sb.Append(c); break;
                    case '{':
                    case '[':
                    {
                        // Boş nesne / dizi tek satırda kalsın: {} []
                        int j = i + 1;
                        while (j < json.Length && char.IsWhiteSpace(json[j])) j++;
                        if (j < json.Length && json[j] == (c == '{' ? '}' : ']')) { sb.Append(c).Append(json[j]); i = j; break; }
                        sb.Append(c);
                        depth++;
                        NewLine();
                        break;
                    }
                    case '}':
                    case ']':
                        depth--;
                        NewLine();
                        sb.Append(c);
                        break;
                    case ',': sb.Append(c); NewLine(); break;
                    case ':': sb.Append(": "); break;
                    default:
                        if (!char.IsWhiteSpace(c)) sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }
    }

    /// <summary>
    /// Cihaz süzgeci (yandaki IP listesi): bir satır seçili cihaza aitse gösterilir. Cihaza ait = o cihazla kurulan
    /// bağlantıdan gelen (dinleyicide cihaz bağlanır, istemcide cihaza bağlanılır). site/js/tcp.js'de aynı kural vardır.
    /// </summary>
    public static class TcpFilter
    {
        /// <summary>"172.16.154.12:52344" → "172.16.154.12".</summary>
        public static string RemoteIp(string remote)
        {
            int i = remote.LastIndexOf(':');
            return i > 0 ? remote[..i] : remote;
        }

        /// <summary>
        /// Satır seçili cihaza ait mi? Cihazın kendi satırları her zaman; oturumun genel satırları (bilgi, "Durduruldu")
        /// ve listede olmayan kaynaklardan gelenler de gösterilir, listedeki diğer cihazlarınkiler gizlenir.
        /// </summary>
        public static bool Matches(TcpLine line, string ip, ISet<string> listIps)
        {
            string from = RemoteIp(line.Remote);
            if (from == ip) return true;
            if (line.Kind == TcpLineKind.Data) return false;
            return from.Length == 0 || !listIps.Contains(from);
        }
    }
}
