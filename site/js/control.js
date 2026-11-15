// Cihaz Kontrol modülü: cihazların anlık durumu (sıcaklık, bellek, depolama, SerialWorker, USB, ağ) ve toplu işlemler.
// Her kartta "Cihaz | Hasta" sekmesi: Hasta, yataktaki hastayı ve son monitör / ventilatör değerlerini YBDB'den gösterir.
// WPF ControlView / ControlDevice / ControlPatient / ControlViewModel karşılığı. SSH ve SQL okuması ajandadır; biçimlendirme burada.
import { api, stream } from "./api.js";
import { $, $$, esc, toast, unitColor, ipFilter, ICONS, storeGet, storeSet, copyText } from "./util.js";
import { openTty } from "./tty.js";

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

/** EDID'den monitör adı (tanımlayıcı 0xFC); yoksa üç harfli üretici kodu (ör. "DEL"). WPF ControlDevice.EdidName. */
function edidName(b64) {
  let e;
  try { e = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)); } catch { return ""; }
  if (e.length < 128 || e[0] !== 0 || e[1] !== 0xff || e[7] !== 0) return "";
  for (let d = 54; d + 18 <= 126; d += 18) {
    if (e[d] === 0 && e[d + 1] === 0 && e[d + 2] === 0 && e[d + 3] === 0xfc) {
      let name = String.fromCharCode(...e.slice(d + 5, d + 18));
      const nl = name.indexOf("\n");
      if (nl >= 0) name = name.slice(0, nl);
      name = name.trim();
      if (name) return name;
    }
  }
  const id = (e[8] << 8) | e[9], k = [(id >> 10) & 31, (id >> 5) & 31, id & 31];
  return k.every((x) => x >= 1 && x <= 26) ? k.map((x) => String.fromCharCode(64 + x)).join("") : "";
}

/**
 * HDMI kablosu takılı mı + ayrıntılar (WPF ControlDevice.ApplyHdmi ile aynı).
 * KMS: "HDMI_card1-HDMI-A-1=connected|<EDID base64>|<ilk mod>|<mod sayısı>" (son iki alan eski ajanda yok);
 * eski sürücü: TVS = "tvservice -s" (bit 0x2 takılı, 0x1 takılı değil; çözünürlük), TVN = "tvservice -n" (device_name=…).
 * FB = görüntü belleği modu|boyutu (aktif çözünürlük), VIDEO = çekirdek satırındaki video=, HCFG = config.txt hdmi_* satırları.
 * Bağlı ama EDID boşsa ekran kendini tanıtmıyor (KVM / çevirici / ekran kapalı / kablo) → uyarı.
 * hdmi_force_hotplug=1 ya da video=HDMI-A-1:…D (…e) bağlantıyı zorlar: kablo yokken de "bağlı" görünür. Bilgi gelmezse null.
 */
function parseHdmi(values, g) {
  const edidLen = (b64) => { if (!b64) return 0; try { return atob(b64).length; } catch { return null; } };
  // Boş değer de "geldi" sayılır (ör. VIDEO= → video= ayarı yok); anahtar hiç yoksa (eski ajan) null
  const raw = (k) => { const e = Object.entries(values).find(([x]) => x.toLowerCase() === k.toLowerCase()); return e ? String(e[1] ?? "") : null; };
  const ports = [];
  for (const [k, v] of Object.entries(values)) {
    if (!/^hdmi_/i.test(k)) continue;
    const key = k.slice(5), a = key.lastIndexOf("-A-");
    const port = a >= 0 ? "HDMI-" + key.slice(a + 3) : key;           // card1-HDMI-A-1 → HDMI-1
    if (ports.some((x) => x.port === port)) continue;
    const parts = String(v).split("|");
    const s = parts[0].trim(), b64 = (parts[1] ?? "").trim();
    ports.push({
      port, conn: s === "connected" ? true : s === "disconnected" ? false : null,
      mon: b64 ? edidName(b64) : "", edid: parts.length > 1 ? edidLen(b64) : null,
      pref: (parts[2] ?? "").trim(), modes: parseInt(parts[3], 10) || 0,
    });
  }
  let source = "KMS (/sys/class/drm)", active = "";
  const tvs = g("TVS");
  if (!ports.length && tvs && /^state/i.test(tvs)) {
    const m = /state\s+0x([0-9a-f]+)/i.exec(tvs);
    let conn = null;
    if (m) { const st = parseInt(m[1], 16); conn = st & 2 ? true : st & 1 ? false : null; }
    const tvn = g("TVN") ?? "";
    let name = tvn.startsWith("device_name=") ? tvn.slice(12).trim() : "";
    if (name.indexOf("-") === 3) name = name.slice(4);                // "DEL-DELL P2419H": üretici kodu önde
    ports.push({ port: "HDMI", conn, mon: conn === true ? name : "", edid: null, pref: "", modes: 0 });
    source = "tvservice (eski sürücü) · " + tvs;
    const r = /(\d+)x(\d+)\s*@\s*([\d.]+)\s*Hz/.exec(tvs);            // "…], 1920x1080 @ 60.00Hz, progressive"
    if (r) active = `${r[1]}×${r[2]} @ ${String(parseFloat(r[3]))} Hz`;
  }
  if (!ports.length) return null;

  const fb = g("FB");                                                  // "U:640x480p-0|640,480"
  if (!active && fb) { const fm = /(\d+)x(\d+)/.exec(fb) || /(\d+),(\d+)/.exec(fb); if (fm) active = `${fm[1]}×${fm[2]}`; }

  const videoRaw = raw("VIDEO"), cfgRaw = raw("HCFG");
  const video = (videoRaw ?? "").split(" ").filter(Boolean);
  const forceVideo = video.some((t) => /^video=HDMI-A-\d+:\S*[De]$/.test(t));
  const cfg = [...new Set((cfgRaw ?? "").split(" ").filter(Boolean))];
  const forceCfg = cfg.some((t) => /^hdmi_force_hotplug(:\d)?=1$/.test(t));
  const forced = forceVideo || forceCfg;

  const multi = ports.length > 1, on = ports.filter((x) => x.conn === true);
  const noEdid = on.length > 0 && on.every((x) => x.edid === 0);
  const res = active ? " · " + active : "";
  const label = (x) => (multi ? x.port + " bağlı" : "Bağlı") + (x.mon ? " · " + x.mon : "");
  let text, sev;
  if (noEdid) { text = (forced ? "Zorlanmış bağlantı" : "Bağlı · ekran yanıt vermiyor") + res; sev = "warn"; }
  else if (on.length) { text = on.map(label).join(", ") + res; sev = "ok"; }
  else if (ports.every((x) => x.conn === false)) { text = "Takılı değil"; sev = "warn"; }
  else { text = "Bilinmiyor"; sev = "muted"; }

  const tip = ports.map((x) => {
    let l = `${x.port}: ${x.conn === true ? "bağlı" : x.conn === false ? "takılı değil" : "bilinmiyor"}${x.mon ? " · " + x.mon : ""}`;
    if (x.conn === true && x.edid != null)
      l += x.edid === 0 ? " · EDID yok (0 bayt)"
        : ` · EDID ${x.edid} bayt` + (x.pref ? ` · önerilen ${x.pref}` : "") + (x.modes > 0 ? ` · ${x.modes} mod` : "");
    return l;
  });
  if (active) tip.push("Aktif çözünürlük: " + active);
  if (videoRaw != null)
    tip.push(!video.length ? "Çekirdek: video= ayarı yok"
      : "Çekirdek: " + video.join(" ") + (forceVideo ? " (bağlantıyı zorluyor)" : " (bağlantıyı zorlamaz)"));
  if (cfgRaw != null) {
    const others = cfg.filter((t) => !t.startsWith("hdmi_force_hotplug"));
    tip.push("config.txt: hdmi_force_hotplug " + (forceCfg ? "açık" : "kapalı") + (others.length ? " · " + others.join(" · ") : ""));
  }
  tip.push("Kaynak: " + source);
  if (noEdid && !forced) tip.push("Ekran kendini tanıtmıyor. Olası neden: arada KVM / HDMI çevirici, ekran kapalı ya da kablo arızalı.");
  if (forced) tip.push('Not: bağlantı zorlanmış; kablo yokken de "bağlı" görünür.');
  const [state, sub] = noEdid ? ["warn", "ekran?"] : on.length ? ["ok", "bağlı"] : sev === "warn" ? ["warn", "yok"] : ["unknown", "?"];
  return { text, sev, tip: tip.join("\n"), state, sub };
}

