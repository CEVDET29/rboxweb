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
        /// <summary>restartSw | reboot | expand | swOn/swOff | webOn/webOff | tuiOn/tuiOff | cronOn/cronOff | loginB1..B4
        /// (komutlar burada sabittir; istemci komut gönderemez).</summary>
        public string Action { get; set; } = "";
        public List<CtlTarget> Targets { get; set; } = new();
    }

    /// <summary>TTY ekranı: Data yalnız gönderimde (base64 bayt; ör. "ls\r", Alt+R = ESC 'r').</summary>
    public sealed class CtlTtyRequest
    {
        public string Ip { get; set; } = "";
        public int Tty { get; set; } = 2;
        public string? Data { get; set; }
    }

    /// <summary>Genel Cihaz Kontrol'ün ajan tarafı (WPF'teki ControlViewModel'in arayüzsüz karşılığı).</summary>
    internal static class ControlService
    {
        // ── TTY ekranı (WPF TtyWindow karşılığı) ─────────────────────────
        // IP başına açık tutulan SSH bağlantısı; panel ~1 sn'de bir okur. 30 sn kullanılmayan bağlantı kapanır
        // (panel kapandı / sekme gitti). Diğer işlemlerden bağımsızdır (TryBegin kilidine girmez).
        private static readonly ConcurrentDictionary<string, TtyConsole> Ttys = new();
        private static readonly Timer TtySweep = new(_ =>
        {
            foreach (var (ip, c) in Ttys)
                if (DateTime.UtcNow - c.LastUsed > TimeSpan.FromSeconds(30) && Ttys.TryRemove(ip, out var old)) old.Dispose();
        }, null, TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(10));

        public static bool IsValidIp(string ip) =>
            System.Net.IPAddress.TryParse(ip, out var a) && a.AddressFamily == AddressFamily.InterNetwork && ip.Split('.').Length == 4;

        private static TtyConsole Tty(string ip)
        {
            var (user, pass) = UpdateService.Credentials()!.Value;
            return Ttys.GetOrAdd(ip, _ => new TtyConsole(ip, user, pass, UpdateService.WorkFolder));
        }

        public static async Task<object> TtyReadAsync(CtlTtyRequest r, CancellationToken ct)
        {
            var f = await Tty(r.Ip).ReadAsync(r.Tty, ct);
            return new { tty = f.Tty, rows = f.Rows, cols = f.Cols, cursorX = f.CursorX, cursorY = f.CursorY,
                         activeTty = f.ActiveTty, lines = f.Lines, attrs = Convert.ToBase64String(f.Attrs) };
        }

        public static Task TtySendAsync(CtlTtyRequest r, CancellationToken ct) =>
            Tty(r.Ip).SendAsync(r.Tty, Convert.FromBase64String(r.Data ?? ""), ct);

        public static void TtyClose(string ip)
        {
            if (Ttys.TryRemove(ip, out var c)) c.Dispose();
        }

        /// <summary>Aynı anda sorgulanan cihaz sayısı (tüm liste tek seferde SSH açmasın).</summary>
        private const int Parallel = 16;

        /// <summary>
        /// Tek SSH oturumunda okunan istatistikler ("ANAHTAR=değer" satırları). sudo gerektirmez.
        /// Ağ: arayüz başına IP/CIDR, ağ geçidi, MAC, durum; varsayılan rota arayüzü; Wi-Fi SSID ve sinyal.
        /// USB: takılı USB seri aygıtlar (ttyUSB0/ttyUSB1…): VID:PID, üretici, ürün, fiziksel port.
        /// İşlemci: /proc/stat 0,5 sn arayla (CPU, NCPU). HDMI: kablo durumu + monitör EDID'i (HDMI_…, TVS/TVN).
        /// Komut WPF ControlViewModel.StatsCommand ile aynı tutulur.
        /// </summary>
        private const string StatsCommand =
            "PATH=$PATH:/sbin:/usr/sbin; " +
            "echo \"UP=$(cut -d. -f1 /proc/uptime)\"; " +
            "echo \"TEMP=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)\"; " +
            "free -m | awk '/^Mem:/{print \"MEM=\"$3\"/\"$2}'; " +
            "df -Pm / | awk 'NR==2{print \"DISK=\"$3\"/\"$2}'; " +
            "echo \"LOAD=$(cut -d' ' -f1 /proc/loadavg)\"; " +
            // İşlemci kullanımı: /proc/stat iki kez (0,5 sn arayla); "toplam boşta" çiftleri, yüzde C# tarafında
            "c1=$(awk '/^cpu /{t=0; for(i=2;i<=NF;i++) t+=$i; print t, $5+$6}' /proc/stat); sleep 0.5; " +
            "c2=$(awk '/^cpu /{t=0; for(i=2;i<=NF;i++) t+=$i; print t, $5+$6}' /proc/stat); " +
            "echo \"CPU=$c1 $c2\"; echo \"NCPU=$(nproc 2>/dev/null)\"; " +
            // SerialWorker: şu an çalışıyor mu | açılışta etkin mi (not-found = servis kurulu değil)
            "echo \"SW=$(systemctl is-active serialworker.service 2>/dev/null)|$(systemctl is-enabled serialworker.service 2>&1 | head -n1)\"; " +
            // cron.service: açılışta etkin mi | şu an çalışıyor mu (salt okunur; Cihaz Güncelleme enable/disable eder)
            "echo \"CRON=$(systemctl is-enabled cron.service 2>&1 | head -n1)|$(systemctl is-active cron.service 2>/dev/null)\"; " +
            // swtui: kur.sh /usr/local/bin/swtui → ~/rasyobox-tui/swtui bağı kurar; sürüm rasyobox_tui.py'den (boş = kurulu değil)
            "p=$(readlink -f /usr/local/bin/swtui 2>/dev/null); tv=; if [ -f \"$p\" ]; then tv=$(grep -m1 '^__version__' \"${p%/*}/rasyobox_tui.py\" 2>/dev/null | tr -dc '0-9.'); tv=${tv:-?}; fi; " +
            "echo \"TUI=$tv|$(systemctl is-active swtui.service 2>/dev/null)|$(systemctl is-enabled swtui.service 2>&1 | head -n1)\"; " +
            // RasyoBOX web arayüzü: açılışta etkin mi | şu an çalışıyor mu | 80 portu dinleniyor mu (ss yoksa ?)
            "echo \"WEB=$(systemctl is-enabled rasyobox-web.service 2>&1 | head -n1)|$(systemctl is-active rasyobox-web.service 2>/dev/null)|" +
            "$(command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '$4 ~ /:80$/{f=1} END{print f?\"open\":\"closed\"}' || echo '?')\"; " +
            // Otomatik giriş (raspi-config Boot / Auto Login): raspi-config var mı | console/desktop | giren kullanıcı (boş = kapalı).
            // Masaüstü ölçütü raspi-config get_boot_cli ile aynı: varsayılan hedef graphical ve lightdm etkin.
            // Konsol: getty@tty1 autologin.conf (--autologin <kullanıcı>); masaüstü: lightdm.conf autologin-user=
            "m=console; [ \"$(systemctl get-default 2>/dev/null)\" = graphical.target ] && systemctl is-enabled --quiet lightdm 2>/dev/null && m=desktop; a=; " +
            "if [ $m = desktop ]; then a=$(sed -n 's/^autologin-user=//p' /etc/lightdm/lightdm.conf 2>/dev/null | head -n1); " +
            "else f=/etc/systemd/system/getty@tty1.service.d/autologin.conf; if [ -f $f ]; then a=$(grep -o -e '--autologin [^ ]*' $f | head -n1 | cut -d' ' -f2); a=${a:-?}; fi; fi; " +
            "echo \"LOGIN=$(command -v raspi-config >/dev/null 2>&1 && echo yes || echo no)|$m|$a\"; " +
            "echo \"HOST=$(hostname)\"; " +
            "echo \"CARD=$(lsblk -bdno SIZE /dev/mmcblk0 2>/dev/null)\"; " +
            // USB seri portlar (ttyUSB0/ttyUSB1…, ttyACM0…): sysfs'te USB aygıtına çıkılıp VID:PID, üretici, ürün ve
            // fiziksel port okunur. lsusb gerekmez. Satır: USB_ttyUSB0=0403:6001|FTDI|FT232R USB UART|1-1.2
            "for t in /sys/class/tty/ttyUSB* /sys/class/tty/ttyACM*; do " +
            "[ -e \"$t\" ] || continue; n=${t##*/}; d=$(readlink -f \"$t/device\"); " +
            "while [ -n \"$d\" ] && [ \"$d\" != / ] && [ ! -f \"$d/idVendor\" ]; do d=$(dirname \"$d\"); done; " +
            "[ -f \"$d/idVendor\" ] && echo \"USB_$n=$(cat $d/idVendor):$(cat $d/idProduct)|$(cat $d/manufacturer 2>/dev/null)|$(cat $d/product 2>/dev/null)|${d##*/}\"; " +
            "done; " +
            // HDMI: KMS sürücüsünde (Bookworm, vc4-kms-v3d) her bağlantı noktasının durumu ve monitörün EDID'i sysfs'te.
            // Satır: HDMI_card1-HDMI-A-1=connected|<EDID base64>|<ilk mod (önerilen)>|<mod sayısı>.
            // Eski firmware sürücüsünde tvservice (-s durum + çözünürlük, -n monitör adı).
            "for s in /sys/class/drm/card*-HDMI-A-*; do [ -e \"$s/status\" ] || continue; " +
            "echo \"HDMI_${s##*/}=$(cat \"$s/status\" 2>/dev/null)|$(base64 -w0 \"$s/edid\" 2>/dev/null)|$(head -n1 \"$s/modes\" 2>/dev/null)|$(wc -l < \"$s/modes\" 2>/dev/null)\"; done; " +
            // Aktif çözünürlük (görüntü belleği), çekirdek satırındaki video= ve config.txt'deki etkin hdmi_* ayarları
            "echo \"FB=$(head -n1 /sys/class/graphics/fb0/modes 2>/dev/null)|$(cat /sys/class/graphics/fb0/virtual_size 2>/dev/null)\"; " +
            "echo \"VIDEO=$(grep -o 'video=[^ ]*' /proc/cmdline 2>/dev/null | tr '\\n' ' ')\"; " +
            "echo \"HCFG=$(grep -hE '^[[:space:]]*hdmi_[a-z_]+(:[0-9])?[[:space:]]*=' /boot/config.txt /boot/firmware/config.txt 2>/dev/null | tr -d ' \\t\\r' | tr '\\n' ' ')\"; " +
            "TV=$(command -v tvservice || ls /opt/vc/bin/tvservice 2>/dev/null); " +
            "if [ -n \"$TV\" ]; then echo \"TVS=$($TV -s 2>&1 | head -n1)\"; echo \"TVN=$($TV -n 2>&1 | head -n1)\"; fi; " +
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
            // Karedeki tıklama: servisi kalıcı olarak aç / kapat (WPF ControlViewModel.Toggle*). Sonuç gerçek son duruma göre.
            "swOn" => Svc("serialworker.service", "SerialWorker", true, false),
            "swOff" => Svc("serialworker.service", "SerialWorker", false, false),
            "webOn" => Svc("rasyobox-web.service", "RasyoBOX web arayüzü", true, false),
            "webOff" => Svc("rasyobox-web.service", "RasyoBOX web arayüzü", false, false),
            "tuiOn" => Svc("swtui.service", "swtui (TUI)", true, false),
            "tuiOff" => Svc("swtui.service", "swtui (TUI)", false, false),
            "cronOn" => Svc("cron.service", "cron", true, true),
            "cronOff" => Svc("cron.service", "cron", false, true),
            // Otomatik giriş: raspi-config nonint do_boot_behaviour (konsol B1 kapalı / B2 açık, masaüstü B3 / B4)
            "loginB1" => Login("B1", false, false), "loginB2" => Login("B2", true, false),
            "loginB3" => Login("B3", false, true), "loginB4" => Login("B4", true, true),
            _ => null,
        };

        private static CtlAction Svc(string unit, string name, bool enable, bool sysvFallback) =>
            new(ServiceToggleCommand(unit, enable, sysvFallback), enable ? $"{name} açıldı" : $"{name} kapatıldı", true, 60);

        private static CtlAction Login(string opt, bool on, bool desktop)
        {
            const string conf = "/etc/systemd/system/getty@tty1.service.d/autologin.conf";
            const string lightdm = "grep -q '^autologin-user=' /etc/lightdm/lightdm.conf";
            string check = desktop ? (on ? lightdm : "! " + lightdm) : (on ? $"[ -f {conf} ]" : $"[ ! -f {conf} ]");
            return new($"raspi-config nonint do_boot_behaviour {opt}; {check}",
                       on ? "Otomatik giriş açıldı · yeniden başlatma gerekli" : "Otomatik giriş kapatıldı · yeniden başlatma gerekli", true, 60);
        }

        /// <summary>
        /// WPF ControlViewModel.ServiceToggleCommand ile aynı. Açılış ayarı ile başlat/durdur ayrı komutlar: biri düşse de
        /// diğeri yapılır. sysvFallback (cron): bozuk perl'li cihazda update-rc.d düşerse SysV senkronu atlanır, o da olmazsa
        /// wants bağı elle kurulur/kaldırılır. Çıkış kodu gerçek son duruma göredir (is-enabled + is-active).
        /// </summary>
        private static string ServiceToggleCommand(string unit, bool enable, bool sysvFallback)
        {
            string wants = "/etc/systemd/system/multi-user.target.wants/" + unit;
            string boot = enable ? $"systemctl enable {unit}" : $"systemctl disable {unit}";
            if (sysvFallback)
            {
                string manual = enable
                    ? $"[ -f /lib/systemd/system/{unit} ] && ln -sf /lib/systemd/system/{unit} {wants} && systemctl daemon-reload"
                    : $"rm -f {wants} && systemctl daemon-reload";
                boot = $"{boot} || SYSTEMCTL_SKIP_SYSV=1 {boot} || {{ {manual}; }}";
            }
            return enable
                ? $"systemctl unmask {unit} 2>/dev/null; {boot}; systemctl start {unit}; " +
                  $"systemctl is-enabled --quiet {unit} && systemctl is-active --quiet {unit}"
                : $"{boot}; systemctl stop {unit}; " +
                  $"! systemctl is-enabled --quiet {unit} && ! systemctl is-active --quiet {unit}";
        }

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
