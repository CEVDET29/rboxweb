using System.Collections.Concurrent;
using System.Net.Sockets;
using RboxAgent.Modules.Update;
using RboxAgent.Modules.Update.Services;

namespace RboxAgent.Modules.Control
{
    public sealed record CtlTarget(int Id, string Ip, bool NeedVersion);

    public sealed class CtlRefreshRequest
    {
        public List<CtlTarget> Targets { get; set; } = new();
    }

    /// <summary>Hasta sekmesi "Daha eskisini ara": HBSinyal ya da SolunumSinyal, aktif hasta.</summary>
    public sealed class CtlOlderRequest
    {
        public string Table { get; set; } = "";
        public int HastaId { get; set; }
    }

    public sealed class CtlExecRequest
    {
        /// <summary>restartSw | reboot | expand (komutlar burada sabittir; istemci komut gönderemez).</summary>
        public string Action { get; set; } = "";
        public List<CtlTarget> Targets { get; set; } = new();
    }

    /// <summary>Genel Cihaz Kontrol'ün ajan tarafı (WPF'teki ControlViewModel'in arayüzsüz karşılığı).</summary>
    internal static class ControlService
    {
        /// <summary>Aynı anda sorgulanan cihaz sayısı (tüm liste tek seferde SSH açmasın).</summary>
        private const int Parallel = 16;

        /// <summary>
        /// Tek SSH oturumunda okunan istatistikler ("ANAHTAR=değer" satırları). sudo gerektirmez.
        /// Ağ: arayüz başına IP/CIDR, ağ geçidi, MAC, durum; varsayılan rota arayüzü; Wi-Fi SSID ve sinyal.
        /// USB: takılı USB seri aygıtlar (ttyUSB0/ttyUSB1…): VID:PID, üretici, ürün, fiziksel port.
        /// </summary>
        private const string StatsCommand =
            "PATH=$PATH:/sbin:/usr/sbin; " +
            "echo \"UP=$(cut -d. -f1 /proc/uptime)\"; " +
            "echo \"TEMP=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)\"; " +
            "free -m | awk '/^Mem:/{print \"MEM=\"$3\"/\"$2}'; " +
            "df -Pm / | awk 'NR==2{print \"DISK=\"$3\"/\"$2}'; " +
            "echo \"LOAD=$(cut -d' ' -f1 /proc/loadavg)\"; " +
            "echo \"SW=$(systemctl is-active serialworker.service 2>/dev/null)\"; " +
            "echo \"HOST=$(hostname)\"; " +
            "echo \"CARD=$(lsblk -bdno SIZE /dev/mmcblk0 2>/dev/null)\"; " +
            "for t in /sys/class/tty/ttyUSB* /sys/class/tty/ttyACM*; do " +
            "[ -e \"$t\" ] || continue; n=${t##*/}; d=$(readlink -f \"$t/device\"); " +
            "while [ -n \"$d\" ] && [ \"$d\" != / ] && [ ! -f \"$d/idVendor\" ]; do d=$(dirname \"$d\"); done; " +
            "[ -f \"$d/idVendor\" ] && echo \"USB_$n=$(cat $d/idVendor):$(cat $d/idProduct)|$(cat $d/manufacturer 2>/dev/null)|$(cat $d/product 2>/dev/null)|${d##*/}\"; " +
            "done; " +
            "for i in wlan0 eth0; do " +
            "echo \"${i}_MAC=$(cat /sys/class/net/$i/address 2>/dev/null)\"; " +
            "echo \"${i}_UP=$(cat /sys/class/net/$i/operstate 2>/dev/null)\"; " +
            "echo \"${i}_IP=$(ip -o -4 addr show dev $i 2>/dev/null | awk '{print $4}' | head -n1)\"; " +
            "echo \"${i}_GW=$(ip route show dev $i 2>/dev/null | awk '/default/{print $3; exit}')\"; " +
            "done; " +
            "echo \"DEFIF=$(ip route show default 2>/dev/null | awk '{print $5; exit}')\"; " +
            "echo \"SSID=$(iwgetid -r 2>/dev/null || iw dev wlan0 link 2>/dev/null | awk -F': ' '/SSID/{print $2}')\"; " +
            "awk '/wlan0:/{gsub(/\\./,\"\",$3); gsub(/\\./,\"\",$4); print \"WQ=\"$3; print \"WDBM=\"$4}' /proc/net/wireless 2>/dev/null";