// ── Durum kareleri (WPF ControlDevice: TileState + Sub + ipucu) ──
// state: ok yeşil · off gri · missing soluk bordo (kurulu değil) · warn sarı · error kırmızı · unknown
const ENABLED = ["enabled", "enabled-runtime", "static", "indirect", "generated", "alias"];
const isEn = (en) => ENABLED.includes(en);
const isRun = (act) => ["active", "activating", "reloading"].includes(act);
const noUnit = (en) => /not-found|No such file/.test(en);
/** İpucunun son satırı: kareye tıklanınca ne olacağı. */
const hint = (turnsOff) => (turnsOff ? "\n▸ Tıkla: kapat (açılışta da kapalı kalır)" : "\n▸ Tıkla: aç (açılışta da otomatik başlar)");
const fields = (raw) => String(raw).split("|").map((x) => x.trim());

/**
 * "SW=<is-active>|<is-enabled>" (WPF ApplyStats). Açılış ayarı okunduysa: etkin + çalışıyor yeşil · etkin + durmuş sarı ·
 * kapalı + çalışıyor sarı (geçici) · kapalı gri. is-enabled "not-found" ise kurulu değil. Sürüm ipucuna çizimde eklenir.
 */
function parseSw(raw) {
  const [sw = "bilinmiyor", en = ""] = fields(raw ?? "bilinmiyor");
  const missing = noUnit(en), known = !!en && !missing, boot = isEn(en);
  const text = missing ? "Kurulu değil" : { active: "Çalışıyor", inactive: "Durdurulmuş", failed: "Hata", activating: "Başlıyor" }[sw] ?? sw;
  const sev = missing ? "muted" : { active: "ok", activating: "info", failed: "error" }[sw] ?? "warn";
  const state = missing ? "missing" : sw === "active" ? (!known || boot ? "ok" : "warn")
    : ["activating", "reloading"].includes(sw) ? "warn" : sw === "failed" ? "error" : known && boot ? "warn" : "off";
  return {
    text, sev, state, missing, off: sw === "active" && (!known || boot), can: !missing && !["", "bilinmiyor"].includes(sw),
    tip0: `SerialWorker: ${text}\nserialworker.service · şu an: ${sw || DASH} · açılışta: ${en || DASH}`
      + (sw === "active" && known && !boot ? "\nAçılışta kapalı: cihaz yeniden başlatılınca durur" : ""),
  };
}

