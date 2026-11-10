using System.Net;

namespace RboxAgent.Modules.Ping
{
    /// <summary>SSH yanıtı kontrolünün sonucu.</summary>
    public enum SshBannerState { Closed, NoResponse, Responding }

    /// <summary>Cihazdan okunan yatak ID'sinin Excel'dekiyle karşılaştırması.</summary>
    public enum BedIdState
    {
        /// <summary>Okunamadı (SSH yok, dosya / alan yok).</summary>
        Unread,
        /// <summary>Okundu, Excel'de yatak ID yok: karşılaştırılmadı.</summary>
        NoExcel,
        Match,
        Mismatch,
        /// <summary>Cihazdaki değer 999: karşılaştırmadan önce gelir, sorun sayılmaz.</summary>
        Is999,
    }

    public record CheckOptions(
        bool CheckSsh,
        bool CheckSshBanner,
        bool CheckMac,
        bool CheckVendor,
        bool SshMacFallback,
        bool CheckBedId,
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
        /// <summary>SSH yanıtı (sshd karşılama satırı); kontrol kapalıysa null.</summary>
        public SshBannerState? SshBanner { get; init; }
        /// <summary>Karşılama satırı (ör. "SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u3"); yoksa boş.</summary>
        public string SshBannerText { get; init; } = "";

        public bool MacChecked { get; init; }
        public string? DetectedMac { get; init; }
        public bool MacViaSsh { get; init; }

        public string ExcelMacDisplay { get; init; } = "";
        public bool ExcelMacValid { get; init; }
        /// <summary>İki MAC de geçerliyse eşleşme sonucu, değilse null.</summary>
        public bool? MacMatch { get; init; }

        /// <summary>null: vendor kontrolü kapalı. "": kontrol açık ama MAC yok.</summary>
        public string? Vendor { get; init; }

        /// <summary>Yatak ID kontrolü kapalıysa null.</summary>
        public BedIdState? BedId { get; init; }
        /// <summary>Cihazdaki JsonSettings.json'dan okunan YatakId; okunamadıysa null.</summary>
        public string? DeviceBedId { get; init; }
        /// <summary>Okunamadıysa sebebi.</summary>
        public string? BedIdError { get; init; }

        public bool HasProblem =>
            !IpValid
            || PingOk == false
            || SshOpen == false
            || (SshBanner != null && SshBanner != SshBannerState.Responding)
            || MacMatch == false
            || (MacChecked && DetectedMac == null)
            || BedId == BedIdState.Mismatch;

        /// <summary>İzleme modunda değişiklik tespiti için özet imza.</summary>
        public string Signature =>
            $"{IpValid}|{PingOk}|{SshOpen}|{SshBanner}|{MacKeyOrEmpty(DetectedMac)}|{MacMatch}|{DeviceBedId}";

        private static string MacKeyOrEmpty(string? mac) => MacAddress.ToKey(mac);
    }

    public static class DeviceChecker
    {
        public static async Task<DeviceCheckResult> CheckAsync(
            string ipText, string? excelMacRaw, string? excelBedIdRaw, CheckOptions opt, CancellationToken ct)
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

            // 2) SSH 22/tcp ve SSH yanıtı (opsiyonel). Yanıt kontrolü portu da denediğinden ikisi açıksa tek bağlantı yeter.
            bool? sshOpen = null;
            SshBannerState? banner = null;
            string bannerText = "";
            if (opt.CheckSshBanner)
            {
                (var state, bannerText) = await NetworkTools.CheckSshBannerAsync(ip, opt.TcpTimeoutMs, 1500, ct).ConfigureAwait(false);
                banner = state;
                if (opt.CheckSsh) sshOpen = state != SshBannerState.Closed;
            }
            else if (opt.CheckSsh)
                sshOpen = await NetworkTools.CheckTcpPortOpenAsync(ip, 22, opt.TcpTimeoutMs, ct).ConfigureAwait(false);
            bool port22 = sshOpen == true || banner is SshBannerState.Responding or SshBannerState.NoResponse;

