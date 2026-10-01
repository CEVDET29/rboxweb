using System.Data;
using Microsoft.Data.SqlClient;

namespace RboxAgent.Modules.Ybdb
{
    /// <summary>YBDB veritabanına salt-okunur erişim.</summary>
    internal sealed class YbdbRepository
    {
        private const string SQL_CIHAZ =
            @"SELECT [Id],[Adi],[IP],[Port],[YatakId]
              FROM [dbo].[Cihaz]
              ORDER BY [Id] ASC;";

        private const string SQL_ODALAR =
            @"SELECT o.Id, o.Adi, o.BolumId, ok.Adi AS BolumAdi
              FROM Oda AS o
              LEFT JOIN OdaKategorileri AS ok ON ok.Id = o.BolumId
              ORDER BY o.Adi ASC;";

        private const string SQL_YATAKLAR =
            @"SELECT
                  h.HastaId,
                  CASE WHEN hk.HastakabulId IS NULL THEN NULL
                       ELSE LTRIM(RTRIM(ISNULL(hk.Adi, '') + ' ' + ISNULL(hk.Soyadi, ''))) END AS HastaAdi,
                  y.YatakId,
                  y.Adi AS YatakAdi,
                  o.Id AS OdaId,
                  o.Adi AS OdaAdi,
                  ok.Adi AS BolumAdi,
                  y.Basamak
              FROM Yatak AS y
              INNER JOIN Oda AS o ON o.Id = y.OdaKodu
              INNER JOIN OdaKategorileri AS ok ON ok.Id = o.BolumId
              LEFT JOIN Hasta AS h ON h.YatakId = y.YatakId AND h.CikisSaati IS NULL
              LEFT JOIN Hastakabul AS hk ON hk.HastakabulId = h.HastakabulId AND hk.TaburcuMU = 0
              ORDER BY o.Adi, y.Adi;";

        public const string DurumBos = "Boş";
        public const string DurumDolu = "Dolu";

        private readonly string _connectionString;

        public YbdbRepository(string connectionString) => _connectionString = connectionString;

        /// <summary>Cihaz tablosu düzenleme (CihazRepository) aynı bağlantıyı kullanır.</summary>
        public string ConnectionString => _connectionString;

        public static string BuildConnectionString(string server, string user, string password)
        {
            if (string.IsNullOrWhiteSpace(server))
                throw new ArgumentException("Sunucu adresi boş olamaz.");
            if (string.IsNullOrWhiteSpace(user))
                throw new ArgumentException("Kullanıcı adı boş olamaz.");

            var csb = new SqlConnectionStringBuilder
            {
                DataSource = server.Trim(),
                InitialCatalog = "YBDB",
                UserID = user.Trim(),
                Password = password,
                Encrypt = true,
                TrustServerCertificate = true,
                ConnectTimeout = 5,
                // Varsayılan yeniden deneme, ulaşılamayan sunucuda hatayı ~25 sn geciktiriyordu
                ConnectRetryCount = 0,
                ApplicationName = "YbdbOdalarApp"
            };
            return csb.ToString();
        }

        public async Task TestAsync(CancellationToken ct = default)
        {
            await using var con = new SqlConnection(_connectionString);
            await con.OpenAsync(ct);
        }

        public Task<DataTable> GetOdalarAsync(CancellationToken ct = default) => QueryAsync(SQL_ODALAR, ct);

        public async Task<DataTable> GetYataklarAsync(CancellationToken ct = default)
        {
            var dt = await QueryAsync(SQL_YATAKLAR, ct);

            // Durum kolonu: sıralanabilir ve filtrelenebilir olsun diye istemcide hesaplanır.
            var durum = dt.Columns.Add("Durum", typeof(string));
            foreach (DataRow row in dt.Rows)
                row[durum] = row.IsNull("HastaId") ? DurumBos : DurumDolu;

            return dt;
        }

        public Task<DataTable> GetCihazlarAsync(CancellationToken ct = default) => QueryAsync(SQL_CIHAZ, ct);

        /// <summary>Odalar tablosuna yatak sayısı / doluluk kolonlarını ekler.</summary>
        public static void AddDoluluk(DataTable odalar, DataTable yataklar)
        {
            var sayac = yataklar.AsEnumerable()
                .GroupBy(r => Convert.ToString(r["OdaId"]) ?? "")
                .ToDictionary(g => g.Key, g => (toplam: g.Count(), dolu: g.Count(r => !r.IsNull("HastaId"))));

            var cToplam = odalar.Columns.Add("YatakSayisi", typeof(int));
            var cDolu = odalar.Columns.Add("DoluSayisi", typeof(int));
            var cDoluluk = odalar.Columns.Add("Doluluk", typeof(string));

            foreach (DataRow row in odalar.Rows)
            {
                sayac.TryGetValue(Convert.ToString(row["Id"]) ?? "", out var s);
                row[cToplam] = s.toplam;
                row[cDolu] = s.dolu;
                row[cDoluluk] = s.toplam == 0 ? "—" : $"{s.dolu} / {s.toplam}";
            }
        }

        /// <summary>Cihaz tablosuna bağlı olduğu yatak ve oda adlarını ekler.</summary>
        public static void AddYatakBilgisi(DataTable cihazlar, DataTable yataklar)
        {
            var yatakMap = new Dictionary<string, DataRow>();
            foreach (DataRow y in yataklar.Rows)
                yatakMap.TryAdd(Convert.ToString(y["YatakId"]) ?? "", y);

            var cYatak = cihazlar.Columns.Add("YatakAdi", typeof(string));
            var cOda = cihazlar.Columns.Add("OdaAdi", typeof(string));

            foreach (DataRow row in cihazlar.Rows)
            {
                if (yatakMap.TryGetValue(Convert.ToString(row["YatakId"]) ?? "", out var y))
                {
                    row[cYatak] = y["YatakAdi"];
                    row[cOda] = y["OdaAdi"];
                }
            }
        }

        /// <summary>SQL hatalarını kullanıcıya anlaşılır bir mesaja çevirir.</summary>
        public static string FriendlyError(Exception ex) => ex switch
        {
            SqlException { Number: 18456 } => "Kullanıcı adı veya şifre hatalı.",
            SqlException { Number: 4060 } => "YBDB veritabanına erişim yetkiniz yok ya da veritabanı bulunamadı.",
            SqlException { Number: -2 or 53 or 2 or 40 or 64 or 26 or 258 or 10060 or 11001 } =>
                "Sunucuya ulaşılamadı. Sunucu adresini ve ağ bağlantısını kontrol edin.",
            SqlException sql => $"Veritabanı hatası ({sql.Number}): {sql.Message}",
            ArgumentException => ex.Message,
            _ => ex.Message
        };

        private async Task<DataTable> QueryAsync(string sql, CancellationToken ct)
        {
            await using var con = new SqlConnection(_connectionString);
            await using var cmd = new SqlCommand(sql, con);
            await con.OpenAsync(ct);
            await using var r = await cmd.ExecuteReaderAsync(ct);

            // DataTable.Load senkron okur; UI donmasın diye satırlar async okunur.
            var dt = new DataTable();
            for (int i = 0; i < r.FieldCount; i++)
                dt.Columns.Add(r.GetName(i), r.GetFieldType(i));

            var values = new object[r.FieldCount];
            dt.BeginLoadData();
            while (await r.ReadAsync(ct))
            {
                r.GetValues(values);
                dt.Rows.Add(values);
            }
            dt.EndLoadData();
            return dt;
        }
    }
}
