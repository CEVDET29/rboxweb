using System.Text.RegularExpressions;

namespace RboxAgent.Modules.Ping
{
    /// <summary>MAC adresi normalizasyonu ve doğrulaması için tek nokta.</summary>
    public static class MacAddress
    {
        private static readonly Regex ValidRegex = new(
            @"^(?:[0-9A-Fa-f]{2}([:\-]))(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}$",
            RegexOptions.Compiled);

        /// <summary>Karşılaştırma anahtarı: ayraçsız, büyük harf (örn. "B827EB123456").</summary>
        public static string ToKey(string? mac)
        {
            if (string.IsNullOrWhiteSpace(mac)) return "";
            var chars = mac.Where(c => c != ':' && c != '-' && c != '.' && !char.IsWhiteSpace(c));
            return new string(chars.ToArray()).ToUpperInvariant();
        }

        /// <summary>Görüntüleme biçimi: "AA:BB:CC:DD:EE:FF". 12 hex karakter değilse sadece büyütülür.</summary>
        public static string ToDisplay(string? mac)
        {
            if (string.IsNullOrWhiteSpace(mac)) return "";
            string key = ToKey(mac);
            if (key.Length == 12 && key.All(Uri.IsHexDigit))
                return string.Join(":", Enumerable.Range(0, 6).Select(i => key.Substring(i * 2, 2)));
            return mac.Trim().Replace("-", ":").ToUpperInvariant();
        }

        public static bool IsValid(string? mac)
        {
            if (string.IsNullOrWhiteSpace(mac)) return false;
            return ValidRegex.IsMatch(mac.Trim());
        }
    }
}
