using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;

namespace RboxAgent.Modules.Ping
{
    public sealed record RowIn(int Id, string? Ip, string? Mac);

    public sealed class RunRequest
    {
        public List<RowIn> Rows { get; set; } = new();
        /// <summary>false: tabloyu sıfırlamadan sessiz tarama (izleme modu).</summary>
        public bool Quiet { get; set; }
    }

    public sealed record Cell(string Text, string Sev);
    public sealed record MacCell(string Text, string Source, string Sev);

    /// <summary>Tarayıcıya giden tek satırlık sonuç. Metin ve renkleri ajan üretir; arayüz sadece çizer.</summary>
    public sealed class ItemResult
    {
        public string Type { get; init; } = "item";
        public int Id { get; init; }
        public bool IpValid { get; init; }
        public bool? PingOk { get; init; }
        public long PingSort { get; init; }
        public Cell Ping { get; init; } = new("—", "muted");
        public Cell Ssh { get; init; } = new("—", "muted");
        public MacCell Mac { get; init; } = new("—", "", "muted");
        public Cell Vendor { get; init; } = new("—", "muted");
        public Cell Status { get; init; } = new("", "none");
        public bool? MacMatch { get; init; }
        public bool HasProblem { get; init; }
        public string Signature { get; init; } = "";
        public string? Error { get; init; }
    }

    public static class PingService
    {
        private static readonly ConcurrentDictionary<string, CancellationTokenSource> Runs = new();
        private static readonly Regex SafeSshUser = new(@"^[A-Za-z0-9._-]+$");
        private const string Dash = "—";

        public static bool Cancel(string runId)
        {
            if (!Runs.TryGetValue(runId, out var cts)) return false;
            try { cts.Cancel(); } catch (ObjectDisposedException) { }
            return true;
        }

        public static CheckOptions BuildOptions(PingSettings s, SshSettings ssh) => new(
            CheckSsh: s.CheckSsh,
            CheckMac: s.CheckMac,
            CheckVendor: s.CheckVendor,
            SshMacFallback: s.SshMacFallback,
            SshUser: ssh.User.Trim(),
            SshPass: DataStore.Unprotect(ssh.PassProtected),
            PingTimeoutMs: s.PingTimeoutMs,
            TcpTimeoutMs: s.TcpTimeoutMs,
            SshTimeoutMs: s.SshTimeoutMs);

        /// <summary>
        /// Satırları en fazla Concurrency eşzamanlı kontrol eder; her sonuç biter bitmez emit edilir.
        /// Paket yok: bir cihaz biter bitmez sıradaki başlar (WPF sürümüyle aynı).
        /// </summary>
        public static async Task RunAsync(string runId, RunRequest req, Func<object, Task> emit, CancellationToken clientGone)
        {
            var settings = DataStore.Settings.Ping;
            var opt = BuildOptions(settings, DataStore.Settings.Ssh);
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(clientGone);
            Runs[runId] = cts;
            var ct = cts.Token;

            try
            {
                await OuiPreloadAsync();
                using var gate = new SemaphoreSlim(Math.Max(1, settings.Concurrency));
                var emitLock = new SemaphoreSlim(1, 1);

                async Task Safe(object o)
                {
                    await emitLock.WaitAsync();
                    try { await emit(o); }
                    catch { cts.Cancel(); }      // istemci koptu
                    finally { emitLock.Release(); }
                }

                await Task.WhenAll(req.Rows.Select(async row =>
                {
                    try
                    {
                        await gate.WaitAsync(ct);
                        try
                        {
                            await Safe(new { type = "running", id = row.Id });
                            var r = await DeviceChecker.CheckAsync(row.Ip ?? "", row.Mac, opt, ct);
                            await Safe(Present(row.Id, r));
                        }
                        finally { gate.Release(); }
                    }
                    catch (OperationCanceledException)
                    {
                        await Safe(new { type = "cancelled", id = row.Id });
                    }
                    catch (Exception ex)
                    {
                        await Safe(new ItemResult
                        {
                            Id = row.Id,
                            Error = ex.GetType().Name,
                            Status = new Cell("Hata: " + ex.GetType().Name, "error"),
                            PingSort = long.MaxValue,
                        });
                    }
                }));

                await Safe(new { type = "done", cancelled = ct.IsCancellationRequested });
            }
            finally
            {
                Runs.TryRemove(runId, out _);
            }
        }

