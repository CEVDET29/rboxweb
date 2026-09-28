using System.Text;

namespace RboxAgent.Modules.Ping
{
    /// <summary>
    /// MAC → üretici eşlemesi. Uygulama klasöründe IEEE'nin "oui.csv" dosyası varsa
    /// (https://standards-oui.ieee.org/oui/oui.csv) tam liste oradan yüklenir;
    /// yoksa aşağıdaki gömülü küçük tablo kullanılır.
    /// </summary>
    public static class OuiLookup
    {
        public const string CsvFileName = "oui.csv";

        private static readonly Dictionary<string, string> BuiltIn = new(StringComparer.OrdinalIgnoreCase)
        {
            // Raspberry Pi Foundation / Trading
            ["B827EB"] = "Raspberry Pi Foundation",
            ["DCA632"] = "Raspberry Pi Trading",
            ["E45F01"] = "Raspberry Pi Trading",
            ["D83ADD"] = "Raspberry Pi Trading",
            ["28CDC1"] = "Raspberry Pi Trading",
            ["2CCF67"] = "Raspberry Pi (Trading)",
            // Common vendors (examples)
            ["FCFC48"] = "Intel Corporate",
            ["F0D5BF"] = "Huawei",
            ["F4F5E8"] = "Xiaomi",
            ["3C5AB4"] = "AzureWave",
            ["001A11"] = "Cisco Systems",
            ["AC2B6E"] = "Ubiquiti Networks",
        };

        private static readonly Lazy<Dictionary<string, string>> Map = new(LoadMap);

        /// <summary>Yüklü kayıt sayısı ve kaynağı (durum çubuğu için).</summary>
        public static string SourceDescription { get; private set; } = "";

        public static string GetVendor(string mac)
        {
            var key = MacAddress.ToKey(mac);
            if (key.Length < 6) return "Bilinmiyor";
            return Map.Value.TryGetValue(key.Substring(0, 6), out var vendor) ? vendor : "Bilinmiyor";
        }

        /// <summary>Tabloyu arka planda önceden yükler (ilk sorguda bekleme olmasın).</summary>
        public static void Preload() => _ = Map.Value;

        private static Dictionary<string, string> LoadMap()
        {
            var map = new Dictionary<string, string>(BuiltIn, StringComparer.OrdinalIgnoreCase);
            // Önce exe'nin yanı, sonra ajanın veri klasörü
            string path = Path.Combine(AppContext.BaseDirectory, CsvFileName);
            if (!File.Exists(path)) path = Path.Combine(DataStore.Folder, CsvFileName);
            if (!File.Exists(path))
            {
                SourceDescription = $"OUI: gömülü tablo ({map.Count} kayıt)";
                return map;
            }

            try
            {
                int loaded = 0;
                foreach (var line in File.ReadLines(path, Encoding.UTF8).Skip(1))
                {
                    var fields = ParseCsvLine(line, 3);
                    if (fields.Count < 3) continue;
                    string oui = fields[1].Trim();
                    string org = fields[2].Trim();
                    if (oui.Length != 6 || org.Length == 0) continue;
                    map[oui] = org;
                    loaded++;
                }
                SourceDescription = $"OUI: {CsvFileName} ({loaded} kayıt)";
            }
            catch (Exception ex)
            {
                SourceDescription = $"OUI: {CsvFileName} okunamadı ({ex.Message}), gömülü tablo kullanılıyor";
            }
            return map;
        }

        /// <summary>Tırnak içindeki virgülleri destekleyen basit CSV ayrıştırıcı; ilk maxFields alanı döner.</summary>
        private static List<string> ParseCsvLine(string line, int maxFields)
        {
            var result = new List<string>(maxFields);
            var sb = new StringBuilder();
            bool inQuotes = false;
            for (int i = 0; i < line.Length && result.Count < maxFields; i++)
            {
                char c = line[i];
                if (inQuotes)
                {
                    if (c == '"' && i + 1 < line.Length && line[i + 1] == '"') { sb.Append('"'); i++; }
                    else if (c == '"') inQuotes = false;
                    else sb.Append(c);
                }
                else if (c == '"') inQuotes = true;
                else if (c == ',') { result.Add(sb.ToString()); sb.Clear(); }
                else sb.Append(c);
            }
            if (result.Count < maxFields) result.Add(sb.ToString());
            return result;
        }
    }
}
