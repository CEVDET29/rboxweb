// Cihaz Kontrol modülü: cihazların anlık durumu (sıcaklık, bellek, depolama, SerialWorker, USB, ağ) ve toplu işlemler.
// Her kartta "Cihaz | Hasta" sekmesi: Hasta, yataktaki hastayı ve son monitör / ventilatör değerlerini YBDB'den gösterir.
// WPF ControlView / ControlDevice / ControlPatient / ControlViewModel karşılığı. SSH ve SQL okuması ajandadır; biçimlendirme burada.
import { api, stream } from "./api.js";
import { $, $$, esc, toast, unitColor, ICONS, storeGet, storeSet } from "./util.js";

const DASH = "—";

/** Bilinen üreticilerin (USB VID) tam adları; sysfs'teki "manufacturer" çoğu zaman kısadır (ör. "FTDI"). */
const VENDORS = {
  "0403": "Future Technology Devices International", "067B": "Prolific Technology", "10C4": "Silicon Laboratories",
  "1A86": "QinHeng Electronics", "2341": "Arduino", "04D8": "Microchip Technology", "0483": "STMicroelectronics",
  "0557": "ATEN International", "04B4": "Cypress Semiconductor", "2C7C": "Quectel Wireless Solutions",
  "12D1": "Huawei Technologies", "1199": "Sierra Wireless",
};

const trNum = (n, d = 1) => n.toFixed(d).replace(".", ",");
const lower = (s) => String(s ?? "").toLocaleLowerCase("tr");
const isIpv4 = (s) => { const p = String(s || "").trim().split("."); return p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && +x <= 255); };

// ── MAC yardımcıları (WPF MacAddress ile aynı) ────────────────
const macKey = (m) => String(m || "").replace(/[:\-.\s]/g, "").toUpperCase();
const macDisplay = (m) => {
  const k = macKey(m);
  if (/^[0-9A-F]{12}$/.test(k)) return k.match(/../g).join(":");
  return String(m || "").trim().replace(/-/g, ":").toUpperCase();
};
const macValid = (m) => /^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/i.test(String(m || "").trim());

// ── Biçimlendirme ─────────────────────────────────────────────
const fmtMb = (mb) => (mb >= 1024 ? trNum(mb / 1024) + " GB" : Math.round(mb) + " MB");

function usedTotal(raw) {
  if (!raw) return { text: DASH, pct: 0 };
  const p = raw.split("/");
  const used = Number(p[0]), total = Number(p[1]);
  if (p.length !== 2 || !Number.isFinite(used) || !(total > 0)) return { text: DASH, pct: 0 };
  return { text: `${fmtMb(used)} / ${fmtMb(total)}`, pct: Math.round((100 * used) / total) };
}

function fmtUptime(sec) {
  const days = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (days >= 1) return `${days} gün ${h} sa`;
  if (sec >= 3600) return `${h} sa ${m} dk`;
  return `${Math.max(1, m)} dakika`;
}

function usbPort(key, value) {
  const device = key.slice(4);                                   // "USB_ttyUSB0" → "ttyUSB0"
  const [vidPidRaw = "", mfr = "", product = "", busPort = ""] = value.split("|").map((x) => x.trim());
  const vidPid = vidPidRaw.toUpperCase();
  const full = VENDORS[vidPid.split(":")[0]] ?? "";
  const related = full && mfr && (lower(full).includes(lower(mfr)) || lower(mfr).includes(lower(full)));
  // "FTDI" + tablo "Future Technology Devices International" → "FTDI (Future Technology Devices International)"
  const vendor = !full ? (mfr || vidPid) : !mfr ? full : related ? (mfr.length >= full.length ? mfr : full) : `${mfr} (${full})`;
  return {
    name: /^tty/i.test(device) ? device.slice(3).toUpperCase() : device,          // ttyUSB0 → USB0, ttyACM0 → ACM0
    vendor, product, tip: `/dev/${device} · USB ${busPort} · ${vidPid}`,
  };
}

/** Cihazdan gelen "ANAHTAR=değer" satırlarından kart verisini üretir (WPF ControlDevice.ApplyStats). */
function parseStats(values, d) {
  const V = Object.fromEntries(Object.entries(values).map(([k, x]) => [k.toLowerCase(), x]));
  const g = (k) => (V[k.toLowerCase()] ? V[k.toLowerCase()] : null);
  const s = {};

  const milli = parseFloat(g("TEMP"));
  if (Number.isFinite(milli) && milli > 0) {
    const c = milli / 1000;
    s.temp = { text: trNum(c) + " °C", sev: c >= 75 ? "error" : c >= 60 ? "warn" : "ok" };
  } else s.temp = { text: DASH, sev: "none" };

  const up = parseInt(g("UP"), 10);
  s.uptime = Number.isFinite(up) ? fmtUptime(up) : DASH;
  s.load = g("LOAD") ?? DASH;
  s.mem = usedTotal(g("MEM"));
  s.disk = usedTotal(g("DISK"));

  // Kart boyutu (lsblk, bayt) ile kök bölüm boyutu (df, MB): fark 1 GB'tan büyükse bölüm kartın tamamını kullanmıyordur
  const diskRaw = g("DISK"), cardBytes = g("CARD");
  const diskTotalMb = diskRaw && diskRaw.split("/").length === 2 && Number(diskRaw.split("/")[1]) > 0 ? Number(diskRaw.split("/")[1]) : 0;
  const cardMb = cardBytes && Number(cardBytes) > 0 ? Number(cardBytes) / 1024 / 1024 : 0;
  s.cardText = cardMb > 0 ? "kart " + trNum(cardMb / 1024) + " GB" : "";
  if (cardMb <= 0 || diskTotalMb <= 0) {
    s.canExpand = true; s.expandTip = "Depolamayı SD kartın tamamına genişlet (raspi-config --expand-rootfs)";
  } else {
    s.canExpand = cardMb - diskTotalMb > 1024;
    s.expandTip = s.canExpand
      ? `Bölüm ${trNum(diskTotalMb / 1024)} GB, kart ${trNum(cardMb / 1024)} GB: depolamayı kartın tamamına genişlet (sonra yeniden başlatma gerekir)`
      : "Depolama zaten SD kartın tamamını kullanıyor";
  }

  const sw = g("SW") ?? "bilinmiyor";
  s.swText = { active: "Çalışıyor", inactive: "Durdurulmuş", failed: "Hata", activating: "Başlıyor" }[sw] ?? sw;
  s.swSev = { active: "ok", activating: "info", failed: "error" }[sw] ?? "warn";
  s.host = g("HOST") ?? "";

  // Ağ
  const defIf = g("DEFIF") ?? "";
  const excelKey = macKey(d.excelMac);
  let anyMatch = false;
  s.ifaces = [];
  for (const n of ["wlan0", "eth0"]) {
    const mac = g(n + "_MAC") ?? "";
    if (!mac) continue;
    const addr = g(n + "_IP") ?? "";
    const nic = {
      name: n, address: addr || DASH, gateway: g(n + "_GW") ?? DASH, mac: macDisplay(mac),
      isUp: lower(g(n + "_UP")) === "up", isVia: !!addr && addr.split("/")[0] === d.ip, isInternet: defIf === n,
      macMatches: !!excelKey && macKey(mac) === excelKey,
    };
    anyMatch ||= nic.macMatches;
    s.ifaces.push(nic);
  }
  s.hasNetInfo = s.ifaces.length > 0;
  s.excelMacMismatch = !!d.excelMac && !anyMatch && s.hasNetInfo;
  const via = s.ifaces.find((n) => n.isVia);
  s.viaText = via ? `${via.name} üzerinden bağlı` : "";

  // Wi-Fi: SSID ve sinyal (/proc/net/wireless: kalite x/70, seviye dBm)
  s.ssid = g("SSID") ?? "";
  s.hasWifi = s.ssid.length > 0;
  const quality = parseInt(g("WQ"), 10) || 0;
  const dbm = parseInt(g("WDBM"), 10);
  const hasDbm = Number.isFinite(dbm) && dbm < 0;
  const pct = s.hasWifi ? Math.min(100, Math.max(0, Math.round((quality * 100) / 70))) : 0;
  s.signalBars = !s.hasWifi ? 0 : pct >= 75 ? 4 : pct >= 50 ? 3 : pct >= 25 ? 2 : 1;
  const q4 = !hasDbm ? "" : dbm >= -55 ? "Çok iyi" : dbm >= -67 ? "İyi" : dbm >= -75 ? "Orta" : "Zayıf";
  s.signalText = !s.hasWifi ? "" : hasDbm ? `%${pct} · ${dbm} dBm · ${q4}` : `%${pct}`;

  // USB seri aygıtlar (ttyUSB0/ttyUSB1…): port, üretici, ürün
  s.usb = Object.entries(values)
    .filter(([k]) => /^usb_/i.test(k))
    .sort((a, b) => a[0].length - b[0].length || a[0].localeCompare(b[0]))
    .map(([k, v]) => usbPort(k, v));
  return s;
}