        /// <summary>Cihaz Güncelleme'nin versiyon kontrolüyle aynı komut (sudo, login kabuğu).</summary>
        private const string VersionCommand = "dotnet /var/www/consoleApps/publish/SerialWorkerServiceVol61.dll --version";

        // ExpandFsRebootStep ile aynı: oturum kapanmadan komut dönebilsin diye 3 sn gecikmeli
        private const string DelayedReboot =
            "command -v systemd-run >/dev/null 2>&1 " +
            "&& systemd-run --unit=rasyobox-delayed-reboot --on-active=3s /usr/bin/systemctl reboot " +
            "|| nohup sh -c 'sleep 3; systemctl reboot' >/dev/null 2>&1 &";

        private static int _busy;
        public static bool TryBegin() => Interlocked.CompareExchange(ref _busy, 1, 0) == 0;
        public static void End() => Volatile.Write(ref _busy, 0);

        private sealed record CtlAction(string Command, string DoneText, bool OnlineAfter, int TimeoutSeconds);

        private static CtlAction? Find(string action) => action switch
        {
            "restartSw" => new("systemctl restart serialworker.service", "SerialWorker yeniden başlatıldı", true, 40),
            "reboot" => new(DelayedReboot, "Yeniden başlatılıyor", false, 40),
            "expand" => new("raspi-config --expand-rootfs", "Yeniden başlatma gerekli", true, 60),
            _ => null,
        };

        public static bool IsKnownAction(string action) => Find(action) != null;

        private static async Task<bool> IsPortOpenAsync(string ip, int port, int timeoutMs)
        {
            try
            {
                using var tcp = new TcpClient();
                var connect = tcp.ConnectAsync(ip, port);
                return await Task.WhenAny(connect, Task.Delay(timeoutMs)) == connect && tcp.Connected;
            }
            catch { return false; }
        }

        private static Dictionary<string, string> ParseKeyValues(string output)
        {
            var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var line in output.Replace("\r\n", "\n").Split('\n'))
            {
                int i = line.IndexOf('=');
                if (i > 0) map[line[..i].Trim()] = line[(i + 1)..].Trim();
            }
            return map;
        }

        private static object State(string text, string sev, bool online, bool unreachable = false) =>
            new { text, sev, online, unreachable };

        // ── Yenileme ─────────────────────────────────────────────────────

