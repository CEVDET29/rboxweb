// Cihaz Kontrol modülü: cihazların anlık durumu (sıcaklık, bellek, depolama, SerialWorker, USB, ağ) ve toplu işlemler.
// WPF ControlView / ControlDevice / ControlViewModel karşılığı. SSH ile okuma ajandadadır; biçimlendirme burada.
import { api, stream } from "./api.js";
import { $, $$, esc, toast, unitColor, ICONS } from "./util.js";

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
    </section>

    <div id="cGrid"></div>
    <div class="sm muted" style="padding:0 4px" id="cStatus">Hazır  ·  SSH bilgileri üst banttaki SSH düğmesinden alınır.</div>`;

  const el = {
    summary: $("#cSummary", root), refresh: $("#cRefresh", root), auto: $("#cAuto", root), secs: $("#cSecs", root),
    note: $("#cNote", root), grid: $("#cGrid", root), status: $("#cStatus", root),
    restartAll: $("#cRestartAll", root), rebootAll: $("#cRebootAll", root),
  };

  const setStatus = (t) => { statusText = t; el.status.textContent = `${t}  ·  SSH bilgileri üst banttaki SSH düğmesinden alınır.`; };

  // ── Cihaz listesi ───────────────────────────────────────────
  function newDevice(id, r, room) {
    return {
      id, ip: r.ip, room, yatakAdi: (r.yatak || "").trim() || r.ip, yatakId: r.yatakId || "",
      excelMac: macValid(macDisplay(r.mac)) ? macDisplay(r.mac) : "",
      status: { text: "Bekleniyor", sev: "muted" }, online: false, unreachable: false, busy: false, lastUpdate: "",
      s: null, swVersion: "", rebootRequired: false,
    };
  }

  function setDevices(list) {
    if (busy) return false;
    devices = []; rooms = [];
    const seen = new Set(), map = new Map();
    for (const r of list.rows) {
      const ip = (r.ip || "").trim();
      const key = (r.oda || "").trim().toLocaleLowerCase("tr");
      if (!map.has(key)) { map.set(key, rooms.length); rooms.push({ title: (r.oda || "").trim() || "(Oda belirtilmemiş)", idx: rooms.length, collapsed: false }); }
      if (!isIpv4(ip) || seen.has(ip)) continue;
      seen.add(ip);
      devices.push(newDevice(devices.length, { ...r, ip }, map.get(key)));
    }
    el.note.textContent = devices.length ? `${devices.length} cihaz · ${new Set(devices.map((d) => d.room)).size} oda` : "";
    render();
    return true;
  }

  // ── Çizim ───────────────────────────────────────────────────
  function summary() {
    if (devices.length === 0) return "Cihaz listesi yüklenmedi";
    const online = devices.filter((d) => d.online).length;
    const sw = devices.filter((d) => d.s?.swSev === "ok").length;
    return `${online} / ${devices.length} çevrimiçi · SerialWorker ${sw} çalışıyor`;
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

  function cardHtml(d) {
    const s = d.s;
    const cls = ["dcard", d.unreachable ? "unreach" : "", d.busy ? "busy" : ""].join(" ");
    const disabled = busy ? "disabled" : "";
    let h = `<div class="${cls}" data-id="${d.id}">
      <div class="head">
        <span class="bar" style="background:${unitColor(d.room)}"></span>
        <div style="min-width:0;flex:1"><div class="title" title="${esc(d.yatakAdi)}">${esc(d.yatakAdi)}</div><div class="sub">${esc(rooms[d.room].title)}</div></div>
        ${badge(d.status.text, d.status.sev)}
      </div>
      <div class="ipline"><span><span class="mono">${esc(d.ip)}</span> ${esc(s?.viaText ?? "")}</span><span>${esc(s?.host ?? "")}</span></div>
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

    h += `<hr>${d.lastUpdate ? `<div class="sm muted" style="margin-bottom:6px">Son okuma ${esc(d.lastUpdate)}</div>` : ""}
      <div class="acts">
        <button class="btn mini" data-act="refresh" data-id="${d.id}" ${disabled} title="Bu cihazı yenile">${ICONS.redo}</button>
        <button class="btn mini" data-act="update" data-id="${d.id}" title="İlgili cihazı güncelle (Cihaz Güncelleme'ye geçer)">${ICONS.upload}</button>
        <button class="btn mini" data-act="restartSw" data-id="${d.id}" ${disabled} title="SerialWorker servisini yeniden başlat">${ICONS.term}</button>
        <button class="btn mini" data-act="reboot" data-id="${d.id}" ${disabled} title="Cihazı yeniden başlat" style="color:var(--error-text)">⏻</button>
      </div></div>`;
    return h;
  }

  function render() {
    el.summary.textContent = summary();
    el.refresh.disabled = busy || devices.length === 0;
    el.restartAll.disabled = el.rebootAll.disabled = busy || devices.length === 0;

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
      html += `<div class="cgroup" data-room="${rm.idx}"><span class="gchip" style="background:${unitColor(rm.idx)};margin:0"></span>${rm.collapsed ? "▸" : "▾"} ${esc(rm.title)}
        <span class="gcount">${online > 0 ? `${items.length} cihaz · ${online} çevrimiçi` : `${items.length} cihaz`}${problems ? ` · <span class="txt-error">${problems} ulaşılamıyor</span>` : ""}</span></div>`;
      if (!rm.collapsed) html += `<div class="cards">${items.map(cardHtml).join("")}</div>`;
    }
    el.grid.innerHTML = html;
  }

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
    if (ok.length) { await new Promise((r) => setTimeout(r, 2000)); await refresh(devices); }
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
  el.refresh.addEventListener("click", () => refresh(devices));
  el.restartAll.addEventListener("click", () => restartSw(devices, `${devices.length} cihaz için: SerialWorker servisi yeniden başlatılsın mı?`));
  el.rebootAll.addEventListener("click", () => reboot(devices, `${devices.length} cihaz için: Cihazlar YENİDEN BAŞLATILSIN mı?\n\nCihazlar yaklaşık 1 dakika boyunca veri gönderemez.`));
  $("#cToggle", root).addEventListener("click", () => { const anyOpen = rooms.some((r) => !r.collapsed); rooms.forEach((r) => (r.collapsed = anyOpen)); render(); });

  el.auto.addEventListener("change", () => { autoRefresh = el.auto.checked; applyTimer(); if (autoRefresh && !busy) refresh(devices); });
  el.secs.addEventListener("change", () => { refreshSeconds = Number(el.secs.value); applyTimer(); });
  function applyTimer() {
    clearInterval(timer); timer = null;
    if (autoRefresh) timer = setInterval(() => { if (!busy && devices.length) refresh(devices); }, Math.max(10, refreshSeconds) * 1000);
  }

  el.grid.addEventListener("click", (e) => {
    const g = e.target.closest(".cgroup");
    if (g) { const rm = rooms[+g.dataset.room]; rm.collapsed = !rm.collapsed; render(); return; }
    const b = e.target.closest("[data-act]"); if (!b) return;
    const d = dev(+b.dataset.id); if (!d) return;
    if (b.dataset.act === "update") { ctx.openInUpdate?.(d.ip); return; }
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
