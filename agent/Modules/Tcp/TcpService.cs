using System.Collections.Concurrent;

namespace RboxAgent.Modules.Tcp
{
    /// <summary>
    /// TCP modülü: sayfanın açtığı dinleyici / istemci oturumları. Tarayıcı yeni satırları saniyede bir yoklar (sürekli
    /// ping gibi). Uzun süre yoklanmayan oturum (sayfa kapandı) durdurulup silinir; arka plandaki sekmede tarayıcı
    /// zamanlayıcıları dakikada bire kadar yavaşlatabildiği için süre sürekli pingdekinden uzundur.
    /// </summary>
    public static class TcpService
    {
        public const int MaxSessions = 8;
        private const int MaxLines = 3000;
        private static readonly TimeSpan Orphan = TimeSpan.FromMinutes(3);

        private sealed class Session
        {
            public required int Id;
            public required TcpSession Tcp;
            public readonly CancellationTokenSource Cts = new();
            public readonly List<TcpLine> Lines = new();
            public DateTime LastPoll = DateTime.UtcNow;
        }

        private static readonly ConcurrentDictionary<int, Session> Sessions = new();
        private static int _nextId;
        private static readonly Timer Janitor = new(_ => Cleanup(), null, 30000, 30000);

        public static object Addresses() =>
            new { addresses = TcpSession.LocalAddresses().Select(a => new { address = a.Address, label = a.Label }) };

        /// <summary>mode "connect": listedeki cihazlara (hosts) port'tan bağlanır; diğer her değer: bind:port'u dinler.</summary>
        public static (bool ok, string error, int id) Start(string? mode, int port, string? bind, IEnumerable<string>? hosts)
        {
            Cleanup();
            if (Sessions.Count >= MaxSessions) return (false, $"En fazla {MaxSessions} oturum açık olabilir.", 0);

            TcpSession tcp = mode == "connect"
                ? new TcpConnectSession(hosts ?? Array.Empty<string>(), port)
                : new TcpListenSession(port, TcpSession.ParseBind(bind));
            var s = new Session { Id = Interlocked.Increment(ref _nextId), Tcp = tcp };
            tcp.Line += line =>
            {
                lock (s.Lines)
                {
                    s.Lines.Add(line);
                    if (s.Lines.Count > MaxLines) s.Lines.RemoveRange(0, s.Lines.Count - MaxLines);
                }
            };
            string? error = tcp.TryStart();
            if (error != null) return (false, error, 0);

            Sessions[s.Id] = s;
            var ct = s.Cts.Token;
            _ = Task.Run(() => tcp.RunAsync(ct));
            return (true, "", s.Id);
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

        /// <summary>Oturumun <paramref name="after"/>'dan sonraki satırları ve durumu. Bilinmeyen kimlik "gone" döner.</summary>
        public static object Poll(int id, long after)
        {
            Cleanup();
            if (!Sessions.TryGetValue(id, out var s)) return new { id, gone = true };
            s.LastPoll = DateTime.UtcNow;
            var t = s.Tcp;
            // Önce durum, sonra satırlar: "durdu" okunduysa son satır ("Durduruldu") listeye çoktan eklenmiştir
            bool running = t.Running;
            List<TcpLine> lines;
            lock (s.Lines) lines = s.Lines.Where(x => x.Seq > after).ToList();
            // Durdurulan oturum son satırları gönderildikten sonra silinir
            if (!running && lines.Count == 0) Remove(id);
            return new
            {
                id, gone = false, running, endpoint = t.Endpoint,
                active = t.ActiveConnections, total = t.TotalConnections, bytes = t.BytesReceived,
                hosts = (t as TcpConnectSession)?.Hosts().Select(h => new { host = h.Host, state = h.State.ToString().ToLowerInvariant(), error = h.Error }),
                lines = lines.Select(x => new
                {
                    seq = x.Seq, time = x.Time.ToString("HH:mm:ss.fff"), remote = x.Remote,
                    kind = x.Kind.ToString().ToLowerInvariant(), text = x.Text, hex = x.Hex, bytes = x.Bytes,
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