// ── Hasta sekmesi (YBDB) ──────────────────────────────────────
// SerialWorker'ın yazdığı SinyalId'ler (WPF PatientRepository ile aynı). 59 her zaman RR (solunum sayısı).
const HB = { hr: 25, nibpMean: 0, nibpDia: 1, nibpSys: 2, spo2: 66, temp: 74, rr: 59 };
const VENT = { peep: 50, peepUstu: 51, pip: 53, pTepe: 56, port: 55, tvi: 72, tve: 71, mve: 38, rr: 57, rrSet: 58, fio2: 16, ie: 26, mode: 209 };
/** Ajandaki PatientRepository.Window: son değerler yalnızca en yeni bu kadar satırda aranır (~2-3 gün). */
const WINDOW_K = 100;
/** Bu süreden eski değer sarı, STALE_ERR'den eskisi kırmızı; simgeler de durur (veri 10 dk aralıklarla yazılıyor). */
const STALE_WARN = 20 * 60000, STALE_ERR = 60 * 60000;
/** Son bu süre içinde okunmamış değer soluk gösterilir ve simgesi durur (WPF VitalItem.FreshFor ile aynı). */
const FRESH_MS = 5 * 60000;

// Monitör simgeleri (24x24): kalp, damla, basınç göstergesi, termometre (Material Design Icons, Apache 2.0); akciğer
const VICON = {
  hr: "M12,21.35L10.55,20.03C5.4,15.36 2,12.27 2,8.5C2,5.41 4.42,3 7.5,3C9.24,3 10.91,3.81 12,5.08C13.09,3.81 14.76,3 16.5,3C19.58,3 22,5.41 22,8.5C22,12.27 18.6,15.36 13.45,20.03L12,21.35Z",
  spo2: "M12,20A6,6 0 0,1 6,14C6,10 12,3.25 12,3.25C12,3.25 18,10 18,14A6,6 0 0,1 12,20Z",
  nibp: "M12,16A3,3 0 0,1 9,13C9,11.88 9.61,10.9 10.5,10.39L20.21,4.77L14.68,14.35C14.18,15.33 13.17,16 12,16M12,3C13.81,3 15.5,3.5 16.97,4.32L14.87,5.53C14,5.19 13,5 12,5A8,8 0 0,0 4,13C4,15.21 4.89,17.21 6.34,18.65H6.35C6.74,19.04 6.74,19.67 6.35,20.06C5.96,20.45 5.32,20.45 4.93,20.07V20.07C3.12,18.26 2,15.76 2,13A10,10 0 0,1 12,3M22,13C22,15.76 20.88,18.26 19.07,20.07V20.07C18.68,20.45 18.05,20.45 17.66,20.06C17.27,19.67 17.27,19.04 17.66,18.65V18.65C19.11,17.2 20,15.21 20,13C20,12 19.81,11 19.46,10.1L20.67,8C21.5,9.5 22,11.18 22,13Z",
  temp: "M15,13V5A3,3 0 0,0 9,5V13A5,5 0 1,0 15,13M12,4A1,1 0 0,1 13,5V8H11V5A1,1 0 0,1 12,4Z",
  rr: "M11,3H13V10L15,12V9.5C15,7 16.5,5 18.5,5C20.5,5 22,9 22,15C22,18.5 20.5,20 18,20C16,20 15,19 15,17V14.5L12,11.5L9,14.5V17C9,19 8,20 6,20C3.5,20 2,18.5 2,15C2,9 3.5,5 5.5,5C7.5,5 9,7 9,9.5V12L11,10Z",
};

