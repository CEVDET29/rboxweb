using System.Text;
using System.Text.RegularExpressions;

namespace RboxAgent.Modules.Hl7
{
    /// <summary>
    /// Bir TCP bağlantısından parça parça gelen okunur metni (TcpSession.Printable: kontrol karakterleri &lt;VT&gt;
    /// &lt;FS&gt; diye yazılmış) tamamlanmış HL7 mesaj metinlerine böler. MLLP'de &lt;FS&gt; mesajı bitirir; çerçevesiz
    /// gönderende bir sonraki MSH öncekini bitirir, sonuncusu bağlantı kapanınca (<see cref="Flush"/>) çıkar.
    /// </summary>
    public sealed partial class Hl7Stream
    {
        private const string Fs = "<FS>";
        private readonly StringBuilder _buf = new();

        [GeneratedRegex(@"^(<VT>|<FS>|[A-Z][A-Z0-9]{2}\|)")]
        private static partial Regex BreakStart();

        public List<string> Push(string text)
        {
            var done = new List<string>();
            if (text.Length == 0) return done;
            // Printable parçanın sonundaki tek satır sonunu atar: yeni parça segmentle / çerçeveyle başlıyorsa geri konur
            if (_buf.Length > 0 && _buf[^1] != '\n' && BreakStart().IsMatch(text)) _buf.Append('\n');
            _buf.Append(text);

            while (true)
            {
                string s = _buf.ToString();
                int fs = s.IndexOf(Fs, StringComparison.Ordinal);
                int next = SecondMsh(s);
                int cut = fs >= 0 && (next < 0 || fs + Fs.Length <= next) ? fs + Fs.Length : next;
                if (cut <= 0) break;
                done.Add(s[..cut]);
                _buf.Remove(0, cut);
            }

            // HL7 olmayan veri birikmesin: içinde MSH yoksa yalnızca kuyruğu tutulur (bölünmüş "<V" / "MS" için)
            if (_buf.Length > 4096 && _buf.ToString().IndexOf("MSH", StringComparison.Ordinal) < 0)
                _buf.Remove(0, _buf.Length - 16);
            else if (_buf.Length > 2_000_000)
                _buf.Clear();
            return done;
        }

        /// <summary>Bağlantı kapandı: yarım kalan (ya da çerçevesiz son) mesaj.</summary>
        public string? Flush()
        {
            var s = _buf.ToString();
            _buf.Clear();
            return s.Contains("MSH", StringComparison.Ordinal) ? s : null;
        }

        /// <summary>Satır başındaki ikinci MSH'nin (önünde &lt;VT&gt; varsa onun) konumu; yoksa -1.</summary>
        private static int SecondMsh(string s)
        {
            bool seen = false;
            for (int i = s.IndexOf("MSH", StringComparison.Ordinal); i >= 0; i = s.IndexOf("MSH", i + 3, StringComparison.Ordinal))
            {
                if (i + 3 >= s.Length || char.IsLetterOrDigit(s[i + 3])) continue;
                int start = i >= 4 && string.CompareOrdinal(s, i - 4, "<VT>", 0, 4) == 0 ? i - 4 : i;
                if (start != 0 && s[start - 1] != '\n') continue;
                if (seen) return start;
                seen = true;
            }
            return -1;
        }
    }
}
