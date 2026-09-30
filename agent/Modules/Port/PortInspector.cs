using System.Diagnostics;
using System.Management;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Security;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Microsoft.Win32;
using RboxAgent.Modules.Ping;

namespace RboxAgent.Modules.Port
{
    // NOT: Bu dosya WPF (RboxTools/Modules/Port) ile web ajanında (RboxWeb/agent/Modules/Port) aynıdır;
    // yalnızca namespace farklıdır. Birinde değişiklik yapınca diğerine de kopyalayın.

    /// <summary>
    /// Port Kontrol: bir port ya da uygulama (.exe) adı için bu bilgisayarda hangi sürecin dinlediğini,
    /// sürecin ayrıntılarını (yol, sürüm, hizmet, kullanıcı, komut satırı), bağlantıları ve güvenlik duvarı
    /// kurallarını; uzak bilgisayar için port açık mı, bilgisayar adı, işletim sistemi tahmini, MAC ve
    /// servis tanıtım bilgisini (SSH / HTTP / TLS / SQL Browser) toplar. Hiçbir şeyi değiştirmez.
    /// </summary>
    public static class PortInspector
    {
        public const int MaxRemotePorts = 64;

        /// <summary>Uzak bilgisayar için sorgu boşsa taranan yaygın portlar.</summary>
        public static readonly int[] CommonPorts = { 22, 80, 135, 139, 443, 445, 1433, 2575, 3389, 5900, 7070, 8080, 47800 };

        private static readonly Dictionary<int, string> WellKnown = new()
        {
            [20] = "FTP veri", [21] = "FTP", [22] = "SSH", [23] = "Telnet", [25] = "SMTP", [53] = "DNS",
            [67] = "DHCP sunucu", [68] = "DHCP istemci", [80] = "HTTP", [104] = "DICOM", [110] = "POP3",
            [123] = "NTP (saat)", [135] = "Windows RPC", [137] = "NetBIOS ad", [138] = "NetBIOS datagram",
            [139] = "NetBIOS oturum", [143] = "IMAP", [161] = "SNMP", [389] = "LDAP", [443] = "HTTPS",
            [445] = "SMB (dosya paylaşımı)", [500] = "IPsec/IKE", [514] = "Syslog", [636] = "LDAPS",
            [1433] = "SQL Server", [1434] = "SQL Server Browser", [1521] = "Oracle", [1900] = "SSDP / UPnP",
            [2049] = "NFS", [2575] = "HL7 (MLLP)", [3306] = "MySQL", [3389] = "Uzak Masaüstü (RDP)",
            [4500] = "IPsec NAT-T", [5353] = "mDNS", [5355] = "LLMNR", [5432] = "PostgreSQL", [5900] = "VNC",
            [5985] = "WinRM (HTTP)", [5986] = "WinRM (HTTPS)", [6379] = "Redis", [6568] = "AnyDesk (keşif)",
            [7070] = "AnyDesk", [8080] = "HTTP (alternatif)", [8443] = "HTTPS (alternatif)", [9100] = "Yazıcı (RAW)",
            [11112] = "DICOM", [27017] = "MongoDB",
        };

        private static readonly HashSet<int> HttpPorts = new() { 80, 8000, 8080, 8081, 8088, 8888, 5000, 5985, 47800, 47801, 47802 };
        private static readonly HashSet<int> TlsPorts = new() { 443, 8443, 636, 993, 995, 5986 };

        public static string ServiceName(int port) =>
            WellKnown.TryGetValue(port, out var s) ? s
            : port is >= 47800 and <= 47809 ? "RasyoBOX Ajan"
            : port >= 49152 ? "Dinamik (geçici) port"
            : "";

        // ══════════════════════════════════════════════════════════════════════
        //  Giriş
        // ══════════════════════════════════════════════════════════════════════

        /// <param name="query">"1433", "80,443", "8000-8010", "sqlservr.exe", "anydesk" ya da boş</param>
        /// <param name="host">Boş = bu bilgisayar; IP ya da bilgisayar adı = uzak bilgisayar</param>
        public static async Task<PortReport> InspectAsync(string? query, string? host, CancellationToken ct = default)
        {
            var sw = Stopwatch.StartNew();
            var q = ParseQuery(query);
            var report = new PortReport { Query = (query ?? "").Trim(), Host = (host ?? "").Trim() };
            if (q.Error != null) { report.Notes.Add(q.Error); report.Ok = false; return report; }

            report.Ports = q.Ports;
            report.Names = q.Names;

            IPAddress[] addrs = Array.Empty<IPAddress>();
            bool local = string.IsNullOrWhiteSpace(host);
            if (!local)
            {
                (addrs, var err) = await ResolveAsync(host!.Trim(), ct);
                if (err != null) { report.Notes.Add(err); report.Ok = false; return report; }
                local = addrs.Any(IsLocalAddress);
            }

            if (local)
            {
                report.Mode = "local";
                await Task.Run(() => InspectLocal(report, q), ct);
                // SQL Server kurulumunu da göster (1433/1434 sorulduysa ya da SQL süreci arandıysa)
                if (q.Ports.Contains(1433) || q.Ports.Contains(1434) || report.Processes.Any(p => p.Name.StartsWith("sqlservr", StringComparison.OrdinalIgnoreCase)))
                {
                    report.SqlInstances = await SqlBrowserAsync(IPAddress.Loopback, ct);
                    foreach (var p in report.Processes.Where(p => p.Name.StartsWith("sqlservr", StringComparison.OrdinalIgnoreCase)
                                                                  && !p.Listening.Contains("TCP")))
                        report.Notes.Add($"{p.Name} (PID {p.Pid}, {string.Join(", ", p.Services.Select(s => s.Name))}) TCP portu dinlemiyor: "
                                         + "ağdan bağlanılamaz. SQL Server Configuration Manager → Protokoller → TCP/IP'yi etkinleştirip hizmeti yeniden başlatın.");
                    if (report.SqlInstances.Count == 0)
                        report.Notes.Add("SQL Server Browser (UDP 1434) yanıt vermedi: hizmet kapalı olabilir. Adlandırılmış örneklere (SUNUCU\\SQLEXPRESS) başka bilgisayardan bağlanmak için gerekir.");
                }
            }
            else
            {
                report.Mode = "remote";
                if (q.Names.Count > 0)
                {
                    report.Notes.Add("Uzak bilgisayarda uygulama adıyla arama yapılamaz (süreç listesi yalnızca bu bilgisayarda okunur). Port numarası girin.");
                    report.Ok = false;
                    return report;
                }
                await InspectRemoteAsync(report, host!.Trim(), addrs, q.Ports.Count > 0 ? q.Ports : CommonPorts.ToList(), ct);
            }

            report.ElapsedMs = sw.ElapsedMilliseconds;
            return report;
        }

        // ── Sorgu çözümleme ───────────────────────────────────────────────────

        private sealed class ParsedQuery
        {
            public List<int> Ports { get; } = new();
            public List<string> Names { get; } = new();
            public string? Error { get; set; }
        }

