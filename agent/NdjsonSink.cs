using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace RboxAgent
{
    /// <summary>
    /// Satır satır JSON (ndjson) yazıcısı. Emit() her iş parçacığından çağrılabilir ve beklemez;
    /// yazma tek bir arka plan görevinde yapılır (güncelleme adımları eşzamanlı log üretir).
    /// İstemci bağlantıyı koparırsa <see cref="Broken"/> iptal edilir; çağıran işi durdurabilir.
    /// </summary>
    internal sealed class NdjsonSink
    {
        private readonly Channel<byte[]> _channel = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions { SingleReader = true });
        private readonly CancellationTokenSource _broken = new();
        private readonly JsonSerializerOptions _json;
        private readonly Task _pump;
        private volatile bool _dead;

        public NdjsonSink(Stream stream, JsonSerializerOptions json)
        {
            _json = json;
            _pump = Task.Run(async () =>
            {
                try
                {
                    await foreach (var bytes in _channel.Reader.ReadAllAsync())
                    {
                        await stream.WriteAsync(bytes);
                        await stream.FlushAsync();
                    }
                }
                catch
                {
                    _dead = true;
                    _broken.Cancel();          // istemci koptu
                }
            });
        }

        /// <summary>İstemci bağlantısı koptuğunda iptal edilir.</summary>
        public CancellationToken Broken => _broken.Token;

        public void Emit(object message)
        {
            if (_dead) return;
            _channel.Writer.TryWrite(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(message, _json) + "\n"));
        }

        /// <summary>Kuyruktaki her şey yazılana kadar bekler.</summary>
        public async Task CompleteAsync()
        {
            _channel.Writer.TryComplete();
            try { await _pump; } catch { /* zaten işlendi */ }
        }
    }
}