        private static Task OuiPreloadAsync() => Task.Run(OuiLookup.Preload);

        // ── Sunum (WPF'teki DeviceItem.ApplyResult / DescribeStatus ile aynı kurallar) ───────

        private static ItemResult Present(int id, DeviceCheckResult r)
        {
            Cell ping; long sort;
            if (!r.IpValid) { ping = new(Dash, "muted"); sort = long.MaxValue; }
            else if (r.PingMs is long ms) { ping = new(ms < 1 ? "<1 ms" : $"{ms} ms", "ok"); sort = ms; }
            else { ping = new("Yanıt yok", "warn"); sort = long.MaxValue - 1; }

            Cell ssh = r.SshOpen switch
            {
                true => new("Açık", "ok"),
                false => new("Kapalı", "warn"),
                null => new(Dash, "muted"),
            };

            MacCell mac;
            if (r.DetectedMac != null)
                mac = new(r.DetectedMac, r.MacViaSsh ? "SSH" : "ARP", r.MacMatch == false ? "error" : "none");
            else
                mac = new(r.MacChecked && r.IpValid ? "Okunamadı" : Dash, "", "muted");

            Cell vendor = string.IsNullOrEmpty(r.Vendor)
                ? new(Dash, "muted")
                : new(r.Vendor, r.Vendor.Contains("Raspberry", StringComparison.OrdinalIgnoreCase) ? "none" : "warn");

            return new ItemResult
            {
                Id = id,
                IpValid = r.IpValid,
                PingOk = r.PingOk,
                PingSort = sort,
                Ping = ping,
                Ssh = ssh,
                Mac = mac,
                Vendor = vendor,
                Status = DescribeStatus(r),
                MacMatch = r.MacMatch,
                HasProblem = r.HasProblem,
                Signature = r.Signature,
            };
        }

        private static Cell DescribeStatus(DeviceCheckResult r)
        {
            if (!r.IpValid) return new("Geçersiz IP", "error");

            if (r.MacMatch == false)
            {
                bool bothPi = IsRaspberry(r.ExcelMacDisplay) && IsRaspberry(r.DetectedMac);
                return new(bothPi ? "Başka bir Pi" : "Farklı cihaz", "error");
            }

            if (r.PingOk != true && r.SshOpen != true) return new("Ulaşılamıyor", "warn");
            if (r.SshOpen == false) return new("SSH kapalı", "warn");
            if (r.MacChecked && r.DetectedMac == null) return new("MAC okunamadı", "warn");
            if (r.ExcelMacDisplay.Length > 0 && !r.ExcelMacValid) return new("Excel MAC geçersiz", "warn");
            if (r.MacMatch == true) return new("Eşleşiyor", "ok");
            return new("Erişilebilir", "ok");
        }

        private static bool IsRaspberry(string? mac) =>
            !string.IsNullOrEmpty(mac) && OuiLookup.GetVendor(mac).Contains("Raspberry", StringComparison.OrdinalIgnoreCase);

        // ── Yardımcılar ──────────────────────────────────────────────────────

        /// <summary>Excel satırı → API çıktısı.</summary>
        public static object ToRowDto(DeviceRow r)
        {
            string ip = r.Ip?.Trim() ?? "";
            string mac = MacAddress.ToDisplay(r.Mac);
            long key = long.MaxValue;
            if (IPAddress.TryParse(ip, out var a) && a.AddressFamily == AddressFamily.InterNetwork)
            {
                var b = a.GetAddressBytes();
                key = ((long)b[0] << 24) | ((long)b[1] << 16) | ((long)b[2] << 8) | b[3];
            }
            return new
            {
                oda = r.OdaAdi?.Trim() ?? "",
                yatak = r.YatakAdi ?? "",
                yatakId = r.YatakId ?? "",
                ip,
                ipSort = key,
                mac,
                macInvalid = mac.Length > 0 && !MacAddress.IsValid(mac),
            };
        }

        /// <summary>SSH terminalini sunucuda açar (WPF'teki "SSH ile bağlan").</summary>
        public static bool OpenSsh(string ipText, string user)
        {
            if (!IPAddress.TryParse(ipText, out var ip)) return false;
            string target = SafeSshUser.IsMatch(user) ? $"{user}@{ip}" : ip.ToString();
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("ssh", target) { UseShellExecute = true });
            return true;
        }
    }
}
