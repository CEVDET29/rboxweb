using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace RboxAgent.Modules.Tcp
{
    /// <summary>
    /// Demo: gerçek cihaz bağlamadan, programa gömülü (anonimleştirilmiş) kayıtları bir dinleyiciye gelmiş gibi
    /// oynatır. Kayıttaki her kaynak (ip:port) ayrı bir bağlantı gibi görünür; parçalar kayıttaki zamanlamayla gelir,
    /// kayıt bitince başa sarar. Her turda HL7 zamanları şimdiye kaydırılır ve kontrol no (MSH-10) değişir (yoksa
    /// "tekrar" sayılırdı). Veri dinleyicideki yoldan geçer: ham konsol, cihaz listesi, HL7, Dalgalar.
    /// Kayıtlar Demo/make_demo.py ile üretilir: monitör + ventilatör dalgaları, eGateway pompa / perfüzör ölçümleri.
    /// </summary>
    public sealed partial class TcpDemoSession : TcpSession
    {
        private static readonly string[] Resources = { "demo-dalgalar.txt", "demo-egateway.txt" };
        private long _bytes;

        public override string Endpoint => "demo";
        /// <summary>Oynatılan veri (bayt); durum satırında.</summary>
        public long DemoBytes => Interlocked.Read(ref _bytes);
        public int Sources { get; private set; }

        private sealed record Chunk(double At, string Remote, string Text);

        [GeneratedRegex(@"^\s*\[(\d+):(\d+):(\d+)(?:\.(\d+))?\]\s+(\d{1,3}(?:\.\d{1,3}){3}:\d+)\s+\S+\s+[\d,.]+\s*[KMG]?B\s*$")]
        private static partial Regex Header();

        // HL7 zaman damgası: YYYYMMDDHHMMSS[.ffff][±hhmm]
        [GeneratedRegex(@"(?<![\d])(\d{14})(\.\d+)?([+-]\d{4})?(?![\d])")]
        private static partial Regex Stamp();

        public override string? TryStart()
        {
            Running = true;
            Emit(TcpLineKind.Info, "", "Demo başladı: gerçek cihaz yok; kayıtlı (anonimleştirilmiş) monitör, ventilatör ve pompa verisi gerçek zamanlamasıyla oynatılıyor.");
            return null;
        }

        public override async Task RunAsync(CancellationToken ct)
        {
            // Cihaz (IP) başına ayrı döngü: kayıtta cihazlar farklı anlarda başlıyor (monitörler ~13 sn sonra); tek döngüde
            // her turun başında dalgalar boş kalıyordu. Aynı cihazın birden çok bağlantısı tek bağlantı gibi gösterilir.
            var captures = Resources.Select(Load).SelectMany(PerDevice).Where(c => c.Count > 0).ToList();
            var open = new HashSet<string>();
            Sources = captures.Count;
            try
            {
                await Task.WhenAll(captures.Select(c => PlayAsync(c, open, ct)));
            }
            catch (OperationCanceledException) { }
            finally
            {
                lock (open)
                {
                    foreach (var r in open)
                    {
                        Interlocked.Decrement(ref _active);
                        Emit(TcpLineKind.Disconnect, r, "Demo durduruldu");
                    }
                    open.Clear();
                }
                Emit(TcpLineKind.Info, "", $"Demo durduruldu. {FormatBytes(DemoBytes)} oynatıldı.");
                Running = false;
            }
        }

        private async Task PlayAsync(List<Chunk> chunks, HashSet<string> open, CancellationToken ct)
        {
            int round = 0;
            while (!ct.IsCancellationRequested)
            {
                round++;
                var start = DateTime.Now;
                double t0 = chunks[0].At;
                // Kayıttaki ilk HL7 zamanı şimdiye denk gelsin
                var first = FirstStamp(chunks);
                TimeSpan shift = first is { } f ? start - f : TimeSpan.Zero;
                foreach (var c in chunks)
                {
                    var wait = TimeSpan.FromSeconds(c.At - t0) - (DateTime.Now - start);
                    if (wait > TimeSpan.Zero) await Task.Delay(wait, ct);
                    ct.ThrowIfCancellationRequested();
                    lock (open)
                    {
                        if (open.Add(c.Remote))
                        {
                            Interlocked.Increment(ref _active);
                            Interlocked.Increment(ref _total);
                            Emit(TcpLineKind.Connect, c.Remote, $"Bağlandı (demo · {ActiveConnections} açık bağlantı)");
                        }
                    }
                    var bytes = ToBytes(c.Text, round, shift);
                    Interlocked.Add(ref _bytes, bytes.Length);
                    var chars = Encoding.UTF8.GetChars(bytes);
                    Emit(TcpLineKind.Data, c.Remote, Printable(chars, chars.Length), HexDump(bytes, bytes.Length), bytes.Length);
                }
                // Tur sonu: sonraki tur, bir parça aralığı (~1 sn) sonra başlar; dalga kesintisiz sürer
                var next = start + TimeSpan.FromSeconds(chunks[^1].At - t0 + 1) - DateTime.Now;
                if (next > TimeSpan.Zero) await Task.Delay(next, ct);
            }
        }

        /// <summary>
        /// Kaydı cihazlara (IP) böler; her cihazın parçaları kendi zaman çizelgesinde kalır, 3 sn'den uzun boşluklar (bağlantı
        /// kopup yeniden kurulduğu anlar) 1 sn'ye kısaltılır, adres ilk bağlantının ip:port'u olur.
        /// </summary>
        private static IEnumerable<List<Chunk>> PerDevice(List<Chunk> chunks)
        {
            foreach (var g in chunks.GroupBy(c => TcpFilter.RemoteIp(c.Remote)))
            {
                var list = g.OrderBy(c => c.At).ToList();
                string remote = list[0].Remote;
                double at = 0, prev = list[0].At;
                var outList = new List<Chunk>();
                foreach (var c in list)
                {
                    double gap = c.At - prev;
                    at += gap > 3 ? 1 : gap;
                    prev = c.At;
                    outList.Add(c with { At = at, Remote = remote });
                }
                yield return outList;
            }
        }

        /// <summary>Gömülü kaydı okur: "[saat] ip:port ← boyut" başlıklı parçalar.</summary>
        private static List<Chunk> Load(string name)
        {
            using var s = typeof(TcpDemoSession).Assembly.GetManifestResourceStream(name);
            if (s == null) return new();
            var text = new StreamReader(s, Encoding.UTF8).ReadToEnd().Replace("\r\n", "\n");
            var list = new List<Chunk>();
            double at = 0, last = -1, day = 0;
            string? remote = null;
            var sb = new StringBuilder();
            void Close()
            {
                var body = sb.ToString().Trim('\n');
                if (remote != null && body.Length > 0) list.Add(new Chunk(at, remote, body));
                sb.Clear();
            }
            foreach (var line in text.Split('\n'))
            {
                var m = Header().Match(line);
                if (m.Success)
                {
                    Close();
                    double t = int.Parse(m.Groups[1].Value) * 3600 + int.Parse(m.Groups[2].Value) * 60 + int.Parse(m.Groups[3].Value)
                               + (m.Groups[4].Success ? double.Parse("0." + m.Groups[4].Value, CultureInfo.InvariantCulture) : 0);
                    if (last >= 0 && t + day < last - 3600) day += 86400;
                    at = t + day;
                    last = at;
                    remote = m.Groups[5].Value;
                    continue;
                }
                if (remote != null) sb.Append(line).Append('\n');
            }
            Close();
            return list;
        }

        private static DateTime? FirstStamp(List<Chunk> chunks)
        {
            foreach (var c in chunks)
            {
                int at = c.Text.IndexOf("MSH|", StringComparison.Ordinal);
                if (at < 0) continue;
                var f = c.Text[at..].Split('|');
                if (f.Length > 6 && f[6].Length >= 14 && DateTime.TryParseExact(f[6][..14], "yyyyMMddHHmmss", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d))
                    return d;
            }
            return null;
        }

        /// <summary>
        /// Cihazın göndereceği baytlar: &lt;VT&gt; / &lt;FS&gt; MLLP baytlarına, satır sonları CR'ye; zamanlar şimdiye kaydırılır
        /// (saat dilimi yerel), 2. turdan itibaren MSH-10'a tur eki eklenir.
        /// </summary>
        private static byte[] ToBytes(string chunk, int round, TimeSpan shift)
        {
            string zone = DateTimeOffset.Now.ToString("zzz", CultureInfo.InvariantCulture).Replace(":", "");
            var lines = chunk.Split('\n');
            for (int i = 0; i < lines.Length; i++)
            {
                var line = Stamp().Replace(lines[i], m =>
                {
                    if (!DateTime.TryParseExact(m.Groups[1].Value, "yyyyMMddHHmmss", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d))
                        return m.Value;
                    return (d + shift).ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture) + m.Groups[2].Value + (m.Groups[3].Success ? zone : "");
                });
                int at = line.IndexOf("MSH|", StringComparison.Ordinal);
                if (at >= 0 && round > 1)
                {
                    var f = line[at..].Split('|');
                    if (f.Length > 9 && f[9].Length > 0) f[9] += "-" + round;
                    line = line[..at] + string.Join('|', f);
                }
                lines[i] = line;
            }
            var s = string.Join('\r', lines).Replace("<VT>", "\x0b").Replace("<FS>", "\x1c");
            if (s.EndsWith('\x1c')) s += "\r";
            return Encoding.UTF8.GetBytes(s);
        }
    }
}
