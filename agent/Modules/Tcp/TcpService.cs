using System.Collections.Concurrent;
using RboxAgent.Modules.Hl7;

namespace RboxAgent.Modules.Tcp
{
    /// <summary>
    /// TCP modülü: sayfanın açtığı dinleyici / istemci / demo oturumları. Tarayıcı yeni satırları saniyede bir yoklar
    /// (sürekli ping gibi). Uzun süre yoklanmayan oturum (sayfa kapandı) durdurulup silinir; arka plandaki sekmede
    /// tarayıcı zamanlayıcıları dakikada bire kadar yavaşlatabildiği için süre sürekli pingdekinden uzundur.
    /// HL7 onayı (ACK) açıksa ajan gelen her HL7 mesajına anında MLLP onayı yazar (sayfanın yoklama gecikmesi
    /// gönderenin zaman aşımına takılmasın); gönderilen onaylar yoklamada sayfaya bildirilir.
    /// </summary>
    public static class TcpService
    {
        public const int MaxSessions = 8;
        private const int MaxLines = 3000;
        private const int MaxAcks = 500;
        private static readonly TimeSpan Orphan = TimeSpan.FromMinutes(3);

        private sealed record AckRecord(long Seq, string Remote, string Control, string Time, bool Ok);

        private sealed class Session
        {
            public required int Id;
            public required TcpSession Tcp;
            public readonly CancellationTokenSource Cts = new();
            public readonly List<TcpLine> Lines = new();
            public DateTime LastPoll = DateTime.UtcNow;
            public volatile bool Ack;
            public readonly Dictionary<string, Hl7Stream> Streams = new();
            public readonly List<AckRecord> Acks = new();
            public long AckSeq;
            public long AckCount;
        }

        private static readonly ConcurrentDictionary<int, Session> Sessions = new();
        private static int _nextId;
        private static readonly Timer Janitor = new(_ => Cleanup(), null, 30000, 30000);

        public static object Addresses() =>
            new { addresses = TcpSession.LocalAddresses().Select(a => new { address = a.Address, label = a.Label }) };

        /// <summary>
        /// mode "connect": listedeki cihazlara (hosts) port'tan bağlanır; "demo": gömülü kayıtları oynatır (gerçek cihaz
        /// yok, ACK gönderilmez); diğer her değer: bind:port'u dinler.
        /// </summary>
        public static (bool ok, string error, int id) Start(string? mode, int port, string? bind, IEnumerable<string>? hosts, bool ack = false)
        {
            Cleanup();
            if (Sessions.Count >= MaxSessions) return (false, $"En fazla {MaxSessions} oturum açık olabilir.", 0);

            TcpSession tcp = mode switch
            {
                "connect" => new TcpConnectSession(hosts ?? Array.Empty<string>(), port),
                "demo" => new TcpDemoSession(),
                _ => new TcpListenSession(port, TcpSession.ParseBind(bind)),
            };
            var s = new Session { Id = Interlocked.Increment(ref _nextId), Tcp = tcp, Ack = ack && tcp is not TcpDemoSession };
            tcp.Line += line =>
            {
                lock (s.Lines)
                {
                    s.Lines.Add(line);
                    if (s.Lines.Count > MaxLines) s.Lines.RemoveRange(0, s.Lines.Count - MaxLines);
                }
                if (s.Ack) Acknowledge(s, line);
            };
            string? error = tcp.TryStart();
            if (error != null) return (false, error, 0);

            Sessions[s.Id] = s;
            var ct = s.Cts.Token;
            _ = Task.Run(() => tcp.RunAsync(ct));
            return (true, "", s.Id);
        }

        /// <summary>ACK'yı açar / kapatır (oturum sürerken). Demoda onay gönderilmez.</summary>
        public static bool SetAck(int id, bool on)
        {
            if (!Sessions.TryGetValue(id, out var s)) return false;
            s.Ack = on && s.Tcp is not TcpDemoSession;
            if (!s.Ack) lock (s.Streams) s.Streams.Clear();
            return true;
        }

