using System.Data;
using ExcelDataReader;

namespace RboxAgent.Modules.Ping
{
    public record DeviceRow(string? OdaAdi, string? YatakAdi, string? YatakId, string? Ip, string? Mac);

    public static class ExcelReader
    {
        public const string PreferredSheetName = "Sayfa1";
        private const int HeaderSearchRowLimit = 10;

        private static readonly string[] OdaNames = ["ODA ADI", "SERVİS ADI"];
        private static readonly string[] YatakAdiNames = ["YATAK ADI", "Yatak ADI", "Yatak Adı", "YATAK NO"];
        private static readonly string[] YatakIdNames = ["YATAK ID", "Yatak ID", "RASYOTEK YATAK NO"];
        private static readonly string[] IpNames = ["IP", "İP", "IPv4", "IP ADRESI", "IP ADRESİ", "RASYOBOX IP", "IP ADRES"];

        static ExcelReader()
        {
            System.Text.Encoding.RegisterProvider(System.Text.CodePagesEncodingProvider.Instance);
        }

        /// <summary>
        /// .xlsx ve .xls okur. Önce "Sayfa1", sonra diğer sayfalar denenir; başlık satırı
        /// ilk <see cref="HeaderSearchRowLimit"/> satır içinde IP sütununun bulunduğu satırdır.
        /// </summary>
        public static List<DeviceRow> LoadDevices(string path)
        {
            using var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = ExcelReaderFactory.CreateReader(stream);
            var conf = new ExcelDataSetConfiguration()
            {
                ConfigureDataTable = _ => new ExcelDataTableConfiguration() { UseHeaderRow = false }
            };
            var ds = reader.AsDataSet(conf);

            var tables = ds.Tables.Cast<DataTable>()
                .OrderBy(t => string.Equals(t.TableName, PreferredSheetName, StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                .ToList();
            if (tables.Count == 0) throw new InvalidOperationException("Excel dosyasında sayfa bulunamadı.");

            foreach (var table in tables)
            {
                int headerRow = FindHeaderRow(table, out int idxIp);
                if (headerRow < 0) continue;

                var header = table.Rows[headerRow];
                int idxOda = FindColumnIndex(header, OdaNames);
                int idxYatakAdi = FindColumnIndex(header, YatakAdiNames);
                int idxYatakId = FindColumnIndex(header, YatakIdNames);
                int idxMac = FindColumnIndexContains(header, "MAC"); // örn: "MAC", "Cihaz MAC", "MAC Address" vb.

                var list = new List<DeviceRow>();
                string lastOda = "";
                for (int r = headerRow + 1; r < table.Rows.Count; r++)
                {
                    var row = table.Rows[r];

                    // Birleştirilmiş ODA hücreleri sadece ilk satırda değer taşır → aşağı doldur
                    string oda = GetCell(row, idxOda);
                    if (oda.Length > 0) lastOda = oda; else oda = lastOda;

                    string ip = GetCell(row, idxIp);
                    if (string.IsNullOrWhiteSpace(ip)) continue;

                    list.Add(new DeviceRow(
                        oda,
                        GetCell(row, idxYatakAdi),
                        GetCell(row, idxYatakId),
                        ip,
                        GetCell(row, idxMac)));
                }
                return list;
            }

            throw new InvalidOperationException(
                $"Hiçbir sayfanın ilk {HeaderSearchRowLimit} satırında IP sütunu bulunamadı. " +
                $"Beklenen başlıklardan biri: {string.Join(", ", IpNames)}");
        }

        private static int FindHeaderRow(DataTable table, out int idxIp)
        {
            int limit = Math.Min(HeaderSearchRowLimit, table.Rows.Count);
            for (int r = 0; r < limit; r++)
            {
                idxIp = FindColumnIndex(table.Rows[r], IpNames);
                if (idxIp >= 0) return r;
            }
            idxIp = -1;
            return -1;
        }

        private static int FindColumnIndexContains(DataRow headerRow, string token)
        {
            for (int i = 0; i < headerRow.ItemArray.Length; i++)
            {
                string name = Convert.ToString(headerRow[i])?.Trim() ?? string.Empty;
                if (name.IndexOf(token, StringComparison.OrdinalIgnoreCase) >= 0)
                    return i;
            }
            return -1;
        }

        private static int FindColumnIndex(DataRow headerRow, IEnumerable<string> names)
        {
            for (int i = 0; i < headerRow.ItemArray.Length; i++)
            {
                string name = Convert.ToString(headerRow[i])?.Trim() ?? string.Empty;
                foreach (var target in names)
                {
                    if (name.Equals(target, StringComparison.OrdinalIgnoreCase))
                        return i;
                }
            }
            return -1;
        }

        private static string GetCell(DataRow row, int idx)
        {
            if (idx < 0 || idx >= row.ItemArray.Length) return string.Empty;
            return Convert.ToString(row[idx])?.Trim() ?? string.Empty;
        }
    }
}
