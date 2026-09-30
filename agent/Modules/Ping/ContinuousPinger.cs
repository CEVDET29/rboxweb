using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace RboxAgent.Modules.Ping
{
    // NOT: Bu dosya WPF (RboxTools/Modules/Ping) ile web ajanında (RboxWeb/agent/Modules/Ping) aynıdır;
    // yalnızca namespace farklıdır. Birinde değişiklik yapınca diğerine de kopyalayın.

    /// <summary>Konsol satırının türü: bilgi (başlık / istatistik), yanıt geldi, yanıt yok.</summary>
    public enum PingLineKind { Info, Ok, Fail }

    public sealed record PingLine(long Seq, DateTime Time, string Text, PingLineKind Kind);

    /// <summary>
    /// "ping &lt;ip&gt; -t" gibi durdurulana kadar saniyede bir ping atar ve Windows'un Türkçe ping çıktısıyla aynı
    /// biçimde satır üretir. Durdurulunca istatistik satırlarını ekler. Satırlar <see cref="Line"/> olayıyla gelir.
    /// Farkı: "Hedef ana bilgisayara ulaşılamıyor" yanıtı Windows'ta "alındı" sayılır, burada kayıp sayılır.
    /// </summary>
    public sealed class ContinuousPinger
    {
        public const int IntervalMs = 1000;
        public const int TimeoutMs = 2000;
        private static readonly byte[] Payload = new byte[32];

        private long _seq;

        public ContinuousPinger(string target) => Target = target.Trim();

        public string Target { get; }
        public int Sent { get; private set; }
        public int Received { get; private set; }
        public int Lost => Sent - Received;
        public long? MinMs { get; private set; }
        public long? MaxMs { get; private set; }
        public long? LastMs { get; private set; }
        private long _sumMs;
        public long? AvgMs => Received > 0 ? _sumMs / Received : null;
        /// <summary>Son yanıt geldi mi (null = henüz ping atılmadı).</summary>
        public bool? Up { get; private set; }
        public bool Running { get; private set; }

        public event Action<PingLine>? Line;

        private void Emit(string text, PingLineKind kind) =>
            Line?.Invoke(new PingLine(Interlocked.Increment(ref _seq), DateTime.Now, text, kind));

        /// <summary>İptal edilene kadar çalışır; iptalde istatistikleri yazıp döner (istisna fırlatmaz).</summary>
        public async Task RunAsync(CancellationToken ct)
        {
            Running = true;
            try
            {
                IPAddress? ip;
                if (!IPAddress.TryParse(Target, out ip))
                {
                    try
                    {
                        var list = await Dns.GetHostAddressesAsync(Target, ct);
                        ip = list.FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork) ?? list.FirstOrDefault();
                    }
                    catch (OperationCanceledException) { return; }
                    catch { ip = null; }
                    if (ip == null)
                    {
                        Emit($"Ping isteği {Target} ana bilgisayarını bulamadı. Lütfen adı denetleyip yeniden deneyin.", PingLineKind.Fail);
                        return;
                    }
                }
                string head = ip.ToString() == Target ? Target : $"{Target} [{ip}]";
                Emit($"{head} {Payload.Length} bayt veri ile ping ediliyor:", PingLineKind.Info);

                using var ping = new System.Net.NetworkInformation.Ping();
                var sw = new System.Diagnostics.Stopwatch();
                while (!ct.IsCancellationRequested)
                {
                    sw.Restart();
                    PingReply? reply = null;
                    try { reply = await ping.SendPingAsync(ip, TimeSpan.FromMilliseconds(TimeoutMs), Payload, null, ct); }
                    catch (OperationCanceledException) { break; }
                    catch (PingException ex) { Sent++; Up = false; Emit("Genel hata. " + (ex.InnerException?.Message ?? ex.Message), PingLineKind.Fail); }

                    if (reply != null)
                    {
                        Sent++;
                        if (reply.Status == IPStatus.Success)
                        {
                            Received++;
                            long ms = reply.RoundtripTime;
                            LastMs = ms;
                            _sumMs += ms;
                            MinMs = MinMs is { } mn ? Math.Min(mn, ms) : ms;
                            MaxMs = MaxMs is { } mx ? Math.Max(mx, ms) : ms;
                            Up = true;
                            string time = ms < 1 ? "süre<1ms" : $"süre={ms}ms";
                            string ttl = reply.Options != null ? $" TTL={reply.Options.Ttl}" : "";
                            Emit($"{reply.Address} yanıtı: bayt={reply.Buffer.Length} {time}{ttl}", PingLineKind.Ok);
                        }
                        else
                        {
                            Up = false;
                            Emit(reply.Status switch
                            {
                                IPStatus.TimedOut => "İstek zaman aşımına uğradı.",
                                IPStatus.DestinationHostUnreachable => $"{Addr(reply, ip)} yanıtı: Hedef ana bilgisayara ulaşılamıyor.",
                                IPStatus.DestinationNetworkUnreachable => $"{Addr(reply, ip)} yanıtı: Hedef ağa ulaşılamıyor.",
                                IPStatus.TtlExpired => $"{Addr(reply, ip)} yanıtı: Aktarımda TTL süresi doldu.",
                                _ => "Genel hata. (" + reply.Status + ")",
                            }, PingLineKind.Fail);
                        }
                    }

                    var wait = IntervalMs - (int)sw.ElapsedMilliseconds;
                    if (wait > 0)
                    {
                        try { await Task.Delay(wait, ct); }
                        catch (OperationCanceledException) { break; }
                    }
                }

                // Ctrl+C'deki gibi istatistik
                Emit("", PingLineKind.Info);
                Emit($"{ip} için Ping istatistikleri:", PingLineKind.Info);
                int pct = Sent > 0 ? (int)Math.Round(100.0 * Lost / Sent) : 0;
                Emit($"    Paket: Giden = {Sent}, Alınan = {Received}, Kaybedilen = {Lost} (%{pct} kayıp),", PingLineKind.Info);
                if (Received > 0)
                {
                    Emit("Milisaniye cinsinden yaklaşık gidiş geliş süreleri:", PingLineKind.Info);
                    Emit($"    En Az = {MinMs}ms, En Çok = {MaxMs}ms, Ortalama = {AvgMs}ms", PingLineKind.Info);
                }
                Emit("Durduruldu.", PingLineKind.Info);
            }
            finally { Running = false; }
        }

        private static string Addr(PingReply r, IPAddress ip) =>
            r.Address != null && !r.Address.Equals(IPAddress.Any) ? r.Address.ToString() : ip.ToString();
    }
}