            // 3) MAC tespiti (opsiyonel): önce ARP, yoksa SSH fallback
            string? detectedMac = null;
            bool macViaSsh = false;
            if (opt.CheckMac && (pingOk || port22))
                detectedMac = NullIfEmpty(MacAddress.ToDisplay(
                    await NetworkTools.GetMacFromArpAsync(ip, ct).ConfigureAwait(false)));

            // 4) SSH ile MAC (ARP yoksa) ve yatak ID: ikisi de gerekiyorsa tek bağlantı
            bool sshUsable = port22 && banner != SshBannerState.NoResponse && !string.IsNullOrWhiteSpace(opt.SshUser);
            bool wantSshMac = opt.CheckMac && detectedMac == null && opt.SshMacFallback;
            string? deviceBedId = null, bedError = null;
            if (sshUsable && (wantSshMac || opt.CheckBedId))
            {
                var (sshMac, bed, err) = await NetworkTools.ReadViaSshAsync(
                    ip, opt.SshUser, opt.SshPass, opt.SshTimeoutMs, wantSshMac, opt.CheckBedId, ct).ConfigureAwait(false);
                if (wantSshMac)
                {
                    detectedMac = NullIfEmpty(MacAddress.ToDisplay(sshMac));
                    macViaSsh = detectedMac != null;
                }
                (deviceBedId, bedError) = (bed, err);
            }
            else if (opt.CheckBedId)
            {
                bedError = string.IsNullOrWhiteSpace(opt.SshUser) ? "SSH kullanıcı adı girilmemiş (üst banttaki SSH düğmesi)"
                         : banner == SshBannerState.NoResponse ? "SSH yanıt vermiyor"
                         : "SSH portu (22) kapalı ya da cihaza ulaşılamıyor";
            }

            BedIdState? bedState = null;
            if (opt.CheckBedId)
            {
                string excelBed = BedKey(excelBedIdRaw);
                bedState = deviceBedId == null ? BedIdState.Unread
                         : deviceBedId == "999" ? BedIdState.Is999
                         : excelBed.Length == 0 ? BedIdState.NoExcel
                         : excelBed == deviceBedId ? BedIdState.Match
                         : BedIdState.Mismatch;
            }

            bool detectedValid = MacAddress.IsValid(detectedMac);

            // 5) Excel MAC ↔ cihaz MAC karşılaştırma
            bool? macMatch = (excelMacValid && detectedValid)
                ? MacAddress.ToKey(excelMacDisp) == MacAddress.ToKey(detectedMac)
                : null;

            // 6) Vendor (opsiyonel) — öncelik: cihaz MAC, yoksa Excel MAC
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
                SshBanner = banner,
                SshBannerText = bannerText,
                MacChecked = opt.CheckMac,
                DetectedMac = detectedValid ? detectedMac : null,
                MacViaSsh = macViaSsh,
                ExcelMacDisplay = excelMacDisp,
                ExcelMacValid = excelMacValid,
                MacMatch = macMatch,
                Vendor = vendor,
                BedId = bedState,
                DeviceBedId = deviceBedId,
                BedIdError = bedError,
            };
        }

        private static string? NullIfEmpty(string? s) => string.IsNullOrWhiteSpace(s) ? null : s;

        /// <summary>Excel'deki yatak ID'si: "13.0" / " 13 " → "13".</summary>
        private static string BedKey(string? v)
        {
            var t = (v ?? "").Trim();
            if (decimal.TryParse(t, System.Globalization.NumberStyles.Number, System.Globalization.CultureInfo.InvariantCulture, out var d)
                && d == decimal.Truncate(d) && d >= 0)
                return ((long)d).ToString(System.Globalization.CultureInfo.InvariantCulture);
            return t;
        }
    }
}
