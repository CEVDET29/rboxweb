using Microsoft.Data.SqlClient;

namespace RboxAgent.Modules.Ybdb
{
    // NOT: Bu dosya WPF (RboxTools/Modules/Ybdb) ile web ajanında (RboxWeb/agent/Modules/Ybdb) aynıdır;
    // yalnızca namespace farklıdır. Birinde değişiklik yapınca diğerine de kopyalayın.

    /// <summary>YBDB dbo.Cihaz satırı: yalnızca düzenlenen sütunlar (Id, Adi, CTS, IP, Port, YatakId).</summary>
    public sealed class CihazKaydi
    {
        public int Id { get; set; }
        public string? Adi { get; set; }
        public string? Cts { get; set; }
        public string? Ip { get; set; }
        public string? Port { get; set; }
        public int? YatakId { get; set; }
        /// <summary>Hastane yazılımı SilinmeTarihi doldurmuş (yalnızca bilgi; listede soluk gösterilir).</summary>
        public bool Silinmis { get; set; }

        public CihazKaydi Clone() => (CihazKaydi)MemberwiseClone();
    }

    /// <summary>Kayıt, okunduktan sonra başkası tarafından değiştirilmiş / silinmiş.</summary>
    public sealed class CihazConflictException(string message) : Exception(message);

    /// <summary>
    /// dbo.Cihaz üzerinde ekle / güncelle / sil. Yalnızca Adi, CTS, IP, Port, YatakId yazılır; diğer sütunlara
    /// dokunulmaz (yeni satırda NULL kalır). Güncelleme ve silme iyimser eşzamanlılıkla yapılır: satır okunduğu
    /// haliyle değilse hiçbir şey yazılmaz ve <see cref="CihazConflictException"/> fırlatılır. Silme gerçek DELETE'tir.
    /// </summary>
    public sealed class CihazRepository(string connectionString)
    {
        public const int AdiMax = 200, KisaMax = 50;

        private const string SqlList =
            @"SELECT [Id],[Adi],[CTS],[IP],[Port],[YatakId],
                     CAST(CASE WHEN [SilinmeTarihi] IS NULL THEN 0 ELSE 1 END AS bit) AS [Silinmis]
              FROM [dbo].[Cihaz] ORDER BY [Id];";

        // NULL'ları da eşit sayan karşılaştırma: okunduğu andaki değerler hâlâ aynı mı
        private const string SameAsOriginal =
            @"[Id] = @Id
              AND (([Adi] = @oAdi) OR ([Adi] IS NULL AND @oAdi IS NULL))
              AND (([CTS] = @oCts) OR ([CTS] IS NULL AND @oCts IS NULL))
              AND (([IP] = @oIp) OR ([IP] IS NULL AND @oIp IS NULL))
              AND (([Port] = @oPort) OR ([Port] IS NULL AND @oPort IS NULL))
              AND (([YatakId] = @oYatak) OR ([YatakId] IS NULL AND @oYatak IS NULL))";

        public async Task<List<CihazKaydi>> ListAsync(CancellationToken ct = default)
        {
            await using var con = new SqlConnection(connectionString);
            await using var cmd = new SqlCommand(SqlList, con);
            await con.OpenAsync(ct);
            await using var r = await cmd.ExecuteReaderAsync(ct);
            var list = new List<CihazKaydi>();
            while (await r.ReadAsync(ct))
                list.Add(new CihazKaydi
                {
                    Id = Convert.ToInt32(r["Id"]),
                    Adi = Str(r["Adi"]), Cts = Str(r["CTS"]), Ip = Str(r["IP"]), Port = Str(r["Port"]),
                    YatakId = r["YatakId"] is DBNull ? null : Convert.ToInt32(r["YatakId"]),
                    Silinmis = Convert.ToBoolean(r["Silinmis"]),
                });
            return list;
        }