        /// <summary>
        /// Gelen parçayı bağlantısının HL7 akışına ekler; tamamlanan her mesaja (MSH-15 NE değilse, ACK'ya değil)
        /// MLLP çerçeveli kabul onayı yazar. WPF TcpViewModel'deki onayla aynı (Hl7Parser.BuildAck).
        /// </summary>
        private static void Acknowledge(Session s, TcpLine line)
        {
            if (line.Remote.Length == 0) return;
            var done = new List<string>();
            lock (s.Streams)
            {
                if (line.Kind == TcpLineKind.Data)
                {
                    if (!s.Streams.TryGetValue(line.Remote, out var st)) s.Streams[line.Remote] = st = new Hl7Stream();
                    done.AddRange(st.Push(line.Text));
                }
                else if (line.Kind == TcpLineKind.Disconnect)
                    s.Streams.Remove(line.Remote);
            }
            foreach (var text in done)
                foreach (var m in Hl7Parser.Parse(text).Messages)
                {
                    if (!Hl7Parser.WantsAck(m)) continue;
                    var now = DateTime.Now;
                    string control = m.Get("MSH", 10), remote = line.Remote;
                    _ = Task.Run(async () =>
                    {
                        bool ok = await s.Tcp.SendAsync(remote, Hl7Parser.Frame(Hl7Parser.BuildAck(m, now)));
                        lock (s.Acks)
                        {
                            if (ok) s.AckCount++;
                            s.Acks.Add(new AckRecord(++s.AckSeq, remote, control, now.ToString("HH:mm:ss"), ok));
                            if (s.Acks.Count > MaxAcks) s.Acks.RemoveRange(0, s.Acks.Count - MaxAcks);
                        }
                    });
                }
        }

        /// <summary>Oturumu durdurur; satırlar son yoklamaya kadar alınabilsin diye hemen silinmez.</summary>
        public static bool Stop(int id)
        {
            if (!Sessions.TryGetValue(id, out var s)) return false;
            s.Cts.Cancel();
            return true;
        }

        /// <summary>İstemci oturumu sürerken listeye eklenen / listeden çıkarılan cihaz.</summary>
        public static bool Host(int id, string? host, bool add)
        {
            if (!Sessions.TryGetValue(id, out var s) || s.Tcp is not TcpConnectSession c) return false;
            return add ? c.AddHost(host ?? "") : c.RemoveHost(host ?? "");
        }

        public static bool Remove(int id)
        {
            if (!Sessions.TryRemove(id, out var s)) return false;
            s.Cts.Cancel();
            return true;
        }

        /// <summary>
        /// Oturumun <paramref name="after"/>'dan sonraki satırları, <paramref name="ackAfter"/>'dan sonraki onaylar ve durum.
        /// Bilinmeyen kimlik "gone" döner. hex=false: onaltılık döküm gönderilmez (HL7 / dalga verisinde boyut yarıya iner).
        /// </summary>
        public static object Poll(int id, long after, bool hex = true, long ackAfter = 0)
        {
            Cleanup();
            if (!Sessions.TryGetValue(id, out var s)) return new { id, gone = true };
            s.LastPoll = DateTime.UtcNow;
            var t = s.Tcp;
            // Önce durum, sonra satırlar: "durdu" okunduysa son satır ("Durduruldu") listeye çoktan eklenmiştir
            bool running = t.Running;
            List<TcpLine> lines;
            lock (s.Lines) lines = s.Lines.Where(x => x.Seq > after).ToList();
            List<AckRecord> acks;
            long ackCount;
            lock (s.Acks) { acks = s.Acks.Where(a => a.Seq > ackAfter).ToList(); ackCount = s.AckCount; }
            // Durdurulan oturum son satırları gönderildikten sonra silinir
            if (!running && lines.Count == 0) Remove(id);
            return new
            {
                id, gone = false, running, endpoint = t.Endpoint, demo = t is TcpDemoSession,
                active = t.ActiveConnections, total = t.TotalConnections,
                bytes = t is TcpDemoSession d ? d.DemoBytes : t.BytesReceived,
                hosts = (t as TcpConnectSession)?.Hosts().Select(h => new { host = h.Host, state = h.State.ToString().ToLowerInvariant(), error = h.Error }),
                ack = s.Ack, ackCount,
                acks = acks.Select(a => new { seq = a.Seq, remote = a.Remote, control = a.Control, time = a.Time, ok = a.Ok }),
                lines = lines.Select(x => new
                {
                    seq = x.Seq, time = x.Time.ToString("HH:mm:ss.fff"), remote = x.Remote,
                    kind = x.Kind.ToString().ToLowerInvariant(), text = x.Text, hex = hex ? x.Hex : null, bytes = x.Bytes,
                    json = x.Json?.Select(j => new { text = j.Text, error = j.Error }),
                }),
            };
        }

        private static void Cleanup()
        {
            var limit = DateTime.UtcNow - Orphan;
            foreach (var s in Sessions.Values.Where(s => s.LastPoll < limit).ToList())
                Remove(s.Id);
        }
    }
}