/** "WEB=<is-enabled>|<is-active>|<open|closed|?>" → rasyobox-web.service + port 80 (WPF ApplyWeb). Satır yoksa null. */
function parseWeb(raw) {
  if (raw == null) return null;
  const [en = "", act = "", port = "?"] = fields(raw);
  const running = isRun(act), missing = !en || noUnit(en), boot = isEn(en);
  const text = missing ? "Yüklü değil"
    : running ? (port === "closed" ? "Çalışıyor · port 80 kapalı" : !boot ? "Çalışıyor · geçici (açılışta kapalı)" : "Çalışıyor")
    : en === "disabled" ? "Devre dışı" : en.startsWith("masked") ? "Maskeli" : act === "failed" ? "Hata" : "Durmuş";
  const [state, sub] = missing ? ["missing", "yok"]
    : running ? (port === "closed" ? ["warn", "kapalı"] : !boot ? ["warn", "geçici"] : ["ok", port === "open" ? ":80" : "açık"])
    : act === "failed" ? ["error", "hata"]
    : [boot ? "warn" : "off", en === "disabled" ? "kapalı" : en.startsWith("masked") ? "maskeli" : "durdu"];
  const off = running && boot;                 // açık ve kalıcıysa kapatılır; diğer her durumda açılır
  return {
    state, sub, off, can: !missing,
    tip: missing ? "RasyoBOX web arayüzü kurulu değil (rasyobox-web.service yok)"
      : `RasyoBOX web arayüzü: ${text}\nrasyobox-web.service · açılışta: ${en} · şu an: ${act || DASH}\nPort 80: ${{ open: "dinleniyor", closed: "kapalı" }[port] ?? "okunamadı"}` + hint(off),
  };
}

/** "CRON=<is-enabled>|<is-active>" (WPF ApplyCron). Kareye tıklanınca servis kalıcı olarak açılır / kapatılır. Satır yoksa null. */
function parseCron(raw) {
  if (raw == null) return null;
  const [en = "", act = ""] = fields(raw);
  const running = isRun(act);
  const text = isEn(en) ? (running ? "Etkin" : "Etkin · durmuş")
    : en === "disabled" ? (running ? "Devre dışı · çalışıyor" : "Devre dışı")
    : en === "masked" || en === "masked-runtime" ? "Maskeli"
    : !en || noUnit(en) ? "Kurulu değil" : en;
  const [state, sub] = {
    "Etkin": ["ok", "açık"], "Etkin · durmuş": ["warn", "durdu"], "Devre dışı · çalışıyor": ["warn", "geçici"],
    "Devre dışı": ["off", "kapalı"], "Maskeli": ["off", "maskeli"], "Kurulu değil": ["missing", "yok"],
  }[text] ?? ["unknown", "?"];
  const can = ["ok", "off", "warn"].includes(state);
  return {
    state, sub, off: state === "ok", can,
    tip: `Cron: ${text}\ncron.service · açılışta: ${en || DASH} · şu an: ${act || DASH}`
      + (text === "Devre dışı · çalışıyor" ? "\nCihaz yeniden başlatılınca durur" : "") + (can ? hint(state === "ok") : ""),
  };
}

/** "TUI=<sürüm|boş>|<is-active>|<is-enabled>" (WPF ApplyTui). Üçüncü alan yoksa yalnız çalışma durumuna bakılır. Satır yoksa null. */
function parseTui(raw) {
  if (raw == null) return null;
  const [ver = "", act = "", en = ""] = fields(raw);
  const running = isRun(act), known = en.length > 0;
  const unitMissing = known && (noUnit(en) || en.includes("Failed"));
  const enabled = isEn(en), masked = en.startsWith("masked");
  const [state, word] = !ver ? ["missing", "yok"] : unitMissing ? ["off", "servis yok"]
    : !known ? (running ? ["ok", "açık"] : ["off", "durdu"])
    : enabled ? (running ? ["ok", "açık"] : ["warn", "durdu"])
    : running ? ["warn", "geçici"] : ["off", masked ? "maskeli" : "kapalı"];
  const can = !!ver && !unitMissing;
  return {
    state, sub: !ver ? "yok" : ver !== "?" ? ver : word, off: state === "ok", can,
    tip: (ver ? `swtui ${ver === "?" ? "(sürüm okunamadı)" : ver}` : "swtui kurulu değil")
      + `\nswtui.service · açılışta: ${known ? en : DASH} · şu an: ${act || DASH}`
      + (known && !enabled && running ? "\nCihaz yeniden başlatılınca durur" : "")
      + (can ? hint(state === "ok") : "") + (!ver ? "\nKurmak için: Cihaz Güncelleme → swtui" : ""),
  };
}

/**
 * "LOGIN=<yes|no: raspi-config var mı>|<console|desktop>|<otomatik giren kullanıcı, boş = kapalı>" (WPF ApplyLogin).
 * Tıklanınca raspi-config nonint do_boot_behaviour B1/B2 (konsol) ya da B3/B4 (masaüstü); yeniden başlatınca geçerli.
 */
function parseLogin(raw) {
  if (raw == null) return null;
  const [rc = "", mode = "", user = ""] = fields(raw);
  const can = rc === "yes", desktop = mode === "desktop", on = user.length > 0;
  return {
    state: on ? "ok" : "off", sub: on ? "açık" : "kapalı", off: on, can, desktop,
    tip: `Otomatik giriş: ${on ? `açık · kullanıcı ${user === "?" ? "(okunamadı)" : user}` : "kapalı"}`
      + `\nAçılış: ${desktop ? "masaüstü (lightdm)" : "konsol (tty1)"}`
      + (can ? (on ? "\n▸ Tıkla: kapat (yeniden başlatınca geçerli)" : "\n▸ Tıkla: aç (yeniden başlatınca geçerli)")
        : "\nraspi-config bulunamadı: buradan değiştirilemez"),
  };
}

/** Bellek / disk doluluğu: %90 ve üstü sarı, %95 ve üstü kırmızı + ⚠ (WPF Fill / PercentText). Okunmadıysa boş. */
function fill(u) {
  if (u.text === DASH) return { ...u, sev: "none", pctText: "" };
  const sev = u.pct >= 95 ? "error" : u.pct >= 90 ? "warn" : "ok";
  return { ...u, sev, pctText: `%${u.pct}` + (sev === "error" ? " ⚠" : "") };
}

