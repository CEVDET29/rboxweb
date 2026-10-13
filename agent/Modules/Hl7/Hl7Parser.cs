using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace RboxAgent.Modules.Hl7
{
    /// <summary>
    /// HL7 v2 metnini mesajlara ayırır. Girdi ham MLLP verisi (0x0B … 0x1C 0x0D) ya da TCP modülünden kopyalanan
    /// okunur metin olabilir (kontrol karakterleri &lt;VT&gt; &lt;FS&gt; &lt;CR&gt; diye yazılmış). Her MSH yeni bir
    /// mesaj başlatır; segment olmayan satırlar (TCP konsolunun saat / adres başlıkları vb.) sayılıp atlanır.
    /// </summary>
    public static partial class Hl7Parser
    {
        [GeneratedRegex(@"^[A-Z][A-Z0-9]{2}(?=[|^~\\&#!])")]
        private static partial Regex SegmentStart();

        [GeneratedRegex(@"<(VT|FS|CR|LF|SB|EB)>", RegexOptions.IgnoreCase)]
        private static partial Regex CtrlToken();

        public static Hl7ParseResult Parse(string text)
        {
            var messages = new List<Hl7Message>();
            int skipped = 0;
            if (string.IsNullOrWhiteSpace(text)) return new Hl7ParseResult(messages, 0);

            // <VT> / <FS> yazılmış çerçeveler ve gerçek kontrol karakterleri satır sonu sayılır
            text = CtrlToken().Replace(text, "\n");
            var lines = text.Split(new[] { "\r\n", "\r", "\n", "\x0B", "\x1C" }, StringSplitOptions.None);

            Hl7Message? cur = null;
            char fieldSep = '|';
            foreach (var raw in lines)
            {
                var line = raw.Trim().TrimStart('﻿');
                if (line.Length == 0) continue;

                // Satırın ortasında başlayan mesaj (ör. "14:16:17  10.0.0.5  MSH|^~\&|…")
                int msh = line.IndexOf("MSH", StringComparison.Ordinal);
                if (msh > 0 && msh + 3 < line.Length && !char.IsLetterOrDigit(line[msh + 3])) line = line[msh..];

                if (line.StartsWith("MSH", StringComparison.Ordinal) && line.Length > 8)
                {
                    fieldSep = line[3];
                    cur = new Hl7Message(fieldSep, line.Substring(4, Math.Min(4, line.Length - 4)));
                    messages.Add(cur);
                    cur.AddSegment(line);
                    continue;
                }

                if (cur != null && SegmentStart().IsMatch(line) && line.Length > 3 && line[3] == fieldSep)
                    cur.AddSegment(line);
                else
                    skipped++;
            }
            return new Hl7ParseResult(messages, skipped);
        }

        // ── Onay (ACK) ───────────────────────────────────────────────

        /// <summary>
        /// Bu mesaja dönülecek kabul onayı (MSA-1 AA, MSA-2 = gelen MSH-10); segmentler CR ile ayrılmış, çerçevesiz.
        /// Gönderen / alıcı alanları yer değiştirir; sürüm ve işlem kimliği gelen mesajdan alınır.
        /// </summary>
        public static string BuildAck(Hl7Message m, DateTime now)
        {
            var msh = m.First("MSH");
            string R(int i) => msh?.RawField(i) ?? "";
            string enc = R(2).Length > 0 ? R(2) : "^~\\&";
            string trigger = m.Get("MSH", 9, 2);
            string time = now.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
            var ack = string.Join(m.FieldSep, "MSH", enc, R(5), R(6), R(3), R(4), time, "",
                $"ACK{m.Comp}{trigger}{m.Comp}ACK", "A" + R(10), R(11), R(12));
            return ack + "\r" + string.Join(m.FieldSep, "MSA", "AA", R(10)) + "\r";
        }

        /// <summary>Onay beklenir mi? ACK'ya onay verilmez; MSH-15 = NE ise gönderen kabul onayı istemiyor.</summary>
        public static bool WantsAck(Hl7Message m) => m.Get("MSH", 9, 1) != "ACK" && m.Get("MSH", 15) != "NE";

        /// <summary>MLLP çerçevesi: 0x0B + mesaj + 0x1C 0x0D, UTF-8.</summary>
        public static byte[] Frame(string message) => Encoding.UTF8.GetBytes("\x0B" + message + "\x1C\r");

        // ── HL7 zaman damgası ────────────────────────────────────────

        /// <summary>"20261009141616.0000+0300" → yerel saat (dilim yazılıysa ona göre). Eksik haneler kabul edilir (YYYYMMDD[HH[MM[SS]]]).</summary>
        public static DateTimeOffset? ParseTime(string s)
        {
            s = s.Trim();
            if (s.Length < 8) return null;
            int i = 0;
            while (i < s.Length && char.IsAsciiDigit(s[i])) i++;
            var digits = s[..i];
            if (digits.Length < 8 || digits.Length % 2 != 0 || digits.Length > 14) return null;

            int Part(int start, int len, int def) => digits.Length >= start + len ? int.Parse(digits.AsSpan(start, len), CultureInfo.InvariantCulture) : def;
            int y = Part(0, 4, 1), mo = Part(4, 2, 1), d = Part(6, 2, 1), h = Part(8, 2, 0), mi = Part(10, 2, 0), se = Part(12, 2, 0);

            double frac = 0;
            if (i < s.Length && s[i] == '.')
            {
                int j = ++i;
                while (i < s.Length && char.IsAsciiDigit(s[i])) i++;
                if (i > j) frac = double.Parse("0." + s[j..i], CultureInfo.InvariantCulture);
            }

            TimeSpan offset = TimeZoneInfo.Local.GetUtcOffset(DateTime.Now);
            if (i < s.Length && (s[i] == '+' || s[i] == '-') && s.Length - i >= 5
                && int.TryParse(s.AsSpan(i + 1, 2), out int oh) && int.TryParse(s.AsSpan(i + 3, 2), out int om))
                offset = new TimeSpan(oh, om, 0) * (s[i] == '-' ? -1 : 1);

            try
            {
                return new DateTimeOffset(y, mo, d, h, mi, se, offset).AddSeconds(frac);
            }
            catch (ArgumentOutOfRangeException) { return null; }
        }
    }

    public sealed record Hl7ParseResult(IReadOnlyList<Hl7Message> Messages, int SkippedLines);

    /// <summary>Bir HL7 mesajı: ayraçlar MSH-1 / MSH-2'den okunur.</summary>
    public sealed class Hl7Message
    {
        public Hl7Message(char fieldSep, string encoding)
        {
            FieldSep = fieldSep;
            Comp = encoding.Length > 0 ? encoding[0] : '^';
            Rep = encoding.Length > 1 ? encoding[1] : '~';
            Esc = encoding.Length > 2 ? encoding[2] : '\\';
            Sub = encoding.Length > 3 ? encoding[3] : '&';
        }

        public char FieldSep { get; }
        public char Comp { get; }
        public char Rep { get; }
        public char Esc { get; }
        public char Sub { get; }

        public List<Hl7Segment> Segments { get; } = new();

        /// <summary>Segmentler CR ile birleştirilmiş özgün mesaj (çerçevesiz).</summary>
        public string Raw => string.Join("\r", Segments.Select(s => s.Raw));

        internal void AddSegment(string line) => Segments.Add(new Hl7Segment(this, line));

        public Hl7Segment? First(string id) => Segments.FirstOrDefault(s => s.Id == id);
        public IEnumerable<Hl7Segment> All(string id) => Segments.Where(s => s.Id == id);

        /// <summary>"PV1", 3, 3 → PV1-3.3 (kaçış dizileri çözülmüş). Yoksa "".</summary>
        public string Get(string seg, int field, int comp = 0, int sub = 0) => First(seg)?.Get(field, comp, sub) ?? "";

        /// <summary>\F\ \S\ \T\ \R\ \E\ \Xhh..\ kaçış dizilerini çözer; .br gibi biçim komutları boşluk olur.</summary>
        public string Unescape(string s)
        {
            if (s.IndexOf(Esc) < 0) return s;
            var sb = new StringBuilder(s.Length);
            for (int i = 0; i < s.Length; i++)
            {
                if (s[i] != Esc) { sb.Append(s[i]); continue; }
                int end = s.IndexOf(Esc, i + 1);
                if (end < 0) { sb.Append(s, i, s.Length - i); break; }
                var code = s.Substring(i + 1, end - i - 1);
                switch (code)
                {
                    case "F": sb.Append(FieldSep); break;
                    case "S": sb.Append(Comp); break;
                    case "R": sb.Append(Rep); break;
                    case "T": sb.Append(Sub); break;
                    case "E": sb.Append(Esc); break;
                    default:
                        if (code.Length > 1 && code[0] == 'X' && code.Length % 2 == 1)
                        {
                            try { sb.Append(Encoding.UTF8.GetString(Convert.FromHexString(code[1..]))); }
                            catch (FormatException) { sb.Append(Esc).Append(code).Append(Esc); }
                        }
                        else if (code is ".br" or ".sp") sb.Append(' ');
                        else sb.Append(Esc).Append(code).Append(Esc);
                        break;
                }
                i = end;
            }
            return sb.ToString();
        }
    }

    /// <summary>
    /// Bir segment. <see cref="Fields"/>[n] = n numaralı alan (HL7 numarası; [0] segment adı). MSH'de MSH-1 alan
    /// ayracının kendisi, MSH-2 kodlama karakterleridir; numaralar buna göre kaydırılır.
    /// </summary>
    public sealed class Hl7Segment
    {
        private readonly Hl7Message _msg;

        internal Hl7Segment(Hl7Message msg, string raw)
        {
            _msg = msg;
            Raw = raw;
            var parts = raw.Split(msg.FieldSep);
            Id = parts[0];
            if (Id == "MSH")
            {
                var f = new string[parts.Length + 1];
                f[0] = "MSH";
                f[1] = msg.FieldSep.ToString();
                for (int k = 1; k < parts.Length; k++) f[k + 1] = parts[k];
                Fields = f;
            }
            else Fields = parts;
        }

        public string Id { get; }
        public string Raw { get; }
        public string[] Fields { get; }

        /// <summary>Kaçışları çözülmemiş alan metni (bileşen ayraçları dahil).</summary>
        public string RawField(int field) => field < Fields.Length ? Fields[field] : "";

        /// <summary>Alan / bileşen / alt bileşen (1'den başlar; 0 = tamamı). Tekrarlı alanda ilk tekrar alınır.</summary>
        public string Get(int field, int comp = 0, int sub = 0)
        {
            var f = RawField(field);
            if (f.Length == 0) return "";
            if (Id == "MSH" && field <= 2) return f;
            f = f.Split(_msg.Rep)[0];
            if (comp > 0)
            {
                var c = f.Split(_msg.Comp);
                f = comp <= c.Length ? c[comp - 1] : "";
                if (sub > 0)
                {
                    var s = f.Split(_msg.Sub);
                    f = sub <= s.Length ? s[sub - 1] : "";
                }
            }
            return _msg.Unescape(f);
        }

        /// <summary>Alanın dolu bileşenleri: (bileşen no, değer).</summary>
        public IEnumerable<(int Index, string Value)> Components(int field)
        {
            var f = RawField(field);
            if (f.Length == 0 || (Id == "MSH" && field <= 2)) yield break;
            var c = f.Split(_msg.Rep)[0].Split(_msg.Comp);
            if (c.Length < 2) yield break;
            for (int k = 0; k < c.Length; k++)
                if (c[k].Length > 0) yield return (k + 1, _msg.Unescape(c[k]));
        }

        public int RepeatCount(int field)
        {
            var f = RawField(field);
            return f.Length == 0 || (Id == "MSH" && field <= 2) ? 0 : f.Split(_msg.Rep).Length;
        }
    }
}
