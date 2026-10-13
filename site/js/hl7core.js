// HL7 v2 çekirdeği: WPF RboxTools Modules/Hl7 (Hl7Parser, Hl7Stream, Hl7FileImport, Hl7Dictionary, Hl7Profiles,
// Hl7MessageVm / Hl7ObsVm) ile aynı kurallar. Ayrıştırma tarayıcıda yapılır; ajan yalnızca TCP verisini getirir
// (ve ACK açıksa onayı kendisi gönderir).
import DEFAULT_PROFILES from "./hl7profiles.js";

// ── Sayı / zaman yardımcıları ────────────────────────────────────
const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
/** C# double.TryParse (InvariantCulture, Float) karşılığı: sayı değilse NaN. */
export const num = (s) => { const t = String(s ?? "").trim(); return NUM_RE.test(t) ? Number(t) : NaN; };
const pad = (n, w = 2) => String(n).padStart(w, "0");
/** Türkçe sayı ("0.##" gibi): en çok dec ondalık, virgülle. */
export const fmtTr = (v, dec = 2) => v.toLocaleString("tr-TR", { maximumFractionDigits: dec, useGrouping: false });

/**
 * "20261009141616.0000+0300" → { ms (mutlak), h, mi, s, y, mo, d, off (dk) }. Saat dilimi yazılı değilse yerel.
 * Ekranda cihazın yazdığı saat gösterilir (C# DateTimeOffset gibi); süre hesapları ms ile.
 */
