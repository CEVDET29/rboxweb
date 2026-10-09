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
    /// Ekleme ve kaldırma netsh ile yapılır; uygulama yönetici değilse Windows yönetici izni (UAC) sorar.
    /// Yalnızca bu adla oluşturulan kurallara dokunulur; başka kurallar değiştirilmez.
    /// </summary>
    public static class FirewallManager
    {
        /// <summary>Kartta her zaman gösterilen portlar.</summary>
        public static readonly int[] DefaultPorts = { 1433, 22, 8080, 8082, 8085, 6155, 8089, 9000, 9999, 9998, 9997 };

        public const string RulePrefix = "RasyoBOX TCP ";
        public static string RuleName(int port) => RulePrefix + port;

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
                st.Profiles = string.Join(", ", Profs.Select(p =>
                {
                    bool on = Convert.ToBoolean(Get(policy, "FirewallEnabled", p.Bit));
                    return $"{p.Name}: {(on ? "açık" : "KAPALI")}{((current & p.Bit) != 0 ? " (etkin ağ)" : "")}";
                }));
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

            foreach (var p in ports)
            {
                var list = found[p];
                var ps = new FwPortStatus
                {
                    Port = p,
                    Service = PortInspector.ServiceName(p),
                    Own = list.Any(x => x.rule.Name.Equals(RuleName(p), StringComparison.OrdinalIgnoreCase)),
                    OwnEnabled = list.Any(x => x.rule.Enabled && x.rule.Name.Equals(RuleName(p), StringComparison.OrdinalIgnoreCase)),
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

        /// <summary>Her port için "RasyoBOX TCP &lt;port&gt;" gelen izin kuralını (TCP, tüm profiller) oluşturur; varsa yeniler.</summary>
        public static Task<FwActionResult> AllowAsync(IEnumerable<int> portList, CancellationToken ct = default) =>
            RunAsync(CleanPorts(portList), add: true, ct);

        /// <summary>Yalnızca bu uygulamanın oluşturduğu "RasyoBOX TCP &lt;port&gt;" kurallarını siler.</summary>
        public static Task<FwActionResult> RemoveAsync(IEnumerable<int> portList, CancellationToken ct = default) =>
            RunAsync(CleanPorts(portList), add: false, ct);

        private static async Task<FwActionResult> RunAsync(List<int> ports, bool add, CancellationToken ct)
        {
            var res = new FwActionResult();
            if (ports.Count == 0) { res.Message = "Port seçilmedi."; res.Status = ReadStatus(ports); return res; }

            var cmds = new List<string>();
            foreach (var p in ports)
            {
                cmds.Add($"netsh advfirewall firewall delete rule name=\"{RuleName(p)}\" >nul 2>&1");
                if (add)
                    cmds.Add($"netsh advfirewall firewall add rule name=\"{RuleName(p)}\" dir=in action=allow protocol=TCP localport={p} profile=any enable=yes"
                             + $" description=\"RasyoBOX Araclari tarafindan eklendi\" >nul");
            }

            try
            {
                await Task.Run(() => RunScript(cmds, ct), ct);
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
                ? (res.Ok ? $"{ports.Count} port için izin kuralı eklendi." : $"Kural eklenemedi: {string.Join(", ", bad)}")
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
            try { RunCmd(file, ct); }
            finally { try { File.Delete(file); } catch { } }
        }

        private static void RunCmd(string scriptFile, CancellationToken ct)
        {
            bool admin = IsAdmin();
            var psi = new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.SystemDirectory, "cmd.exe"),
                Arguments = $"/d /c call \"{scriptFile}\"",
            };
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
            using var p = Process.Start(psi) ?? throw new InvalidOperationException("cmd.exe başlatılamadı.");
            using var reg = ct.Register(() => { try { p.Kill(); } catch { } });
            if (!p.WaitForExit(120_000)) { try { p.Kill(); } catch { } throw new TimeoutException("netsh 2 dakikada bitmedi."); }
        }
    }

    public sealed class FwStatus
    {
        public bool IsAdmin { get; set; }
        public string Profiles { get; set; } = "";
        public bool ActiveProfileOff { get; set; }
        public string Error { get; set; } = "";
        public List<FwPortStatus> Ports { get; set; } = new();
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
                return sb.ToString();
            }
        }
    }

    public sealed class FwRuleRef
    {
        public string Name { get; set; } = "";
        public bool Enabled { get; set; }
        public bool Allow { get; set; }
        public string Program { get; set; } = "";
        public string Profiles { get; set; } = "";
    }

    public sealed class FwActionResult
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public FwStatus? Status { get; set; }
    }
}
