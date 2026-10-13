using System.Text.Json;

namespace RboxAgent.Modules.Hl7
{
    /// <summary>
    /// Kullanıcının HL7 cihaz profilleri (yerleşik profiller sayfanın içinde). Önce ajanın kendi klasöründeki
    /// hl7-profiles.json, yoksa bu bilgisayardaki masaüstü uygulamasının dosyası (%AppData%\RasyoBOX Araclari) okunur;
    /// aynı id'li profil yerleşik olanın yerine geçer. Yorum ve sondaki virgül kabul edilir; sayfaya düz JSON gider.
    /// </summary>
    public static class Hl7ProfileFile
    {
        private const string FileName = "hl7-profiles.json";

        private static IEnumerable<string> Candidates()
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            yield return Path.Combine(appData, "RboxAgent", FileName);
            yield return Path.Combine(appData, "RasyoBOX Araclari", FileName);
        }

        public static object ReadUser()
        {
            foreach (var path in Candidates())
            {
                if (!File.Exists(path)) continue;
                try
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(path), new JsonDocumentOptions
                    {
                        CommentHandling = JsonCommentHandling.Skip,
                        AllowTrailingCommas = true,
                    });
                    JsonElement? profiles = null;
                    foreach (var p in doc.RootElement.EnumerateObject())
                        if (string.Equals(p.Name, "profiles", StringComparison.OrdinalIgnoreCase)) profiles = p.Value.Clone();
                    return new { path, profiles, error = (string?)null };
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
                {
                    return new { path, profiles = (JsonElement?)null, error = ex.Message };
                }
            }
            return new { path = (string?)null, profiles = (JsonElement?)null, error = (string?)null };
        }
    }
}