        public static async Task RefreshAsync(CtlRefreshRequest req, NdjsonSink sink)
        {
            var (user, pass) = UpdateService.Credentials()!.Value;
            var ct = sink.Broken;
            int total = req.Targets.Count, done = 0;
            sink.Emit(new { type = "start", total });

            using var gate = new SemaphoreSlim(Parallel);
            try
            {
                await Task.WhenAll(req.Targets.Select(async t =>
                {
                    try { await gate.WaitAsync(ct); } catch (OperationCanceledException) { return; }
                    var updater = new SshUpdater(t.Ip, user, pass, UpdateService.WorkFolder, (_, _) => Task.CompletedTask);
                    try
                    {
                        sink.Emit(new { type = "busy", id = t.Id });
                        if (!await IsPortOpenAsync(t.Ip, 22, 2000))
                        {
                            sink.Emit(new { type = "device", id = t.Id, state = State("Ulaşılamıyor", "error", false, true) });
                            return;
                        }

                        using var client = await Task.Run(() => updater.Connect(5), ct);
                        if (!client.IsConnected)
                        {
                            sink.Emit(new { type = "device", id = t.Id, state = State("SSH bağlanamadı", "error", false, true) });
                            return;
                        }

                        var values = await Task.Run(() =>
                        {
                            using var cmd = client.CreateCommand(StatsCommand);
                            cmd.CommandTimeout = TimeSpan.FromSeconds(10);
                            return ParseKeyValues(cmd.Execute());
                        }, ct);

                        // Sürüm: dotnet --version Pi 3'te birkaç saniye sürer; yalnızca istenirse (ilk okuma / servis yeniden başlayınca) okunur
                        string? version = null;
                        if (t.NeedVersion)
                        {
                            var (ok, stdout, _) = await updater.ExecuteSudoGetOutputAsync(client, VersionCommand, t.Ip, ct, 15);
                            string ver = (stdout ?? "").Replace("\r", "").Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0) ?? "";
                            version = ok && ver.Length > 0 ? ver : "";
                        }

                        sink.Emit(new { type = "device", id = t.Id, state = State("Çevrimiçi", "ok", true), values, version });
                    }
                    catch (OperationCanceledException) { }
                    catch (Renci.SshNet.Common.SshAuthenticationException)
                    {
                        sink.Emit(new { type = "device", id = t.Id, state = State("SSH kimlik doğrulama hatası", "error", false, true) });
                    }
                    catch (Renci.SshNet.Common.SshOperationTimeoutException)
                    {
                        sink.Emit(new { type = "device", id = t.Id, state = State("Zaman aşımı", "warn", false, true) });
                    }
                    catch (Exception ex)
                    {
                        sink.Emit(new { type = "device", id = t.Id, state = State("Hata: " + ex.GetType().Name, "error", false, true) });
                    }
                    finally
                    {
                        updater.CleanupTempFolder();
                        gate.Release();
                        sink.Emit(new { type = "progress", done = Interlocked.Increment(ref done), total });
                    }
                }));
            }
            finally { sink.Emit(new { type = "done", cancelled = ct.IsCancellationRequested }); }
        }

        // ── Komutlar (SerialWorker yeniden başlat / cihazı yeniden başlat / depolamayı genişlet) ──

        public static async Task ExecAsync(CtlExecRequest req, NdjsonSink sink)
        {
            var (user, pass) = UpdateService.Credentials()!.Value;
            var act = Find(req.Action)!;
            var ct = sink.Broken;
            sink.Emit(new { type = "start", total = req.Targets.Count });

            using var gate = new SemaphoreSlim(Parallel);
            try
            {
                await Task.WhenAll(req.Targets.Select(async t =>
                {
                    try { await gate.WaitAsync(ct); } catch (OperationCanceledException) { return; }
                    var updater = new SshUpdater(t.Ip, user, pass, UpdateService.WorkFolder, (_, _) => Task.CompletedTask);
                    try
                    {
                        sink.Emit(new { type = "busy", id = t.Id });
                        if (!await IsPortOpenAsync(t.Ip, 22, 2000))
                        {
                            sink.Emit(new { type = "device", id = t.Id, ok = false, state = State("Ulaşılamıyor", "error", false, true) });
                            return;
                        }

                        using var client = await Task.Run(() => updater.Connect(5), ct);
                        if (!client.IsConnected)
                        {
                            sink.Emit(new { type = "device", id = t.Id, ok = false, state = State("SSH bağlanamadı", "error", false, true) });
                            return;
                        }

                        var (ok, _, err) = await updater.ExecuteSudoGetOutputAsync(client, act.Command, t.Ip, CancellationToken.None, act.TimeoutSeconds);
                        sink.Emit(new
                        {
                            type = "device", id = t.Id, ok,
                            state = State(ok ? act.DoneText : "Komut başarısız", ok ? "info" : "error", ok && act.OnlineAfter),
                            error = ok ? null : updater.Redact(err).Trim(),
                        });
                    }
                    catch (Exception ex)
                    {
                        sink.Emit(new { type = "device", id = t.Id, ok = false, state = State("Hata: " + updater.Redact(ex.GetType().Name), "error", false, true) });
                    }
                    finally
                    {
                        updater.CleanupTempFolder();
                        gate.Release();
                    }
                }));
            }
            finally { sink.Emit(new { type = "done" }); }
        }
    }
}
