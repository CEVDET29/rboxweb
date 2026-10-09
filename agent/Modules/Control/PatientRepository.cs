using System.Globalization;
using Microsoft.Data.SqlClient;

namespace RboxAgent.Modules.Control
{
    /// <summary>YBDB'deki bir yatak (Yatak.IpAddress = yataktaki RasyoBOX'ın IP'si).</summary>
    public sealed record BedRow(int YatakId, string YatakAdi, string Ip, string OdaAdi, string BolumAdi, bool Silinmis);

    /// <summary>Yataktaki son hasta kaydı (yatıyorsa aktif; yoksa en son çıkan).</summary>
    public sealed record PatientRow(int HastaId, int YatakId, string Adi, string Soyadi,
                                    DateTime? Kabul, DateTime? Cikis, bool Aktif);

    /// <summary>Bir sinyalin pencere içindeki son değeri.</summary>
    public sealed record SignalValue(int SinyalId, decimal Deger, DateTime Zaman);

    /// <summary>dbo.Cihaz'da yatağa bağlı tıbbi cihaz (ventilatör vb.).</summary>
    public sealed record BedDevice(int YatakId, string Adi, string Ip, string Port);

    /// <summary>Tek sorgu turunun sonucu: kartlar bununla güncellenir.</summary>
    public sealed class PatientSnapshot
    {
        public List<BedRow> Beds { get; } = new();
        public Dictionary<int, PatientRow> PatientByBed { get; } = new();
        /// <summary>HastaId → monitör (HBSinyal) son değerleri.</summary>
        public Dictionary<int, List<SignalValue>> Monitor { get; } = new();
        /// <summary>HastaId → ventilatör (SolunumSinyal) son değerleri.</summary>
        public Dictionary<int, List<SignalValue>> Vent { get; } = new();
        public Dictionary<int, List<BedDevice>> DevicesByBed { get; } = new();
        public DateTime ReadAt { get; set; } = DateTime.Now;
    }

    /// <summary>
    /// Cihaz Kontrol "Hasta" sekmesinin YBDB okumaları — salt okunur (YBDB'de yalnızca dbo.Cihaz düzenlenir,
    /// o da YBDB modülünde). HBSinyal milyonlarca satır ve yalnızca Id üzerinde (clustered PK) indeks var:
    /// HastaId / Tarih ile süzmek tüm tabloyu tarar. Bu yüzden son değerler yalnızca en yeni
    /// <see cref="Window"/> satır içinde (Id aralığı, ucuz) aranır; daha eskisi yalnızca istenince.
    /// </summary>
    public sealed class PatientRepository
    {
        /// <summary>Monitör tablosuna günde ~37 bin satır gelir: ~100 bin satır son 2-3 günü kapsar.</summary>
        public const int Window = 100_000;

        // SerialWorker'ın yazdığı SinyalId'ler (SerialWorkerServiceVol61.dll, SendToDatabase.GetSignals)
        public const int HbHr = 25, HbNibpMean = 0, HbNibpDia = 1, HbNibpSys = 2, HbSpo2 = 66, HbTemp = 74, HbRr = 59;
        public const int VPeep = 50, VPeepUstu = 51, VPip = 53, VPTepe = 56, VPort = 55, VTvi = 72, VTve = 71,
                         VMve = 38, VRr = 57, VRrSet = 58, VFio2 = 16, VIe = 26, VMode = 209;

        private const string SQL_YATAK =
            @"SELECT y.YatakId, y.Adi, LTRIM(RTRIM(ISNULL(y.IpAddress, ''))) AS Ip,
                     ISNULL(o.Adi, '') AS OdaAdi, ISNULL(ok.Adi, '') AS BolumAdi,
                     CAST(CASE WHEN y.SilinmeTarihi IS NULL THEN 0 ELSE 1 END AS bit) AS Silinmis
              FROM Yatak AS y
              LEFT JOIN Oda AS o ON o.Id = y.OdaKodu
              LEFT JOIN OdaKategorileri AS ok ON ok.Id = o.BolumId;";