        /// <summary>Yeni satır ekler ve Id'sini döner. Id kimlik (IDENTITY) sütunu değilse en büyük Id + 1 kilitli olarak verilir.</summary>
        public async Task<int> InsertAsync(CihazKaydi k, CancellationToken ct = default)
        {
            Validate(k);
            await using var con = new SqlConnection(connectionString);
            await con.OpenAsync(ct);
            await using var tx = (SqlTransaction)await con.BeginTransactionAsync(ct);

            bool identity;
            await using (var c = new SqlCommand("SELECT COLUMNPROPERTY(OBJECT_ID('dbo.Cihaz'), 'Id', 'IsIdentity');", con, tx))
                identity = Convert.ToInt32(await c.ExecuteScalarAsync(ct) ?? 0) == 1;

            int id;
            if (identity)
            {
                await using var c = new SqlCommand(
                    @"INSERT INTO [dbo].[Cihaz] ([Adi],[CTS],[IP],[Port],[YatakId])
                      OUTPUT INSERTED.[Id] VALUES (@Adi,@Cts,@Ip,@Port,@Yatak);", con, tx);
                AddValues(c, k);
                id = Convert.ToInt32(await c.ExecuteScalarAsync(ct));
            }
            else
            {
                // Aynı anda iki ekleme aynı Id'yi almasın: tablo aralığı işlem bitene kadar kilitli
                await using (var c = new SqlCommand("SELECT ISNULL(MAX([Id]), 0) + 1 FROM [dbo].[Cihaz] WITH (UPDLOCK, HOLDLOCK);", con, tx))
                    id = Convert.ToInt32(await c.ExecuteScalarAsync(ct));
                await using var ins = new SqlCommand(
                    @"INSERT INTO [dbo].[Cihaz] ([Id],[Adi],[CTS],[IP],[Port],[YatakId]) VALUES (@Id,@Adi,@Cts,@Ip,@Port,@Yatak);", con, tx);
                ins.Parameters.AddWithValue("@Id", id);
                AddValues(ins, k);
                await ins.ExecuteNonQueryAsync(ct);
            }
            await tx.CommitAsync(ct);
            return id;
        }

        /// <summary>Satırı günceller; okunduğu haliyle değilse yazmaz ve CihazConflictException fırlatır.</summary>
        public async Task UpdateAsync(CihazKaydi original, CihazKaydi changed, CancellationToken ct = default)
        {
            Validate(changed);
            await using var con = new SqlConnection(connectionString);
            await using var c = new SqlCommand(
                $@"UPDATE [dbo].[Cihaz] SET [Adi]=@Adi, [CTS]=@Cts, [IP]=@Ip, [Port]=@Port, [YatakId]=@Yatak
                   WHERE {SameAsOriginal};", con);
            AddValues(c, changed, original);
            AddOriginal(c, original);
            await con.OpenAsync(ct);
            int n = await c.ExecuteNonQueryAsync(ct);
            if (n == 0) throw new CihazConflictException(
                $"Cihaz {original.Id} siz açtıktan sonra başka biri tarafından değiştirilmiş ya da silinmiş. Hiçbir şey yazılmadı; listeyi yenileyip tekrar deneyin.");
        }

        /// <summary>Satırı kalıcı olarak siler (DELETE); okunduğu haliyle değilse silmez.</summary>
        public async Task DeleteAsync(CihazKaydi original, CancellationToken ct = default)
        {
            await using var con = new SqlConnection(connectionString);
            await using var c = new SqlCommand($"DELETE FROM [dbo].[Cihaz] WHERE {SameAsOriginal};", con);
            AddOriginal(c, original);
            await con.OpenAsync(ct);
            int n = await c.ExecuteNonQueryAsync(ct);
            if (n == 0) throw new CihazConflictException(
                $"Cihaz {original.Id} siz açtıktan sonra değiştirilmiş ya da zaten silinmiş. Hiçbir şey silinmedi; listeyi yenileyin.");
        }

        /// <summary>Uzunluk sınırları (varchar(200) / varchar(50)); aşılırsa SQL kesme hatası yerine açık mesaj.</summary>
        public static void Validate(CihazKaydi k)
        {
            Check(k.Adi, AdiMax, "Adi");
            Check(k.Cts, KisaMax, "CTS");
            Check(k.Ip, KisaMax, "IP");
            Check(k.Port, KisaMax, "Port");
            static void Check(string? v, int max, string name)
            {
                if (v != null && v.Length > max) throw new ArgumentException($"{name} en fazla {max} karakter olabilir ({v.Length} yazıldı).");
            }
        }

        /// <summary>Yazma hatalarını anlaşılır Türkçe mesaja çevirir (okuma hataları YbdbRepository.FriendlyError'da).</summary>
        public static string FriendlyWriteError(Exception ex) => ex switch
        {
            CihazConflictException or ArgumentException => ex.Message,
            SqlException { Number: 229 or 230 } => "Bu SQL kullanıcısının Cihaz tablosuna yazma yetkisi yok. Yetkili bir kullanıcıyla bağlanın.",
            SqlException { Number: 547 } => "Bu cihaz başka kayıtlarda kullanılıyor (ilişkili tablo); silinemez / değiştirilemez.",
            SqlException { Number: 2627 or 2601 } => "Aynı anahtar değerine sahip başka bir kayıt var.",
            SqlException { Number: 515 } => "Tabloda boş bırakılamayan bir sütun var (NOT NULL); bu alanlar olmadan kayıt eklenemiyor.",
            SqlException { Number: 8152 or 2628 } => "Girilen değer sütun için çok uzun.",
            SqlException sql => $"Veritabanı hatası ({sql.Number}): {sql.Message}",
            _ => ex.Message,
        };

        private static string? Str(object v)
        {
            if (v is DBNull) return null;
            var s = Convert.ToString(v);
            return s;
        }

        /// <summary>Boş alan NULL yazılır; ancak veritabanında zaten boş metin ('') ise öyle kalır (dokunulmamış alan değişmesin).</summary>
        private static object Db(string? s, string? original = null) =>
            !string.IsNullOrEmpty(s) ? s : original == "" ? "" : DBNull.Value;

        private static void AddValues(SqlCommand c, CihazKaydi k, CihazKaydi? o = null)
        {
            c.Parameters.Add(new SqlParameter("@Adi", System.Data.SqlDbType.VarChar, AdiMax) { Value = Db(k.Adi, o?.Adi) });
            c.Parameters.Add(new SqlParameter("@Cts", System.Data.SqlDbType.VarChar, KisaMax) { Value = Db(k.Cts, o?.Cts) });
            c.Parameters.Add(new SqlParameter("@Ip", System.Data.SqlDbType.VarChar, KisaMax) { Value = Db(k.Ip, o?.Ip) });
            c.Parameters.Add(new SqlParameter("@Port", System.Data.SqlDbType.VarChar, KisaMax) { Value = Db(k.Port, o?.Port) });
            c.Parameters.Add(new SqlParameter("@Yatak", System.Data.SqlDbType.Int) { Value = (object?)k.YatakId ?? DBNull.Value });
        }

        private static void AddOriginal(SqlCommand c, CihazKaydi o)
        {
            c.Parameters.AddWithValue("@Id", o.Id);
            // Okunan değerler aynen (boş metin NULL'a çevrilmez: veritabanında '' de olabilir)
            c.Parameters.Add(new SqlParameter("@oAdi", System.Data.SqlDbType.VarChar, AdiMax) { Value = (object?)o.Adi ?? DBNull.Value });
            c.Parameters.Add(new SqlParameter("@oCts", System.Data.SqlDbType.VarChar, KisaMax) { Value = (object?)o.Cts ?? DBNull.Value });
            c.Parameters.Add(new SqlParameter("@oIp", System.Data.SqlDbType.VarChar, KisaMax) { Value = (object?)o.Ip ?? DBNull.Value });
            c.Parameters.Add(new SqlParameter("@oPort", System.Data.SqlDbType.VarChar, KisaMax) { Value = (object?)o.Port ?? DBNull.Value });
            c.Parameters.Add(new SqlParameter("@oYatak", System.Data.SqlDbType.Int) { Value = (object?)o.YatakId ?? DBNull.Value });
        }
    }
}
