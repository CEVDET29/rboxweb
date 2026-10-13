using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace RboxAgent.Modules.Port
{
    // NOT: Bu dosya WPF (RboxTools/Modules/Port) ile web ajanında (RboxWeb/agent/Modules/Port) aynıdır;
    // yalnızca namespace farklıdır. Birinde değişiklik yapınca diğerine de kopyalayın.

    /// <summary>
    /// Güvenlik duvarı port izni: verilen TCP portları için bu bilgisayarda gelen bağlantıya izin veren bir kural
    /// var mı (okuma, yönetici gerekmez) ve "RasyoBOX TCP &lt;port&gt;" adlı izin kuralını ekleme / kaldırma.
    /// Ekleme PowerShell (New-NetFirewallRule; açıklama Türkçe karakterli olabilsin diye), olmazsa netsh ile;
    /// kaldırma netsh ile yapılır. Uygulama yönetici değilse Windows yönetici izni (UAC) sorar.
    /// Yalnızca bu adla oluşturulan kurallara dokunulur; başka kurallar değiştirilmez.
    /// </summary>
    public static class FirewallManager
    {
        /// <summary>Kartta her zaman gösterilen portlar.</summary>
        public static readonly int[] DefaultPorts = { 1433, 22, 8080, 8082, 8085, 6155, 8089, 9000, 9999, 9998, 9997 };

        public const string RulePrefix = "RasyoBOX TCP ";
        public static string RuleName(int port) => RulePrefix + port;

        /// <summary>Kuralın açıklaması (Windows Güvenlik Duvarı'ndaki "Açıklama"); kullanıcı değiştirebilir.</summary>
        public const string DefaultDescription = "RasyoBOX";
        /// <summary>0.14.0'ın yazdığı sabit açıklama; ekranda "RasyoBOX" gösterilir.</summary>
        private const string LegacyDescription = "RasyoBOX Araclari tarafindan eklendi";

        /// <summary>Boşsa "RasyoBOX"; kontrol karakterleri atılır, en fazla 200 karakter.</summary>
        public static string CleanDescription(string? d)
        {
            var t = new string((d ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();
            if (t.Length > 200) t = t[..200].TrimEnd();
            return t.Length == 0 ? DefaultDescription : t;
        }

        private const int ProfAll = 0x7FFFFFFF;
        private static readonly (int Bit, string Name)[] Profs = { (1, "Etki alanı"), (2, "Özel"), (4, "Genel") };

        public static bool IsAdmin()
        {
            try
            {
                using var id = WindowsIdentity.GetCurrent();
                return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
            }
            catch { return false; }
        }

        public static List<int> CleanPorts(IEnumerable<int>? ports) =>
            (ports ?? Array.Empty<int>()).Where(p => p is > 0 and <= 65535).Distinct().Take(64).ToList();

        // ── Okuma ────────────────────────────────────────────────────────────

        private static object? Get(object o, string name, params object[] args) =>
            o.GetType().InvokeMember(name, BindingFlags.GetProperty, null, o, args);

        public static FwStatus ReadStatus(IEnumerable<int> portList)
        {
            var ports = CleanPorts(portList);
            var st = new FwStatus { IsAdmin = IsAdmin() };
            var found = ports.ToDictionary(p => p, _ => new List<(FwRuleRef rule, int prof, bool app)>());
            object? policy = null;
            try
            {
                var t = Type.GetTypeFromProgID("HNetCfg.FwPolicy2") ?? throw new InvalidOperationException("Güvenlik duvarı hizmetine ulaşılamadı.");
                policy = Activator.CreateInstance(t)!;
                int current = Convert.ToInt32(Get(policy, "CurrentProfileTypes"));
                foreach (var pr in Profs)
                    st.ProfileList.Add(new FwProfile
                    {
                        Name = pr.Name,
                        On = Convert.ToBoolean(Get(policy, "FirewallEnabled", pr.Bit)),
                        Active = (current & pr.Bit) != 0,
                    });
                st.Profiles = string.Join(", ", st.ProfileList.Select(x => $"{x.Name}: {(x.On ? "açık" : "KAPALI")}{(x.Active ? " (etkin ağ)" : "")}"));
                st.ActiveProfileOff = Profs.Any(p => (current & p.Bit) != 0 && !Convert.ToBoolean(Get(policy, "FirewallEnabled", p.Bit)));

                var rules = Get(policy, "Rules")!;
                foreach (var r in (System.Collections.IEnumerable)rules)
                {
                    try
                    {
                        if (Convert.ToInt32(Get(r, "Direction")) != 1) continue;                  // yalnızca gelen
                        int proto = Convert.ToInt32(Get(r, "Protocol"));                           // 6 TCP, 256 tümü
                        if (proto != 6 && proto != 256) continue;
                        string lp = Get(r, "LocalPorts") as string ?? "";
                        if (lp is "" or "*") continue;                                             // her port kuralı: çok genel, sayma
                        var hits = ports.Where(p => PortListContains(lp, p)).ToList();
                        if (hits.Count == 0) continue;

                        string app = Get(r, "ApplicationName") as string ?? "";
                        int prof = Convert.ToInt32(Get(r, "Profiles"));
                        var rr = new FwRuleRef
                        {
                            Name = Get(r, "Name") as string ?? "",
                            Description = Get(r, "Description") as string ?? "",
                            Enabled = Convert.ToBoolean(Get(r, "Enabled")),
                            Allow = Convert.ToInt32(Get(r, "Action")) == 1,
                            Program = app.Length > 0 ? Path.GetFileName(Environment.ExpandEnvironmentVariables(app)) : "",
                            Profiles = prof == ProfAll ? "Tümü" : string.Join(", ", Profs.Where(p => (prof & p.Bit) != 0).Select(p => p.Name)),
                        };
                        foreach (var p in hits) found[p].Add((rr, (prof & current) != 0 ? 1 : 0, app.Length > 0));
                    }
                    catch { }
                    finally { if (r != null && Marshal.IsComObject(r)) Marshal.ReleaseComObject(r); }
                }
            }
            catch (Exception ex)
            {
                st.Error = "Güvenlik duvarı okunamadı: " + ex.Message;
            }
            finally { if (policy != null && Marshal.IsComObject(policy)) Marshal.ReleaseComObject(policy); }

            var listeners = ReadListeners(ports);
            foreach (var p in ports)
            {
                var list = found[p];
                var own = list.Select(x => x.rule).FirstOrDefault(x => x.Name.Equals(RuleName(p), StringComparison.OrdinalIgnoreCase));
                var ps = new FwPortStatus
                {
                    Port = p,
                    Service = PortInspector.ServiceName(p),
                    Own = list.Any(x => x.rule.Name.Equals(RuleName(p), StringComparison.OrdinalIgnoreCase)),
                    OwnEnabled = list.Any(x => x.rule.Enabled && x.rule.Name.Equals(RuleName(p), StringComparison.OrdinalIgnoreCase)),
                    OwnDescription = own == null ? "" : own.Description is "" or LegacyDescription ? DefaultDescription : own.Description,
                    Listening = listeners.ContainsKey(p),
                    ListenProcess = listeners.TryGetValue(p, out var lp) ? lp : "",
                    Rules = list.Select(x => x.rule).OrderByDescending(x => x.Enabled).ThenBy(x => x.Name).ToList(),
                };
                // Etkin ağ profilinde geçerli, programa bağlı olmayan etkin kurallar belirleyicidir; engelleme izinden üstündür.
                var live = list.Where(x => x.rule.Enabled && x.prof == 1 && !x.app).Select(x => x.rule).ToList();
                if (live.Any(x => !x.Allow)) { ps.State = "blocked"; ps.Label = "Engelli"; }
                else if (live.Any(x => x.Allow)) { ps.State = "allowed"; ps.Label = "İzinli"; }
                else if (list.Any(x => x.rule.Enabled && x.rule.Allow && x.prof == 1)) { ps.State = "partial"; ps.Label = "Programa özel"; }
                else if (list.Any(x => x.rule.Enabled && x.rule.Allow)) { ps.State = "partial"; ps.Label = "Başka profil"; }
                else { ps.State = "none"; ps.Label = "Kural yok"; }
                st.Ports.Add(ps);
            }
            return st;
        }

        /// <summary>
        /// Portu TCP'de dinleyen süreçler (port → "sqlservr.exe" / "System (http.sys)"). İzin verilse bile portu dinleyen
        /// bir uygulama yoksa bağlantı kurulamaz; kutucukta bu da gösterilir. Okunamazsa boş döner.
        /// </summary>
        private static Dictionary<int, string> ReadListeners(List<int> ports)
        {
            var map = new Dictionary<int, string>();
            try
            {
                var set = new HashSet<int>(ports);
                var names = new Dictionary<int, string>();
                string NameOf(int pid)
                {
                    if (names.TryGetValue(pid, out var n)) return n;
                    n = pid == 4 ? "System (http.sys)" : "PID " + pid;
                    try { using var pr = Process.GetProcessById(pid); n = pr.ProcessName + ".exe"; if (pid == 4) n = "System (http.sys)"; } catch { }
                    return names[pid] = n;
                }
                foreach (var g in PortInspector.ReadEndpoints()
                             .Where(e => e.Protocol.StartsWith("TCP") && e.State == "LISTEN" && set.Contains(e.LocalPort))
                             .GroupBy(e => e.LocalPort))
                    map[g.Key] = string.Join(", ", g.Select(e => e.Pid).Distinct().Where(pid => pid > 0).Select(NameOf).Distinct());
            }
            catch { }
            return map;
        }

        private static bool PortListContains(string list, int port)
        {
            foreach (var part in list.Split(','))
            {
                var p = part.Trim();
                var dash = p.IndexOf('-');
                if (dash > 0 && int.TryParse(p[..dash], out var a) && int.TryParse(p[(dash + 1)..], out var b)) { if (port >= a && port <= b) return true; }
                else if (int.TryParse(p, out var v) && v == port) return true;
            }
            return false;
        }

        // ── Ekleme / kaldırma ───────────────────────────────────────────────

        /// <summary>
        /// Her port için "RasyoBOX TCP &lt;port&gt;" gelen izin kuralını (TCP, tüm profiller) verilen açıklamayla
        /// oluşturur; varsa yeniler (açıklama da değişir).
        /// </summary>
        public static Task<FwActionResult> AllowAsync(IEnumerable<int> portList, string? description = null, CancellationToken ct = default) =>
            RunAsync(CleanPorts(portList), add: true, CleanDescription(description), ct);

        /// <summary>Yalnızca bu uygulamanın oluşturduğu "RasyoBOX TCP &lt;port&gt;" kurallarını siler.</summary>
        public static Task<FwActionResult> RemoveAsync(IEnumerable<int> portList, CancellationToken ct = default) =>
            RunAsync(CleanPorts(portList), add: false, "", ct);

        private static List<string> NetshCommands(List<int> ports, bool add, string description)
        {
            var cmds = new List<string>();
            foreach (var p in ports)
            {
                cmds.Add($"netsh advfirewall firewall delete rule name=\"{RuleName(p)}\" >nul 2>&1");
                if (add)
                    cmds.Add($"netsh advfirewall firewall add rule name=\"{RuleName(p)}\" dir=in action=allow protocol=TCP localport={p} profile=any enable=yes"
                             + $" description=\"{AsciiForCmd(description)}\" >nul");
            }
            return cmds;
        }

        /// <summary>netsh yedeği için: .cmd dosyası ASCII yazılır, Türkçe harfler sadeleştirilir, tırnak / % / ^ atılır.</summary>
        private static string AsciiForCmd(string s)
        {
            var map = new Dictionary<char, string> { ['ç'] = "c", ['Ç'] = "C", ['ğ'] = "g", ['Ğ'] = "G", ['ı'] = "i", ['İ'] = "I",
                                                     ['ö'] = "o", ['Ö'] = "O", ['ş'] = "s", ['Ş'] = "S", ['ü'] = "u", ['Ü'] = "U" };
            var sb = new StringBuilder();
            foreach (var c in s)
            {
                if (map.TryGetValue(c, out var r)) sb.Append(r);
                else if (c is >= ' ' and <= '~' && c is not ('"' or '%' or '^' or '&' or '|' or '<' or '>')) sb.Append(c);
            }
            var t = sb.ToString().Trim();
            return t.Length == 0 ? DefaultDescription : t;
        }

        /// <summary>Elevated PowerShell için betik: açıklama tek tırnaklı dizgede (tırnaklar ikilenir), dosya UTF-8 BOM'lu.</summary>
        private static string PowerShellAddScript(List<int> ports, string description)
        {
            // PowerShell ‘ ’ ‚ ‛ işaretlerini de tek tırnak sayar: hepsi ' yapılıp ikilenir
            var d = new string(description.Select(c => c is '\u2018' or '\u2019' or '\u201A' or '\u201B' ? '\'' : c).ToArray()).Replace("'", "''");
            var sb = new StringBuilder();
            sb.AppendLine("$ErrorActionPreference = 'Continue'");
            sb.AppendLine($"$d = '{d}'");
            sb.AppendLine($"foreach ($p in {string.Join(", ", ports)}) {{");
            sb.AppendLine($"  $n = '{RulePrefix}' + $p");
            sb.AppendLine("  Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue");
            sb.AppendLine("  New-NetFirewallRule -DisplayName $n -Direction Inbound -Action Allow -Protocol TCP -LocalPort $p -Profile Any -Enabled True -Description $d | Out-Null");
            sb.AppendLine("}");
            return sb.ToString();
        }

        private static async Task<FwActionResult> RunAsync(List<int> ports, bool add, string description, CancellationToken ct)
        {
            var res = new FwActionResult();
            if (ports.Count == 0) { res.Message = "Port seçilmedi."; res.Status = ReadStatus(ports); return res; }

            try
            {
                if (add)
                {
                    bool psRan = false;
                    try { await Task.Run(() => RunPowerShell(PowerShellAddScript(ports, description), ct), ct); psRan = true; }
                    catch (Win32Exception ex) when (ex.NativeErrorCode == 1223) { throw; }
                    catch { /* PowerShell yok / engelli: netsh yedeği aşağıda */ }

                    // PowerShell kuralları oluşturamadıysa (NetSecurity modülü yok, betik engellendi…) eksikler için netsh
                    var missing = psRan ? ReadStatus(ports).Ports.Where(p => !p.OwnEnabled).Select(p => p.Port).ToList() : ports;
                    if (missing.Count > 0)
                    {
                        res.UsedFallback = true;
                        await Task.Run(() => RunScript(NetshCommands(missing, true, description), ct), ct);
                    }
                }
                else
                {
                    await Task.Run(() => RunScript(NetshCommands(ports, false, ""), ct), ct);
                }
            }
            catch (Win32Exception ex) when (ex.NativeErrorCode == 1223)
            {
                res.Message = "Yönetici izni verilmedi; güvenlik duvarı değiştirilmedi.";
                res.Status = ReadStatus(ports);
                return res;
            }
            catch (Exception ex)
            {
                res.Message = "Komut çalıştırılamadı: " + ex.Message;
                res.Status = ReadStatus(ports);
                return res;
            }

            // Sonucu çıkış koduna değil, kuralların gerçekten oluşup oluşmadığına bakarak bildir
            res.Status = ReadStatus(ports);
            var bad = res.Status.Ports.Where(p => add ? !p.OwnEnabled : p.Own).Select(p => p.Port).ToList();
            res.Ok = bad.Count == 0;
            res.Message = add
                ? (res.Ok ? $"{ports.Count} port için izin kuralı eklendi (açıklama: {description})." : $"Kural eklenemedi: {string.Join(", ", bad)}")
                : (res.Ok ? $"{ports.Count} port için RasyoBOX kuralı kaldırıldı." : $"Kural kaldırılamadı: {string.Join(", ", bad)}");
            if (res.Ok && add && res.Status.Ports.Any(p => p.State == "blocked"))
                res.Message += " Uyarı: başka bir engelleme kuralı hâlâ geçerli (engelleme izinden üstündür).";
            return res;
        }

        /// <summary>Komutları geçici bir .cmd dosyasına yazıp tek seferde çalıştırır (tek UAC sorusu; cmd satır sınırı yok).</summary>
        private static void RunScript(List<string> cmds, CancellationToken ct)
        {
            var file = Path.Combine(Path.GetTempPath(), $"rbox-fw-{Guid.NewGuid():N}.cmd");
            File.WriteAllText(file, "@echo off\r\n" + string.Join("\r\n", cmds) + "\r\n", Encoding.ASCII);
            try { RunElevated(Path.Combine(Environment.SystemDirectory, "cmd.exe"), $"/d /c call \"{file}\"", ct); }
            finally { try { File.Delete(file); } catch { } }
        }

        /// <summary>Betiği geçici .ps1 dosyasına (UTF-8 BOM: Windows PowerShell 5.1 Türkçe karakteri doğru okusun) yazıp çalıştırır.</summary>
        private static void RunPowerShell(string script, CancellationToken ct)
        {
            var exe = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
            if (!File.Exists(exe)) throw new FileNotFoundException("powershell.exe bulunamadı", exe);
            var file = Path.Combine(Path.GetTempPath(), $"rbox-fw-{Guid.NewGuid():N}.ps1");
            File.WriteAllText(file, script, new UTF8Encoding(true));
            try { RunElevated(exe, $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{file}\"", ct); }
            finally { try { File.Delete(file); } catch { } }
        }

        private static void RunElevated(string fileName, string arguments, CancellationToken ct)
        {
            bool admin = IsAdmin();
            var psi = new ProcessStartInfo { FileName = fileName, Arguments = arguments };
            if (admin)
            {
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
            }
            else
            {
                // Yönetici değil: Windows yönetici izni (UAC) sorar. Kullanıcı reddederse Win32Exception 1223.
                psi.UseShellExecute = true;
                psi.Verb = "runas";
                psi.WindowStyle = ProcessWindowStyle.Hidden;
            }
            using var p = Process.Start(psi) ?? throw new InvalidOperationException(Path.GetFileName(fileName) + " başlatılamadı.");
            using var reg = ct.Register(() => { try { p.Kill(); } catch { } });
            if (!p.WaitForExit(120_000)) { try { p.Kill(); } catch { } throw new TimeoutException(Path.GetFileName(fileName) + " 2 dakikada bitmedi."); }
        }
    }

    public sealed class FwStatus
    {
        public bool IsAdmin { get; set; }
        public string Profiles { get; set; } = "";
        public bool ActiveProfileOff { get; set; }
        public string Error { get; set; } = "";
        /// <summary>Etki alanı / Özel / Genel: güvenlik duvarı açık mı, etkin ağ bu mu (başlıktaki rozetler).</summary>
        public List<FwProfile> ProfileList { get; set; } = new();
        public List<FwPortStatus> Ports { get; set; } = new();
    }

    public sealed class FwProfile
    {
        public string Name { get; set; } = "";
        public bool On { get; set; }
        public bool Active { get; set; }
        public string Tooltip => $"{Name}: güvenlik duvarı {(On ? "açık" : "KAPALI")}{(Active ? " · etkin ağ" : "")}";
    }

    public sealed class FwPortStatus
    {
        public int Port { get; set; }
        public string Service { get; set; } = "";
        /// <summary>allowed | blocked | partial (yalnızca başka profil / programa bağlı) | none</summary>
        public string State { get; set; } = "none";
        public string Label { get; set; } = "";
        /// <summary>"RasyoBOX TCP &lt;port&gt;" kuralı var mı (etkin olsun olmasın).</summary>
        public bool Own { get; set; }
        public bool OwnEnabled { get; set; }
        /// <summary>"RasyoBOX TCP &lt;port&gt;" kuralının açıklaması (kural yoksa boş).</summary>
        public string OwnDescription { get; set; } = "";
        /// <summary>Bu bilgisayarda portu TCP'de dinleyen bir uygulama var mı.</summary>
        public bool Listening { get; set; }
        /// <summary>Dinleyen süreç(ler), ör. "sqlservr.exe".</summary>
        public string ListenProcess { get; set; } = "";
        public List<FwRuleRef> Rules { get; set; } = new();

        public string Tooltip
        {
            get
            {
                var sb = new StringBuilder();
                sb.Append(State switch
                {
                    "allowed" => "Gelen bağlantıya izin veren kural var.",
                    "blocked" => "Bu portu engelleyen etkin bir kural var (engelleme izinden üstündür).",
                    "partial" when Label == "Programa özel" => "İzin kuralı yalnızca belirli bir program için: o program dışındaki uygulamalar bu portta engellenebilir.",
                    "partial" => "İzin kuralı var ama etkin ağ profilinde geçerli değil (yalnızca başka profil).",
                    _ => "Bu port için gelen kuralı yok: başka bilgisayarlardan bağlantı engellenebilir.",
                });
                foreach (var r in Rules.Take(8))
                    sb.Append('\n').Append("• ").Append(r.Name)
                      .Append(" — ").Append(r.Allow ? "izin" : "engelle")
                      .Append(r.Enabled ? "" : ", kapalı")
                      .Append(r.Program.Length > 0 ? ", program: " + r.Program : "")
                      .Append(", profil: ").Append(r.Profiles);
                if (Rules.Count > 8) sb.Append('\n').Append($"… ve {Rules.Count - 8} kural daha");
                if (OwnDescription.Length > 0) sb.Append('\n').Append("RasyoBOX kuralının açıklaması: ").Append(OwnDescription);
                sb.Append('\n').Append(Listening
                    ? $"Dinleyen uygulama: {(ListenProcess.Length > 0 ? ListenProcess : "var")}"
                    : "Bu portu dinleyen uygulama yok: izin verilse de bağlantı kurulamaz.");
                sb.Append('\n').Append("Çift tık: bu portu soldaki sorguda aç · sağ tık: ad ver");
                return sb.ToString();
            }
        }
    }

    public sealed class FwRuleRef
    {
        public string Name { get; set; } = "";
        public string Description { get; set; } = "";
        public bool Enabled { get; set; }
        public bool Allow { get; set; }
        public string Program { get; set; } = "";
        public string Profiles { get; set; } = "";
    }

    public sealed class FwActionResult
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        /// <summary>PowerShell kuralları oluşturamadı, netsh kullanıldı (açıklamadaki Türkçe harfler sadeleşir).</summary>
        public bool UsedFallback { get; set; }
        public FwStatus? Status { get; set; }
    }
}