        // Yatak başına bir kayıt: yatan hasta (CikisSaati boş — YBDB modülündeki 'Dolu' ile aynı kural) önce,
        // yoksa en son kabul edilen (taburcu olmuş) hasta.
        private const string SQL_HASTA =
            @"SELECT HastaId, YatakId, Adi, Soyadi, KabulTarihi, KabulSaati, CikisTarihi, CikisSaati, Aktif
              FROM (
                  SELECT h.HastaId, h.YatakId, ISNULL(hk.Adi, '') AS Adi, ISNULL(hk.Soyadi, '') AS Soyadi,
                         h.KabulTarihi, h.KabulSaati, h.CikisTarihi, h.CikisSaati,
                         CAST(CASE WHEN h.CikisSaati IS NULL THEN 1 ELSE 0 END AS bit) AS Aktif,
                         ROW_NUMBER() OVER (PARTITION BY h.YatakId
                             ORDER BY CASE WHEN h.CikisSaati IS NULL THEN 0 ELSE 1 END,
                                      h.KabulTarihi DESC, h.KabulSaati DESC, h.HastaId DESC) AS rn
                  FROM Hasta AS h
                  LEFT JOIN HastaKabul AS hk ON hk.HastaKabulId = h.HastaKabulId
                  WHERE h.YatakId IS NOT NULL
              ) AS x
              WHERE x.rn = 1;";

        private const string SQL_CIHAZ =
            @"SELECT YatakId, ISNULL(Adi, '') AS Adi, ISNULL(IP, '') AS IP, ISNULL(Port, '') AS Port
              FROM [dbo].[Cihaz]
              WHERE YatakId IS NOT NULL AND SilinmeTarihi IS NULL
              ORDER BY YatakId, Id;";


        private readonly string _connectionString;

        public PatientRepository(string connectionString) => _connectionString = connectionString;

        /// <summary>Yataklar, son hastalar, bağlı cihazlar ve aktif hastaların son monitör / ventilatör değerleri.</summary>
        public async Task<PatientSnapshot> ReadAsync(CancellationToken ct = default)
        {
            var s = new PatientSnapshot();
            await using var con = new SqlConnection(_connectionString);
            await con.OpenAsync(ct);

            await ReadRowsAsync(con, SQL_YATAK, r => s.Beds.Add(new BedRow(
                r.GetInt32(0), Str(r, 1), Str(r, 2), Str(r, 3), Str(r, 4), !r.IsDBNull(5) && r.GetBoolean(5))), ct);

            await ReadRowsAsync(con, SQL_HASTA, r =>
            {
                var p = new PatientRow(r.GetInt32(0), r.GetInt32(1), Str(r, 2), Str(r, 3),
                                       Combine(r, 4, 5), Combine(r, 6, 7), !r.IsDBNull(8) && r.GetBoolean(8));
                s.PatientByBed[p.YatakId] = p;
            }, ct);

            await ReadRowsAsync(con, SQL_CIHAZ, r =>
            {
                var d = new BedDevice(r.GetInt32(0), Str(r, 1), Str(r, 2), Str(r, 3));
                if (!s.DevicesByBed.TryGetValue(d.YatakId, out var list)) s.DevicesByBed[d.YatakId] = list = new();
                list.Add(d);
            }, ct);

            var aktif = s.PatientByBed.Values.Where(p => p.Aktif).Select(p => p.HastaId).Distinct().ToList();
            if (aktif.Count > 0)
            {
                await ReadLatestAsync(con, "HBSinyal", aktif, s.Monitor, ct);
                await ReadLatestAsync(con, "SolunumSinyal", aktif, s.Vent, ct);
            }
            s.ReadAt = DateTime.Now;
            return s;
        }