        private static ParsedQuery ParseQuery(string? query)
        {
            var r = new ParsedQuery();
            foreach (var raw in (query ?? "").Split(new[] { ',', ';', ' ' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var t = raw.Trim();
                var dash = t.IndexOf('-');
                if (int.TryParse(t, out var p))
                {
                    if (p is < 1 or > 65535) { r.Error = $"Geçersiz port: {t} (1-65535)"; return r; }
                    if (!r.Ports.Contains(p)) r.Ports.Add(p);
                }
                else if (dash > 0 && int.TryParse(t[..dash], out var a) && int.TryParse(t[(dash + 1)..], out var b))
                {
                    if (a is < 1 or > 65535 || b is < 1 or > 65535 || b < a) { r.Error = $"Geçersiz port aralığı: {t}"; return r; }
                    if (b - a >= 1024) { r.Error = "Port aralığı en fazla 1024 port olabilir."; return r; }
                    for (int i = a; i <= b; i++) if (!r.Ports.Contains(i)) r.Ports.Add(i);
                }
                else
                {
                    var n = t.Trim('"');
                    if (n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) n = n[..^4];
                    if (n.Length > 0 && !r.Names.Contains(n, StringComparer.OrdinalIgnoreCase)) r.Names.Add(n);
                }
            }
            return r;
        }

        private static async Task<(IPAddress[] addrs, string? error)> ResolveAsync(string host, CancellationToken ct)
        {
            if (IPAddress.TryParse(host, out var ip)) return (new[] { ip }, null);
            try
            {
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                cts.CancelAfter(4000);
                var list = await Dns.GetHostAddressesAsync(host, cts.Token);
                list = list.Where(a => a.AddressFamily == AddressFamily.InterNetwork)
                           .Concat(list.Where(a => a.AddressFamily == AddressFamily.InterNetworkV6)).ToArray();
                return list.Length > 0 ? (list, null) : (list, $"'{host}' adı çözülemedi.");
            }
            catch (Exception) when (!ct.IsCancellationRequested)
            {
                return (Array.Empty<IPAddress>(), $"'{host}' adı çözülemedi (DNS / NetBIOS'ta bulunamadı). IP adresi girmeyi deneyin.");
            }
        }

        private static bool IsLocalAddress(IPAddress a)
        {
            if (IPAddress.IsLoopback(a)) return true;
            try
            {
                return NetworkInterface.GetAllNetworkInterfaces()
                    .SelectMany(n => n.GetIPProperties().UnicastAddresses)
                    .Any(u => u.Address.Equals(a));
            }
            catch { return false; }
        }

        // ══════════════════════════════════════════════════════════════════════
        //  Bu bilgisayar
        // ══════════════════════════════════════════════════════════════════════

        private static void InspectLocal(PortReport report, ParsedQuery q)
        {
            report.Machine = LocalMachine();
            var all = ReadEndpoints();
            var httpUrls = ResolveHttpSys(all);

            // Aranan süreçler: süreç adı ya da (Windows hizmeti adı / görünen adı) eşleşenler
            var services = ReadServices();
            var namePids = new HashSet<int>();
            if (q.Names.Count > 0)
            {
                foreach (var p in SafeProcesses())
                    if (q.Names.Any(n => p.name.Contains(n, StringComparison.OrdinalIgnoreCase))) namePids.Add(p.pid);
                foreach (var s in services)
                    if (s.ProcessId > 0 && q.Names.Any(n => s.Name.Contains(n, StringComparison.OrdinalIgnoreCase)
                                                        || s.DisplayName.Contains(n, StringComparison.OrdinalIgnoreCase)))
                        namePids.Add(s.ProcessId);
            }

            List<EndpointRow> rows;
            if (q.Ports.Count == 0 && q.Names.Count == 0)
                rows = all.Where(e => e.State == "LISTEN" || e.Protocol.StartsWith("UDP")).ToList();   // boş sorgu: dinlenen tüm portlar
            else
                rows = all.Where(e => q.Ports.Contains(e.LocalPort) || (e.RemotePort > 0 && q.Ports.Contains(e.RemotePort) && e.State != "LISTEN")
                                      || namePids.Contains(e.Pid)).ToList();

            // Yalnızca aranan portu kullanan bağlantılar kalsın; TIME_WAIT gibi sürecsiz satırları sona at
            rows = rows.OrderBy(e => e.Pid == 0 ? 1 : 0)
                       .ThenBy(e => e.State == "LISTEN" || e.Protocol.StartsWith("UDP") ? 0 : 1)
                       .ThenBy(e => e.LocalPort).ThenBy(e => e.Protocol).ToList();

            const int maxRows = 1500;
            if (rows.Count > maxRows)
            {
                report.Notes.Add($"{rows.Count} satır bulundu; ilk {maxRows} tanesi gösteriliyor.");
                rows = rows.Take(maxRows).ToList();
            }

            // Uzak adres adları (en çok 40 farklı adres, hepsi paralel ve kısa zaman aşımlı)
            var names = ReverseDns(rows.Where(r => r.RemoteAddress.Length > 0 && r.State != "LISTEN")
                                       .Select(r => r.RemoteAddress).Distinct().Take(40));
            foreach (var r in rows)
                if (names.TryGetValue(r.RemoteAddress, out var n)) r.RemoteName = n;

            // Süreç ayrıntıları
            var pidList = rows.Select(r => r.Pid).Concat(namePids).Where(p => p > 0).Distinct().Take(60).ToList();
            var wmi = ReadWmiProcesses(pidList);
            foreach (var pid in pidList)
            {
                var pi = ReadProcess(pid, wmi);
                if (pi == null) continue;
                pi.Services = services.Where(s => s.ProcessId == pid).Select(s => s.Clone()).ToList();
                // Yetkisiz okumada (SYSTEM hizmetleri) yol / kullanıcı hizmet kaydından tamamlanır
                if (pi.Services.Count > 0)
                {
                    if (pi.Path.Length == 0) pi.Path = ExeFromCommand(pi.Services[0].PathName);
                    if (pi.User.Length == 0) pi.User = pi.Services[0].Account;
                    FillVersion(pi);
                }
                var mine = all.Where(e => e.Pid == pid).ToList();
                pi.Listening = string.Join(", ", mine.Where(e => e.State == "LISTEN" || e.Protocol.StartsWith("UDP"))
                                                     .Select(e => (e.Protocol.StartsWith("UDP") ? "UDP " : "TCP ") + e.LocalPort)
                                                     .Distinct().OrderBy(s => s.Length).ThenBy(s => s));
                pi.Connections = mine.Count(e => e.State == "ESTABLISHED");
                if (httpUrls.TryGetValue(pid, out var urls)) pi.HttpUrls = string.Join("  ", urls.Distinct());
                report.Processes.Add(pi);
            }
            foreach (var r in rows)
                r.Process = report.Processes.FirstOrDefault(p => p.Pid == r.Pid)?.Name ?? (r.Pid == 0 ? "" : r.Process);

            report.Endpoints = rows;

            // Özet notlar
            foreach (var port in q.Ports.Take(20))
            {
                var listen = all.Where(e => e.LocalPort == port && (e.State == "LISTEN" || e.Protocol.StartsWith("UDP"))).ToList();
                var svc = ServiceName(port);
                var label = svc.Length > 0 ? $"{port} ({svc})" : port.ToString();
                if (listen.Count == 0)
                    report.Notes.Add($"Port {label}: bu bilgisayarda dinleyen uygulama yok.");
                else
                    report.Notes.Add($"Port {label}: " + string.Join(", ", listen.Select(e => $"{(e.Protocol.StartsWith("UDP") ? "UDP" : "TCP")} {PidName(report, e.Pid)}").Distinct()) + " dinliyor.");
            }
            foreach (var n in q.Names)
            {
                var found = report.Processes.Where(p => p.Name.Contains(n, StringComparison.OrdinalIgnoreCase)
                                                        || p.Services.Any(s => s.Name.Contains(n, StringComparison.OrdinalIgnoreCase) || s.DisplayName.Contains(n, StringComparison.OrdinalIgnoreCase))).ToList();
                if (found.Count == 0) report.Notes.Add($"'{n}': çalışan uygulama ya da hizmet bulunamadı.");
                else foreach (var p in found)
                    report.Notes.Add($"{p.Name} (PID {p.Pid}): " + (p.Listening.Length > 0 ? $"dinlediği portlar {p.Listening}." : "port dinlemiyor.")
                                     + (p.Connections > 0 ? $" {p.Connections} açık bağlantı." : ""));
            }
            if (q.Ports.Count == 0 && q.Names.Count == 0)
                report.Notes.Add($"Bu bilgisayarda dinlenen {rows.Count(r => r.State == "LISTEN")} TCP ve {rows.Count(r => r.Protocol.StartsWith("UDP"))} UDP portu var.");

            // Güvenlik duvarı: dinlenen portlar ve bulunan uygulamalar için gelen kuralları
            var fwPorts = rows.Where(r => r.State == "LISTEN" || r.Protocol.StartsWith("UDP"))
                              .Select(r => (r.LocalPort, r.Protocol.StartsWith("UDP") ? 17 : 6))
                              .Concat(q.Ports.Select(p => (p, 6))).Distinct().Take(200).ToList();
            var fwApps = report.Processes.Select(p => p.Path).Where(p => p.Length > 0).Distinct().ToList();
            if (q.Ports.Count > 0 || q.Names.Count > 0)
                report.Firewall = ReadFirewall(fwPorts, fwApps);
        }

        /// <summary>
        /// http.sys (HttpListener, IIS, WinRM, WCF …) üzerinden dinlenen portlar Windows'ta "System" (PID 4) görünür.
        /// "netsh http show servicestate" ile portu kaydeden asıl süreç bulunur ve satırlar ona aktarılır
        /// (Via = "http.sys"). Dönüş: PID → kaydettiği URL'ler. Yalnızca kimlik ve URL satırları okunur;
        /// etiketler Windows diline göre değişse de çalışır.
        /// </summary>
        private static Dictionary<int, List<string>> ResolveHttpSys(List<EndpointRow> all)
        {
            var result = new Dictionary<int, List<string>>();
            if (!all.Any(e => e.Pid == 4 && e.State == "LISTEN")) return result;

            string text;
            try
            {
                var psi = new ProcessStartInfo("netsh", "http show servicestate view=requestq verbose=no")
                {
                    RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true,
                    StandardOutputEncoding = Encoding.Latin1,
                };
                using var p = Process.Start(psi)!;
                text = p.StandardOutput.ReadToEnd();
                if (!p.WaitForExit(5000)) { try { p.Kill(); } catch { } return result; }
            }
            catch { return result; }

            // Blok: satır başında (girintisiz) başlar; içinde "Xxx: 1234, yyy: ..." süreç satırları ve URL'ler bulunur
            var portOwners = new Dictionary<int, HashSet<int>>();
            var pids = new List<int>();
            var urls = new List<(int port, string url)>();
            void Flush()
            {
                foreach (var pid in pids)
                    foreach (var (port, url) in urls)
                    {
                        (portOwners.TryGetValue(port, out var set) ? set : portOwners[port] = new()).Add(pid);
                        (result.TryGetValue(pid, out var l) ? l : result[pid] = new()).Add(url);
                    }
                pids.Clear(); urls.Clear();
            }
            var pidRx = new System.Text.RegularExpressions.Regex(@"^\s+[^\s:]+:\s*(\d+),\s*[^\s:]+:");
            var urlRx = new System.Text.RegularExpressions.Regex(@"^\s+(HTTPS?://[^\s/]*?:(\d+)[^\s]*)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            foreach (var line in text.Split('\n'))
            {
                if (line.Length > 0 && !char.IsWhiteSpace(line[0]) && line.Contains(':') && !line.StartsWith("-")) Flush();
                var m = pidRx.Match(line);
                if (m.Success && int.TryParse(m.Groups[1].Value, out var pid) && pid > 4) { pids.Add(pid); continue; }
                var u = urlRx.Match(line);
                if (u.Success && int.TryParse(u.Groups[2].Value, out var port)) urls.Add((port, u.Groups[1].Value.TrimEnd('\r')));
            }
            Flush();

            // Portu tek bir süreç kaydetmişse PID 4 satırlarını o sürece ver
            foreach (var e in all.Where(e => e.Pid == 4 && e.Protocol.StartsWith("TCP")))
                if (portOwners.TryGetValue(e.LocalPort, out var owners) && owners.Count == 1)
                {
                    e.Pid = owners.First();
                    e.Via = "http.sys";
                }
            return result;
        }

        private static string PidName(PortReport r, int pid) =>
            pid == 0 ? "?" : (r.Processes.FirstOrDefault(p => p.Pid == pid) is { } p ? $"{p.Name} (PID {pid})" : $"PID {pid}");

        private static MachineInfo LocalMachine()
        {
            var m = new MachineInfo { IsLocal = true, Name = Environment.MachineName };
            try { m.Domain = System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties().DomainName; } catch { }
            if (string.IsNullOrEmpty(m.Domain))
                m.Domain = Environment.UserDomainName.Equals(Environment.MachineName, StringComparison.OrdinalIgnoreCase) ? "" : Environment.UserDomainName;
            m.Os = LocalOsName();
            m.OsArch = RuntimeInformation.OSArchitecture.ToString().ToLowerInvariant();
            try { m.Uptime = FormatSpan(TimeSpan.FromMilliseconds(Environment.TickCount64)); } catch { }
            try
            {
                var ips = NetworkInterface.GetAllNetworkInterfaces()
                    .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
                    .SelectMany(n => n.GetIPProperties().UnicastAddresses.Where(u => u.Address.AddressFamily == AddressFamily.InterNetwork)
                                      .Select(u => $"{u.Address} ({n.Name})"));
                m.Addresses = string.Join(", ", ips);
            }
            catch { }
            m.User = Environment.UserDomainName + "\\" + Environment.UserName;
            m.IsAdmin = IsAdmin();
            return m;
        }

        private static string LocalOsName()
        {
            try
            {
                using var k = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
                var name = k?.GetValue("ProductName") as string ?? "Windows";
                var disp = k?.GetValue("DisplayVersion") as string ?? k?.GetValue("ReleaseId") as string ?? "";
                var build = k?.GetValue("CurrentBuildNumber") as string ?? "";
                var ubr = k?.GetValue("UBR") is int u ? "." + u : "";
                // Windows 11 kayıt defterinde hâlâ "Windows 10" yazar
                if (int.TryParse(build, out var b) && b >= 22000 && name.Contains("Windows 10"))
                    name = name.Replace("Windows 10", "Windows 11");
                return $"{name}{(disp.Length > 0 ? " " + disp : "")} (derleme {build}{ubr})";
            }
            catch { return RuntimeInformation.OSDescription; }
        }

        private static bool IsAdmin()
        {
            try
            {
                using var id = System.Security.Principal.WindowsIdentity.GetCurrent();
                return new System.Security.Principal.WindowsPrincipal(id).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
            }
            catch { return false; }
        }

        private static string FormatSpan(TimeSpan t) =>
            t.TotalDays >= 1 ? $"{(int)t.TotalDays} gün {t.Hours} sa" : t.TotalHours >= 1 ? $"{(int)t.TotalHours} sa {t.Minutes} dk" : $"{t.Minutes} dk";

        // ── TCP / UDP tabloları (iphlpapi, süreç kimliğiyle) ─────────────────

        [DllImport("iphlpapi.dll", SetLastError = true)]
        private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int af, int tableClass, int reserved);

        [DllImport("iphlpapi.dll", SetLastError = true)]
        private static extern uint GetExtendedUdpTable(IntPtr table, ref int size, bool order, int af, int tableClass, int reserved);

        private const int AF_INET = 2, AF_INET6 = 23, TCP_TABLE_OWNER_PID_ALL = 5, UDP_TABLE_OWNER_PID = 1;

        private static readonly string[] TcpStates =
            { "?", "CLOSED", "LISTEN", "SYN_SENT", "SYN_RCVD", "ESTABLISHED", "FIN_WAIT1", "FIN_WAIT2", "CLOSE_WAIT", "CLOSING", "LAST_ACK", "TIME_WAIT", "DELETE_TCB" };

        private static int Port(int raw) => ((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF);

        public static List<EndpointRow> ReadEndpoints()
        {
            var list = new List<EndpointRow>();
            ReadTable(true, AF_INET, list);
            ReadTable(true, AF_INET6, list);
            ReadTable(false, AF_INET, list);
            ReadTable(false, AF_INET6, list);
            return list;
        }

        private static void ReadTable(bool tcp, int af, List<EndpointRow> list)
        {
            int size = 0;
            _ = tcp ? GetExtendedTcpTable(IntPtr.Zero, ref size, true, af, TCP_TABLE_OWNER_PID_ALL, 0)
                    : GetExtendedUdpTable(IntPtr.Zero, ref size, true, af, UDP_TABLE_OWNER_PID, 0);
            for (int attempt = 0; attempt < 3 && size > 0; attempt++)
            {
                size += 4096;
                var buf = Marshal.AllocHGlobal(size);
                try
                {
                    uint rc = tcp ? GetExtendedTcpTable(buf, ref size, true, af, TCP_TABLE_OWNER_PID_ALL, 0)
                                  : GetExtendedUdpTable(buf, ref size, true, af, UDP_TABLE_OWNER_PID, 0);
                    if (rc == 122) continue;           // ERROR_INSUFFICIENT_BUFFER: tablo büyüdü, yeniden dene
                    if (rc != 0) return;
                    int n = Marshal.ReadInt32(buf);
                    bool v6 = af == AF_INET6;
                    int rowSize = tcp ? (v6 ? 56 : 24) : (v6 ? 28 : 12);
                    for (int i = 0; i < n; i++)
                    {
                        var row = buf + 4 + i * rowSize;
                        var e = new EndpointRow { Protocol = (tcp ? "TCP" : "UDP") + (v6 ? "v6" : "") };
                        if (!v6)
                        {
                            if (tcp)
                            {
                                int st = Marshal.ReadInt32(row);
                                e.State = st is > 0 and < 13 ? TcpStates[st] : "?";
                                e.LocalAddress = new IPAddress((uint)Marshal.ReadInt32(row, 4)).ToString();
                                e.LocalPort = Port(Marshal.ReadInt32(row, 8));
                                e.RemoteAddress = new IPAddress((uint)Marshal.ReadInt32(row, 12)).ToString();
                                e.RemotePort = Port(Marshal.ReadInt32(row, 16));
                                e.Pid = Marshal.ReadInt32(row, 20);
                            }
                            else
                            {
                                e.LocalAddress = new IPAddress((uint)Marshal.ReadInt32(row, 0)).ToString();
                                e.LocalPort = Port(Marshal.ReadInt32(row, 4));
                                e.Pid = Marshal.ReadInt32(row, 8);
                            }
                        }
                        else
                        {
                            var bytes = new byte[16];
                            Marshal.Copy(row, bytes, 0, 16);
                            e.LocalAddress = new IPAddress(bytes).ToString();
                            e.LocalPort = Port(Marshal.ReadInt32(row, 20));
                            if (tcp)
                            {
                                Marshal.Copy(row + 24, bytes, 0, 16);
                                e.RemoteAddress = new IPAddress(bytes).ToString();
                                e.RemotePort = Port(Marshal.ReadInt32(row, 44));
                                int st = Marshal.ReadInt32(row, 48);
                                e.State = st is > 0 and < 13 ? TcpStates[st] : "?";
                                e.Pid = Marshal.ReadInt32(row, 52);
                            }
                            else e.Pid = Marshal.ReadInt32(row, 24);
                        }
                        if (e.State == "LISTEN" || !tcp) { e.RemoteAddress = ""; e.RemotePort = 0; }
                        list.Add(e);
                    }
                    return;
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
        }

        // ── Süreçler ─────────────────────────────────────────────────────────

        private static IEnumerable<(int pid, string name)> SafeProcesses()
        {
            foreach (var p in Process.GetProcesses())
            {
                int id = p.Id;
                string name;
                try { name = p.ProcessName; } catch { continue; }
                finally { p.Dispose(); }
                yield return (id, name);
            }
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(int access, bool inherit, int pid);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr h);

        private static string ImagePath(int pid)
        {
            var h = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
            if (h == IntPtr.Zero) return "";
            try
            {
                var sb = new StringBuilder(1024);
                int size = sb.Capacity;
                return QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : "";
            }
            finally { CloseHandle(h); }
        }

        private sealed record WmiProc(string CommandLine, string ExecutablePath, string User, int ParentPid);

        private static Dictionary<int, WmiProc> ReadWmiProcesses(List<int> pids)
        {
            var map = new Dictionary<int, WmiProc>();
            if (pids.Count == 0) return map;
            try
            {
                var where = string.Join(" OR ", pids.Select(p => "ProcessId=" + p));
                // Handle (anahtar) seçilmezse nesnenin yolu olmaz ve GetOwner çağrılamaz
                using var s = new ManagementObjectSearcher($"SELECT Handle, ProcessId, CommandLine, ExecutablePath, ParentProcessId FROM Win32_Process WHERE {where}");
                s.Options.Timeout = TimeSpan.FromSeconds(8);
                foreach (ManagementObject o in s.Get())
                    using (o)
                    {
                        int pid = Convert.ToInt32(o["ProcessId"]);
                        string user = "";
                        try
                        {
                            var args = new object[] { "", "" };
                            if (Convert.ToInt32(o.InvokeMethod("GetOwner", args)) == 0)
                                user = (args[1] as string is { Length: > 0 } d ? d + "\\" : "") + args[0];
                        }
                        catch { }
                        map[pid] = new WmiProc(o["CommandLine"] as string ?? "", o["ExecutablePath"] as string ?? "", user,
                                               Convert.ToInt32(o["ParentProcessId"] ?? 0));
                    }
            }
            catch { /* WMI kapalı / yetki yok: yol ve adla yetinilir */ }
            return map;
        }

        private static ProcessDetail? ReadProcess(int pid, Dictionary<int, WmiProc> wmi)
        {
            var d = new ProcessDetail { Pid = pid };
            if (pid == 4) { d.Name = "System"; d.Description = "Windows çekirdeği (http.sys, SMB gibi çekirdek sürücüleri bu kimlikle görünür)"; return d; }
            try
            {
                using var p = Process.GetProcessById(pid);
                d.Name = p.ProcessName + ".exe";
                try { d.Started = p.StartTime.ToString("dd.MM.yyyy HH:mm:ss"); } catch { }
                try { d.MemoryMb = Math.Round(p.WorkingSet64 / 1048576.0, 1); } catch { }
                try { d.SessionId = p.SessionId; } catch { }
            }
            catch (ArgumentException) { return null; }        // süreç kapanmış
            catch { d.Name = "PID " + pid; }

            wmi.TryGetValue(pid, out var w);
            d.Path = ImagePath(pid);
            if (d.Path.Length == 0 && w != null) d.Path = w.ExecutablePath;
            d.CommandLine = w?.CommandLine ?? "";
            d.User = w?.User ?? "";
            d.ParentPid = w?.ParentPid ?? 0;
            FillVersion(d);
            return d;
        }

        private static void FillVersion(ProcessDetail d)
        {
            if (d.Product.Length > 0 || d.Path.Length == 0 || !File.Exists(d.Path)) return;
            try
            {
                var v = FileVersionInfo.GetVersionInfo(d.Path);
                d.Product = (v.ProductName ?? "").Trim();
                d.Company = (v.CompanyName ?? "").Trim();
                d.Version = (v.ProductVersion ?? v.FileVersion ?? "").Trim();
                d.Description = (v.FileDescription ?? "").Trim();
            }
            catch { }
        }

        /// <summary>Hizmet komut satırından exe yolu: "C:\a b\x.exe" -k ... → C:\a b\x.exe</summary>
        private static string ExeFromCommand(string cmd)
        {
            cmd = cmd.Trim();
            if (cmd.StartsWith('"')) { int e = cmd.IndexOf('"', 1); return e > 1 ? cmd[1..e] : ""; }
            int i = cmd.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
            return i > 0 ? cmd[..(i + 4)] : cmd;
        }

        private static List<ServiceDetail> ReadServices()
        {
            var list = new List<ServiceDetail>();
            try
            {
                using var s = new ManagementObjectSearcher("SELECT Name, DisplayName, ProcessId, State, StartMode, StartName, PathName FROM Win32_Service");
                s.Options.Timeout = TimeSpan.FromSeconds(8);
                foreach (ManagementObject o in s.Get())
                    using (o)
                        list.Add(new ServiceDetail
                        {
                            Name = o["Name"] as string ?? "",
                            DisplayName = o["DisplayName"] as string ?? "",
                            ProcessId = Convert.ToInt32(o["ProcessId"] ?? 0),
                            State = TrState(o["State"] as string ?? ""),
                            StartMode = TrStart(o["StartMode"] as string ?? ""),
                            Account = o["StartName"] as string ?? "",
                            PathName = o["PathName"] as string ?? "",
                        });
            }
            catch { }
            return list;
        }

        private static string TrState(string s) => s switch
        {
            "Running" => "Çalışıyor", "Stopped" => "Durdu", "Start Pending" => "Başlıyor", "Stop Pending" => "Duruyor",
            "Paused" => "Duraklatıldı", _ => s,
        };

        private static string TrStart(string s) => s switch
        {
            "Auto" => "Otomatik", "Manual" => "El ile", "Disabled" => "Devre dışı", "Boot" => "Önyükleme", "System" => "Sistem", _ => s,
        };

        private static Dictionary<string, string> ReverseDns(IEnumerable<string> addrs)
        {
            var map = new System.Collections.Concurrent.ConcurrentDictionary<string, string>();
            var tasks = addrs.Where(a => IPAddress.TryParse(a, out var ip) && !IPAddress.Any.Equals(ip) && !IPAddress.IPv6Any.Equals(ip))
                .Select(async a =>
                {
                    var ip = IPAddress.Parse(a);
                    if (IPAddress.IsLoopback(ip)) { map[a] = "localhost"; return; }
                    var n = await ReverseAsync(ip, 1500);
                    if (n.Length > 0) map[a] = n;
                }).ToArray();
            try { Task.WaitAll(tasks, 4000); } catch { }
            return new Dictionary<string, string>(map);
        }

        private static async Task<string> ReverseAsync(IPAddress ip, int timeoutMs)
        {
            try
            {
                var t = Dns.GetHostEntryAsync(ip);
                if (await Task.WhenAny(t, Task.Delay(timeoutMs)) != t) return "";
                var name = t.Result.HostName;
                return name == ip.ToString() ? "" : name;
            }
            catch { return ""; }
        }

        // ── Güvenlik duvarı (Windows Defender Güvenlik Duvarı, salt okunur) ──

        private static object? Get(object o, string name, params object[] args) =>
            o.GetType().InvokeMember(name, BindingFlags.GetProperty, null, o, args);

        private static FirewallInfo? ReadFirewall(List<(int port, int proto)> ports, List<string> apps)
        {
            if (ports.Count == 0 && apps.Count == 0) return null;
            object? policy = null;
            try
            {
                var t = Type.GetTypeFromProgID("HNetCfg.FwPolicy2");
                if (t == null) return null;
                policy = Activator.CreateInstance(t)!;
                var fw = new FirewallInfo();
                var profs = new[] { (1, "Etki alanı"), (2, "Özel"), (4, "Genel") };
                int current = Convert.ToInt32(Get(policy, "CurrentProfileTypes"));
                fw.Profiles = string.Join(", ", profs.Select(p =>
                {
                    bool on = Convert.ToBoolean(Get(policy, "FirewallEnabled", p.Item1));
                    return $"{p.Item2}: {(on ? "açık" : "KAPALI")}{((current & p.Item1) != 0 ? " (etkin ağ)" : "")}";
                }));
                fw.AnyProfileOff = profs.Any(p => (current & p.Item1) != 0 && !Convert.ToBoolean(Get(policy, "FirewallEnabled", p.Item1)));

                var appSet = new HashSet<string>(apps, StringComparer.OrdinalIgnoreCase);
                var rules = Get(policy, "Rules")!;
                foreach (var r in (System.Collections.IEnumerable)rules)
                {
                    try
                    {
                        if (Convert.ToInt32(Get(r, "Direction")) != 1) continue;                      // yalnızca gelen
                        int proto = Convert.ToInt32(Get(r, "Protocol"));                               // 6 TCP, 17 UDP, 256 tümü
                        string lp = Get(r, "LocalPorts") as string ?? "";
                        string app = Environment.ExpandEnvironmentVariables(Get(r, "ApplicationName") as string ?? "");
                        bool appMatch = app.Length > 0 && appSet.Contains(app);
                        var portMatch = ports.Where(p => (proto == 256 || proto == p.proto) && PortListContains(lp, p.port)).Select(p => p.port).ToList();
                        bool anyPortRule = lp is "" or "*" && app.Length == 0;                           // her port / her uygulama kuralı (çok geneldir, atla)
                        if (!appMatch && (portMatch.Count == 0 || anyPortRule)) continue;
                        // Uygulamaya bağlı bir port kuralı başka uygulama içinse eşleşme değildir
                        if (!appMatch && app.Length > 0) continue;

                        int prof = Convert.ToInt32(Get(r, "Profiles"));
                        fw.Rules.Add(new FirewallRule
                        {
                            Name = Get(r, "Name") as string ?? "",
                            Enabled = Convert.ToBoolean(Get(r, "Enabled")),
                            Action = Convert.ToInt32(Get(r, "Action")) == 1 ? "İzin ver" : "Engelle",
                            Protocol = proto switch { 6 => "TCP", 17 => "UDP", 256 => "Tümü", _ => proto.ToString() },
                            Ports = lp is "" or "*" ? "Tümü" : lp,
                            Program = app.Length > 0 ? Path.GetFileName(app) : "Tümü",
                            Profiles = prof == 0x7FFFFFFF ? "Tümü" : string.Join(", ", profs.Where(p => (prof & p.Item1) != 0).Select(p => p.Item2)),
                            Remote = (Get(r, "RemoteAddresses") as string) is { } ra && ra != "*" ? ra : "Tümü",
                        });
                    }
                    catch { }
                    finally { if (r != null && Marshal.IsComObject(r)) Marshal.ReleaseComObject(r); }
                    if (fw.Rules.Count >= 100) break;
                }
                fw.Rules = fw.Rules.OrderByDescending(r => r.Enabled).ThenBy(r => r.Action).ThenBy(r => r.Name).ToList();
                return fw;
            }
            catch (Exception ex)
            {
                return new FirewallInfo { Profiles = "Okunamadı: " + ex.Message };
            }
            finally { if (policy != null && Marshal.IsComObject(policy)) Marshal.ReleaseComObject(policy); }
        }

        private static bool PortListContains(string list, int port)
        {
            if (list is "" or "*") return true;
            foreach (var part in list.Split(','))
            {
                var p = part.Trim();
                var dash = p.IndexOf('-');
                if (dash > 0 && int.TryParse(p[..dash], out var a) && int.TryParse(p[(dash + 1)..], out var b)) { if (port >= a && port <= b) return true; }
                else if (int.TryParse(p, out var v) && v == port) return true;
            }
            return false;
        }

        // ══════════════════════════════════════════════════════════════════════
        //  Uzak bilgisayar
        // ══════════════════════════════════════════════════════════════════════

        private static async Task InspectRemoteAsync(PortReport report, string host, IPAddress[] addrs, List<int> ports, CancellationToken ct)
        {
            if (ports.Count > MaxRemotePorts)
            {
                report.Notes.Add($"Uzak bilgisayarda en fazla {MaxRemotePorts} port denenir; ilk {MaxRemotePorts} port denendi.");
                ports = ports.Take(MaxRemotePorts).ToList();
            }
            var ip = addrs[0];
            var m = new MachineInfo { IsLocal = false, Address = ip.ToString() };
            if (addrs.Length > 1) m.Addresses = string.Join(", ", addrs.Select(a => a.ToString()));
            report.Machine = m;

            // Ad / ping / NetBIOS / ARP aynı anda
            var dnsTask = IPAddress.TryParse(host, out _) ? ReverseAsync(ip, 2500) : Task.FromResult(host);
            var pingTask = PingAsync(ip, ct);
            var nbTask = NetbiosAsync(ip, ct);
            var portTasks = ports.Select(p => ProbeAsync(ip, host, p, ct)).ToList();
            var sqlTask = ports.Contains(1433) || ports.Contains(1434) ? SqlBrowserAsync(ip, ct) : Task.FromResult(new List<SqlInstance>());

            await Task.WhenAll(dnsTask, pingTask, nbTask, sqlTask);
            m.DnsName = dnsTask.Result;
            var (rtt, ttl) = pingTask.Result;
            m.PingMs = rtt;
            m.Ttl = ttl;
            m.Name = nbTask.Result.name;
            m.Domain = nbTask.Result.group;
            if (m.Name.Length == 0 && m.DnsName.Length > 0) m.Name = m.DnsName.Split('.')[0];
            string nbMac = nbTask.Result.mac;

            var mac = ip.AddressFamily == AddressFamily.InterNetwork ? await NetworkTools.GetMacFromArpAsync(ip, ct) : null;
            if (string.IsNullOrEmpty(mac) && nbMac.Length > 0) mac = nbMac;
            if (!string.IsNullOrEmpty(mac))
            {
                m.Mac = MacAddress.ToDisplay(mac);
                try { m.Vendor = OuiLookup.GetVendor(m.Mac); } catch { }
            }

            report.RemotePorts = (await Task.WhenAll(portTasks)).OrderBy(p => p.Port).ToList();
            report.SqlInstances = sqlTask.Result;

            // İşletim sistemi: önce servis tanıtımından (SSH/HTTP), yoksa TTL'den tahmin
            var hint = report.RemotePorts.Select(p => p.OsHint).FirstOrDefault(h => h.Length > 0);
            if (hint != null) { m.Os = hint; m.OsSource = "servis tanıtımı"; }
            else if (nbTask.Result.name.Length > 0 || report.RemotePorts.Any(p => p.Open && p.Port is 135 or 445 or 3389))
            { m.Os = "Windows"; m.OsSource = nbTask.Result.name.Length > 0 ? "NetBIOS yanıtı" : "açık Windows portları"; }
            else if (ttl is > 0)
            {
                m.Os = ttl <= 64 ? "Linux / Unix (ör. RasyoBOX, Raspberry Pi)" : ttl <= 128 ? "Windows" : "Ağ cihazı (router / switch) ya da diğer";
                m.OsSource = $"TTL {ttl} tahmini";
            }

            int open = report.RemotePorts.Count(p => p.Open);
            if (rtt == null && open == 0)
                report.Notes.Add("Bilgisayar ping'e ve denenen portlara yanıt vermedi (kapalı, farklı ağda ya da güvenlik duvarı engelliyor).");
            else if (rtt == null)
                report.Notes.Add("Ping yanıtı yok (güvenlik duvarı ICMP'yi engelliyor olabilir) ama bazı portlar açık.");
            // Ayrıntı tabloda; burada tek satır özet
            var openList = report.RemotePorts.Where(p => p.Open).Select(p => p.Port + (p.Service.Length > 0 ? $" ({p.Service})" : "")).ToList();
            if (ports.Count == 1)
            {
                var p = report.RemotePorts[0];
                report.Notes.Add($"Port {p.Port}{(p.Service.Length > 0 ? " (" + p.Service + ")" : "")}: {p.State}" + (p.Banner.Length > 0 ? " · " + p.Banner : ""));
            }
            else
                report.Notes.Add(open == 0 ? $"Denenen {ports.Count} portun hiçbiri açık değil."
                                           : $"Denenen {ports.Count} porttan {open} tanesi açık: {string.Join(", ", openList)}.");
        }

        private static async Task<(long? rtt, int? ttl)> PingAsync(IPAddress ip, CancellationToken ct)
        {
            using var p = new System.Net.NetworkInformation.Ping();
            for (int i = 0; i < 2; i++)
            {
                try
                {
                    var r = await p.SendPingAsync(ip, TimeSpan.FromMilliseconds(1200), null, null, ct);
                    if (r.Status == IPStatus.Success) return (r.RoundtripTime, r.Options?.Ttl);
                }
                catch (PingException) { }
            }
            return (null, null);
        }

        /// <summary>Tek portu dener; açıksa tanıtım satırını (banner) / HTTP sunucusunu / TLS sertifikasını okur.</summary>
        private static async Task<RemotePort> ProbeAsync(IPAddress ip, string host, int port, CancellationToken ct)
        {
            var r = new RemotePort { Port = port, Service = ServiceName(port) };
            var sw = Stopwatch.StartNew();
            using var client = new TcpClient(ip.AddressFamily);
            using (var cts = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                cts.CancelAfter(2500);
                try { await client.ConnectAsync(ip, port, cts.Token); }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested) { r.State = "Yanıt yok (filtreli / güvenlik duvarı)"; return r; }
                catch (SocketException ex) when (ex.SocketErrorCode == SocketError.ConnectionRefused) { r.State = "Kapalı (bağlantı reddedildi)"; return r; }
                catch (SocketException ex) { r.State = "Ulaşılamıyor (" + ex.SocketErrorCode + ")"; return r; }
            }
            r.Open = true;
            r.TimeMs = sw.ElapsedMilliseconds;
            r.State = "Açık";
            try { await ReadBannerAsync(client, host, r, ct); } catch { }
            return r;
        }

        private static async Task ReadBannerAsync(TcpClient client, string host, RemotePort r, CancellationToken ct)
        {
            var stream = client.GetStream();
            if (TlsPorts.Contains(r.Port))
            {
                using var ssl = new SslStream(stream, true);   // yalnızca bilgi okunur, sertifika doğrulanmaz (aşağıdaki geri çağrı)
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                cts.CancelAfter(3000);
                await ssl.AuthenticateAsClientAsync(new SslClientAuthenticationOptions
                {
                    TargetHost = IPAddress.TryParse(host, out _) ? "" : host,
                    RemoteCertificateValidationCallback = (_, _, _, _) => true,
                }, cts.Token);
                if (ssl.RemoteCertificate is { } c)
                {
                    using var cert = new X509Certificate2(c);
                    r.Tls = $"Sertifika: {cert.GetNameInfo(X509NameType.SimpleName, false)} · veren {cert.GetNameInfo(X509NameType.SimpleName, true)}"
                            + $" · bitiş {cert.NotAfter:dd.MM.yyyy}{(cert.NotAfter < DateTime.Now ? " (SÜRESİ DOLMUŞ)" : "")}";
                }
                if (r.Port is 443 or 8443 or 5986) await HttpHeadAsync(ssl, host, r, ct);
                return;
            }

            // Önce sunucu kendiliğinden bir şey yazıyor mu (SSH, FTP, SMTP …). Okuma iptal edilirse .NET soketi
            // kapattığı için veri gelene kadar Available yoklanır; böylece ardından HTTP isteği gönderilebilir.
            int wait = r.Port == 22 ? 2500 : HttpPorts.Contains(r.Port) ? 400 : 1200;
            for (int t = 0; t < wait && client.Available == 0; t += 100) await Task.Delay(100, ct);
            if (client.Available > 0)
            {
                var buf = new byte[512];
                int n = await stream.ReadAsync(buf, ct);
                if (n > 0) { SetBanner(r, Encoding.ASCII.GetString(buf, 0, n)); return; }
            }
            if (HttpPorts.Contains(r.Port)) await HttpHeadAsync(stream, host, r, ct);
        }

        private static async Task HttpHeadAsync(Stream s, string host, RemotePort r, CancellationToken ct)
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(2500);
            // GET (bazı cihazlar HEAD'e yanıt vermez); yalnızca başlıklar okunur
            var req = Encoding.ASCII.GetBytes($"GET / HTTP/1.0\r\nHost: {host}\r\nUser-Agent: RasyoBOX-PortKontrol\r\nConnection: close\r\n\r\n");
            await s.WriteAsync(req, cts.Token);
            var buf = new byte[4096];
            int total = 0;
            try
            {
                while (total < buf.Length)
                {
                    int n = await s.ReadAsync(buf.AsMemory(total), cts.Token);
                    if (n <= 0) break;
                    total += n;
                    if (Encoding.ASCII.GetString(buf, 0, total).Contains("\r\n\r\n")) break;
                }
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
            if (total == 0) return;
            var lines = Encoding.ASCII.GetString(buf, 0, total).Split("\r\n");
            var status = lines[0].Trim();
            var server = lines.FirstOrDefault(l => l.StartsWith("Server:", StringComparison.OrdinalIgnoreCase))?[7..].Trim() ?? "";
            r.Banner = Clean(status + (server.Length > 0 ? " · Sunucu: " + server : ""));
            r.OsHint = OsFromText(server);
        }

        private static void SetBanner(RemotePort r, string text)
        {
            var first = text.Split('\n')[0];
            r.Banner = Clean(first);
            r.OsHint = OsFromText(first);
        }

        private static string Clean(string s)
        {
            var sb = new StringBuilder();
            foreach (var ch in s.Trim()) sb.Append(ch >= ' ' && ch < 127 ? ch : '·');
            var t = sb.ToString();
            return t.Length > 160 ? t[..160] + "…" : t;
        }

        private static string OsFromText(string s)
        {
            var t = s.ToLowerInvariant();
            if (t.Contains("raspbian")) return "Linux (Raspbian / Raspberry Pi OS)";
            if (t.Contains("ubuntu")) return "Linux (Ubuntu)";
            if (t.Contains("debian")) return "Linux (Debian / Raspberry Pi OS)";
            if (t.Contains("centos") || t.Contains("red hat") || t.Contains("rhel")) return "Linux (Red Hat / CentOS)";
            if (t.Contains("microsoft") || t.Contains("windows") || t.Contains("iis")) return "Windows";
            if (t.Contains("dropbear")) return "Linux (gömülü cihaz)";
            return "";
        }

        /// <summary>NetBIOS ad sorgusu (UDP 137): Windows bilgisayarın adı, çalışma grubu / etki alanı ve MAC'i.</summary>
        private static async Task<(string name, string group, string mac)> NetbiosAsync(IPAddress ip, CancellationToken ct)
        {
            if (ip.AddressFamily != AddressFamily.InterNetwork) return ("", "", "");
            try
            {
                using var udp = new UdpClient(AddressFamily.InterNetwork);
                var q = new byte[50];
                q[0] = 0x52; q[1] = 0x42;                        // işlem no
                q[5] = 1;                                        // 1 soru
                q[12] = 0x20;                                    // ad uzunluğu (32)
                q[13] = (byte)'C'; q[14] = (byte)'K';            // '*' kodlanmış
                for (int i = 15; i < 45; i++) q[i] = (byte)'A';  // 15 x 0x00 kodlanmış
                q[46] = 0x00; q[47] = 0x21; q[48] = 0x00; q[49] = 0x01;   // NBSTAT, IN
                await udp.SendAsync(q, q.Length, new IPEndPoint(ip, 137));
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                cts.CancelAfter(1500);
                var res = await udp.ReceiveAsync(cts.Token);
                var b = res.Buffer;
                if (b.Length < 57) return ("", "", "");
                int count = b[56], off = 57;
                string name = "", group = "";
                for (int i = 0; i < count && off + 18 <= b.Length; i++, off += 18)
                {
                    var n = Encoding.ASCII.GetString(b, off, 15).Trim();
                    byte suffix = b[off + 15];
                    bool isGroup = (b[off + 16] & 0x80) != 0;
                    if (suffix == 0 && !isGroup && name.Length == 0) name = n;
                    if (suffix == 0 && isGroup && group.Length == 0) group = n;
                }
                string mac = off + 6 <= b.Length ? BitConverter.ToString(b, off, 6).Replace('-', ':') : "";
                if (mac == "00:00:00:00:00:00") mac = "";
                return (name, group, mac);
            }
            catch { return ("", "", ""); }
        }

        /// <summary>SQL Server Browser (UDP 1434): kurulu örnekler, sürüm ve TCP portları.</summary>
        private static async Task<List<SqlInstance>> SqlBrowserAsync(IPAddress ip, CancellationToken ct)
        {
            var list = new List<SqlInstance>();
            try
            {
                using var udp = new UdpClient(ip.AddressFamily);
                await udp.SendAsync(new byte[] { 0x02 }, 1, new IPEndPoint(ip, 1434));
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                cts.CancelAfter(1500);
                var res = await udp.ReceiveAsync(cts.Token);
                if (res.Buffer.Length < 4 || res.Buffer[0] != 0x05) return list;
                var text = Encoding.ASCII.GetString(res.Buffer, 3, res.Buffer.Length - 3);
                foreach (var block in text.Split(";;", StringSplitOptions.RemoveEmptyEntries))
                {
                    var parts = block.Split(';');
                    var kv = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    for (int i = 0; i + 1 < parts.Length; i += 2) kv[parts[i]] = parts[i + 1];
                    if (!kv.TryGetValue("InstanceName", out var inst)) continue;
                    kv.TryGetValue("Version", out var ver);
                    kv.TryGetValue("tcp", out var tcp);
                    kv.TryGetValue("ServerName", out var server);
                    list.Add(new SqlInstance
                    {
                        Server = server ?? "", Instance = inst, Version = ver ?? "", Product = SqlProduct(ver ?? ""),
                        TcpPort = tcp ?? "", Clustered = kv.TryGetValue("IsClustered", out var c) && c == "Yes",
                    });
                }
            }
            catch { }
            return list;
        }

        private static string SqlProduct(string v)
        {
            var p = v.Split('.');
            if (p.Length < 2 || !int.TryParse(p[0], out var major)) return "";
            return major switch
            {
                17 => "SQL Server 2025", 16 => "SQL Server 2022", 15 => "SQL Server 2019", 14 => "SQL Server 2017",
                13 => "SQL Server 2016", 12 => "SQL Server 2014", 11 => "SQL Server 2012",
                10 => p[1].StartsWith("5") ? "SQL Server 2008 R2" : "SQL Server 2008", 9 => "SQL Server 2005", _ => "",
            };
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Sonuç modeli (web'e JSON olarak gider, WPF'te doğrudan bağlanır)
    // ══════════════════════════════════════════════════════════════════════════

    public sealed class PortReport
    {
        public bool Ok { get; set; } = true;
        public string Mode { get; set; } = "";                 // local | remote
        public string Query { get; set; } = "";
        public string Host { get; set; } = "";
        public List<int> Ports { get; set; } = new();
        public List<string> Names { get; set; } = new();
        public MachineInfo? Machine { get; set; }
        public List<string> Notes { get; set; } = new();
        public List<ProcessDetail> Processes { get; set; } = new();
        public List<EndpointRow> Endpoints { get; set; } = new();
        public List<RemotePort> RemotePorts { get; set; } = new();
        public List<SqlInstance> SqlInstances { get; set; } = new();
        public FirewallInfo? Firewall { get; set; }
        public long ElapsedMs { get; set; }
    }

    public sealed class MachineInfo
    {
        public bool IsLocal { get; set; }
        public string Name { get; set; } = "";
        public string Domain { get; set; } = "";
        public string DnsName { get; set; } = "";
        public string Address { get; set; } = "";
        public string Addresses { get; set; } = "";
        public string Os { get; set; } = "";
        public string OsSource { get; set; } = "";
        public string OsArch { get; set; } = "";
        public string Uptime { get; set; } = "";
        public string User { get; set; } = "";
        public bool IsAdmin { get; set; }
        public long? PingMs { get; set; }
        public int? Ttl { get; set; }
        public string Mac { get; set; } = "";
        public string Vendor { get; set; } = "";
    }

    public sealed class EndpointRow
    {
        public string Protocol { get; set; } = "";
        public string LocalAddress { get; set; } = "";
        public int LocalPort { get; set; }
        public string RemoteAddress { get; set; } = "";
        public int RemotePort { get; set; }
        public string RemoteName { get; set; } = "";
        public string State { get; set; } = "";
        public int Pid { get; set; }
        public string Process { get; set; } = "";
        public string Via { get; set; } = "";                  // "http.sys": port çekirdek üzerinden bu sürece ait
        public string Service => PortInspector.ServiceName(LocalPort);
    }

    public sealed class ProcessDetail
    {
        public int Pid { get; set; }
        public string Name { get; set; } = "";
        public string Path { get; set; } = "";
        public string Product { get; set; } = "";
        public string Company { get; set; } = "";
        public string Version { get; set; } = "";
        public string Description { get; set; } = "";
        public string Started { get; set; } = "";
        public string CommandLine { get; set; } = "";
        public string User { get; set; } = "";
        public int ParentPid { get; set; }
        public int SessionId { get; set; }
        public double MemoryMb { get; set; }
        public string Listening { get; set; } = "";
        public string HttpUrls { get; set; } = "";
        public int Connections { get; set; }
        public List<ServiceDetail> Services { get; set; } = new();
    }

    public sealed class ServiceDetail
    {
        public string Name { get; set; } = "";
        public string DisplayName { get; set; } = "";
        public int ProcessId { get; set; }
        public string State { get; set; } = "";
        public string StartMode { get; set; } = "";
        public string Account { get; set; } = "";
        public string PathName { get; set; } = "";
        public ServiceDetail Clone() => (ServiceDetail)MemberwiseClone();
    }

    public sealed class RemotePort
    {
        public int Port { get; set; }
        public string Service { get; set; } = "";
        public bool Open { get; set; }
        public string State { get; set; } = "";
        public long? TimeMs { get; set; }
        public string Banner { get; set; } = "";
        public string Tls { get; set; } = "";
        public string OsHint { get; set; } = "";
    }

    public sealed class SqlInstance
    {
        public string Server { get; set; } = "";
        public string Instance { get; set; } = "";
        public string Version { get; set; } = "";
        public string Product { get; set; } = "";
        public string TcpPort { get; set; } = "";
        public bool Clustered { get; set; }
    }

    public sealed class FirewallInfo
    {
        public string Profiles { get; set; } = "";
        public bool AnyProfileOff { get; set; }
        public List<FirewallRule> Rules { get; set; } = new();
    }

    public sealed class FirewallRule
    {
        public string Name { get; set; } = "";
        public bool Enabled { get; set; }
        public string Action { get; set; } = "";
        public string Protocol { get; set; } = "";
        public string Ports { get; set; } = "";
        public string Program { get; set; } = "";
        public string Profiles { get; set; } = "";
        public string Remote { get; set; } = "";
    }
}