const pad2 = (n) => String(n).padStart(2, "0");
const toDate = (v) => (v ? new Date(v) : null);
const fmtDT = (t) => `${pad2(t.getDate())}.${pad2(t.getMonth() + 1)}.${t.getFullYear()} ${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
const fmtShort = (t) => {
  const now = new Date();
  const hm = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  return t.toDateString() === now.toDateString() ? hm : `${pad2(t.getDate())}.${pad2(t.getMonth() + 1)} ${hm}`;
};
function ago(ms) {
  const min = ms / 60000;
  if (min < 1) return "şimdi";
  if (min < 60) return `${Math.floor(min)} dk önce`;
  if (min < 1440) return `${Math.floor(min / 60)} sa önce`;
  return `${Math.floor(min / 1440)} gün önce`;
}
const numTr = (v) => Number(v).toLocaleString("tr-TR", { maximumFractionDigits: 2, useGrouping: false });
/** "Ahmet Yılmaz" → "A*** Y***" (ekran paylaşımında ad görünmesin). */
const mask = (name) => name.split(/\s+/).filter(Boolean).map((w) => w[0].toLocaleUpperCase("tr") + "***").join(" ");
/** Excel'de "12", " 12 " ya da "12.0" olabilir. */
const bedKey = (v) => { const t = String(v ?? "").trim(); const n = Number(t); return t && Number.isInteger(n) && n >= 0 ? String(n) : t; };
const dayCount = (kabul) => {
  const a = new Date(kabul.getFullYear(), kabul.getMonth(), kabul.getDate()), t = new Date();
  return Math.max(1, Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()) - a) / 86400000) + 1);
};

/** Sinyal listesini SinyalId → en yeni değer haritasına çevirir (zaman Date). */
function signalMap(rows) {
  const m = new Map();
  for (const r of rows ?? []) {
    const z = toDate(r.zaman);
    const cur = m.get(r.sinyalId);
    if (!cur || z > cur.z) m.set(r.sinyalId, { v: r.deger, z });
  }
  return m;
}
const latest = (m) => (m.size ? new Date(Math.max(...[...m.values()].map((x) => x.z)))  : null);
/** Değer taze (≤20 dk) ve pozitifse dakikadaki hızı, değilse 0: simge hareketi buna göre. */
const freshRate = (m, id) => { const x = m.get(id); return x && Date.now() - x.z <= STALE_WARN && x.v > 0 ? Number(x.v) : 0; };

function vItem(m, label, id, unit, kind = "", tileUnit = "", rate = 0) {
  const x = m.get(id);
  return x ? { label, value: numTr(x.v), tip: `${label} (${unit}) · ${fmtDT(x.z)} · SinyalId ${id}`, kind, unit: tileUnit, rate, z: x.z }
           : { label, value: DASH, tip: `${label} (${unit}) · SinyalId ${id} · kayıt yok`, kind, unit: tileUnit, rate: 0 };
}

/** Kutu soluk mu: değer yok ya da son 5 dakikada okunmamış. Bayat değerde simge durur, ipucuna not eklenir. */
function freshen(it) {
  const stale = it.value !== DASH && it.z != null && Date.now() - it.z > FRESH_MS;
  return { ...it, dim: it.value === DASH || stale, rate: stale ? 0 : it.rate,
           tip: stale ? `${it.tip} · son ${FRESH_MS / 60000} dk'da okunmadı` : it.tip };
}

/** Monitör kutuları; sıra yerleşimle aynı: HR, SpO2, Temp / NIBP (geniş), RR. */
function monitorItems(m) {
  const hr = freshRate(m, HB.hr), rr = freshRate(m, HB.rr);
  const sys = m.get(HB.nibpSys), dia = m.get(HB.nibpDia), mean = m.get(HB.nibpMean);
  const nibpT = [sys, dia, mean].filter(Boolean).map((x) => x.z);
  const nibp = nibpT.length === 0
    ? { label: "NIBP", value: DASH, tip: "NIBP (mmHg) · kayıt yok", kind: "nibp", unit: "mmHg", rate: 0 }
    : { label: "NIBP", value: `${sys ? numTr(sys.v) : DASH}/${dia ? numTr(dia.v) : DASH}`, sub: mean ? `(${numTr(mean.v)})` : "",
        tip: `NIBP sistolik/diastolik (ortalama) mmHg · ${fmtDT(new Date(Math.max(...nibpT)))}`, kind: "nibp", unit: "mmHg", rate: 0,
        z: new Date(Math.max(...nibpT)) };
  return [
    vItem(m, "HR", HB.hr, "/dk", "hr", "/dk", hr),
    vItem(m, "SpO2", HB.spo2, "%", "spo2", "%", freshRate(m, HB.spo2) > 0 ? hr : 0),
    vItem(m, "Temp", HB.temp, "°C", "temp", "°C"),
    nibp,
    vItem(m, "RR", HB.rr, "solunum sayısı /dk", "rr", "/dk", rr),
  ];
}

function ventItems(m) {
  const rr = m.get(VENT.rr), set = m.get(VENT.rrSet);
  const rrT = [rr, set].filter(Boolean).map((x) => x.z);
  return [
    vItem(m, "Mode", VENT.mode, "ham kod"), vItem(m, "FiO2", VENT.fio2, "%"), vItem(m, "PEEP", VENT.peep, "cmH2O"),
    vItem(m, "PIP", VENT.pip, "cmH2O"), vItem(m, "pTepe", VENT.pTepe, "cmH2O"), vItem(m, "Port", VENT.port, "cmH2O"),
    vItem(m, "P>PEEP", VENT.peepUstu, "PEEP üstü basınç"), vItem(m, "I:E", VENT.ie, "ham değer"),
    vItem(m, "TVi", VENT.tvi, "ml"), vItem(m, "TVe", VENT.tve, "ml"), vItem(m, "MVe", VENT.mve, "l/dk"),
    rrT.length === 0 ? { label: "RR / set", value: DASH, tip: "Solunum sayısı / ayarlanan · kayıt yok" }
      : { label: "RR / set", value: `${rr ? numTr(rr.v) : DASH} / ${set ? numTr(set.v) : DASH}`,
          tip: `Solunum sayısı / ayarlanan (/dk) · ${fmtDT(new Date(Math.max(...rrT)))}`, z: new Date(Math.max(...rrT)) },
  ];
}

const ANIM_KIND = { hr: "beat", spo2: "pulse", rr: "breath" };

/**
 * Monitör simgelerini ölçülen hızda canlandırır: kalp HR hızında atar ("lub-dub"), SpO2 damlası nabızla hafifçe
 * atar, akciğer RR hızında nefes alıp verir. Dalga formu değildir; yalnızca değerin taze olduğunu gösterir.
 */
function animateIcons(root) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const svg of root.querySelectorAll(".pbody:not(.hid) svg[data-rate]")) {
    const rate = Number(svg.dataset.rate), kind = svg.dataset.anim;
    if (!(rate >= 1 && rate <= 300) || !kind) continue;
    const P = 60000 / rate;
    const f = Math.min(1, (P * 0.9) / 460);                 // vuruş en fazla ~0,46 sn; yüksek hızda periyoda sığar
    const at = (ms) => Math.min(1, (ms * f) / P);
    const S = (s) => `scale(${s})`;
    const frames = kind === "breath"
      ? [{ transform: S(1), offset: 0, easing: "ease-in-out" }, { transform: S(1.18), offset: 0.4, easing: "ease-in-out" }, { transform: S(1), offset: 1 }]
      : kind === "beat"
        ? [{ transform: S(1), offset: 0 }, { transform: S(1.28), offset: at(110) }, { transform: S(1), offset: at(230) },
           { transform: S(1.13), offset: at(330) }, { transform: S(1), offset: at(460) }, { transform: S(1), offset: 1 }]
        : [{ transform: S(1), offset: 0 }, { transform: S(1.16), offset: at(140) }, { transform: S(1), offset: at(400) }, { transform: S(1), offset: 1 }];
    svg.animate(frames, { duration: P, iterations: Infinity });
  }
}

