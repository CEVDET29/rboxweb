using System.Data;
using System.Globalization;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace RboxAgent.Modules.Ybdb
{
    public sealed class ConnectRequest
    {
        public string? Server { get; set; }
        public string? User { get; set; }
        /// <summary>null / boş: kayıtlı parola kullanılır (varsa).</summary>
        public string? Pass { get; set; }
        public bool Remember { get; set; }
    }

    public sealed record OdaDto(string Id, string Adi, string BolumAdi, int YatakSayisi, int DoluSayisi, int Renk);
    public sealed record YatakDto(string YatakId, string YatakAdi, string OdaId, string OdaAdi, string BolumAdi,
                                  string? HastaId, string? HastaAdi, string? Basamak, string Durum, int Renk);
    public sealed record BolumDto(string Ad, int Renk);
    public sealed record YbdbData(List<OdaDto> Odalar, List<YatakDto> Yataklar, List<BolumDto> Bolumler, string Zaman);

    /// <summary>YBDB (SQL Server) salt-okunur erişim. Bağlantı dizesi yalnızca bellekte tutulur.</summary>
    public static class YbdbService
    {
        private static YbdbRepository? _repo;
        private static string _server = "";

        public static bool Connected => _repo != null;
        public static string ConnectedServer => _server;

        /// <summary>Bu PC'nin IPv4 adresi: önce Wi-Fi, yoksa Ethernet (WPF sürümündeki varsayılan sunucu).</summary>
        public static string? PreferredIPv4() =>
            Find(NetworkInterfaceType.Wireless80211) ?? Find(NetworkInterfaceType.Ethernet);

        private static string? Find(NetworkInterfaceType type)
        {
            try
            {
                foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (nic.OperationalStatus != OperationalStatus.Up || nic.NetworkInterfaceType != type) continue;
                    var props = nic.GetIPProperties();
                    if (props.GatewayAddresses.Count == 0) continue;
                    foreach (var ua in props.UnicastAddresses)
                        if (ua.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(ua.Address))
                            return ua.Address.ToString();
                }
            }
            catch (NetworkInformationException) { }
            return null;
        }

        /// <summary>Bağlantıyı dener; başarılıysa ayarları kaydeder. Hata metni kullanıcıya gösterilebilir Türkçe mesajdır.</summary>
        public static async Task<(bool ok, string message)> ConnectAsync(ConnectRequest req)
        {
            var s = DataStore.Settings.Ybdb;
            string server = (req.Server ?? "").Trim();
            string user = (req.User ?? "").Trim();
            string pass = !string.IsNullOrEmpty(req.Pass) ? req.Pass : DataStore.Unprotect(s.PassProtected);

            try
            {
                var repo = new YbdbRepository(YbdbRepository.BuildConnectionString(server, user, pass));
                // SqlClient, ulaşılamayan bir IP'de ~25 sn bekleyebiliyor; kullanıcı bu kadar beklemesin
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(8));
                await repo.TestAsync(cts.Token);
                _repo = repo;
                _server = server;
            }
            catch (OperationCanceledException)
            {
                return (false, "Sunucuya ulaşılamadı. Sunucu adresini ve ağ bağlantısını kontrol edin.");
            }
            catch (Exception ex)
            {
                return (false, YbdbRepository.FriendlyError(ex));
            }

            s.Server = server;
            s.User = string.IsNullOrWhiteSpace(user) ? "RasyoUser" : user;
            s.RememberPassword = req.Remember;
            if (!req.Remember) s.PassProtected = null;
            else if (!string.IsNullOrEmpty(req.Pass)) s.PassProtected = DataStore.Protect(req.Pass);
            DataStore.Save();
            return (true, server);
        }

        public static async Task<YbdbData> LoadAsync()
        {
            var repo = _repo ?? throw new InvalidOperationException("Bağlı değil.");
            var odalarTask = repo.GetOdalarAsync();
            var yataklarTask = repo.GetYataklarAsync();
            await Task.WhenAll(odalarTask, yataklarTask);
            var odalar = odalarTask.Result;
            var yataklar = yataklarTask.Result;
            YbdbRepository.AddDoluluk(odalar, yataklar);

            // Her bölüme (GYB-2, GYB-3...) ada göre sıralı bir renk sırası; oda ve yatak aynı bölümde aynı renkte (WPF ile aynı)
            var tr = CultureInfo.GetCultureInfo("tr-TR");
            var cmp = StringComparer.Create(tr, ignoreCase: true);
            var names = odalar.AsEnumerable().Select(r => S(r, "BolumAdi") ?? "")
                .Concat(yataklar.AsEnumerable().Select(r => S(r, "BolumAdi") ?? ""))
                .Where(n => n.Length > 0).Distinct(cmp).OrderBy(n => n, cmp).ToList();
            var map = names.Select((n, i) => (n, i)).ToDictionary(p => p.n, p => p.i, cmp);
            int Renk(string? ad) => ad != null && map.TryGetValue(ad, out int i) ? i : -1;

            return new YbdbData(
                odalar.AsEnumerable().Select(r => new OdaDto(
                    S(r, "Id") ?? "", S(r, "Adi") ?? "", S(r, "BolumAdi") ?? "",
                    Convert.ToInt32(r["YatakSayisi"]), Convert.ToInt32(r["DoluSayisi"]), Renk(S(r, "BolumAdi")))).ToList(),
                yataklar.AsEnumerable().Select(r => new YatakDto(
                    S(r, "YatakId") ?? "", S(r, "YatakAdi") ?? "", S(r, "OdaId") ?? "", S(r, "OdaAdi") ?? "", S(r, "BolumAdi") ?? "",
                    S(r, "HastaId"), S(r, "HastaAdi"), S(r, "Basamak"), S(r, "Durum") ?? "", Renk(S(r, "BolumAdi")))).ToList(),
                names.Select(n => new BolumDto(n, map[n])).ToList(),
                DateTime.Now.ToString("dd.MM.yyyy HH:mm:ss"));
        }

        /// <summary>Hücreyi metne çevirir; NULL ve boş metin null olur.</summary>
        private static string? S(DataRow r, string col)
        {
            if (!r.Table.Columns.Contains(col) || r.IsNull(col)) return null;
            string v = Convert.ToString(r[col], CultureInfo.InvariantCulture)?.Trim() ?? "";
            return v.Length == 0 ? null : v;
        }
    }
}