/** Karttaki IP kopyala düğmesi: kısa süre ✓ gösterir. */
async function copyIpBtn(ip, btn) {
  try {
    await copyText(ip);
    btn.classList.add("done"); btn.innerHTML = ICONS.check;
    setTimeout(() => { btn.classList.remove("done"); btn.innerHTML = ICONS.copy; }, 1200);
    toast(`IP kopyalandı: ${ip}`);
  } catch { toast("Kopyalanamadı"); }
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
  s.mem = fill(usedTotal(g("MEM")));
  s.disk = fill(usedTotal(g("DISK")));

  // İşlemci: CPU = "t1 i1 t2 i2" (/proc/stat toplam ve boşta+iowait, 0,5 sn arayla) → kullanım = 1 − Δboşta / Δtoplam
  const cp = String(g("CPU") ?? "").trim().split(/\s+/).map(Number);
  if (cp.length === 4 && cp.every(Number.isFinite) && cp[2] - cp[0] > 0) {
    const pct = Math.min(100, Math.max(0, Math.round(100 * (1 - (cp[3] - cp[1]) / (cp[2] - cp[0])))));
    const nc = parseInt(g("NCPU"), 10);
    s.cpu = { pct, text: `%${pct}`, sev: pct >= 90 ? "error" : pct >= 70 ? "warn" : "ok", detail: (nc > 0 ? `${nc} çekirdek · ` : "") + `yük ${s.load}` };
  } else s.cpu = null;
  s.hdmi = parseHdmi(values, g);

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

  const sw = parseSw(g("SW"));
  s.swText = sw.text; s.swSev = sw.sev;
  s.t = { sw, web: parseWeb(g("WEB")), tui: parseTui(g("TUI")), cron: parseCron(g("CRON")), login: parseLogin(g("LOGIN")) };
  if (s.hdmi) s.t.hdmi = { state: s.hdmi.state, sub: s.hdmi.sub, tip: `HDMI: ${s.hdmi.text}\n${s.hdmi.tip}` };
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
  s.t.usb = {
    state: s.usb.length ? "ok" : "off", sub: s.usb.length ? String(s.usb.length) : "yok",
    tip: s.usb.length ? "USB seri aygıtlar\n" + s.usb.map((u) => `${u.name} · ${u.vendor}${u.product ? " · " + u.product : ""}\n    ${u.tip}`).join("\n")
      : "Takılı USB seri aygıt yok",
  };
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
  // Kart | Liste görünümü ve "Ağ ayrıntıları" (tüm kartlarda AĞ bölümü) bu tarayıcıda hatırlanır
  let layout = storeGet("rbox.ctl.layout") === "liste" ? "liste" : "kart";
  let netOpen = storeGet("rbox.ctl.net") !== "0";

  // Araç çubuğu: düğmeler yalnız simge, adı ve ne yaptığı ipucunda (WPF 1.58.1). Aç / kapat düğmeleri açıkken vurgulu.
  root.innerHTML = `
    <section class="card">
      <div class="card-h row" style="justify-content:space-between">GENEL KONTROL <b id="cSummary" style="font-size:13px;text-transform:none;letter-spacing:0;color:var(--text)">Cihaz listesi yüklenmedi</b></div>
      <div class="card-b row">
        <button class="btn primary ib" id="cRefresh" title="Yenile · tüm cihazları yeniden kontrol et">${ICONS.redo}</button>
        <button class="btn ib tgl" id="cAuto" aria-pressed="false">${ICONS.timer}</button>
        <select id="cSecs" title="Otomatik yenileme aralığı"><option value="10">10 sn</option><option value="15" selected>15 sn</option><option value="30">30 sn</option><option value="60">60 sn</option></select>
        <button class="btn ib" id="cToggle" title="Tüm odaları daralt / genişlet">${ICONS.chevrons}</button>
        <span class="row tight"><input type="text" id="cNewIp" class="mono-input" placeholder="IP adresi" style="width:150px" autocomplete="off"
          title="Listede olmayan bir cihazı ekleyin: IP yazıp Enter ya da + (Oda belirtilmemiş grubuna kart eklenir)">
        <button class="btn ib" id="cAddIp" title="Ekle · IP'yi listeye ekle">${ICONS.plus}</button></span>
        <span class="sm muted" id="cNote"></span>
        <span class="spacer" style="flex:1"></span>
        <button class="btn ib" id="cRestartAll" title="SerialWorker'ı yeniden başlat (tümü) · listedeki tüm cihazlarda serialworker.service yeniden başlatılır (onay istenir)">${ICONS.term}</button>
        <button class="btn ib" id="cRebootAll" title="Tümünü yeniden başlat · listedeki tüm cihazlar yeniden başlatılır (onay istenir)" style="color:var(--error-text)">${ICONS.power}</button>
      </div>
      <div class="card-b row" style="padding-top:0">
        <div class="seg mini" id="cLayout" role="tablist" aria-label="Görünüm">
          <button data-l="kart" title="Görünüm: kart">${ICONS.grid}</button><button data-l="liste" title="Görünüm: liste · her cihaz bir satır">${ICONS.list}</button></div>
        <div class="seg mini" id="cView" role="tablist" aria-label="Kart içeriği">
          <button data-v="cihaz" title="Cihaz · tüm kartlarda RasyoBOX istatistikleri">${ICONS.chip}</button><button data-v="hasta" title="Hasta · tüm kartlarda yataktaki hasta (YBDB modülündeki bağlantı kullanılır)">${ICONS.user}</button></div>
        <button class="btn ib tgl" id="cHide" aria-pressed="false">${ICONS.eyeOff}</button>
        <button class="btn ib tgl" id="cNet" aria-pressed="false">${ICONS.globe}</button>
        <button class="btn ib" id="cPatients" title="Hasta bilgilerini yenile · YBDB'den yeniden oku (SSH gerekmez)">${ICONS.redo}</button>
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
    layout: $("#cLayout", root), net: $("#cNet", root),
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
      s: null, swVersion: "", rebootRequired: false, rebootReason: "", netOpen,
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
    return `<div class="vt v-${it.kind}${it.dim ? " none" : ""}" title="${esc(it.tip)}">
      <div class="vh"><svg viewBox="0 0 24 24"><path d="${VICON[it.kind]}"/></svg>
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
        : `<span title="${esc(s?.host ?? "")}"><span class="mono">${esc(d.ip)}</span><button class="copy-ip ccopy" data-act="copyip" data-id="${d.id}" title="IP adresini kopyala">${ICONS.copy}</button>${esc(s?.viaText ?? "")}</span>${badge(d.status.text, d.status.sev)}`}</div>
      <div class="cbody">
      <div class="pbody${pat ? "" : " hid"}">${patientHtml(d)}</div>`;
    if (d.bedOnly) return h + `</div>${footHtml(d, disabled)}</div>`;
    const t = tiles(d), mem = s?.mem, disk = s?.disk;
    const diskTip = `Depolama: ${disk?.text ?? DASH}${s?.cardText ? " · " + s.cardText : ""}`
      + (disk && ["warn", "error"].includes(disk.sev) ? "\nDisk dolmak üzere: Cihaz Güncelleme → Hatalı Log'ları temizle / Dosya temizliği ya da Hafızayı genişlet" : "");
    const expand = `<button class="btn mini ib xbtn" data-act="expand" data-id="${d.id}" ${!s || !s.canExpand || busy ? "disabled" : ""} title="${esc(s?.expandTip ?? "Bir kez okunduktan sonra kullanılabilir")}">${ICONS.down}</button>`;
    // Kompakt kart (WPF 1.55–1.58): sıcaklık · çalışma süresi · işlemci / bellek / depolama yüzde + kullanılan/toplam · kareler · AĞ
    h += `<div class="dbody${pat ? " hid" : ""}">
      <div class="trow" title="Sıcaklık · çalışma süresi"><b class="tv ${s?.temp.sev ?? ""}">${esc(s?.temp.text ?? DASH)}</b><span class="muted">·</span><span class="upt">${esc(s?.uptime ?? DASH)}</span></div>
      <div class="res3">
        ${resCell("İşlemci", s?.cpu?.text, s?.cpu?.sev, s?.cpu?.detail, "İşlemci kullanımı (0,5 sn ölçüm). Yük: son 1 dakikanın ortalaması (çekirdek sayısını aşarsa işlemci yetişemiyor).")}
        ${resCell("Bellek", mem?.pctText, mem?.sev, mem?.text, `Bellek (RAM): ${mem?.text ?? DASH}`)}
        ${resCell("Depolama", disk?.pctText, disk?.sev, disk?.text, diskTip, expand)}
      </div>
      ${d.rebootRequired ? `<div class="warnbox w">⚠ ${esc(d.rebootReason || "Değişiklik")} — etkili olması için yeniden başlatma gerekli</div>` : ""}
      <div class="tk tsec">Hizmetler</div>
      <div class="stiles">${["sw", "web", "tui", "cron"].map((k) => tileHtml(d, t[k])).join("")}</div>
      <div class="tk tsec">Sistem</div>
      <div class="stiles">${["login", "hdmi", "usb"].map((k) => tileHtml(d, t[k])).join("")}</div>
      ${netHtml(d)}`;
    return h + `</div></div>${footHtml(d, disabled)}</div>`;
  }

  /** İşlemci / bellek / depolama hücresi: yüzde (eşik rengi) + altında kullanılan / toplam. */
  const resCell = (k, v, sev, sub, tip, extra = "") => `<div class="rc" title="${esc(tip)}"><div class="tk">${k}</div>
    <div class="rv"><b class="tv ${v ? sev ?? "" : ""}">${esc(v || DASH)}</b>${extra}</div><div class="sm muted rs">${esc(sub || "")}</div></div>`;

  /** Kartın kareleri: tıklanabilir olanlar (kurulu, durumu okundu, cihaz çevrimiçi ve boşta) düğmedir. */
  function tiles(d) {
    const s = d.s, t = s?.t ?? {};
    const live = d.online && !d.busy && !busy;
    const none = (label) => ({ state: "unknown", sub: DASH, tip: s ? `${label}: bu bilgi okunamadı (ajanı güncelleyin)` : "Cihaz henüz okunmadı", click: false });
    const mk = (key, label, x) => ({ key, label, ...(x ? { ...x, click: !!x.can && live } : none(label)) });
    const sw = t.sw && { ...t.sw, sub: d.swVersion || (t.sw.missing ? "yok" : DASH),
      tip: t.sw.tip0 + (d.swVersion ? `\nSerialWorkerServiceVol61.dll sürümü ${d.swVersion}` : "") + (t.sw.can ? hint(t.sw.off) : "") };
    return {
      sw: mk("sw", "SW", sw), web: mk("web", "WEB", t.web), tui: mk("tui", "TUI", t.tui), cron: mk("cron", "CRON", t.cron),
      login: mk("login", "LOGIN", t.login), hdmi: mk("hdmi", "HDMI", t.hdmi), usb: mk("usb", "USB", t.usb),
    };
  }

  const tileHtml = (d, x) => {
    const inner = `<b>${x.label}</b><small>${esc(x.sub)}</small>`;
    return x.click
      ? `<button class="stile st-${x.state}" data-act="tog" data-t="${x.key}" data-id="${d.id}" title="${esc(x.tip)}">${inner}</button>`
      : `<span class="stile st-${x.state}" title="${esc(x.tip)}">${inner}</span>`;
  };

  /** Kart başına açılır / kapanır AĞ bölümü (açılışta araç çubuğundaki "Ağ ayrıntıları"na göre). */
  function netHtml(d) {
    const s = d.s;
    let h = `<button class="nethead" data-act="net" data-id="${d.id}" aria-expanded="${d.netOpen}" title="Ağ ayrıntılarını ${d.netOpen ? "gizle" : "göster"}">
      <span class="tk">Ağ</span><span class="sm muted">${esc(s?.viaText ?? "")}</span><span class="chev">${d.netOpen ? "▾" : "▸"}</span></button>`;
    if (!d.netOpen) return h;
    if (!s?.hasNetInfo) h += `<div class="sm muted" style="margin-top:6px">Cihaza bağlanınca arayüz bilgileri (IP, ağ geçidi, MAC, Wi-Fi) burada görünür.</div>`;
    if (s?.hasWifi) {
      h += `<div class="wifi"><div><b class="row tight" style="gap:6px;flex-wrap:nowrap">${ICONS.wifi}${esc(s.ssid)}</b><div class="sm muted">${esc(s.signalText)}</div></div>
        <div class="sigbars">${[5, 8, 12, 16].map((px, i) => `<i style="height:${px}px" class="${i < s.signalBars ? "on" : ""}"></i>`).join("")}</div></div>`;
    }
    for (const n of s?.ifaces ?? []) h += ifaceHtml(n);
    if (s?.excelMacMismatch) h += `<div class="warnbox e">⚠ Excel'deki MAC <span class="mono">${esc(d.excelMac)}</span> hiçbir arayüzle eşleşmiyor</div>`;
    return h;
  }

  /** Cihaz düğmeleri (kart altı ve liste satırı): yenile, güncelle, SerialWorker'ı yeniden başlat, TTY, yeniden başlat. */
  function actsHtml(d, disabled, withRefresh = true) {
    return (withRefresh ? `<button class="btn mini ib" data-act="refresh" data-id="${d.id}" ${disabled} title="Bu cihazı yenile">${ICONS.redo}</button>` : "")
      + `<button class="btn mini ib" data-act="update" data-id="${d.id}" title="İlgili cihazı güncelle (Cihaz Güncelleme'ye geçer)">${ICONS.upload}</button>
      <button class="btn mini ib" data-act="restartSw" data-id="${d.id}" ${disabled} title="SerialWorker servisini yeniden başlat">${ICONS.term}</button>
      <button class="btn mini ib" data-act="tty" data-id="${d.id}" title="TTY ekranını göster · cihazın konsolu (TTY1 / TTY2), TTY1'e yazılabilir">${ICONS.screen}</button>
      <button class="btn mini ib" data-act="reboot" data-id="${d.id}" ${disabled} title="Cihazı yeniden başlat" style="color:var(--error-text)">${ICONS.power}</button>`;
  }

  /** Kart işlemleri: kartın altına sabit (aynı satırdaki kartlar aynı boya uzar). Son okuma saati düğmelerle aynı satırda. */
  function footHtml(d, disabled) {
    const pat = showPatient(d);
    let h = `<div class="foot"><hr><div class="acts">`;
    if (d.bedOnly || pat) h += `<button class="btn mini ib" data-act="refresh" data-id="${d.id}" title="Hasta bilgilerini yenile (YBDB)">${ICONS.redo}</button>`;
    if (!d.bedOnly) h += actsHtml(d, disabled, !pat)
      + `<button class="btn mini ib" data-act="remove" data-id="${d.id}" ${disabled} title="Listeden kaldır (Excel dosyasına dokunulmaz)">${ICONS.trash}</button>`;
    if (!d.bedOnly && d.lastUpdate) h += `<span class="lastread sm muted" title="Son okuma: ${esc(d.lastUpdate)}">${esc(d.lastUpdate)}</span>`;
    return h + `</div></div>`;
  }

  /** Liste görünümünde bir cihaz satırı (WPF DeviceRow). Sütunlar .lgrid ile başlıkla aynı. */
  function rowHtml(d) {
    const s = d.s, disabled = busy ? "disabled" : "";
    const cls = ["lrow lgrid", d.unreachable ? "unreach" : "", d.busy ? "busy" : ""].join(" ");
    let h = `<div class="${cls}" data-id="${d.id}"><span class="bar" style="background:${unitColor(d.room)}"></span>
      <div class="lname"><b title="${esc(d.yatakAdi)}">${esc(d.yatakAdi)}</b><small>${esc(rooms[d.room].title)}</small></div>`;
    if (d.bedOnly) return h + `<div class="lspan sm muted">RasyoBOX yok · Yatak ID <span class="mono">${esc(d.yatakId)}</span></div></div>`;
    const t = tiles(d);
    const val = (v, sev, tip = "") => `<b class="tv ${v ? sev ?? "" : ""}" title="${esc(tip)}">${esc(v || DASH)}</b>`;
    return h + `<div class="lip" title="${esc(s?.host ?? "")}"><span class="mono">${esc(d.ip)}</span><button class="copy-ip ccopy" data-act="copyip" data-id="${d.id}" title="IP adresini kopyala">${ICONS.copy}</button></div>
      <div class="lstate">${badge(d.status.text, d.status.sev)}</div>
      <div class="stiles">${["sw", "web", "tui", "cron"].map((k) => tileHtml(d, t[k])).join("")}</div>
      ${val(s?.temp.text !== DASH ? s?.temp.text : "", s?.temp.sev, "Sıcaklık")}
      ${val(s?.cpu?.text, s?.cpu?.sev, s?.cpu?.detail ?? "")}
      ${val(s?.mem.pctText, s?.mem.sev, s ? "Bellek: " + s.mem.text : "")}
      ${val(s?.disk.pctText, s?.disk.sev, s ? `Depolama: ${s.disk.text}${s.cardText ? " · " + s.cardText : ""}` : "")}
      <span class="upt" title="Çalışma süresi">${esc(s?.uptime ?? DASH)}</span>
      <div class="acts">${actsHtml(d, disabled)}</div></div>`;
  }

  function render() {
    el.summary.textContent = summary();
    el.refresh.disabled = busy || devices.length === 0;
    el.restartAll.disabled = el.rebootAll.disabled = busy || deviceCards().length === 0;
    for (const c of el.view.children) c.setAttribute("aria-selected", String(c.dataset.v === globalView));
    for (const c of el.layout.children) c.setAttribute("aria-selected", String(c.dataset.l === layout));
    const tgl = (b, on, name, what) => { b.setAttribute("aria-pressed", String(on)); b.title = `${name}: ${on ? "açık" : "kapalı"} · ${what}`; };
    tgl(el.auto, autoRefresh, "Otomatik yenile", "seçilen aralıkla tüm cihazları yeniden okur");
    tgl(el.hide, hideNames, "İsimleri gizle", 'hasta adlarını "A*** Y***" olarak gösterir (ekran paylaşımı için)');
    tgl(el.net, netOpen, "Ağ ayrıntıları", "tüm kartlarda AĞ bölümünü gösterir / gizler");
    el.patients.disabled = patientsBusy || devices.length === 0;
    el.pstatus.textContent = patientStatus;

    if (devices.length === 0) {
      el.grid.className = "";
      el.grid.innerHTML = `<section class="card"><div class="placeholder"><h2>Cihaz listesi yüklenmedi</h2>
        <p>Üst banttaki "Cihaz listesi" düğmesinden Excel seçin — tüm modüller aynı listeyi kullanır.</p></div></section>`;
      return;
    }
    const list = layout === "liste";
    let html = list ? `<div class="lhead lgrid"><span></span><span>Yatak / oda</span><span>IP</span><span>Durum</span><span>Hizmetler</span>
      <span>Sıcaklık</span><span>CPU</span><span>RAM</span><span>Disk</span><span>Çalışma</span><span></span></div>` : "";
    for (const rm of rooms) {
      const items = devices.filter((d) => d.room === rm.idx);
      if (items.length === 0) continue;
      const online = items.filter((d) => d.online).length, problems = items.filter((d) => d.unreachable).length;
      const beds = items.filter((d) => d.bedOnly).length, n = items.length - beds;
      html += `<div class="cgroup" data-room="${rm.idx}"><span class="gchip" style="background:${unitColor(rm.idx)};margin:0"></span>${rm.collapsed ? "▸" : "▾"} ${esc(rm.title)}
        <span class="gcount">${[n ? (online > 0 ? `${n} cihaz · ${online} çevrimiçi` : `${n} cihaz`) : "", beds ? `${beds} RasyoBOX'sız yatak` : ""].filter(Boolean).join(" · ")}${problems ? ` · <span class="txt-error">${problems} ulaşılamıyor</span>` : ""}</span></div>`;
      if (!rm.collapsed) html += list ? `<div class="lrows">${items.map(rowHtml).join("")}</div>` : `<div class="cards">${items.map(cardHtml).join("")}</div>`;
    }
    el.grid.className = list ? "ltable" : "";
    el.grid.innerHTML = list ? `<div class="lin">${html}</div>` : html;
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

  /** Komutu hedeflerde çalıştırır (onay ister); başarılı olan cihazların listesini, hiç çalışmadıysa (vazgeçildi) null döner. */
  async function exec(action, list, question, doneText, skipConfirm = false) {
    if (busy || list.length === 0) return null;
    if (!skipConfirm && !confirm(question)) return null;
    if (ctx.requireSsh && !(await ctx.requireSsh())) return null;
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
    if (ok?.length) { await new Promise((r) => setTimeout(r, 2000)); await refresh(deviceCards()); }
  };
  const reboot = (list, question) => exec("reboot", list, question, "Yeniden başlatılıyor");

  async function expandStorage(d) {
    const sizes = d.s?.cardText ? `\n\nŞu an: ${d.s.disk.text} (${d.s.cardText})` : "";
    const ok = await exec("expand", [d],
      `${d.yatakAdi} (${d.ip}) — depolama SD kartın tamamına genişletilsin mi?${sizes}\n\nYeni boyut cihaz yeniden başlatılınca geçerli olur.`,
      "Genişletme tamamlandı");
    if (!ok) return;
    if (ok.length === 0) {
      if (d.lastUpdate && !d.online) toast(`${d.yatakAdi} (${d.ip}) — depolama genişletilemedi: ${d.lastUpdate}`, 6000);
      return;
    }
    d.rebootRequired = true; d.rebootReason = "Depolama genişletildi";
    d.status = { text: "Yeniden başlatma gerekli", sev: "warn" }; d.online = true;
    render();
    // Genişletme ancak yeniden başlatmadan sonra etkili: soru zaten sorulduğu için ikinci onay istenmez
    if (confirm(`${d.yatakAdi} (${d.ip}) — genişletme tamamlandı.\n\nYeni boyutun kullanılabilmesi için cihaz YENİDEN BAŞLATILMALI.\nŞimdi yeniden başlatılsın mı?`))
      await exec("reboot", [d], "", "Yeniden başlatılıyor", true);
  }

  /**
   * Kareye tıklama: SW / WEB / TUI / CRON servisi kalıcı olarak açılır (unmask + enable + start) ya da kapatılır
   * (disable + stop); LOGIN raspi-config ile otomatik girişi değiştirir. Sonra kart yeniden okunur (gerçek son durum).
   */
  async function toggle(d, key) {
    const x = tiles(d)[key];
    if (!x?.click) return;
    const who = `${d.yatakAdi} (${d.ip})`;
    let ok;
    if (key === "login") {
      const off = x.off, opt = x.desktop ? (off ? "B3" : "B4") : (off ? "B1" : "B2");
      ok = await exec("login" + opt, [d],
        `${who} — otomatik giriş ${off ? "KAPATILSIN" : "AÇILSIN"} mı?\n\n`
        + (off ? "Açılışta kullanıcı adı / şifre sorulur." : "Cihaz açılınca SSH kullanıcısıyla otomatik giriş yapılır.")
        + "\nDeğişiklik cihaz yeniden başlatılınca geçerli olur.",
        off ? "Otomatik giriş kapatıldı · yeniden başlatma gerekli" : "Otomatik giriş açıldı · yeniden başlatma gerekli");
      if (ok?.length) { d.rebootRequired = true; d.rebootReason = "Otomatik giriş değişti"; }
    } else {
      const name = { sw: "SerialWorker", web: "RasyoBOX web arayüzü", tui: "swtui (TUI)", cron: "cron" }[key];
      ok = await exec(key + (x.off ? "Off" : "On"), [d],
        (x.off ? `${who} — ${name} KAPATILSIN mı?\n\nServis durdurulur ve cihaz yeniden başlatılınca da kapalı kalır.`
          : `${who} — ${name} AÇILSIN mı?\n\nServis başlatılır ve cihaz her açıldığında otomatik başlar.`)
        + (key === "sw" && x.off ? "\n\nDİKKAT: SerialWorker kapalıyken cihaz hasta verisi GÖNDERMEZ." : ""),
        `${name} ${x.off ? "kapatıldı" : "açıldı"}`);
      if (ok && !ok.length) toast(`${who} — ${name}: ${d.lastUpdate || "işlem başarısız"}`, 6000);
    }
    if (ok) await refresh([d]);
  }

  async function openTtyFor(d) {
    if (ctx.requireSsh && !(await ctx.requireSsh())) return;
    openTty(d.ip, d.yatakAdi !== d.ip ? `${d.yatakAdi} (${d.ip})` : d.ip);
  }

  // ── Elle IP ekleme (WPF ControlViewModel.AddIp): SSH şifresi kayıtlıysa kart hemen okunur ──
  const newIp = $("#cNewIp", root);
  ipFilter(newIp, "ip");
  function addIp() {
    const ip = newIp.value.trim();
    if (!isIpv4(ip)) { toast("Geçerli bir IP girin."); return; }
    if (devices.some((d) => d.ip === ip)) { toast(`${ip} zaten listede.`); return; }
    const d = newDevice({ ip, yatak: "", yatakId: "", mac: "" }, roomFor(""));
    devices.push(d);
    newIp.value = "";
    updateNote(); setStatus(`${ip} eklendi`); render();
    if (ctx.hasSsh?.() && !busy) refresh([d]);
  }
  $("#cAddIp", root).addEventListener("click", addIp);
  newIp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addIp(); } });

  // ── Olaylar ─────────────────────────────────────────────────
  // Yenile: hasta bilgileri (YBDB, SSH gerekmez) ve cihazlar (SSH) birlikte
  const refreshAll = () => { refreshPatients(); refresh(deviceCards()); };
  el.refresh.addEventListener("click", refreshAll);
  el.restartAll.addEventListener("click", () => { const c = deviceCards(); restartSw(c, `${c.length} cihaz için: SerialWorker servisi yeniden başlatılsın mı?`); });
  el.rebootAll.addEventListener("click", () => { const c = deviceCards(); reboot(c, `${c.length} cihaz için: Cihazlar YENİDEN BAŞLATILSIN mı?\n\nCihazlar yaklaşık 1 dakika boyunca veri gönderemez.`); });
  el.view.addEventListener("click", (e) => { const c = e.target.closest("[data-v]"); if (c) setGlobalView(c.dataset.v); });
  el.hide.addEventListener("click", () => { hideNames = !hideNames; storeSet("rbox.ctl.hideNames", hideNames ? "1" : "0"); render(); });
  el.net.addEventListener("click", () => {
    netOpen = !netOpen; storeSet("rbox.ctl.net", netOpen ? "1" : "0");
    devices.forEach((d) => { d.netOpen = netOpen; });
    render();
  });
  el.layout.addEventListener("click", (e) => {
    const c = e.target.closest("[data-l]");
    if (c && c.dataset.l !== layout) { layout = c.dataset.l; storeSet("rbox.ctl.layout", layout); render(); }
  });
  el.patients.addEventListener("click", () => refreshPatients());
  $("#cToggle", root).addEventListener("click", () => { const anyOpen = rooms.some((r) => !r.collapsed); rooms.forEach((r) => (r.collapsed = anyOpen)); render(); });

  el.auto.addEventListener("click", () => { autoRefresh = !autoRefresh; applyTimer(); render(); if (autoRefresh && !busy) refreshAll(); });
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
    if (b.dataset.act === "copyip") { copyIpBtn(d.ip, b); return; }
    if (b.dataset.act === "update") { ctx.openInUpdate?.(d.ip); return; }
    if (b.dataset.act === "tty") { openTtyFor(d); return; }
    if (b.dataset.act === "net") { d.netOpen = !d.netOpen; render(); return; }
    // Hasta tarafı SSH işlemlerinden bağımsız: cihazlar okunurken de kullanılabilir
    if (b.dataset.act === "view") {
      d.view = b.dataset.v; render();
      if (d.view === "hasta" && !patientsLoaded) refreshPatients();
      return;
    }
    if (b.dataset.act === "older") { searchOlder(d, b.dataset.sec); return; }
    if (b.dataset.act === "refresh" && showPatient(d) && layout === "kart") { refreshPatients(); return; }
    if (busy) { toast("Bir işlem sürüyor, bitince tekrar deneyin."); return; }
    switch (b.dataset.act) {
      case "refresh": refresh([d]); break;
      case "restartSw": restartSw([d], `${d.yatakAdi} (${d.ip}) — SerialWorker servisi yeniden başlatılsın mı?`); break;
      case "reboot": reboot([d], `${d.yatakAdi} (${d.ip}) YENİDEN BAŞLATILSIN mı?`); break;
      case "expand": expandStorage(d); break;
      case "tog": toggle(d, b.dataset.t); break;
      case "remove": devices = devices.filter((x) => x !== d); updateNote(); render(); break;
    }
  });

  render();

  return { root, isBusy: () => busy, setDevices };
}