export function createControl(ctx) {
  const root = document.createElement("div");
  root.className = "stack";

  // ── Durum ───────────────────────────────────────────────────
  let devices = [];                       // cihaz kartları
  let rooms = [];                         // [{title, idx, collapsed}]
  let busy = false;
  let autoRefresh = false, refreshSeconds = 15, timer = null;
  let statusText = "Hazır";
  let abort = null;
  let nextId = 0;
  // Kart görünümü ("cihaz" | "hasta") ve ad maskeleme bu tarayıcıda hatırlanır (varsayılan: cihaz, adlar gizli)
  let globalView = storeGet("rbox.ctl.view") === "hasta" ? "hasta" : "cihaz";
  let hideNames = storeGet("rbox.ctl.hideNames") !== "0";
  let patientsBusy = false, patientsLoaded = false, patientStatus = "";

  root.innerHTML = `
    <section class="card">
      <div class="card-h row" style="justify-content:space-between">GENEL KONTROL <b id="cSummary" style="font-size:13px;text-transform:none;letter-spacing:0;color:var(--text)">Cihaz listesi yüklenmedi</b></div>
      <div class="card-b row">
        <button class="btn primary" id="cRefresh">${ICONS.redo} Yenile</button>
        <label class="chk"><input type="checkbox" id="cAuto"> Otomatik yenile</label>
        <select id="cSecs" title="Otomatik yenileme aralığı"><option value="10">10 sn</option><option value="15" selected>15 sn</option><option value="30">30 sn</option><option value="60">60 sn</option></select>
        <button class="btn icon" id="cToggle" title="Tüm odaları daralt / genişlet" style="border-color:var(--border-strong)">${ICONS.chevrons}</button>
        <span class="sm muted" id="cNote"></span>
        <span class="spacer" style="flex:1"></span>
        <button class="btn" id="cRestartAll" title="Listedeki tüm cihazlarda serialworker.service'i yeniden başlatır (onay istenir)">${ICONS.term} SerialWorker'ı yeniden başlat (tümü)</button>
        <button class="btn danger" id="cRebootAll" title="Listedeki tüm cihazları yeniden başlatır (onay istenir)">⏻ Tümünü yeniden başlat</button>
      </div>
      <div class="card-b row" style="padding-top:0">
        <span class="sm muted">Kartlar</span>
        <span class="chips" id="cView">
          <button class="chip" data-v="cihaz" title="Tüm kartlarda RasyoBOX istatistikleri">Cihaz</button>
          <button class="chip" data-v="hasta" title="Tüm kartlarda yataktaki hasta (YBDB modülündeki bağlantı kullanılır)">Hasta</button>
        </span>
        <label class="chk" title="Hasta adlarını &quot;A*** Y***&quot; olarak göster (ekran paylaşımı için)"><input type="checkbox" id="cHide"> İsimleri gizle</label>
        <button class="btn mini" id="cPatients" title="Hasta bilgilerini YBDB'den yeniden oku (SSH gerekmez)">${ICONS.redo} Hasta bilgilerini yenile</button>
        <span class="sm muted" id="cPStatus"></span>
      </div>
    </section>

    <div id="cGrid"></div>
    <div class="sm muted" style="padding:0 4px" id="cStatus">Hazır  ·  SSH bilgileri üst banttaki SSH düğmesinden alınır.</div>`;

  const el = {
    summary: $("#cSummary", root), refresh: $("#cRefresh", root), auto: $("#cAuto", root), secs: $("#cSecs", root),
    note: $("#cNote", root), grid: $("#cGrid", root), status: $("#cStatus", root),
    restartAll: $("#cRestartAll", root), rebootAll: $("#cRebootAll", root),
    view: $("#cView", root), hide: $("#cHide", root), patients: $("#cPatients", root), pstatus: $("#cPStatus", root),
  };

  const setStatus = (t) => { statusText = t; el.status.textContent = `${t}  ·  SSH bilgileri üst banttaki SSH düğmesinden, hasta bilgileri YBDB modülündeki bağlantıdan alınır.`; };

  // ── Cihaz listesi ───────────────────────────────────────────
  /** ip boşsa RasyoBOX'sız yatak kartı: yalnızca Hasta sekmesi, cihaz düğmeleri yok. fromYbdb: Excel'de yok, YBDB'deki dolu yatak. */
  function newDevice(r, room, fromYbdb = false) {
    const ip = r.ip || "";
    return {
      id: nextId++, ip, room, yatakAdi: (r.yatak || "").trim() || ip || `Yatak ${r.yatakId}`, yatakId: r.yatakId || "",
      excelMac: macValid(macDisplay(r.mac)) ? macDisplay(r.mac) : "",
      status: ip ? { text: "Bekleniyor", sev: "muted" } : { text: "RasyoBOX yok", sev: "muted" },
      online: false, unreachable: false, busy: false, lastUpdate: "",
      s: null, swVersion: "", rebootRequired: false,
      bedOnly: !ip, fromYbdb, view: globalView,
      pt: { state: "noybdb", message: "YBDB'ye bağlı değil — YBDB modülünden bağlanın" },
      older: {},                             // "Daha eskisini ara" sonucu: { monitor: {hastaId, rows}, vent: {...} }
      searching: {},
    };
  }
  const showPatient = (d) => d.bedOnly || d.view === "hasta";
  const deviceCards = () => devices.filter((d) => !d.bedOnly);
  const roomFor = (title) => {
    const t = (title || "").trim() || "(Oda belirtilmemiş)", key = t.toLocaleLowerCase("tr");
    let rm = rooms.find((r) => r.title.toLocaleLowerCase("tr") === key);
    if (!rm) { rm = { title: t, idx: rooms.length, collapsed: false }; rooms.push(rm); }
    return rm.idx;
  };

  function setDevices(list) {
    if (busy) return false;
    devices = []; rooms = []; nextId = 0;
    const seen = new Set(), seenBeds = new Set();
    for (const r of list.rows) {
      const ip = (r.ip || "").trim(), bed = bedKey(r.yatakId);
      const room = roomFor(r.oda);
      if (isIpv4(ip)) {
        if (seen.has(ip)) continue;
        seen.add(ip);
        devices.push(newDevice({ ...r, ip }, room));
      } else if (!ip && bed && !seenBeds.has(bed)) {
        seenBeds.add(bed);
        devices.push(newDevice({ ...r, ip: "", yatakId: bed }, room));
      }
    }
    patientsLoaded = false;
    updateNote();
    render();
    if (devices.length) refreshPatients();
    return true;
  }

  function updateNote() {
    const beds = devices.filter((d) => d.bedOnly).length;
    el.note.textContent = devices.length
      ? `${devices.length - beds} cihaz · ${new Set(devices.map((d) => d.room)).size} oda${beds ? ` · ${beds} RasyoBOX'sız yatak` : ""}` : "";
  }

  // ── Çizim ───────────────────────────────────────────────────
  function summary() {
    const cards = deviceCards();
    if (devices.length === 0) return "Cihaz listesi yüklenmedi";
    const online = cards.filter((d) => d.online).length;
    const sw = cards.filter((d) => d.s?.swSev === "ok").length;
    return `${online} / ${cards.length} çevrimiçi · SerialWorker ${sw} çalışıyor`;
  }

  const badge = (text, sev) => (text ? `<span class="badge sev-${sev}">${esc(text)}</span>` : "");

  function ifaceHtml(n) {
    return `<div class="iface${n.isVia ? " via" : ""}">
      <div class="ih"><span class="dot${n.isUp ? " up" : ""}"></span><b class="mono">${n.name}</b>
        <span style="margin-left:auto">${n.isVia ? '<span class="pill">bağlantı</span>' : ""}${n.isInternet ? '<span class="pill">internet çıkışı</span>' : ""}</span></div>
      <div class="kv"><span>IP</span><span class="mono">${esc(n.address)}</span>
        <span>GW</span><span class="mono">${esc(n.gateway)}</span>
        <span>MAC</span><span class="mono">${esc(n.mac)}${n.macMatches ? '<span class="macok" title="Excel ile eşleşiyor">✓</span>' : ""}</span></div></div>`;
  }

  // ── Hasta gövdesi ───────────────────────────────────────────
  function vtileHtml(it) {
    const anim = ANIM_KIND[it.kind] ?? "";
    return `<div class="vt v-${it.kind}${it.dim ? " none" : ""}" title="${esc(it.tip)}">
      <div class="vh"><svg viewBox="0 0 24 24" ${anim ? `data-anim="${anim}" data-rate="${it.rate}"` : ""}><path d="${VICON[it.kind]}"/></svg>
        ${it.kind === "hr" ? "" : `<b>${esc(it.label)}</b>`}<span class="vu">${esc(it.unit)}</span></div>
      <div class="vv">${esc(it.value)}${it.sub ? ` <small>${esc(it.sub)}</small>` : ""}</div></div>`;
  }

  function sectionHtml(d, key, title, rows) {
    const p = d.pt;
    let older = false;
    if ((!rows || rows.length === 0) && d.older[key]?.hastaId === p.hastaId) { rows = d.older[key].rows; older = true; }
    const m = signalMap(rows);
    const items = (key === "monitor" ? monitorItems(m) : ventItems(m)).map(freshen);
    const t = latest(m), has = !!t && items.some((i) => i.value !== DASH);
    let h = `<hr><div class="vsec"><span class="tk">${title}</span>${older && has ? '<span class="badge sev-warn" title="Son 2-3 günde veri yok; gösterilen değerler daha eski kayıtlardan">eski kayıt</span>' : ""}`;
    if (has) {
      const age = Date.now() - t;
      const sev = age > STALE_ERR ? "error" : age > STALE_WARN ? "warn" : "ok";
      h += `<span class="vtime ${sev}" title="Son değerin okunma zamanı (20 dk'dan eski sarı, 60 dk'dan eski kırmızı)">${fmtShort(t)} · ${ago(age)}</span></div>`;
      h += key === "monitor"
        ? `<div class="vgrid">${items.map(vtileHtml).join("")}</div>`
        : `<div class="ptiles">${items.map((i) => `<div class="pt${i.dim ? " none" : ""}" title="${esc(i.tip)}"><span>${esc(i.label)}</span><b>${esc(i.value)}</b></div>`).join("")}</div>`;
    } else {
      h += `</div><div class="sm muted" style="margin-top:6px">${older ? "Kayıt bulunamadı"
        : `Son ${WINDOW_K} bin kayıtta (2-3 gün) ${key === "monitor" ? "monitör" : "ventilatör"} verisi yok`}</div>`;
      if (!older) h += d.searching[key]
        ? `<div class="sm muted" style="margin-top:6px">Aranıyor…</div>`
        : `<button class="btn mini" style="margin-top:6px" data-act="older" data-sec="${key}" data-id="${d.id}" title="Bu hastanın en son kayıtlarını tüm tabloda arar (birkaç saniye sürebilir)">Daha eskisini ara</button>`;
    }
    return h;
  }

  function patientHtml(d) {
    const p = d.pt;
    if (!["occupied", "empty"].includes(p.state)) return `<div class="sm muted" style="margin-top:4px">${esc(p.message)}</div>`;
    const name = (r) => { const full = `${r.adi} ${r.soyadi}`.trim(); return full ? (hideNames ? mask(full) : full) : "(adı yok)"; };
    const b = p.bed, r = p.p;
    const bedText = [b.yatakAdi, b.odaAdi, b.bolumAdi].filter(Boolean).join(" · ") + (b.silinmis ? " (silinmiş yatak)" : "");
    let nameText, lines = [];
    if (p.state === "occupied") {
      nameText = name(r);
      const k = toDate(r.kabul);
      lines.push(k ? `Yatış ${fmtDT(k)} · ${dayCount(k)}. gün` : "Yatış zamanı yok");
    } else if (r) {
      nameText = "Son hasta: " + name(r);
      const k = toDate(r.kabul), c = toDate(r.cikis);
      if (k) lines.push(`Yatış ${fmtDT(k)}`);
      if (c) lines.push(`Taburcu ${fmtDT(c)} · ${ago(Date.now() - c)}`);
    } else nameText = "Bu yatakta hasta kaydı yok";

    let h = `<div class="phead"><b title="${esc(nameText)}">${esc(nameText)}</b>${p.state === "occupied" ? badge("Dolu", "ok") : '<span class="badge sev-muted">Boş</span>'}</div>
      <div class="sub" title="${esc(p.match)}">${esc(bedText)}</div>
      ${lines.map((l) => `<div class="padm">${esc(l)}</div>`).join("")}`;
    if (p.state === "occupied") h += sectionHtml(d, "monitor", "Monitör", p.monitor) + sectionHtml(d, "vent", "Ventilatör", p.vent);
    if (p.devices.length) h += `<hr><div class="tk">Bağlı cihazlar (YBDB)</div><div class="mono sm" style="margin-top:4px">${
      p.devices.map((x) => esc(x.adi + (x.ip ? ` · ${x.ip}${x.port ? ":" + x.port : ""}` : ""))).join("<br>")}</div>`;
    return h;
  }

  function cardHtml(d) {
    const s = d.s;
    const pat = showPatient(d);
    // Pasif (soluk): Cihaz sekmesinde ulaşılamayan cihaz, Hasta sekmesinde boş yatak (ya da YBDB'de yatağı yok)
    const dim = pat ? ["empty", "nobed"].includes(d.pt.state) : d.unreachable;
    const cls = ["dcard", dim ? "unreach" : "", d.busy ? "busy" : ""].join(" ");
    const disabled = busy ? "disabled" : "";
    let h = `<div class="${cls}" data-id="${d.id}">
      <div class="head">
        <span class="bar" style="background:${unitColor(d.room)}"></span>
        <div style="min-width:0;flex:1"><div class="title" title="${esc(d.yatakAdi)}">${esc(d.yatakAdi)}</div><div class="sub">${esc(rooms[d.room].title)}</div></div>
        ${d.bedOnly
          ? '<span class="pill neutral" title="Bu yatakta RasyoBOX yok (yatak ID var, IP yok): yalnızca hasta bilgileri gösterilir">RasyoBOX yok</span>'
          : `<div class="seg mini cseg"><button data-act="view" data-v="cihaz" data-id="${d.id}" aria-selected="${!pat}">Cihaz</button><button data-act="view" data-v="hasta" data-id="${d.id}" aria-selected="${pat}">Hasta</button></div>`}
      </div>
      <div class="ipline">${d.bedOnly
        ? `<span>Yatak ID <span class="mono">${esc(d.yatakId)}</span></span>`
        : `<span title="${esc(s?.host ?? "")}"><span class="mono">${esc(d.ip)}</span> ${esc(s?.viaText ?? "")}</span>${badge(d.status.text, d.status.sev)}`}</div>
      <div class="cbody">
      <div class="pbody${pat ? "" : " hid"}">${patientHtml(d)}</div>`;
    if (d.bedOnly) return h + `</div>${footHtml(d, disabled)}</div>`;
    h += `<div class="dbody${pat ? " hid" : ""}">
      <div class="tilebox">
        <div><div class="tk">Sıcaklık</div><div class="tv ${s?.temp.sev ?? ""}">${esc(s?.temp.text ?? DASH)}</div></div><i></i>
        <div><div class="tk">Çalışma süresi</div><div class="tv">${esc(s?.uptime ?? DASH)}</div></div>
      </div>
      <div class="meterrow"><span><span class="lbl">Bellek</span> ${esc(s?.mem.text ?? DASH)}</span><b>%${s?.mem.pct ?? 0}</b></div>
      <div class="meter ${(s?.mem.pct ?? 0) >= 90 ? "crit" : (s?.mem.pct ?? 0) >= 75 ? "hi" : ""}"><div style="width:${s?.mem.pct ?? 0}%"></div></div>
      <div class="meterrow" style="margin-top:10px"><span><span class="lbl">Depolama</span> ${esc(s?.disk.text ?? DASH)} <span class="muted sm">${esc(s?.cardText ?? "")}</span></span>
        <span class="row tight" style="gap:6px"><b>%${s?.disk.pct ?? 0}</b>
          <button class="btn mini" data-act="expand" data-id="${d.id}" ${!s || !s.canExpand || busy ? "disabled" : ""} title="${esc(s?.expandTip ?? "Bir kez okunduktan sonra kullanılabilir")}">${ICONS.down}</button></span></div>
      <div class="meter ${(s?.disk.pct ?? 0) >= 90 ? "crit" : (s?.disk.pct ?? 0) >= 75 ? "hi" : ""}"><div style="width:${s?.disk.pct ?? 0}%"></div></div>
      ${d.rebootRequired ? '<div class="warnbox w">⚠ Depolama genişletildi — etkili olması için yeniden başlatma gerekli</div>' : ""}
      <div class="swrow"><span class="row tight"><span class="muted">SerialWorker</span>${badge(s?.swText ?? DASH, s?.swSev ?? "muted")}${d.swVersion ? `<span class="badge sev-info" title="SerialWorkerServiceVol61.dll sürümü">${esc(d.swVersion)}</span>` : ""}</span>
        <span class="muted">Yük <span style="color:var(--text)">${esc(s?.load ?? DASH)}</span></span></div>`;

    if (s) {
      h += `<div class="tk" style="margin-top:14px">USB</div>` +
        (s.usb.length === 0 ? `<div class="sm muted" style="margin-top:6px">Takılı USB seri aygıt yok</div>` :
          s.usb.map((u) => `<div class="usbrow" title="${esc(u.tip)}"><span class="badge sev-info">${esc(u.name)}</span>
            <div style="min-width:0"><div style="font-size:12px">${esc(u.vendor)}</div><div class="sm muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(u.product)}</div></div></div>`).join(""));
    }

    h += `<hr><div class="tk">Ağ</div>`;
    if (!s?.hasNetInfo) h += `<div class="sm muted" style="margin-top:6px">Cihaza bağlanınca arayüz bilgileri (IP, ağ geçidi, MAC, Wi-Fi) burada görünür.</div>`;
    if (s?.hasWifi) {
      h += `<div class="wifi"><div><b>📶 ${esc(s.ssid)}</b><div class="sm muted">${esc(s.signalText)}</div></div>
        <div class="sigbars">${[5, 8, 12, 16].map((px, i) => `<i style="height:${px}px" class="${i < s.signalBars ? "on" : ""}"></i>`).join("")}</div></div>`;
    }
    for (const n of s?.ifaces ?? []) h += ifaceHtml(n);
    if (s?.excelMacMismatch) h += `<div class="warnbox e">⚠ Excel'deki MAC <span class="mono">${esc(d.excelMac)}</span> hiçbir arayüzle eşleşmiyor</div>`;
    return h + `</div></div>${footHtml(d, disabled)}</div>`;
  }

  /** Kart işlemleri: kartın altına sabit (aynı satırdaki kartlar aynı boya uzar). */
  function footHtml(d, disabled) {
    const pat = showPatient(d);
    let h = `<div class="foot"><hr>${!d.bedOnly && d.lastUpdate ? `<div class="sm muted" style="margin-bottom:6px">Son okuma ${esc(d.lastUpdate)}</div>` : ""}
      <div class="acts">
        <button class="btn mini" data-act="refresh" data-id="${d.id}" ${pat ? "" : disabled} title="${pat ? "Hasta bilgilerini yenile (YBDB)" : "Bu cihazı yenile"}">${ICONS.redo}</button>`;
    if (!d.bedOnly) h += `
        <button class="btn mini" data-act="update" data-id="${d.id}" title="İlgili cihazı güncelle (Cihaz Güncelleme'ye geçer)">${ICONS.upload}</button>
        <button class="btn mini" data-act="restartSw" data-id="${d.id}" ${disabled} title="SerialWorker servisini yeniden başlat">${ICONS.term}</button>
        <button class="btn mini" data-act="reboot" data-id="${d.id}" ${disabled} title="Cihazı yeniden başlat" style="color:var(--error-text)">⏻</button>`;
    return h + `</div></div>`;
  }

  function render() {
    el.summary.textContent = summary();
    el.refresh.disabled = busy || devices.length === 0;
    el.restartAll.disabled = el.rebootAll.disabled = busy || deviceCards().length === 0;
    for (const c of el.view.children) c.setAttribute("aria-checked", String(c.dataset.v === globalView));
    el.hide.checked = hideNames;
    el.patients.disabled = patientsBusy || devices.length === 0;
    el.pstatus.textContent = patientStatus;

    if (devices.length === 0) {
      el.grid.innerHTML = `<section class="card"><div class="placeholder"><h2>Cihaz listesi yüklenmedi</h2>
        <p>Üst banttaki "Cihaz listesi" düğmesinden Excel seçin — tüm modüller aynı listeyi kullanır.</p></div></section>`;
      return;
    }
    let html = "";
    for (const rm of rooms) {
      const items = devices.filter((d) => d.room === rm.idx);
      if (items.length === 0) continue;
      const online = items.filter((d) => d.online).length, problems = items.filter((d) => d.unreachable).length;
      const beds = items.filter((d) => d.bedOnly).length, n = items.length - beds;
      html += `<div class="cgroup" data-room="${rm.idx}"><span class="gchip" style="background:${unitColor(rm.idx)};margin:0"></span>${rm.collapsed ? "▸" : "▾"} ${esc(rm.title)}
        <span class="gcount">${[n ? (online > 0 ? `${n} cihaz · ${online} çevrimiçi` : `${n} cihaz`) : "", beds ? `${beds} RasyoBOX'sız yatak` : ""].filter(Boolean).join(" · ")}${problems ? ` · <span class="txt-error">${problems} ulaşılamıyor</span>` : ""}</span></div>`;
      if (!rm.collapsed) html += `<div class="cards">${items.map(cardHtml).join("")}</div>`;
    }
    el.grid.innerHTML = html;
    animateIcons(el.grid);
  }

  // Hasta sekmesindeki "x dk önce" ve renkler / simge hareketi zamanla değişir: dakikada bir yeniden çiz
  setInterval(() => { if (!document.hidden && root.isConnected && devices.some(showPatient)) scheduleRender(); }, 60000);

  // ── Hasta verisi (YBDB) ─────────────────────────────────────
  const setAllPatients = (state, message) => devices.forEach((d) => { d.pt = { state, message }; });

  /**
   * Tek istekte tüm kartların hasta verisini okur. Kart → yatak: önce Yatak.IpAddress = kartın IP'si, yoksa Excel'deki
   * yatak ID'si. Hiçbir karta eşlenmemiş DOLU yataklar "RasyoBOX yok" kartı olarak eklenir (yatak boşalınca kalkar).
   */
  async function refreshPatients() {
    if (patientsBusy || devices.length === 0) return;
    patientsBusy = true;
    devices.filter((d) => ["noybdb", "error"].includes(d.pt.state)).forEach((d) => { d.pt = { state: "loading", message: "Hasta bilgileri okunuyor…" }; });
    render();
    try {
      const snap = await api("/api/control/patients");
      applySnapshot(snap);
      patientsLoaded = true;
      patientStatus = `Hasta bilgileri ${new Date(snap.readAt).toLocaleTimeString("tr-TR")}`;
    } catch (e) {
      devices = devices.filter((d) => !d.fromYbdb);
      if (e.status === 409) { setAllPatients("noybdb", "YBDB'ye bağlı değil — YBDB modülünden bağlanın"); patientStatus = ""; }
      else if (e.status === 404) { setAllPatients("error", "Ajan bu özelliği desteklemiyor — ajanı güncelleyin (0.13.0+)"); patientStatus = "Ajan güncel değil"; }
      else { setAllPatients("error", "YBDB okunamadı: " + e.message); patientStatus = "YBDB okunamadı: " + e.message; }
      updateNote();
    } finally {
      patientsBusy = false;
      render();
    }
  }

  function setPatient(d, bed, match, s) {
    const r = s.patientByBed[bed.yatakId];
    const aktif = !!r?.aktif;
    const hastaId = aktif ? r.hastaId : null;
    if (d.pt.hastaId !== hastaId) d.older = {};
    d.pt = {
      state: aktif ? "occupied" : "empty", bed, match, p: r ?? null, hastaId,
      monitor: aktif ? s.monitor[r.hastaId] ?? [] : [], vent: aktif ? s.vent[r.hastaId] ?? [] : [],
      devices: s.devicesByBed[bed.yatakId] ?? [],
    };
  }

  function applySnapshot(s) {
    const beds = [...s.beds].sort((a, b) => a.silinmis - b.silinmis);      // aynı IP / ID'de silinmemiş yatak önce
    const byIp = new Map(), byId = new Map();
    for (const b of beds) {
      if (isIpv4(b.ip) && !byIp.has(b.ip)) byIp.set(b.ip, b);
      if (!byId.has(b.yatakId)) byId.set(b.yatakId, b);
    }

    const used = new Set();
    for (const d of devices.filter((x) => !x.fromYbdb)) {
      let bed = d.ip ? byIp.get(d.ip) : null, match = "Yatak.IpAddress ile eşleşti";
      if (!bed) { const k = bedKey(d.yatakId); bed = /^\d+$/.test(k) ? byId.get(Number(k)) : null; match = "Excel'deki yatak ID ile eşleşti"; }
      if (bed) { setPatient(d, bed, match, s); used.add(bed.yatakId); }
      else d.pt = { state: "nobed", message: d.yatakId
        ? `YBDB'de yatak bulunamadı (yatak ID ${d.yatakId})`
        : "Yatak eşleşmedi: YBDB'de bu IP'ye ait yatak (Yatak.IpAddress) yok, Excel'de yatak ID'si de yok" };
    }

    // Excel'de olmayan dolu yataklar
    const cmp = (a, b) => a.localeCompare(b, "tr", { sensitivity: "base" });
    const wanted = Object.values(s.patientByBed)
      .filter((p) => p.aktif && !used.has(p.yatakId) && byId.has(p.yatakId))
      .map((p) => byId.get(p.yatakId))
      .sort((a, b) => cmp(a.bolumAdi, b.bolumAdi) || cmp(a.yatakAdi, b.yatakAdi));
    const wantedIds = new Set(wanted.map((b) => String(b.yatakId)));
    devices = devices.filter((d) => !d.fromYbdb || wantedIds.has(d.yatakId));
    for (const bed of wanted) {
      let d = devices.find((x) => x.fromYbdb && x.yatakId === String(bed.yatakId));
      if (!d) {
        d = newDevice({ ip: "", yatak: bed.yatakAdi, yatakId: String(bed.yatakId) }, roomFor(bed.bolumAdi || bed.odaAdi), true);
        devices.push(d);
      }
      setPatient(d, bed, "Excel'de yok — YBDB'deki dolu yatak", s);
    }
    updateNote();
  }

  async function searchOlder(d, key) {
    const hastaId = d.pt.hastaId;
    if (!hastaId || d.searching[key]) return;
    d.searching[key] = true; render();
    try {
      const r = await api("/api/control/patients/older", { method: "POST", body: { table: key === "monitor" ? "HBSinyal" : "SolunumSinyal", hastaId } });
      if (d.pt.hastaId === hastaId) d.older[key] = { hastaId, rows: r.rows };
    } catch (e) {
      toast("Eski kayıtlar okunamadı: " + e.message, 5000);
    } finally {
      d.searching[key] = false; render();
    }
  }

  function setGlobalView(v) {
    globalView = v;
    storeSet("rbox.ctl.view", v);
    devices.forEach((d) => { d.view = v; });
    render();
    if (v === "hasta" && !patientsLoaded) refreshPatients();
  }

  addEventListener("rbox:ybdb", () => { patientsLoaded = false; refreshPatients(); });

  let raf = 0;
  const scheduleRender = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };

  // ── İşlemler ────────────────────────────────────────────────
  const dev = (id) => devices.find((d) => d.id === id);

  function applyState(d, m) {
    d.status = { text: m.state.text, sev: m.state.sev };
    d.online = m.state.online; d.unreachable = m.state.unreachable;
    d.busy = false;
    if (m.values) { d.s = parseStats(m.values, d); d.lastUpdate = new Date().toLocaleTimeString("tr-TR"); }
    if (m.version != null) d.swVersion = m.version;
  }

  async function refresh(list) {
    list = list.filter((d) => !d.bedOnly);
    if (busy || list.length === 0) return;
    if (ctx.requireSsh && !(await ctx.requireSsh())) return;
    busy = true; setStatus("Cihazlar okunuyor…");
    abort = new AbortController();
    render();
    try {
      await stream("/api/control/refresh", { targets: list.map((d) => ({ id: d.id, ip: d.ip, needVersion: d.swVersion === "" })) }, (m) => {
        const d = dev(m.id);
        if (m.type === "busy" && d) { d.busy = true; if (!d.online) d.status = { text: "Kontrol ediliyor", sev: "info" }; }
        else if (m.type === "device" && d) applyState(d, m);
        scheduleRender();
      }, abort.signal);
      setStatus(`Son yenileme ${new Date().toLocaleTimeString("tr-TR")}`);
    } catch (e) {
      if (e.name !== "AbortError") toast(e.message, 5000);
      setStatus("Yenileme başarısız");
    } finally {
      devices.forEach((d) => { d.busy = false; });
      busy = false; abort = null; render();
    }
  }

  /** Komutu hedeflerde çalıştırır (onay ister); başarılı olan cihazların listesini döner. */
  async function exec(action, list, question, doneText, skipConfirm = false) {
    if (busy || list.length === 0) return [];
    if (!skipConfirm && !confirm(question)) return [];
    if (ctx.requireSsh && !(await ctx.requireSsh())) return;
    busy = true; setStatus("Komut gönderiliyor…");
    abort = new AbortController();
    render();
    const ok = [];
    try {
      await stream("/api/control/exec", { action, targets: list.map((d) => ({ id: d.id, ip: d.ip, needVersion: false })) }, (m) => {
        const d = dev(m.id);
        if (m.type === "busy" && d) d.busy = true;
        else if (m.type === "device" && d) {
          applyState(d, m);
          if (m.ok) { d.swVersion = ""; ok.push(d); }            // servis / cihaz yeniden başladı: sürüm bir sonraki yenilemede yeniden okunur
          else if (m.error) d.lastUpdate = m.error;
        }
        scheduleRender();
      }, abort.signal);
      if (action === "reboot") ok.forEach((d) => { d.rebootRequired = false; });
      setStatus(`${doneText} · ${new Date().toLocaleTimeString("tr-TR")}`);
    } catch (e) {
      if (e.name !== "AbortError") toast(e.message, 5000);
    } finally {
      devices.forEach((d) => { d.busy = false; });
      busy = false; abort = null; render();
    }
    return ok;
  }

  const restartSw = async (list, question) => {
    const ok = await exec("restartSw", list, question, "SerialWorker yeniden başlatıldı");
    if (ok.length) { await new Promise((r) => setTimeout(r, 2000)); await refresh(deviceCards()); }
  };
  const reboot = (list, question) => exec("reboot", list, question, "Yeniden başlatılıyor");

  async function expandStorage(d) {
    const sizes = d.s?.cardText ? `\n\nŞu an: ${d.s.disk.text} (${d.s.cardText})` : "";
    const ok = await exec("expand", [d],
      `${d.yatakAdi} (${d.ip}) — depolama SD kartın tamamına genişletilsin mi?${sizes}\n\nYeni boyut cihaz yeniden başlatılınca geçerli olur.`,
      "Genişletme tamamlandı");
    if (ok.length === 0) {
      if (d.lastUpdate && !d.online) toast(`${d.yatakAdi} (${d.ip}) — depolama genişletilemedi: ${d.lastUpdate}`, 6000);
      return;
    }
    d.rebootRequired = true;
    d.status = { text: "Yeniden başlatma gerekli", sev: "warn" }; d.online = true;
    render();
    // Genişletme ancak yeniden başlatmadan sonra etkili: soru zaten sorulduğu için ikinci onay istenmez
    if (confirm(`${d.yatakAdi} (${d.ip}) — genişletme tamamlandı.\n\nYeni boyutun kullanılabilmesi için cihaz YENİDEN BAŞLATILMALI.\nŞimdi yeniden başlatılsın mı?`))
      await exec("reboot", [d], "", "Yeniden başlatılıyor", true);
  }

  // ── Olaylar ─────────────────────────────────────────────────
  // Yenile: hasta bilgileri (YBDB, SSH gerekmez) ve cihazlar (SSH) birlikte
  const refreshAll = () => { refreshPatients(); refresh(deviceCards()); };
  el.refresh.addEventListener("click", refreshAll);
  el.restartAll.addEventListener("click", () => { const c = deviceCards(); restartSw(c, `${c.length} cihaz için: SerialWorker servisi yeniden başlatılsın mı?`); });
  el.rebootAll.addEventListener("click", () => { const c = deviceCards(); reboot(c, `${c.length} cihaz için: Cihazlar YENİDEN BAŞLATILSIN mı?\n\nCihazlar yaklaşık 1 dakika boyunca veri gönderemez.`); });
  el.view.addEventListener("click", (e) => { const c = e.target.closest("[data-v]"); if (c) setGlobalView(c.dataset.v); });
  el.hide.addEventListener("change", () => { hideNames = el.hide.checked; storeSet("rbox.ctl.hideNames", hideNames ? "1" : "0"); render(); });
  el.patients.addEventListener("click", () => refreshPatients());
  $("#cToggle", root).addEventListener("click", () => { const anyOpen = rooms.some((r) => !r.collapsed); rooms.forEach((r) => (r.collapsed = anyOpen)); render(); });

  el.auto.addEventListener("change", () => { autoRefresh = el.auto.checked; applyTimer(); if (autoRefresh && !busy) refreshAll(); });
  el.secs.addEventListener("change", () => { refreshSeconds = Number(el.secs.value); applyTimer(); });
  function applyTimer() {
    clearInterval(timer); timer = null;
    if (autoRefresh) timer = setInterval(() => { if (!busy && devices.length) refreshAll(); }, Math.max(10, refreshSeconds) * 1000);
  }

  el.grid.addEventListener("click", (e) => {
    const g = e.target.closest(".cgroup");
    if (g) { const rm = rooms[+g.dataset.room]; rm.collapsed = !rm.collapsed; render(); return; }
    const b = e.target.closest("[data-act]"); if (!b) return;
    const d = dev(+b.dataset.id); if (!d) return;
    if (b.dataset.act === "update") { ctx.openInUpdate?.(d.ip); return; }
    // Hasta tarafı SSH işlemlerinden bağımsız: cihazlar okunurken de kullanılabilir
    if (b.dataset.act === "view") {
      d.view = b.dataset.v; render();
      if (d.view === "hasta" && !patientsLoaded) refreshPatients();
      return;
    }
    if (b.dataset.act === "older") { searchOlder(d, b.dataset.sec); return; }
    if (b.dataset.act === "refresh" && showPatient(d)) { refreshPatients(); return; }
    if (busy) { toast("Bir işlem sürüyor, bitince tekrar deneyin."); return; }
    switch (b.dataset.act) {
      case "refresh": refresh([d]); break;
      case "restartSw": restartSw([d], `${d.yatakAdi} (${d.ip}) — SerialWorker servisi yeniden başlatılsın mı?`); break;
      case "reboot": reboot([d], `${d.yatakAdi} (${d.ip}) YENİDEN BAŞLATILSIN mı?`); break;
      case "expand": expandStorage(d); break;
    }
  });

  render();

  return { root, isBusy: () => busy, setDevices };
}