        /// <summary>
        /// Pencerede veri bulunamayan bir hasta için daha eski kayıtlar: Id'ye göre geriye doğru en yeni 300 satır.
        /// Hastanın hiç kaydı yoksa tüm tablo taranır — yalnızca kullanıcı isteyince çağrılır.
        /// </summary>
        public async Task<List<SignalValue>> ReadOlderAsync(string table, int hastaId, CancellationToken ct = default)
        {
            if (table is not ("HBSinyal" or "SolunumSinyal")) throw new ArgumentException(nameof(table));
            var rows = new List<SignalValue>();
            await using var con = new SqlConnection(_connectionString);
            await con.OpenAsync(ct);
            string sql = $@"SELECT TOP 300 SinyalId, Deger, Tarih, Saat FROM [dbo].[{table}]
                            WHERE HastaId = @h AND ISNULL(ManuelMi, 0) = 0
                            ORDER BY Id DESC;";
            await using var cmd = new SqlCommand(sql, con) { CommandTimeout = 120 };
            cmd.Parameters.Add(new SqlParameter("@h", System.Data.SqlDbType.Int) { Value = hastaId });
            await using var r = await cmd.ExecuteReaderAsync(ct);
            var seen = new HashSet<int>();
            while (await r.ReadAsync(ct))
            {
                int id = r.GetInt32(0);
                if (r.IsDBNull(1) || !seen.Add(id)) continue; // satırlar yeniden eskiye: ilk görülen en yenisi
                rows.Add(new SignalValue(id, r.GetDecimal(1), Combine(r, 2, 3) ?? DateTime.MinValue));
            }
            return rows;
        }

        /// <summary>Son <see cref="Window"/> satırda (Id aralığı) her hasta + sinyal için en yeni, cihazdan gelen değer.</summary>
        private static async Task ReadLatestAsync(SqlConnection con, string table, List<int> hastaIds,
                                                  Dictionary<int, List<SignalValue>> target, CancellationToken ct)
        {
            // Id'ler sayı olarak üretiliyor (kullanıcı girdisi değil); IN listesi güvenli
            string ids = string.Join(",", hastaIds.Select(i => i.ToString(CultureInfo.InvariantCulture)));
            string sql = $@"DECLARE @max int = (SELECT MAX(Id) FROM [dbo].[{table}]);
                SELECT HastaId, SinyalId, Deger, Tarih, Saat
                FROM (
                    SELECT s.HastaId, s.SinyalId, s.Deger, s.Tarih, s.Saat,
                           ROW_NUMBER() OVER (PARTITION BY s.HastaId, s.SinyalId ORDER BY s.Id DESC) AS rn
                    FROM [dbo].[{table}] AS s
                    WHERE s.Id > @max - {Window} AND s.HastaId IN ({ids}) AND ISNULL(s.ManuelMi, 0) = 0
                ) AS x
                WHERE x.rn = 1;";
            await ReadRowsAsync(con, sql, r =>
            {
                if (r.IsDBNull(2)) return;
                int h = r.GetInt32(0);
                if (!target.TryGetValue(h, out var list)) target[h] = list = new();
                list.Add(new SignalValue(r.GetInt32(1), r.GetDecimal(2), Combine(r, 3, 4) ?? DateTime.MinValue));
            }, ct);
        }

        private static async Task ReadRowsAsync(SqlConnection con, string sql, Action<SqlDataReader> row, CancellationToken ct)
        {
            await using var cmd = new SqlCommand(sql, con) { CommandTimeout = 30 };
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct)) row(r);
        }

        private static string Str(SqlDataReader r, int i) => r.IsDBNull(i) ? "" : Convert.ToString(r.GetValue(i))?.Trim() ?? "";

        /// <summary>date + time sütunlarını birleştirir (saat boşsa gün başı).</summary>
        private static DateTime? Combine(SqlDataReader r, int dateCol, int timeCol)
        {
            if (r.IsDBNull(dateCol)) return null;
            var d = Convert.ToDateTime(r.GetValue(dateCol)).Date;
            if (!r.IsDBNull(timeCol) && r.GetValue(timeCol) is TimeSpan t) d += t;
            return d;
        }
    }
}
