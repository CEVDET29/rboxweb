using System.Collections.Concurrent;

namespace RboxAgent.Modules.Ping
{
    /// <summary>
    /// Ping Kontrol'deki sürekli ping sekmeleri ("ping ip -t"). Her sekme ajanda bir oturumdur; tarayıcı yeni
    /// satırları saniyede bir yoklar (açık bağlantı tutulmaz, çok sekmede de tarayıcının bağlantı sınırına takılmaz).
    /// Bir süre yoklanmayan oturumlar (sayfa kapandı) kendiliğinden durdurulup silinir.
    /// </summary>
    public static class LivePingService
    {
        public const int MaxSessions = 16;
        private const int MaxLines = 3000;
        private static readonly TimeSpan Orphan = TimeSpan.FromSeconds(45);

        private sealed class Session
        {
            public required int Id;
            public required string Target;
            public required ContinuousPinger Pinger;
            public CancellationTokenSource? Cts;
            public readonly List<PingLine> Lines = new();
            public DateTime LastPoll = DateTime.UtcNow;
            public Task? Loop;
        }

        private static readonly ConcurrentDictionary<int, Session> Sessions = new();
        private static int _nextId;
        // Sayfa tamamen kapanınca yoklama da gelmez: sahipsiz oturumlar arka planda da temizlensin
        private static readonly Timer Janitor = new(_ => Cleanup(), null, 15000, 15000);

        public static (bool ok, string error, int id) Start(string? target)
        {
            target = (target ?? "").Trim();
            if (target.Length == 0 || target.Length > 253 || target.Any(char.IsWhiteSpace))
                return (false, "Geçersiz IP / ad.", 0);
            Cleanup();
            if (Sessions.Count >= MaxSessions) return (false, $"En fazla {MaxSessions} sürekli ping açık olabilir.", 0);

            var s = new Session { Id = Interlocked.Increment(ref _nextId), Target = target, Pinger = new ContinuousPinger(target) };
            Sessions[s.Id] = s;
            Run(s);
            return (true, "", s.Id);
        }

        /// <summary>Durdurulmuş oturumu aynı sekmede yeniden başlatır (satırlar korunur, istatistik sıfırlanır).</summary>
        public static bool Resume(int id)
        {
            if (!Sessions.TryGetValue(id, out var s) || s.Pinger.Running) return false;
            var p = new ContinuousPinger(s.Target);
            // Sıra numaraları sekme boyunca artmaya devam etsin: yeni ping satırları eskilerin ardından gelir
            long offset;
            lock (s.Lines) offset = s.Lines.Count > 0 ? s.Lines[^1].Seq : 0;
            s.Pinger = p;
            Run(s, offset);
            return true;
        }

        public static bool Stop(int id)
        {
            if (!Sessions.TryGetValue(id, out var s)) return false;
            s.Cts?.Cancel();
            return true;
        }

        public static bool Remove(int id)
        {
            if (!Sessions.TryRemove(id, out var s)) return false;
            s.Cts?.Cancel();
            return true;
        }

        private static void Run(Session s, long seqOffset = 0)
        {
            s.Cts = new CancellationTokenSource();
            var pinger = s.Pinger;
            pinger.Line += l =>
            {
                lock (s.Lines)
                {
                    s.Lines.Add(l with { Seq = l.Seq + seqOffset });
                    if (s.Lines.Count > MaxLines) s.Lines.RemoveRange(0, s.Lines.Count - MaxLines);
                }
            };
            var ct = s.Cts.Token;
            s.Loop = Task.Run(() => pinger.RunAsync(ct));
        }

        /// <summary>İstenen oturumların (cursor'dan sonraki) yeni satırları ve durumu. Bilinmeyen kimlikler "gone" döner.</summary>
        public static object Poll(Dictionary<string, long>? cursors)
        {
            Cleanup();
            var now = DateTime.UtcNow;
            var result = new List<object>();
            foreach (var (key, after) in cursors ?? new())
            {
                if (!int.TryParse(key, out var id)) continue;
                if (!Sessions.TryGetValue(id, out var s)) { result.Add(new { id, gone = true }); continue; }
                s.LastPoll = now;
                List<PingLine> lines;
                lock (s.Lines) lines = s.Lines.Where(l => l.Seq > after).ToList();
                var p = s.Pinger;
                result.Add(new
                {
                    id, gone = false, target = s.Target, running = p.Running, up = p.Up,
                    sent = p.Sent, received = p.Received, lost = p.Lost, lastMs = p.LastMs, minMs = p.MinMs, maxMs = p.MaxMs, avgMs = p.AvgMs,
                    lines = lines.Select(l => new { seq = l.Seq, time = l.Time.ToString("HH:mm:ss"), text = l.Text, kind = l.Kind.ToString().ToLowerInvariant() }),
                });
            }
            return new { sessions = result };
        }

        /// <summary>Uzun süre yoklanmayan (sekmesi / sayfası kapanmış) oturumları durdurup siler.</summary>
        private static void Cleanup()
        {
            var limit = DateTime.UtcNow - Orphan;
            foreach (var s in Sessions.Values.Where(s => s.LastPoll < limit).ToList())
                Remove(s.Id);
        }
    }
}
