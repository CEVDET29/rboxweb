using System.Net;

namespace RboxAgent.Modules.Ping
{
    public record CheckOptions(
        bool CheckSsh,
        bool CheckMac,
        bool CheckVendor,
        bool SshMacFallback,
        string SshUser,
        string SshPass,
        int PingTimeoutMs,
        int TcpTimeoutMs,
        int SshTimeoutMs);

    /// <summary>Bir cihazın kontrol sonucu. null alanlar "atlandı / çalıştırılmadı" demektir.</summary>
    public sealed class DeviceCheckResult
    {
        public bool IpValid { get; init; }
        public bool? PingOk { get; init; }
        /// <summary>Ping gidiş-dönüş süresi (ms); yanıt yoksa null.</summary>
        public long? PingMs { get; init; }
        public bool? SshOpen { get; init; }

        public bool MacChecked { get; init; }
        public string? DetectedMac { get; init; }
        public bool MacViaSsh { get; init; }

        public string ExcelMacDisplay { get; init; } = "";
        public bool ExcelMacValid { get; init; }
        /// <summary>İki MAC de geçerliyse eşleşme sonucu, değilse null.</summary>
        public bool? MacMatch { get; init; }

        /// <summary>null: vendor kontrolü kapalı. "": kontrol açık ama MAC yok.</summary>
        public string? Vendor { get; init; }

        public bool HasProblem =>
            !IpValid
            || PingOk == false
            || SshOpen == false
            || MacMatch == false
            || (MacChecked && DetectedMac == null);

        /// <summary>İzleme modunda değişiklik tespiti için özet imza.</summary>
        public string Signature =>
            $"{IpValid}|{PingOk}|{SshOpen}|{MacKeyOrEmpty(DetectedMac)}|{MacMatch}";

        private static string MacKeyOrEmpty(string? mac) => MacAddress.ToKey(mac);
    }

    public static class DeviceChecker
    {
        public static async Task<DeviceCheckResult> CheckAsync(
            string ipText, string? excelMacRaw, CheckOptions opt, CancellationToken ct)
        {
            string excelMacDisp = MacAddress.ToDisplay(excelMacRaw);
            bool excelMacValid = MacAddress.IsValid(excelMacDisp);

            if (!IPAddress.TryParse(ipText.Trim(), out var ip))
            {
                return new DeviceCheckResult
                {
                    IpValid = false,
                    ExcelMacDisplay = excelMacDisp,
                    ExcelMacValid = excelMacValid,
                };
            }

            ct.ThrowIfCancellationRequested();

            // 1) PING
            long? pingMs = await NetworkTools.PingAsync(ip, opt.PingTimeoutMs, ct).ConfigureAwait(false);
            bool pingOk = pingMs != null;

            // 2) SSH 22/tcp (opsiyonel)
            bool? sshOpen = null;
            if (opt.CheckSsh)
                sshOpen = await NetworkTools.CheckTcpPortOpenAsync(ip, 22, opt.TcpTimeoutMs, ct).ConfigureAwait(false);

            // 3) MAC tespiti (opsiyonel): önce ARP, yoksa SSH fallback
            string? detectedMac = null;
            bool macViaSsh = false;
            if (opt.CheckMac && (pingOk || sshOpen == true))
            {
                detectedMac = NullIfEmpty(MacAddress.ToDisplay(
                    await NetworkTools.GetMacFromArpAsync(ip, ct).ConfigureAwait(false)));

                if (detectedMac == null && opt.SshMacFallback && sshOpen == true && !string.IsNullOrWhiteSpace(opt.SshUser))
                {
                    var sshMac = await NetworkTools.GetMacViaSshAsync(ip, opt.SshUser, opt.SshPass, opt.SshTimeoutMs, ct)
                                                   .ConfigureAwait(false);
                    detectedMac = NullIfEmpty(MacAddress.ToDisplay(sshMac));
                    macViaSsh = detectedMac != null;
                }
            }

            bool detectedValid = MacAddress.IsValid(detectedMac);

            // 4) Excel MAC ↔ cihaz MAC karşılaştırma
            bool? macMatch = (excelMacValid && detectedValid)
                ? MacAddress.ToKey(excelMacDisp) == MacAddress.ToKey(detectedMac)
                : null;

            // 5) Vendor (opsiyonel) — öncelik: cihaz MAC, yoksa Excel MAC
            string? vendor = null;
            if (opt.CheckVendor)
            {
                string? macForVendor = detectedValid ? detectedMac : (excelMacValid ? excelMacDisp : null);
                vendor = macForVendor != null ? OuiLookup.GetVendor(macForVendor) : "";
            }

            return new DeviceCheckResult
            {
                IpValid = true,
                PingOk = pingOk,
                PingMs = pingMs,
                SshOpen = sshOpen,
                MacChecked = opt.CheckMac,
                DetectedMac = detectedValid ? detectedMac : null,
                MacViaSsh = macViaSsh,
                ExcelMacDisplay = excelMacDisp,
                ExcelMacValid = excelMacValid,
                MacMatch = macMatch,
                Vendor = vendor,
            };
        }

        private static string? NullIfEmpty(string? s) => string.IsNullOrWhiteSpace(s) ? null : s;
    }
}