export function parseTime(str) {
  const s = String(str ?? "").trim();
  if (s.length < 8) return null;
  let i = 0;
  while (i < s.length && s[i] >= "0" && s[i] <= "9") i++;
  const digits = s.slice(0, i);
  if (digits.length < 8 || digits.length % 2 !== 0 || digits.length > 14) return null;
  const part = (start, len, def) => (digits.length >= start + len ? Number(digits.substr(start, len)) : def);
  const y = part(0, 4, 1), mo = part(4, 2, 1), d = part(6, 2, 1), h = part(8, 2, 0), mi = part(10, 2, 0), se = part(12, 2, 0);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  let frac = 0;
  if (s[i] === ".") {
    const j = ++i;
    while (i < s.length && s[i] >= "0" && s[i] <= "9") i++;
    if (i > j) frac = Number("0." + s.slice(j, i));
  }
  const wall = Date.UTC(y, mo - 1, d, h, mi, se);
  let off = -new Date(wall).getTimezoneOffset();   // yaklaşık yerel dilim (C# TimeZoneInfo.Local)
  let given = false;
  if ((s[i] === "+" || s[i] === "-") && s.length - i >= 5 && /^\d{4}/.test(s.slice(i + 1, i + 5))) {
    off = (Number(s.substr(i + 1, 2)) * 60 + Number(s.substr(i + 3, 2))) * (s[i] === "-" ? -1 : 1);
    given = true;
  }
  return { y, mo, d, h, mi, s: se, off, given, ms: wall - off * 60000 + frac * 1000 };
}
const hms = (t) => (t ? `${pad(t.h)}:${pad(t.mi)}:${pad(t.s)}` : "");
const dmyhms = (t) => (t ? `${pad(t.d)}.${pad(t.mo)}.${t.y} ${hms(t)}` : "");
const localOff = (t) => -new Date(t.ms).getTimezoneOffset();
const offText = (off) => `${off < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
const nowStamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

// ── Mesaj / segment ──────────────────────────────────────────────
class Hl7Segment {
  constructor(msg, raw) {
    this.msg = msg;
    this.raw = raw;
    const parts = raw.split(msg.fieldSep);
    this.id = parts[0];
    this.fields = this.id === "MSH" ? ["MSH", msg.fieldSep, ...parts.slice(1)] : parts;
  }
  rawField(f) { return f < this.fields.length ? this.fields[f] : ""; }
  /** Alan / bileşen / alt bileşen (1'den başlar; 0 = tamamı). Tekrarlı alanda ilk tekrar. */
  get(field, comp = 0, sub = 0) {
    let f = this.rawField(field);
    if (!f) return "";
    if (this.id === "MSH" && field <= 2) return f;
    f = f.split(this.msg.rep)[0];
    if (comp > 0) {
      const c = f.split(this.msg.comp);
      f = comp <= c.length ? c[comp - 1] : "";
      if (sub > 0) { const s = f.split(this.msg.sub); f = sub <= s.length ? s[sub - 1] : ""; }
    }
    return this.msg.unescape(f);
  }
  /** Dolu bileşenler: [no, değer]. */
  components(field) {
    const f = this.rawField(field);
    if (!f || (this.id === "MSH" && field <= 2)) return [];
    const c = f.split(this.msg.rep)[0].split(this.msg.comp);
    if (c.length < 2) return [];
    return c.map((v, k) => [k + 1, v]).filter(([, v]) => v.length > 0).map(([k, v]) => [k, this.msg.unescape(v)]);
  }
  repeatCount(field) {
    const f = this.rawField(field);
    return !f || (this.id === "MSH" && field <= 2) ? 0 : f.split(this.msg.rep).length;
  }
}

export class Hl7Message {
  constructor(fieldSep, enc) {
    this.fieldSep = fieldSep;
    this.comp = enc[0] || "^"; this.rep = enc[1] || "~"; this.esc = enc[2] || "\\"; this.sub = enc[3] || "&";
    this.segments = [];
  }
  get raw() { return this.segments.map((s) => s.raw).join("\r"); }
  addSegment(line) { this.segments.push(new Hl7Segment(this, line)); }
  first(id) { return this.segments.find((s) => s.id === id) || null; }
  all(id) { return this.segments.filter((s) => s.id === id); }
  get(seg, field, comp = 0, sub = 0) { return this.first(seg)?.get(field, comp, sub) ?? ""; }
  /** \F\ \S\ \T\ \R\ \E\ \Xhh..\ kaçışları; .br / .sp boşluk. */
  unescape(s) {
    const E = this.esc;
    if (!s.includes(E)) return s;
    let out = "";
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== E) { out += s[i]; continue; }
      const end = s.indexOf(E, i + 1);
      if (end < 0) { out += s.slice(i); break; }
      const code = s.slice(i + 1, end);
      switch (code) {
        case "F": out += this.fieldSep; break;
        case "S": out += this.comp; break;
        case "R": out += this.rep; break;
        case "T": out += this.sub; break;
        case "E": out += E; break;
        default:
          if (code.length > 1 && code[0] === "X" && code.length % 2 === 1 && /^[0-9a-f]+$/i.test(code.slice(1))) {
            const bytes = new Uint8Array(code.slice(1).match(/../g).map((h) => parseInt(h, 16)));
            out += new TextDecoder().decode(bytes);
          } else if (code === ".br" || code === ".sp") out += " ";
          else out += E + code + E;
      }
      i = end;
    }
    return out;
  }
}

const SEGMENT_START = /^[A-Z][A-Z0-9]{2}(?=[|^~\\&#!])/;
const CTRL_TOKEN = /<(VT|FS|CR|LF|SB|EB)>/gi;
const isLetterOrDigit = (c) => /[\p{L}\p{N}]/u.test(c);

/** Metni mesajlara ayırır: her MSH yeni mesaj; segment olmayan satırlar atlanır. */
export function parseHl7(text) {
  const messages = [];
  if (!text || !text.trim()) return messages;
  const lines = text.replace(CTRL_TOKEN, "\n").split(/\r\n|\r|\n|\x0B|\x1C/);
  let cur = null, sep = "|";
  for (const raw of lines) {
    let line = raw.trim().replace(/^﻿/, "");
    if (!line) continue;
    const msh = line.indexOf("MSH");
    if (msh > 0 && msh + 3 < line.length && !isLetterOrDigit(line[msh + 3])) line = line.slice(msh);
    if (line.startsWith("MSH") && line.length > 8) {
      sep = line[3];
      cur = new Hl7Message(sep, line.substr(4, Math.min(4, line.length - 4)));
      messages.push(cur);
      cur.addSegment(line);
      continue;
    }
    if (cur && SEGMENT_START.test(line) && line.length > 3 && line[3] === sep) cur.addSegment(line);
  }
  return messages;
}

/** Bu mesaja dönülecek kabul onayı (MSA-1 AA); segmentler CR ile, çerçevesiz. */
export function buildAck(m, now = new Date()) {
  const msh = m.first("MSH");
  const R = (i) => msh?.rawField(i) ?? "";
  const enc = R(2) || "^~\\&";
  const trigger = m.get("MSH", 9, 2);
  const ack = ["MSH", enc, R(5), R(6), R(3), R(4), nowStamp(now), "", `ACK${m.comp}${trigger}${m.comp}ACK`, "A" + R(10), R(11), R(12)].join(m.fieldSep);
  return ack + "\r" + ["MSA", "AA", R(10)].join(m.fieldSep) + "\r";
}

// ── Akış: bağlantı başına parçaları mesajlara böler (Hl7Stream) ──
const BREAK_START = /^(<VT>|<FS>|[A-Z][A-Z0-9]{2}\|)/;
export class Hl7Stream {
  constructor() { this.buf = ""; }
  push(text) {
    const done = [];
    if (!text) return done;
    // Konsol parçanın sonundaki satır sonunu yazmaz: yeni parça segmentle / çerçeveyle başlıyorsa geri konur
    if (this.buf && !this.buf.endsWith("\n") && BREAK_START.test(text)) this.buf += "\n";
    this.buf += text;
    for (;;) {
      const s = this.buf;
      const fs = s.indexOf("<FS>");
      const next = secondMsh(s);
      const cut = fs >= 0 && (next < 0 || fs + 4 <= next) ? fs + 4 : next;
      if (cut <= 0) break;
      done.push(s.slice(0, cut));
      this.buf = s.slice(cut);
    }
    if (this.buf.length > 4096 && !this.buf.includes("MSH")) this.buf = this.buf.slice(-16);
    else if (this.buf.length > 2_000_000) this.buf = "";
    return done;
  }
  flush() { const s = this.buf; this.buf = ""; return s.includes("MSH") ? s : null; }
}
function secondMsh(s) {
  let seen = false;
  for (let i = s.indexOf("MSH"); i >= 0; i = s.indexOf("MSH", i + 3)) {
    if (i + 3 >= s.length || isLetterOrDigit(s[i + 3])) continue;
    const start = i >= 4 && s.substr(i - 4, 4) === "<VT>" ? i - 4 : i;
    if (start !== 0 && s[start - 1] !== "\n") continue;
    if (seen) return start;
    seen = true;
  }
  return -1;
}

// ── Dosyadan yükleme (Hl7FileImport) ─────────────────────────────
const CHUNK_HEADER = /^\s*\[[\d:.]+\]\s+(\d{1,3}(?:\.\d{1,3}){3}:\d+)(?:\s|$)/;

/** Dosya baytları → metin: geçerli UTF-8 değilse Windows-1254 (Türkçe). */
export function decodeFile(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, ""); }
  catch { return new TextDecoder("windows-1254").decode(buf); }
}

/** Metindeki HL7 mesajları ve kaynakları: [{ msg, source }]. "[saat] ip:port" başlıkları kaynağı değiştirir. */
export function importText(text, fallbackSource) {
  text = text.replace(/\x0B/g, "<VT>").replace(/\x1C/g, "<FS>").replace(/♂/g, "<VT>").replace(/∟/g, "<FS>")
    .replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const streams = new Map(), found = [];
  let source = fallbackSource, chunk = [];
  const push = () => {
    if (!chunk.length) return;
    let st = streams.get(source);
    if (!st) { st = new Hl7Stream(); streams.set(source, st); }
    for (const t of st.push(chunk.join("\n").replace(/\n+$/, ""))) found.push([t, source]);
    chunk = [];
  };
  for (const line of text.split("\n")) {
    const m = CHUNK_HEADER.exec(line);
    if (m) { push(); source = m[1]; continue; }
    chunk.push(line);
  }
  push();
  for (const [src, st] of streams) { const rest = st.flush(); if (rest) found.push([rest, src]); }
  const out = [];
  for (const [t, src] of found) for (const msg of parseHl7(t)) out.push({ msg, source: src });
  return out;
}

// ── Sözlük (Hl7Dictionary) ───────────────────────────────────────
const FIELDS = {
  "MSH-1": "Alan ayracı", "MSH-2": "Kodlama karakterleri", "MSH-3": "Gönderen uygulama", "MSH-4": "Gönderen tesis",
  "MSH-5": "Alıcı uygulama", "MSH-6": "Alıcı tesis", "MSH-7": "Mesaj zamanı", "MSH-8": "Güvenlik", "MSH-9": "Mesaj tipi",
  "MSH-10": "Mesaj kontrol no", "MSH-11": "İşlem kimliği (P üretim · T test · D hata ayıklama)", "MSH-12": "HL7 sürümü",
  "MSH-13": "Sıra no", "MSH-14": "Devam işaretçisi", "MSH-15": "Kabul onayı (AL her zaman · NE hiç · ER hatada · SU başarıda)",
  "MSH-16": "Uygulama onayı", "MSH-17": "Ülke kodu", "MSH-18": "Karakter seti", "MSH-19": "Mesaj dili",
  "MSH-20": "Alternatif karakter seti", "MSH-21": "Mesaj profili",
  "MSA-1": "Onay kodu (AA kabul · AE hata · AR red)", "MSA-2": "Onaylanan mesaj kontrol no", "MSA-3": "Metin",
  "ERR-1": "Hata kodu ve yeri", "ERR-3": "HL7 hata kodu", "ERR-4": "Önem", "ERR-8": "Kullanıcı mesajı",
  "EVN-1": "Olay tipi", "EVN-2": "Kayıt zamanı", "EVN-6": "Olay zamanı",
  "PID-1": "Sıra", "PID-2": "Hasta kimliği (eski)", "PID-3": "Hasta kimlik listesi", "PID-4": "Alternatif kimlik",
  "PID-5": "Hasta adı (soyadı^adı^ikinci ad)", "PID-6": "Anne kızlık soyadı", "PID-7": "Doğum tarihi", "PID-8": "Cinsiyet",
  "PID-10": "Irk", "PID-11": "Adres", "PID-13": "Telefon", "PID-18": "Hesap no", "PID-19": "SSN", "PID-31": "Kimlik bilinmiyor",
  "PV1-1": "Sıra", "PV1-2": "Hasta sınıfı (I yatan · O ayaktan · E acil)", "PV1-3": "Yatış yeri (birim^oda^yatak^tesis…)",
  "PV1-4": "Kabul tipi", "PV1-7": "Sorumlu hekim", "PV1-10": "Servis", "PV1-17": "Kabul eden hekim", "PV1-18": "Hasta tipi",
  "PV1-19": "Vizit no", "PV1-44": "Kabul zamanı", "PV1-45": "Taburcu zamanı",
  "ORC-1": "İstem kontrolü", "ORC-2": "Sipariş no (veren)", "ORC-3": "Sipariş no (dolduran)",
  "OBR-1": "Sıra", "OBR-2": "Sipariş no (veren)", "OBR-3": "Sipariş no (dolduran)", "OBR-4": "Hizmet / istem",
  "OBR-7": "Gözlem zamanı", "OBR-8": "Gözlem bitiş zamanı", "OBR-10": "Örneği alan", "OBR-22": "Sonuç zamanı", "OBR-25": "Sonuç durumu",
  "OBX-1": "Sıra", "OBX-2": "Değer tipi (NM sayı · ST metin · CWE kod)", "OBX-3": "Gözlem kimliği",
  "OBX-4": "Alt kimlik (MDS.VMD.kanal.ölçüm)", "OBX-5": "Değer", "OBX-6": "Birim", "OBX-7": "Referans aralığı",
  "OBX-8": "Anormallik (H yüksek · L düşük · A anormal)", "OBX-10": "Anormallik türü",
  "OBX-11": "Sonuç durumu (R doğrulanmamış · F kesin · X yok)", "OBX-14": "Gözlem zamanı", "OBX-16": "Gözlemi yapan",
  "OBX-17": "Yöntem", "OBX-18": "Ekipman kimliği", "OBX-19": "Analiz zamanı", "OBX-20": "Vücut bölgesi",
  "NTE-1": "Sıra", "NTE-2": "Kaynak", "NTE-3": "Not",
};
const SEGMENTS = {
  MSH: "Mesaj başlığı", MSA: "Onay", ERR: "Hata", EVN: "Olay", PID: "Hasta", PV1: "Yatış", PV2: "Yatış (ek)",
  ORC: "İstem", OBR: "Gözlem isteği", OBX: "Gözlem", NTE: "Not", AL1: "Alerji", DG1: "Tanı",
};

const METRICS = {
  MDC_PULS_OXIM_SAT_O2: ["SpO₂", "SpO₂"], MDC_PULS_OXIM_PULS_RATE: ["Nabız (SpO₂)", "PR"], MDC_PULS_RATE: ["Nabız", "PR"],
  MDC_ECG_ELEC_POTL_I: ["EKG I dalgası", "EKG I"], MDC_ECG_ELEC_POTL_II: ["EKG II dalgası", "EKG II"],
  MDC_ECG_ELEC_POTL_III: ["EKG III dalgası", "EKG III"], MDC_ECG_ELEC_POTL_AVR: ["EKG aVR dalgası", "aVR"],
  MDC_ECG_ELEC_POTL_AVL: ["EKG aVL dalgası", "aVL"], MDC_ECG_ELEC_POTL_AVF: ["EKG aVF dalgası", "aVF"],
  MDC_ECG_ELEC_POTL_V: ["EKG V dalgası", "V"], MDC_IMPED_TTHOR: ["Solunum dalgası (empedans)", "Resp"],
  MDC_CONC_AWAY_CO2: ["CO₂ dalgası", "CO₂"], MDC_PRESS_AWAY: ["Havayolu basıncı dalgası", "Paw"],
  MDC_FLOW_AWAY: ["Akış dalgası", "Akış"], MDC_VOL_AWAY: ["Hacim dalgası", "Hacim"],
  MDC_SPO2_SIGNAL_QUALITY_INDEX: ["SpO₂ sinyal kalitesi", "SQI"], COMEN_ECG_HEARTS_PAUSE: ["EKG duraklaması", "Pause"],
  MDC_BLD_PERF_INDEX: ["Perfüzyon indeksi", "PI"], MDC_PULS_OXIM_PERF_REL: ["Perfüzyon indeksi", "PI"],
  MDC_PULS_OXIM_PLETH: ["Pleth dalgası", "Pleth"], MDC_ECG_HEART_RATE: ["Kalp hızı (EKG)", "HR"],
  MDC_ECG_CARD_BEAT_RATE: ["Kalp hızı (EKG)", "HR"], MDC_ECG_V_P_C_RATE: ["PVC hızı", "PVC"], MDC_ECG_V_P_C_CNT: ["PVC sayısı", "PVC"],
  MDC_ECG_TIME_PD_QT_GL: ["QT", "QT"], MDC_ECG_TIME_PD_QTc: ["QTc", "QTc"],
  MDC_TTHOR_RESP_RATE: ["Solunum hızı (empedans)", "RR"], MDC_RESP_RATE: ["Solunum hızı", "RR"],
  MDC_AWAY_RESP_RATE: ["Solunum hızı (havayolu)", "awRR"], MDC_CO2_RESP_RATE: ["Solunum hızı (CO₂)", "awRR"],
  MDC_AWAY_CO2_ET: ["EtCO₂", "EtCO₂"], MDC_CONC_AWAY_CO2_ET: ["EtCO₂", "EtCO₂"],
  MDC_AWAY_CO2_INSP_MIN: ["FiCO₂", "FiCO₂"], MDC_CONC_AWAY_CO2_INSP_MIN: ["FiCO₂", "FiCO₂"], MDC_CONC_AWAY_O2_INSP: ["FiO₂", "FiO₂"],
  MDC_PRESS_BLD_NONINV_SYS: ["NIBP sistolik", "NIBP-S"], MDC_PRESS_BLD_NONINV_DIA: ["NIBP diyastolik", "NIBP-D"],
  MDC_PRESS_BLD_NONINV_MEAN: ["NIBP ortalama", "NIBP-M"], MDC_PULS_RATE_NON_INV: ["Nabız (NIBP)", "PR-NIBP"],
  MDC_PRESS_BLD_ART_ABP_SYS: ["ABP sistolik", "ABP-S"], MDC_PRESS_BLD_ART_ABP_DIA: ["ABP diyastolik", "ABP-D"],
  MDC_PRESS_BLD_ART_ABP_MEAN: ["ABP ortalama", "ABP-M"], MDC_PRESS_BLD_ART_SYS: ["ART sistolik", "ART-S"],
  MDC_PRESS_BLD_ART_DIA: ["ART diyastolik", "ART-D"], MDC_PRESS_BLD_ART_MEAN: ["ART ortalama", "ART-M"],
  MDC_PRESS_BLD_ART_PULM_SYS: ["PA sistolik", "PA-S"], MDC_PRESS_BLD_ART_PULM_DIA: ["PA diyastolik", "PA-D"],
  MDC_PRESS_BLD_ART_PULM_MEAN: ["PA ortalama", "PA-M"], MDC_PRESS_BLD_VEN_CENT: ["CVP", "CVP"],
  MDC_PRESS_BLD_VEN_CENT_MEAN: ["CVP", "CVP"], MDC_PRESS_INTRA_CRAN: ["ICP", "ICP"], MDC_PRESS_INTRA_CRAN_MEAN: ["ICP", "ICP"],
  MDC_TEMP: ["Sıcaklık", "T"], MDC_TEMP_BODY: ["Vücut sıcaklığı", "T"], MDC_TEMP_INJ: ["Enjektat sıcaklığı", "Tinj"],
  MDC_TEMP_SKIN: ["Cilt sıcaklığı", "Tskin"], MDC_TEMP_ESOPH: ["Özofagus sıcaklığı", "Teso"], MDC_TEMP_RECT: ["Rektal sıcaklık", "Trect"],
  MDC_TEMP_TYMP: ["Timpanik sıcaklık", "Ttymp"], MDC_TEMP_NASOPH: ["Nazofarenks sıcaklığı", "Tnaso"],
  MDC_TEMP_BLD: ["Kan sıcaklığı", "TB"], MDC_TEMP_DIFF: ["Sıcaklık farkı", "TD"],
  MDC_PULS_OXIM_PLETH_RESP_RATE: ["Solunum hızı (pleth)", "RR-pleth"], MDC_ECG_SV_BEATS: ["SV atımları", "SV"],
  MDC_LEN_BODY_ACTUAL: ["Boy", "Boy"],
  MDC_FLOW_FLUID_PUMP: ["İnfüzyon hızı", "Hız"], MDC_FLOW_FLUID_PUMP_PROP: ["Programlanan hız", "Hız (prog.)"],
  MDC_FLOW_FLUID_BOLUS: ["Bolus hızı", "Bolus"], MDC_VOL_FLUID_DELIV: ["Verilen hacim", "Verilen"],
  MDC_VOL_FLUID_DELIV_TOTAL_SET: ["Toplam verilen hacim", "Toplam verilen"], MDC_VOL_FLUID_TBI: ["Verilecek hacim", "VTBI"],
  MDC_VOL_FLUID_TBI_REMAIN: ["Kalan hacim", "Kalan hacim"], MDC_TIME_PD_FLUID_DELIV_SINCE_START: ["İnfüzyon süresi", "Süre"],
  MDC_TIME_PD_REMAIN: ["Kalan süre", "Kalan süre"], MDC_TIME_PD_FLUID_STANDBY: ["Bekleme süresi", "Bekleme"],
  MDC_PRESS_FLUID_MEAS: ["Hat basıncı", "Hat basıncı"], MDC_PUMP_MODE: ["Pompa modu", "Pompa modu"],
  MDC_PUMP_STAT: ["Pompa durumu", "Pompa durumu"], MDC_DRUG_NAME_POINTER: ["İlaç", "İlaç"], MDC_PUMP_TCI_MODE: ["TCI modu", "TCI"],
  MDC_CONC_TCI_CURRENT_PLASMA: ["TCI plazma konsantrasyonu", "Cp"], MDC_CONC_TCI_CURRENT_EFFECT: ["TCI etki yeri konsantrasyonu", "Ce"],
  MDC_VENT_MODE: ["Ventilasyon modu", "Vent. modu"], MDC_EVT_STAT_DEV: ["Cihaz durumu", "Cihaz durumu"],
  MDC_EVT_STAT_MODE_SIGH_ACTIVE: ["İç çekme", "Sigh"], MDC_VENT_PRESS_AWAY_END_EXP_POS: ["PEEP", "PEEP"],
  MDC_VENT_PRESS_AWAY_END_EXP_POS_SETTING: ["PEEP (ayar)", "PEEP ayar"], MDC_PRESS_AWAY_INSP_PEAK: ["Tepe basınç", "Ppeak"],
  MDC_PRESS_RESP_PLAT: ["Plato basıncı", "Pplat"], MDC_PRESS_AWAY_INSP_MEAN: ["Ortalama hava yolu basıncı", "Pmean"],
  MDC_VOL_AWAY_TIDAL_EXP: ["Tidal hacim (ekspirasyon)", "VTe"], MDC_VOL_AWAY_TIDAL_INSP: ["Tidal hacim (inspirasyon)", "VTi"],
  MDC_VOL_AWAY_TIDAL_PER_IBW: ["Tidal hacim / ideal kilo", "VT/kg"], MDC_VOL_AWAY_TIDAL_EXP_BTSD_PS: ["VTe (spontan)", "VTe spn"],
  MDC_VOL_MINUTE_AWAY: ["Dakika hacmi", "MV"], MDC_VENT_VOL_MINUTE_EXP: ["Dakika hacmi (ekspirasyon)", "MVe"],
  MDC_VENT_VOL_MINUTE_AWAY_INSP: ["Dakika hacmi (inspirasyon)", "MVi"], MDC_VENT_RESP_BTSD_PSAZC_RATE: ["Solunum sayısı (toplam)", "ftotal"],
  MDC_VENT_RESP_BTSD_PS_RATE: ["Spontan solunum sayısı", "fspn"], MDC_VENT_RESP_RATE_SETTING: ["Solunum sayısı (ayar)", "f ayar"],
  MDC_RATIO_IE: ["I:E oranı", "I:E"], MDC_VENT_VOL_LEAK: ["Kaçak", "Kaçak"], MDC_COMPL_LUNG_STATIC: ["Statik kompliyans", "Cstat"],
  MDC_COMPL_LUNG_DYN: ["Dinamik kompliyans", "Cdyn"], MDC_RES_AWAY_INSP: ["İnspiratuar direnç", "Rinsp"],
  MDC_RES_AWAY_EXP: ["Ekspiratuar direnç", "Reksp"], MDC_RESP_RAPID_SHALLOW_BREATHING_INDEX: ["Hızlı yüzeyel solunum indeksi", "RSBI"],
  MDC_VENT_PRESS_OCCL_P100MS: ["Oklüzyon basıncı (P0.1)", "P0.1"], MDC_VENT_TIME_PD_INSP: ["İnspirasyon süresi", "Tinsp"],
  MDC_VENT_TIME_PD_INSP_SETTING: ["İnspirasyon süresi (ayar)", "Tinsp ayar"], MDC_TIME_PD_INSP_SETTING: ["İnspirasyon süresi (ayar)", "Tinsp ayar"],
  MDC_VENT_FLOW_TRIG_SENS_SETTING: ["Akım tetik duyarlılığı (ayar)", "Tetik ayar"],
  MDC_VENT_PRESS_AWAY_DELTA_SUPP_SETTING: ["Basınç desteği (ayar)", "PS ayar"],
  MDC_VENT_PRESS_AWAY_DELTA_SETTING: ["İnspiratuar basınç (ayar)", "Pinsp ayar"],
  MDC_VENT_PRESS_AWAY_DELTA_BACKUP_SETTING: ["Apne basıncı (ayar)", "Papne ayar"],
  MDC_VENT_PRESS_AWAY_RISETIME_CTLD_SETTING: ["Basınç yükselme süresi (ayar)", "Tslope ayar"],
  MDC_VENT_SIGH_RATE_SETTING: ["İç çekme sıklığı (ayar)", "Sigh ayar"], MDC_CONC_GASDLV_O2_INSP_SETTING: ["FiO₂ (ayar)", "FiO₂ ayar"],
  MNDRY_PRESS_PULSE_VARIATION: ["Nabız basıncı değişkenliği (PPV)", "PPV"], MNDRY_PRESS_PULSE_VARIATION_SOURCE: ["PPV kaynağı", "PPV kaynak"],
};
const PRESSURE_GROUPS = [["MDC_PRESS_BLD_NONINV", "NIBP"], ["MDC_PRESS_BLD_ART_ABP", "ABP"], ["MDC_PRESS_BLD_ART_PULM", "PA"],
  ["MDC_PRESS_BLD_ART", "ART"], ["MDC_PRESS_BLD_VEN_CENT", "CVP"], ["MDC_PRESS_INTRA_CRAN", "ICP"]];
const CODED_VALUES = { MDC_EVT_STAT_RUNNING: "Çalışıyor", MDC_EVT_STAT_STANDBY: "Beklemede", MDC_PUMP_TCI_NONE: "Yok" };
const UNITS = {
  MDC_DIM_PERCENT: "%", MDC_DIM_BEAT_PER_MIN: "bpm", MDC_DIM_RESP_PER_MIN: "rpm", MDC_DIM_MMHG: "mmHg", MDC_DIM_KILO_PASCAL: "kPa",
  MDC_DIM_CM_H2O: "cmH₂O", MDC_DIM_DEGC: "°C", MDC_DIM_FAHR: "°F", MDC_DIM_MILLI_SEC: "ms", MDC_DIM_SEC: "s",
  MDC_DIM_MILLI_VOLT: "mV", MDC_DIM_MICRO_VOLT: "µV", MDC_DIM_MILLI_M: "mm", MDC_DIM_MILLI_L: "mL", MDC_DIM_L_PER_MIN: "L/dk",
  MDC_DIM_MILLI_L_PER_MIN: "mL/dk", MDC_DIM_PER_MIN: "/dk", MDC_DIM_DIMLESS: "", MDC_DIM_X_G: "g", MDC_DIM_KILO_G: "kg",
  MDC_DIM_MILLI_L_PER_HR: "mL/sa", MDC_DIM_MIN: "dk", MDC_DIM_HR: "sa", MDC_DIM_CENTI_M: "cm", MDC_DIM_MICRO_G_PER_ML: "µg/mL",
  MDC_DIM_MILLI_L_PER_KG: "mL/kg", MDC_DIM_MILLI_L_PER_CM_H2O: "mL/cmH₂O", MDC_DIM_CM_H2O_PER_L_PER_SEC: "cmH₂O/L/s",
  MDC_DIM_PER_L_PER_MIN: "1/(L·dk)", MNDRY_DIM_JOULES_PER_MIN: "J/dk", MDC_DIM_MILLI_BAR: "mbar",
};

export const fieldName = (seg, f) => FIELDS[`${seg}-${f}`] || "";
export const segmentName = (seg) => SEGMENTS[seg] || "";

/** [uzun ad, kısa ad]; bilinmiyorsa MDC_ öneki atılmış hali. */
export function metric(mn, fallback) {
  if (METRICS[mn]) return METRICS[mn];
  if (mn.startsWith("MDC_ECG_AMPL_ST_")) { const lead = mn.slice(16); return ["ST " + lead, "ST-" + lead]; }
  let s = mn.startsWith("MDC_") ? mn.slice(4) : mn;
  if (!s) s = fallback;
  return [s, s];
}
/** "MDC_PRESS_BLD_NONINV_SYS" → ["NIBP", "S"]; basınç değilse [null, ""]. */
export function pressure(mn) {
  for (const [prefix, label] of PRESSURE_GROUPS) {
    if (!mn.startsWith(prefix)) continue;
    const rest = mn.slice(prefix.length);
    return rest === "_SYS" ? [label, "S"] : rest === "_DIA" ? [label, "D"] : rest === "_MEAN" || rest === "" ? [label, "M"] : [null, ""];
  }
  return [null, ""];
}
function codedText(mn) {
  if (CODED_VALUES[mn]) return CODED_VALUES[mn];
  const s = mn.startsWith("MNDRY_SRC_") ? "MDC_" + mn.slice(10) : mn;
  for (const [prefix, label] of PRESSURE_GROUPS) if (s === prefix) return label;
  return metric(s, s)[1];
}
function unitText(code, mn, text) {
  if (mn in UNITS) return UNITS[mn];
  if (mn.startsWith("MDC_DIM_")) return mn.slice(8).toLowerCase();
  return (mn || text || code).replace(/Â°/g, "°");
}

// ── Profiller (Hl7Profiles) ──────────────────────────────────────
let profiles = DEFAULT_PROFILES.profiles;
let profileNote = "";

/** Kullanıcı profillerini (ajandan) yerleşiklerin üstüne uygular: aynı id'li profil yerine geçer. */
export function applyUserProfiles(user, path = "") {
  const merged = [...DEFAULT_PROFILES.profiles];
  for (const p of user || []) {
    if (!p || typeof p !== "object") continue;
    const at = merged.findIndex((x) => String(x.id || "").toLowerCase() === String(p.id || "").toLowerCase());
    if (at >= 0) merged[at] = p; else merged.push(p);
  }
  profiles = merged;
  profileNote = user?.length ? `${user.length} kullanıcı profili · ${path}` : "";
}
export const profileInfo = () => profileNote;

const lc = (s) => String(s ?? "").toLowerCase();
const listOf = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function matchProfile(sender, facility, obxSystem, model) {
  const hit = (needles, hay) => !needles || needles.length === 0 || listOf(needles).some((n) => lc(hay).includes(lc(n)));
  for (const p of profiles) {
    const m = p.match;
    if (!m) continue;
    if (hit(m.sender, sender) && hit(m.facility, facility) && hit(m.obxSystem, obxSystem) && hit(m.model, model)) return p;
  }
  return profiles.find((p) => !p.match) || { id: "genel", name: "Genel" };
}
function mapMatches(m, code, text) {
  if (m.code == null && m.text == null) return false;
  if (m.code != null && String(m.code).trim() !== code.trim()) return false;
  if (m.text != null && lc(String(m.text).trim()) !== lc(text.trim())) return false;
  return true;
}
const sameValue = (a, b) => String(a).trim() === b || (!Number.isNaN(num(a)) && !Number.isNaN(num(b)) && num(a) === num(b));

function resolve(p, code, text, value) {
  const map = (p?.map || []).find((m) => mapMatches(m, code, text));
  let v = value.trim();
  if (p && (p.invalidValues || []).some((x) => sameValue(x, v))) v = "";
  if (v.length > 8 && !Number.isNaN(num(v))) v = String(Number(num(v).toPrecision(6)));
  return { name: map?.name ?? null, short: map?.short ?? null, group: map?.group ?? null, part: map?.part ?? "M", hide: !!map?.hide, value: v };
}
function deviceType(p, model, deviceName) {
  const d = (p?.devices || []).find((x) =>
    (x.model == null || lc(String(x.model).trim()) === lc(model.trim()))
    && (x.name == null || lc(deviceName).includes(lc(x.name)))
    && (x.model != null || x.name != null));
  return d?.type ?? model;
}
const FIELD_SPEC = /^([A-Z0-9]{3})-(\d+)(?:\.(\d+))?(?:\.(\d+))?$/i;
function fieldValue(m, spec) {
  if (!spec || !String(spec).trim()) return "";
  const mt = FIELD_SPEC.exec(String(spec).trim());
  if (!mt) return "";
  return m.get(mt[1].toUpperCase(), Number(mt[2]), mt[3] ? Number(mt[3]) : 0, mt[4] ? Number(mt[4]) : 0).trim();
}
const codedValue = (p, text) => (p?.values && Object.prototype.hasOwnProperty.call(p.values, text.trim()) ? p.values[text.trim()] : null);

// ── Cihaz türü ───────────────────────────────────────────────────
export const KINDS = ["all", "monitor", "vent", "infusion", "perfusor"];
/** Profildeki tür adından süzgeç türü; bilinmeyen (Eretna, Comen, EDAN…) monitör sayılır. */
export function kindOf(type) {
  const s = String(type || "").toLocaleLowerCase("tr");
  if (s.includes("ventil")) return "vent";
  if (s.includes("perfüz") || s.includes("perfuz") || s.includes("şırınga")) return "perfusor";
  if (s.includes("infüz") || s.includes("infuz") || s.includes("pompa") || s.includes("pump")) return "infusion";
  return "monitor";
}

// ── Gözlem (OBX) ─────────────────────────────────────────────────
function tryRange(r) {
  r = String(r || "").trim();
  if (!r) return null;
  if (r[0] === ">") { const v = num(r.replace(/^[>=]+/, "")); return Number.isNaN(v) ? null : [v, Infinity]; }
  if (r[0] === "<") { const v = num(r.replace(/^[<=]+/, "")); return Number.isNaN(v) ? null : [-Infinity, v]; }
  const dash = r.indexOf("-", 1);
  if (dash <= 0) return null;
  let lo = num(r.slice(0, dash)), hi = num(r.slice(dash + 1));
  if (Number.isNaN(lo) || Number.isNaN(hi)) return null;
  if (lo > hi) [lo, hi] = [hi, lo];   // Eretna "üst-alt" yollar
  return [lo, hi];
}

/** severity: "", "ok", "warn", "error", "muted" */
class Hl7Obs {
  constructor(s, profile) {
    this.setId = s.get(1);
    this.valueType = s.get(2);
    this.code = s.get(3, 1);
    this.mnemonic = s.get(3, 2);
    const [metricName, metricShort] = metric(this.mnemonic, this.code || s.get(3));
    this.subId = s.get(4);
    let raw = s.get(5);
    if (["CWE", "CNE", "CE", "CF"].includes(this.valueType)) {
      const text = s.get(5, 2);
      raw = text ? (codedValue(profile, text) ?? codedText(text)) : s.get(5, 1);
    } else if (this.valueType === "SN") raw = s.get(5, 1) + s.get(5, 2) + s.get(5, 3) + s.get(5, 4);
    const r = resolve(profile, this.code, this.mnemonic, raw);
    this.name = r.name ?? metricName;
    this.short = r.short ?? metricShort;
    this.hidden = r.hide;
    if (!this.valueType && !raw.trim() && /(_MDS|_VMD|_CHAN)$/.test(this.mnemonic)) this.hidden = true;
    this.value = r.value;
    this.samples = null;
    this.sampleRate = 0;
    this.duration = 0;
    if (this.valueType === "NA") {
      const parts = raw.split("^");
      const arr = new Float64Array(parts.length);
      let any = false;
      for (let i = 0; i < parts.length; i++) { const v = num(parts[i]); arr[i] = v; if (!Number.isNaN(v)) any = true; }
      if (any) this.samples = arr;
    }
    const reps = s.repeatCount(5);
    if (reps > 1) this.value += ` (+${reps - 1})`;
    this.unit = unitText(s.get(6, 1), s.get(6, 2), s.get(6, 3));
    this.unitCode = s.get(6);
    this.range = s.get(7);
    const rg = tryRange(this.range);
    this.rangeText = rg && Number.isFinite(rg[0]) && Number.isFinite(rg[1]) ? `${rg[0]} – ${rg[1]}` : this.range;
    this.flag = s.get(8);
    this.status = s.get(11);
    this.timeText = hms(parseTime(s.get(14)));
    this.key = r.short ?? (this.mnemonic || this.code);
    this.method = s.get(17, 2) || s.get(17, 1);
    [this.group, this.part] = r.group != null ? [r.group, r.part] : pressure(this.mnemonic);
    [this.severity, this.stateText] = this.evaluate();
    this.tip = `OBX-${this.setId} · ${this.code} ${this.mnemonic}` + (this.subId ? ` · alt kimlik ${this.subId}` : "")
      + (this.method ? ` · yöntem ${this.method}` : "") + (this.unitCode ? ` · birim ${this.unitCode}` : "");
  }
  get isWave() { return this.samples != null; }
  get hasValue() { return this.value.length > 0; }
  get isAperiodic() { return /APERIODIC/i.test(this.method); }
  get codeText() { return this.mnemonic ? `${this.mnemonic} (${this.code})` : this.code; }

  evaluate() {
    switch (this.flag) {
      case "HH": return ["error", "Çok yüksek"];
      case "LL": return ["error", "Çok düşük"];
      case "H": return ["warn", "Yüksek"];
      case "L": return ["warn", "Düşük"];
      case "A": case "AA": return ["warn", "Anormal"];
      case "N": return ["ok", "Normal"];
    }
    if (this.status === "X") return ["muted", "Ölçülemedi"];
    const rg = tryRange(this.range), v = num(this.value);
    if (rg && !Number.isNaN(v)) {
      if (v < rg[0]) return ["warn", "Aralık altı"];
      if (v > rg[1]) return ["warn", "Aralık üstü"];
      return ["ok", "Aralıkta"];
    }
    return ["", ""];
  }

  /** Dalganın ölçeği: örnek × çözünürlük; inop (32767 gibi) geçersiz örnek. */
  applyWave(rate, resolution, unit, inop) {
    if (!this.samples) return;
    this.sampleRate = rate;
    if (unit) this.unit = unit;
    const res = resolution > 0 ? resolution : 1;
    let lo = Infinity, hi = -Infinity;
    const s = this.samples;
    for (let i = 0; i < s.length; i++) {
      const v = s[i];
      s[i] = Number.isNaN(v) || (inop != null && v === inop) ? NaN : v * res;
      if (!Number.isNaN(s[i])) { lo = Math.min(lo, s[i]); hi = Math.max(hi, s[i]); }
    }
    const span = lo <= hi ? ` · ${fmtTr(lo, 3)} … ${fmtTr(hi, 3)}` : "";
    const dur = rate > 0 ? ` · ${fmtTr(s.length / rate)} sn` : "";
    this.value = `${s.length} örnek` + (rate > 0 ? ` · ${fmtTr(rate)} Hz` : "") + dur + span;
  }

  /** Örnek sayısı hız × süre ile tutmuyorsa örnekleri doğrusal ara değerle süreye yayar. */
  fitToDuration(seconds, rate = 0) {
    if (rate <= 0) rate = this.sampleRate;
    const s = this.samples;
    if (!s || s.length < 2 || rate <= 0 || seconds <= 0 || seconds > 10) return;
    const want = Math.round(rate * seconds);
    if (want < 2 || want === s.length || Math.abs(want - s.length) > want) return;
    const r = new Float64Array(want);
    for (let i = 0; i < want; i++) {
      const pos = (i * (s.length - 1)) / (want - 1);
      const a = Math.floor(pos), b = Math.min(a + 1, s.length - 1), f = pos - a, va = s[a], vb = s[b];
      r[i] = Number.isNaN(va) ? vb : Number.isNaN(vb) ? va : va + (vb - va) * f;
    }
    this.samples = r;
    this._spark = undefined;
  }

  /** Küçük grafik: 220 × 30 kutuya en çok 240 nokta (SVG polyline points). */
  get spark() {
    if (this._spark !== undefined) return this._spark;
    const s = this.samples;
    this._spark = null;
    if (!s) return null;
    let lo = Infinity, hi = -Infinity, valid = 0;
    for (const v of s) if (!Number.isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); valid++; }
    if (valid < 2) return null;
    const h = hi - lo || 1, n = s.length, step = Math.max(1, Math.floor(n / 240));
    const pts = [];
    for (let i = 0; i < n; i += step) if (!Number.isNaN(s[i])) pts.push(`${((220 * i) / Math.max(1, n - 1)).toFixed(1)},${(29 - (28 * (s[i] - lo)) / h).toFixed(1)}`);
    return (this._spark = pts.join(" "));
  }
}

// ── Mesaj modeli (Hl7MessageVm) ──────────────────────────────────
const isIpv4 = (s) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split(".").every((x) => +x <= 255);
export const remoteIp = (remote) => { const i = String(remote).lastIndexOf(":"); return i > 0 ? remote.slice(0, i) : remote; };
const joinIf = (a, b, sep) => (b ? a + sep + b : a);

/** Bir HL7 mesajının ekrandaki modeli. received: Date. */
export function buildMessage(m, index, source, received) {
  const vm = { message: m, index, source, sourceIp: remoteIp(source), received, isRepeat: false, ackState: "", ackOk: false };
  vm.messageType = joinIf(m.get("MSH", 9, 1), m.get("MSH", 9, 2), "^");
  vm.controlId = m.get("MSH", 10);
  vm.version = m.get("MSH", 12);
  vm.time = parseTime(m.get("MSH", 7));
  vm.sender = m.get("MSH", 3, 1) || m.get("MSH", 3);
  vm.senderId = m.get("MSH", 3, 2);
  vm.facility = m.get("MSH", 4, 1);

  const obxList = m.all("OBX");
  const obxSystem = obxList.map((s) => s.get(3, 3) || s.get(6, 3)).find((x) => x) || "";
  const model = obxList.map((s) => s.get(18, 2)).find((x) => x) || "";
  const profile = matchProfile(m.get("MSH", 3), m.get("MSH", 4), obxSystem, model);
  vm.profileName = profile.name || "";

  const plain = (s) => s.split(m.sub).find((x) => x.length > 0) || "";
  vm.unit = plain(m.get("PV1", 3, 1));
  vm.room = plain(m.get("PV1", 3, 2));
  vm.bed = plain(m.get("PV1", 3, 3));
  vm.stationChannel = ""; vm.monitorIp = "";
  if (!vm.bed) vm.bed = plain(fieldValue(m, profile.fields?.bed));
  if (!vm.unit && !vm.room && !vm.bed) vm.bed = plain(m.get("PV1", 3, 4));
  else {
    const fac = m.get("PV1", 3, 4).split(m.sub);
    if (fac.length > 1 && isIpv4(fac[1])) { vm.stationChannel = fac[0]; vm.monitorIp = fac[1]; }
  }
  vm.locationDesc = m.get("PV1", 3, 9);
  vm.locationCode = m.get("PV1", 3, 10);
  const loc = [];
  if (vm.unit) loc.push(vm.unit);
  if (vm.room) loc.push("Oda " + vm.room);
  if (vm.bed) loc.push("Yatak " + vm.bed);
  else if (!vm.room && vm.locationCode && vm.unit) loc.push(vm.locationCode);
  vm.location = loc.join(" · ") || vm.locationCode || [vm.sender, vm.facility].filter(Boolean).join(" · ");
  const titleParts = [];
  if (vm.unit) titleParts.push([vm.unit, "birim"]);
  if (vm.room) titleParts.push([vm.room, "oda"]);
  if (vm.bed) titleParts.push([vm.bed, "yatak"]);
  else if (!vm.room && vm.locationCode && vm.unit) titleParts.push([vm.locationCode, "konum kodu"]);
  if (!titleParts.length && vm.locationCode) titleParts.push([vm.locationCode, "konum kodu"]);
  if (!titleParts.length) {
    if (vm.sender) titleParts.push([vm.sender, "gönderen"]);
    if (vm.facility) titleParts.push([vm.facility, "tesis"]);
  }

  vm.patient = [m.get("PID", 5, 2), m.get("PID", 5, 3), m.get("PID", 5, 1)].filter(Boolean).join(" ");
  vm.patientId = m.get("PID", 3, 1) || fieldValue(m, profile.fields?.patientId);
  vm.extra = (profile.fields?.extra || []).map((x) => [x.label, fieldValue(m, x.field), x.field]).filter((x) => x[1]);

  let obs = obxList.map((s) => new Hl7Obs(s, profile)).filter((o) => !o.hidden);
  const obrT0 = parseTime(m.get("OBR", 7)), obrT1 = parseTime(m.get("OBR", 8));
  for (const w of obs.filter((o) => o.isWave)) {
    const attrs = obs.filter((o) => !o.isWave && w.subId && o.subId.startsWith(w.subId + "."));
    const numOf = (mn) => { const a = attrs.find((x) => x.mnemonic === mn); const v = a ? num(a.value) : NaN; return Number.isNaN(v) ? 0 : v; };
    const resRow = attrs.find((a) => a.mnemonic === "MDC_ATTR_NU_MSMT_RES");
    const inop = numOf("MDC_EVT_INOP");
    w.applyWave(numOf("MDC_ATTR_SAMP_RATE"), numOf("MDC_ATTR_NU_MSMT_RES"), resRow?.unit ?? "", inop !== 0 ? inop : null);
    if (obrT0 && obrT1) { w.duration = (obrT1.ms - obrT0.ms) / 1000; w.fitToDuration(w.duration); }
    obs = obs.filter((o) => !attrs.includes(o));
  }
  vm.isWaveform = obs.some((o) => o.isWave);
  vm.observations = obs;

  const eq = obxList.map((s) => [s.get(18, 1), s.get(18, 2)]).find(([id, md]) => id || md) || ["", ""];
  vm.deviceId = eq[0]; vm.device = eq[1];
  vm.deviceType = vm.device ? deviceType(profile, vm.device, vm.locationCode) : "";
  vm.kind = kindOf(vm.deviceType);

  vm.obsTime = obrT0;
  const shown = vm.time || vm.obsTime;
  vm.timeText = hms(shown);
  vm.dateText = dmyhms(shown);
  if (shown && shown.given && shown.off !== localOff(shown)) vm.dateText += ` (UTC${offText(shown.off)})`;

  const filled = obs.filter((o) => o.hasValue);
  vm.summary = vm.isWaveform
    ? "Dalga: " + obs.filter((o) => o.isWave).map((o) => o.short + (o.sampleRate > 0 ? ` ${fmtTr(o.sampleRate)} Hz` : "")).join(" · ")
    : filled.length ? filled.slice(0, 5).map((o) => `${o.short} ${o.value}`).join("   ") : "değer yok";
  vm.hasWarning = obs.some((o) => o.severity === "warn" || o.severity === "error");

  vm.detailTitle = titleParts.length ? titleParts.map((p) => p[0]).join(" · ") : `Mesaj ${index}`;
  const parts = titleParts.map(([v, l]) => [l, v]);
  const kind = vm.deviceType || vm.device;
  if (kind) parts.push(["cihaz", kind]);
  if (!vm.patient && vm.patientId) parts.push(["hasta no", vm.patientId]); else parts.push(["hasta", vm.patient]);
  vm.detailParts = parts;

  const obsTimeRaw = m.get("OBR", 7);
  vm.repeatKey = [vm.sourceIp, m.get("MSH", 3), vm.controlId, obsTimeRaw || m.get("MSH", 7)].join("|");
  const bedId = (vm.unit + "^" + vm.room + "^" + vm.bed).toLocaleUpperCase("en");
  vm.bedKey = vm.sourceIp + "|" + (vm.bed ? bedId : vm.locationDesc || vm.deviceId || bedId + vm.locationCode);
  vm.title = vm.location || `Mesaj ${index}`;
  vm.listSub = [vm.timeText, vm.deviceType, vm.sourceIp, vm.patient, `${obs.length} ölçüm`].filter(Boolean).join(" · ");
  vm.info = buildInfo(vm, m);
  return vm;
}

function buildInfo(vm, m) {
  const list = [];
  const add = (label, value, tip) => { if (value) list.push({ label, value, tip }); };
  const rec = vm.received;
  add("Kaynak", vm.source, `Mesajın geldiği TCP bağlantısı · alınma ${pad(rec.getHours())}:${pad(rec.getMinutes())}:${pad(rec.getSeconds())}.${pad(rec.getMilliseconds(), 3)}`);
  add("Mesaj tipi", vm.messageType, "MSH-9 · ORU^R01 = gözlem sonucu (vital bulgular)");
  add("Kontrol no", vm.controlId, "MSH-10 · onay (ACK) bu numarayla verilir");
  add("HL7", vm.version, "MSH-12 · HL7 sürümü");
  add("Gönderen", vm.sender + (vm.senderId ? ` (${vm.senderId})` : ""), "MSH-3 · gönderen uygulama ve kimliği");
  add("Cihaz profili", vm.profileName, "hl7-profiles · bu cihaz için kullanılan ölçüm eşlemesi (yerleşik + ajanın bilgisayarındaki hl7-profiles.json)");
  add("Tesis", vm.facility, "MSH-4 · gönderen tesis / üretici");
  add("Cihaz türü", vm.deviceType !== vm.device ? vm.deviceType : "", "hl7-profiles · OBX-18 modeli (ve PV1-3.10 cihaz kodu) ile bulunur");
  add("Cihaz", vm.device + (vm.deviceId ? ` (${vm.deviceId})` : ""), "OBX-18 · ölçümü yapan cihaz (model ve EUI-64 kimliği)");
  add("Cihaz MAC", vm.locationDesc, "PV1-3.9 · Mindray merkezi monitör burada yataktaki monitörün MAC adresini gönderir");
  add("Konum kodu", vm.locationCode, "PV1-3.10 · merkezi monitördeki yatak / cihaz kodu");
  add("İstasyon kanalı", vm.stationChannel, "PV1-3.4.1 · tesis bileşeni; EDAN'da merkezi istasyondaki kanal / sıra no (tahmini)");
  add("Monitör IP", vm.monitorIp, "PV1-3.4.2 · tesis bileşeni; EDAN'da monitörün ağ adresi (tahmini)");
  for (const [label, value, field] of vm.extra) add(label, value, field + " · cihaz profilinde tanımlı alan");
  add("Hasta no", vm.patientId, "PID-3 · hasta kimliği (yoksa profildeki alan, ör. Eretna PID-2)");
  add("Gözlem zamanı", dmyhms(vm.obsTime), "OBR-7 · ölçümlerin alındığı an");
  add("Profil", m.get("MSH", 21, 2) || m.get("MSH", 21, 1), "MSH-21 · mesaj profili (IHE PCD-01 = cihazdan vital bulgu)");
  add("Karakter seti", m.get("MSH", 18), "MSH-18");
  add("Onay", joinIf(m.get("MSH", 15), m.get("MSH", 16), " / "), "MSH-15 / MSH-16 · kabul ve uygulama onayı (AL her zaman, NE hiç)");
  return list;
}

/** "Alanlar" sekmesi: segment başına dolu alanlar. */
export function segmentRows(m) {
  const counts = {};
  return m.segments.map((s) => {
    counts[s.id] = (counts[s.id] || 0) + 1;
    const occ = counts[s.id];
    const name = segmentName(s.id);
    const header = s.id + (occ > 1 || s.id === "OBX" ? ` #${occ}` : "") + (name ? "  ·  " + name : "");
    const rows = [];
    for (let i = 1; i < s.fields.length; i++) {
      if (!s.fields[i]) continue;
      const reps = s.repeatCount(i);
      rows.push({
        pos: `${s.id}-${i}`, name: fieldName(s.id, i) || "—",
        value: s.id === "MSH" && i <= 2 ? s.fields[i] : s.get(i),
        comps: s.components(i).map(([k, v]) => `${k}: ${v}`).join("   ") + (reps > 1 ? `   (+${reps - 1} tekrar)` : ""),
      });
    }
    return { header, rows };
  });
}

/** Dalga mesajı mı (çözmeden, hızlı): OBR-4 "…WAVEFORM" ya da NA tipli OBX. */
export const isWaveMessage = (m) => /WAVEFORM/i.test(m.get("OBR", 4)) || m.all("OBX").some((s) => s.get(2) === "NA");
export const wantsAck = (m) => m.get("MSH", 9, 1) !== "ACK" && m.get("MSH", 15) !== "NE";
