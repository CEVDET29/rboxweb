// Ping Kontrol modülü: Excel'deki cihazlara ping, SSH portu ve MAC kontrolü (WPF PingView karşılığı).
import { api, stream } from "./api.js";
import { $, $$, esc, debounce, toast, copyText, downloadCsv, ICONS } from "./util.js";

const ROOM_COLORS = ["#3B82F6", "#10B981", "#F59E0B", "#A855F7", "#EC4899", "#14B8A6", "#EF4444", "#84CC16"];
const DASH = "—";

const COLUMNS = [
  { key: "yatak", label: "Yatak", sort: (r) => r.yatak.toLowerCase() },
  { key: "yatakId", label: "Yatak ID", sort: (r) => numOrText(r.yatakId) },
  { key: "ip", label: "IP", sort: (r) => r.ipSort },
  { key: "mac", label: "MAC (Excel)", sort: (r) => r.mac },
  { key: "ping", label: "Ping", sort: (r) => (r.res ? r.res.pingSort : Number.MAX_SAFE_INTEGER) },
  { key: "ssh", label: "SSH", sort: (r) => cell(r, "ssh").text },
  { key: "dmac", label: "Cihaz MAC", sort: (r) => cell(r, "mac").text },
  { key: "vendor", label: "Üretici", sort: (r) => cell(r, "vendor").text },
  { key: "status", label: "Durum", sort: (r) => cell(r, "status").text },
];

const FILTERS = [
  { id: "all", label: "Tümü", cls: "" },
  { id: "ok", label: "Ulaşılan", cls: "ok" },
  { id: "noreply", label: "Yanıt yok", cls: "warn" },
  { id: "mismatch", label: "MAC uyuşmuyor", cls: "err" },
  { id: "problems", label: "Sorunlu", cls: "err" },
];

function numOrText(v) {
  const n = Number(v);
  return v !== "" && Number.isFinite(n) ? n : String(v).toLowerCase();
}

/** Satırın ekranda görünen hücresi (durum: bekliyor / çalışıyor / iptal / sonuç). */
function cell(r, col) {
  const R = r.res;
  switch (r.state) {
    case "pending": return { text: "Bekleniyor", sev: "muted", source: "" };
    case "running":
      if (col === "ping") return { text: "…", sev: "muted" };
      if (col === "status") return { text: "Kontrol ediliyor", sev: "info" };
      return { text: "Bekleniyor", sev: "muted", source: "" };
    case "cancelled":
      if (col === "ping") return { text: "İptal", sev: "muted" };
      if (col === "status") return { text: "İptal edildi", sev: "warn" };
      return { text: DASH, sev: "muted", source: "" };
    case "error":
      if (col === "status") return { text: r.error || "Hata", sev: "error" };
      return { text: DASH, sev: "muted", source: "" };
  }
  if (!R) return col === "status" ? { text: "", sev: "none" } : { text: DASH, sev: "muted", source: "" };
  return R[col];
}

export function createPing(ctx) {
  const root = document.createElement("div");
  root.className = "stack";

  // ── Durum ───────────────────────────────────────────────────
  let rows = [];
  let rooms = [];                     // [{title, idx, collapsed}]
  let fileName = "";
  let running = false;
  let done = 0, total = 0, changedCount = 0;
  let runId = null, abortCtl = null;
  let filter = "all";
  let search = "";
  let sort = { key: null, dir: 1 };
  let lastRunInfo = "";
  let monitorTimer = null;
  let cfg = { checkSsh: false, checkMac: false, checkVendor: false, sshMacFallback: false, monitorIntervalMin: 5, oui: "" };

  // ── İskelet ─────────────────────────────────────────────────
  root.innerHTML = `
    <section class="card">
      <div class="card-h">Kontrol</div>
      <div class="card-b">
        <div class="row">
          <div style="flex:1;min-width:240px"><b id="pFile">Cihaz listesi seçilmedi</b>
            <div class="sm muted" id="pFileSub">Üst banttaki "Cihaz listesi" düğmesinden Excel seçin (tüm modüller aynı listeyi kullanır).</div></div>
          <button class="btn primary" id="pStart">${ICONS.play} <span>Kontrolü başlat</span></button>
          <button class="btn" id="pExport">${ICONS.down} CSV</button>
        </div>
        <div class="progress" style="margin-top:14px"><div id="pBar"></div></div>
        <div class="sm muted" id="pStatus" style="margin-top:6px">Hazır</div>
      </div>
    </section>

    <section class="card">
      <div class="card-h">Kontrol seçenekleri</div>
      <div class="card-b">
        <div class="row" style="gap:22px">
          <label class="chk"><input type="checkbox" id="oSsh"> SSH portu (22)</label>
          <label class="chk"><input type="checkbox" id="oMac"> MAC adresi</label>
          <label class="chk"><input type="checkbox" id="oVendor"> Üretici</label>
          <label class="chk" title="ARP'den MAC okunamazsa SSH ile cihazdan okur"><input type="checkbox" id="oFallback"> SSH ile MAC (yedek)</label>
          <span class="spacer" style="flex:1"></span>
          <label class="chk"><input type="checkbox" id="oMonitor"> <span id="oMonitorText">İzleme modu</span></label>
        </div>
        <div class="sm muted" style="margin-top:10px">SSH kullanıcı / şifre: üst banttaki <b>SSH</b> düğmesinden girilir (tüm modüller için ortak).</div>
      </div>
    </section>

    <div class="tiles" id="pTiles"></div>

    <div class="ping-split" id="pSplit">
    <section class="card">
      <div class="card-b row" style="padding-bottom:12px">
        <input type="search" id="pSearch" placeholder="Ara: oda, yatak, IP, MAC…  (Ctrl+F)" style="width:340px;max-width:100%">
        <span class="sm muted" id="pCount"></span>
        <span class="spacer" style="flex:1"></span>
        <span class="sm muted">Sürekli ping için satıra çift tıklayın</span>
      </div>
      <div class="table-wrap"><table class="fixed" style="min-width:1240px">
        <colgroup><col style="width:120px"><col style="width:80px"><col style="width:130px"><col style="width:150px"><col style="width:96px"><col style="width:80px"><col style="width:170px"><col><col style="width:150px"><col style="width:164px"></colgroup>
        <thead><tr id="pHead"></tr></thead>
        <tbody id="pBody"></tbody>
      </table></div>
    </section>

    <!-- Sürekli ping ("ping ip -t"): her IP bir sekme; ping ajanda atılır, satırlar saniyede bir alınır -->
    <aside class="card lp" id="lpPanel" hidden>
      <div class="card-h row" style="justify-content:space-between">Sürekli ping
        <button class="lp-x" id="lpCloseAll" title="Tüm sürekli pingleri kapat">✕</button></div>
      <div class="lp-tabs" id="lpTabs" role="tablist"></div>
      <div class="lp-bar">
        <span class="lp-stat" id="lpStat"></span>
        <span class="spacer" style="flex:1"></span>
        <button class="btn mini" id="lpToggle"></button>
        <button class="btn mini" id="lpClear" title="Ekranı temizle (ping sürer)">Temizle</button>
        <button class="btn mini icon-only" id="lpCopy" title="Çıktıyı kopyala">${ICONS.copy}</button>
      </div>
      <div class="lp-con" id="lpCon"></div>
      <div class="lp-add">
        <input type="text" id="lpNew" placeholder="Başka IP / ad…" autocomplete="off">
        <button class="btn mini" id="lpAdd">${ICONS.plus} Ekle</button>
      </div>
    </aside>
    </div>`;

  const q = (id) => $("#" + id, root);
  const el = {
    file: q("pFile"), fileSub: q("pFileSub"),
    start: q("pStart"), export: q("pExport"), bar: q("pBar"), status: q("pStatus"),
    ssh: q("oSsh"), mac: q("oMac"), vendor: q("oVendor"), fallback: q("oFallback"),
    monitor: q("oMonitor"), monitorText: q("oMonitorText"),
    tiles: q("pTiles"), search: q("pSearch"), count: q("pCount"), head: q("pHead"), body: q("pBody"),
  };

  // ── Ayarlar (ajanda saklanır) ───────────────────────────────
  async function loadSettings() {
    try { cfg = await api("/api/settings/ping"); } catch { return; }
    el.ssh.checked = cfg.checkSsh; el.mac.checked = cfg.checkMac; el.vendor.checked = cfg.checkVendor;
    el.fallback.checked = cfg.sshMacFallback;
    el.monitorText.textContent = `İzleme modu (her ${cfg.monitorIntervalMin} dk)`;
    updateStatus();
  }

  const saveSettings = debounce(async () => {
    const body = {
      checkSsh: el.ssh.checked, checkMac: el.mac.checked,
      checkVendor: el.vendor.checked, sshMacFallback: el.fallback.checked,
    };
    try {
      await api("/api/settings/ping", { method: "PUT", body });
      Object.assign(cfg, body);
    } catch (e) { toast("Ayarlar kaydedilemedi: " + e.message); }
  }, 500);

  [el.ssh, el.mac, el.vendor, el.fallback].forEach((c) => c.addEventListener("change", () => { syncOptionDeps(); saveSettings(); }));

  function syncOptionDeps() {
    // "SSH ile MAC" yalnızca MAC ve SSH açıkken anlamlı (WPF ile aynı mantık)
    el.fallback.disabled = !(el.mac.checked && el.ssh.checked);
  }

  // ── Liste yükleme ───────────────────────────────────────────
  function setDevices(devices) {
    if (running) { toast("Kontrol sürerken liste değiştirilemez."); return false; }
    const map = new Map();
    rooms = [];
    rows = devices.rows.map((d, id) => {
      const key = d.oda.toLocaleLowerCase("tr");
      if (!map.has(key)) { map.set(key, rooms.length); rooms.push({ title: d.oda || "(Oda belirtilmemiş)", idx: rooms.length, collapsed: false }); }
      return { ...d, id, room: map.get(key), state: "idle", res: null, optKey: null, changed: false, error: "" };
    });
    fileName = devices.fileName;
    lastRunInfo = "";
    el.file.textContent = fileName || "Cihaz listesi seçilmedi";
    el.fileSub.textContent = fileName
      ? `${rows.length} cihaz · ${rooms.length} grup · değiştirmek için üst banttaki "Cihaz listesi" düğmesini kullanın`
      : `Üst banttaki "Cihaz listesi" düğmesinden Excel seçin (tüm modüller aynı listeyi kullanır).`;
    stopMonitorIfEmpty();
    render();
    return true;
  }

  // ── Kontrol çalıştırma ──────────────────────────────────────
  const optKey = () => `${el.ssh.checked}|${el.mac.checked}|${el.fallback.checked}`;

  async function runChecks(list, reset) {
    if (running || list.length === 0) return;
    running = true; done = 0; total = list.length; changedCount = 0; runId = null;
    abortCtl = new AbortController();
    const key = optKey();
    if (reset) list.forEach((r) => { r.state = "pending"; });
    // Seçenekler ve SSH bilgisi kaydedilmeden başlamasın (ajan kayıtlı değerleri okur)
    await saveSettings.flush();
    await ctx.flushSsh?.();
    updateUi(); render();

    try {
      await stream("/api/ping/run", { rows: list.map((r) => ({ id: r.id, ip: r.ip, mac: r.mac })), quiet: !reset }, (m) => onMessage(m, key, reset), abortCtl.signal);
    } catch (e) {
      if (e.name !== "AbortError") {
        toast("Kontrol kesildi: " + e.message);
        list.forEach((r) => { if (r.state === "pending" || r.state === "running") { r.state = "error"; r.error = "Bağlantı koptu"; } });
      }
    } finally {
      const cancelled = abortCtl?.signal.aborted || list.some((r) => r.state === "cancelled");
      running = false; abortCtl = null; runId = null;
      const t = new Date().toLocaleTimeString("tr-TR");
      lastRunInfo = cancelled ? `Son tarama ${t} iptal edildi`
        : `Son tarama ${t}` + (changedCount > 0 ? ` · ${changedCount} cihazda değişiklik` : "");
      updateUi(); render();
    }
  }

  function onMessage(m, key, reset) {
    if (m.type === "start") { runId = m.runId; return; }
    const r = rows[m.id];
    if (m.type === "running") { if (reset && r) r.state = "running"; }
    else if (m.type === "cancelled") { if (r) { r.state = "cancelled"; r.res = null; r.changed = false; done++; } }
    else if (m.type === "item") {
      if (!r) return;
      if (m.error) { r.state = "error"; r.error = m.status.text; r.res = null; r.changed = false; }
      else {
        r.changed = !!r.res && r.optKey === key && r.res.signature !== m.signature;
        if (r.changed) changedCount++;
        r.res = m; r.optKey = key; r.state = "done";
      }
      done++;
    }
    scheduleRender();
  }

  let raf = 0;
  function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; updateUi(); render(); });
  }

  async function startStop() {
    if (running) {
      el.status.textContent = "Durduruluyor…";
      if (runId) api("/api/ping/cancel?id=" + runId, { method: "POST" }).catch(() => {});
      return;
    }
    if (rows.length === 0) { toast("Önce üst banttaki \"Cihaz listesi\" düğmesinden bir Excel dosyası seçin."); return; }
    runChecks(rows, true);
  }
  el.start.addEventListener("click", startStop);

  // ── İzleme modu ─────────────────────────────────────────────
  el.monitor.addEventListener("change", () => {
    clearInterval(monitorTimer); monitorTimer = null;
    if (el.monitor.checked) {
      if (rows.length === 0) { toast("İzleme modu için önce bir Excel dosyası seçin."); el.monitor.checked = false; return; }
      monitorTimer = setInterval(() => { if (!running && rows.length) runChecks(rows, false); }, cfg.monitorIntervalMin * 60_000);
      if (!running) runChecks(rows, false);
    }
    updateStatus();
  });
  function stopMonitorIfEmpty() {
    if (rows.length === 0 && monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; el.monitor.checked = false; }
  }

  // ── Filtre, arama, sıralama ─────────────────────────────────
  const macKey = (s) => (s || "").replace(/[:\-.\s]/g, "").toUpperCase();

  function passes(r) {
    const R = r.res;
    const modeOk = {
      all: true,
      ok: R?.pingOk === true,
      noreply: R?.pingOk === false,
      mismatch: R?.macMatch === false,
      problems: !R || R.hasProblem,
    }[filter];
    if (!modeOk) return false;

    const s = search.trim().toLocaleLowerCase("tr");
    if (!s) return true;
    const dm = R?.mac?.text && R.mac.text !== DASH ? R.mac.text : "";
    const hay = [rooms[r.room].title, r.yatak, r.yatakId, r.ip, r.mac, dm].join("\n").toLocaleLowerCase("tr");
    if (hay.includes(s)) return true;
    const mk = macKey(search);
    return mk.length >= 4 && (macKey(r.mac).includes(mk) || macKey(dm).includes(mk));
  }

  function visibleRows() {
    let list = rows.filter(passes);
    const col = COLUMNS.find((c) => c.key === sort.key);
    list.sort((a, b) => {
      if (a.room !== b.room) return a.room - b.room;          // gruplar Excel sırasında kalır
      if (!col) return a.id - b.id;
      const x = col.sort(a), y = col.sort(b);
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "tr", { numeric: true });
      return c * sort.dir || a.id - b.id;
    });
    return list;
  }

  el.search.addEventListener("input", debounce(() => { search = el.search.value; render(); }, 120));
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && root.offsetParent !== null) {
      e.preventDefault(); el.search.focus(); el.search.select();
    }
  });

  el.head.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-k]"); if (!th) return;
    sort = sort.key === th.dataset.k ? { key: th.dataset.k, dir: -sort.dir } : { key: th.dataset.k, dir: 1 };
    render();
  });

  el.tiles.addEventListener("click", (e) => {
    const t = e.target.closest("[data-f]"); if (!t) return;
    filter = filter === t.dataset.f ? "all" : t.dataset.f; render();
  });

  // ── Çizim ───────────────────────────────────────────────────
  function badge(c) {
    if (!c.text) return "";
    return `<span class="badge sev-${c.sev}">${esc(c.text)}</span>`;
  }

  function stats() {
    return {
      ok: rows.filter((r) => r.res?.pingOk === true).length,
      noreply: rows.filter((r) => r.res?.pingOk === false).length,
      mismatch: rows.filter((r) => r.res?.macMatch === false).length,
      problems: rows.filter((r) => r.res?.hasProblem).length,
    };
  }

  function render() {
    // Üst kutucuklar
    const s = stats();
    const tile = (id, label, n, cls) =>
      `<button class="tile ${cls}" data-f="${id}" aria-pressed="${filter === id}"><div class="n">${n}</div><div class="l">${label}</div></button>`;
    el.tiles.innerHTML =
      tile("all", "Toplam cihaz", rows.length, "") + tile("ok", "Ulaşılan", s.ok, "ok") +
      tile("noreply", "Yanıt yok", s.noreply, "warn") + tile("mismatch", "MAC uyuşmuyor", s.mismatch, "err") +
      tile("problems", "Sorunlu", s.problems, "err");

    // Başlık
    el.head.innerHTML = COLUMNS.map((c) =>
      `<th data-k="${c.key}">${c.label}${sort.key === c.key ? `<span class="arr">${sort.dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("") + "<th></th>";

    const list = visibleRows();
    el.count.textContent = rows.length ? `${list.length} / ${rows.length} satır` : "";

    if (rows.length === 0) {
      el.body.innerHTML = `<tr><td class="empty" colspan="${COLUMNS.length + 1}">Cihaz listesi yok.<br>Yukarıdan bir Excel dosyası seçin ya da buraya sürükleyin.</td></tr>`;
      return;
    }
    if (list.length === 0) {
      el.body.innerHTML = `<tr><td class="empty" colspan="${COLUMNS.length + 1}">Filtreye uyan satır yok.</td></tr>`;
      return;
    }

    let html = "", lastRoom = -1;
    for (const r of list) {
      const room = rooms[r.room];
      if (r.room !== lastRoom) {
        lastRoom = r.room;
        const members = rows.filter((x) => x.room === r.room);
        const prob = members.filter((x) => x.res?.hasProblem).length;
        html += `<tr class="group" data-room="${r.room}" style="cursor:pointer"><td colspan="${COLUMNS.length + 1}">
          <span class="gchip" style="background:${ROOM_COLORS[r.room % ROOM_COLORS.length]}"></span>${room.collapsed ? "▸" : "▾"} ${esc(room.title)}
          <span class="gcount">${members.length} cihaz${prob ? ` · <span class="txt-error">${prob} sorunlu</span>` : ""}</span></td></tr>`;
      }
      if (room.collapsed) continue;

      const ping = cell(r, "ping"), ssh = cell(r, "ssh"), dm = cell(r, "mac"), ven = cell(r, "vendor"), st = cell(r, "status");
      html += `<tr class="item${r.changed ? " changed" : ""}" data-id="${r.id}">
        <td>${esc(r.yatak) || DASH}</td>
        <td>${esc(r.yatakId) || DASH}</td>
        <td class="mono"><span class="ipcell">${esc(r.ip)}<button class="copy-ip" data-act="copy" title="IP adresini kopyala">${ICONS.copy}</button></span></td>
        <td class="mono ${r.macInvalid ? "txt-error" : ""}" title="${r.macInvalid ? "Geçersiz MAC" : ""}">${esc(r.mac) || DASH}</td>
        <td>${badge(ping)}</td>
        <td>${badge(ssh)}</td>
        <td class="mono ${dm.sev === "error" ? "txt-error" : dm.sev === "muted" ? "txt-muted" : ""}">${esc(dm.text)}${dm.source ? `<span class="src">${dm.source}</span>` : ""}</td>
        <td class="${ven.sev === "warn" ? "" : ven.sev === "muted" ? "txt-muted" : ""}">${ven.sev === "warn" ? badge(ven) : esc(ven.text)}</td>
        <td>${badge(st)}${r.changed ? ' <span class="badge sev-warn" title="Önceki taramaya göre değişti">değişti</span>' : ""}</td>
        <td class="actions">
          <button class="btn icon" data-act="live" title="Sürekli ping (ping -t) — sağ panelde açılır">${ICONS.ping}</button>
          <button class="btn icon" data-act="recheck" title="Yeniden kontrol et">${ICONS.redo}</button>
          <button class="btn icon" data-act="copy" title="IP'yi kopyala">${ICONS.copy}</button>
          <button class="btn icon" data-act="ssh" title="SSH ile bağlan (sunucuda terminal açar)">${ICONS.term}</button>
          <button class="btn icon" data-act="web" title="Tarayıcıda aç">${ICONS.globe}</button>
        </td></tr>`;
    }
    el.body.innerHTML = html;
  }

  el.body.addEventListener("click", async (e) => {
    const g = e.target.closest("tr.group");
    if (g) { const room = rooms[+g.dataset.room]; room.collapsed = !room.collapsed; render(); return; }

    const btn = e.target.closest("[data-act]"); if (!btn) return;
    const r = rows[+btn.closest("tr").dataset.id];
    switch (btn.dataset.act) {
      case "live": openLive(r.ip, r.yatak); break;
      case "recheck": if (!running) runChecks([r], true); break;
      case "copy":
        try { await copyText(r.ip); toast("IP kopyalandı: " + r.ip); } catch { toast("Kopyalanamadı"); }
        break;
      case "ssh":
        try { await api("/api/ping/ssh", { method: "POST", body: { ip: r.ip } }); } catch (err) { toast("SSH başlatılamadı: " + err.message); }
        break;
      case "web": window.open(`http://${r.ip}/`, "_blank", "noopener"); break;
    }
  });

  // Satıra çift tıklama: o IP için sürekli ping (düğmelerin üzerinde değilse)
  el.body.addEventListener("dblclick", (e) => {
    if (e.target.closest("[data-act]")) return;
    const tr = e.target.closest("tr.item"); if (!tr) return;
    const r = rows[+tr.dataset.id];
    window.getSelection()?.removeAllRanges();          // çift tıklamanın seçtiği metni bırak
    openLive(r.ip, r.yatak);
  });

  // ── Sürekli ping paneli ─────────────────────────────────────
  const LP_MAX_LINES = 3000;
  const lp = {
    panel: q("lpPanel"), split: q("pSplit"), tabs: q("lpTabs"), stat: q("lpStat"), toggle: q("lpToggle"),
    clear: q("lpClear"), copy: q("lpCopy"), con: q("lpCon"), input: q("lpNew"), add: q("lpAdd"), closeAll: q("lpCloseAll"),
  };
  let live = [];              // [{id, ip, label, lines:[{time,text,kind}], cursor, running, up, sent, received, lost, lastMs, minMs, maxMs, avgMs}]
  let activeLive = null, pollTimer = null, polling = false;

  async function openLive(ip, label = "") {
    ip = String(ip || "").trim();
    if (!ip) return;
    const existing = live.find((s) => s.ip === ip);
    if (existing) {
      activeLive = existing.id;
      if (!existing.running) await liveAction("resume", existing);
      renderLive(true);
      return;
    }
    try {
      const r = await api("/api/ping/live/start", { method: "POST", body: { ip } });
      live.push({ id: r.id, ip, label, lines: [], cursor: 0, running: true, up: null, sent: 0, received: 0, lost: 0 });
      activeLive = r.id;
      renderLive(true);
      ensurePolling();
    } catch (e) { toast(e.message, 4000); }
  }

  async function liveAction(kind, s) {
    try { await api(`/api/ping/live/${kind}`, { method: "POST", body: { id: s.id } }); } catch (e) { toast(e.message, 4000); }
    if (kind === "resume") { s.running = true; ensurePolling(); }
  }

  function closeLive(s) {
    liveAction("remove", s);
    live = live.filter((x) => x !== s);
    if (activeLive === s.id) activeLive = live.at(-1)?.id ?? null;
    renderLive(true);
  }

  function ensurePolling() {
    if (!pollTimer) pollTimer = setInterval(pollLive, 1000);
  }

  async function pollLive() {
    if (polling) return;
    if (live.length === 0) { clearInterval(pollTimer); pollTimer = null; return; }
    polling = true;
    try {
      const cursors = Object.fromEntries(live.map((s) => [s.id, s.cursor]));
      const r = await api("/api/ping/live/poll", { method: "POST", body: { cursors } });
      let activeNew = [];
      for (const u of r.sessions) {
        const s = live.find((x) => x.id === u.id); if (!s) continue;
        if (u.gone) { s.running = false; continue; }
        Object.assign(s, { running: u.running, up: u.up, sent: u.sent, received: u.received, lost: u.lost, lastMs: u.lastMs, minMs: u.minMs, maxMs: u.maxMs, avgMs: u.avgMs });
        if (u.lines.length) {
          s.cursor = u.lines.at(-1).seq;
          s.lines.push(...u.lines);
          if (s.lines.length > LP_MAX_LINES) s.lines.splice(0, s.lines.length - LP_MAX_LINES);
          if (s.id === activeLive) activeNew = u.lines;
        }
      }
      renderLive(false, activeNew);
    } catch { /* ajan geçici olarak yanıt vermedi: bir sonraki turda yeniden denenir */ }
    finally { polling = false; }
  }

  const lineHtml = (l) => `<div class="${l.kind}"><span class="t">${esc(l.time)}</span>${esc(l.text) || "&nbsp;"}</div>`;

  /** full: sekmeler ve konsol baştan çizilir; değilse yalnızca yeni satırlar eklenir. */
  function renderLive(full, newLines = []) {
    const open = live.length > 0;
    lp.panel.hidden = !open;
    lp.split.classList.toggle("live", open);
    if (!open) return;
    const s = live.find((x) => x.id === activeLive) ?? live[0];
    activeLive = s.id;

    lp.tabs.innerHTML = live.map((x) => `<div class="lp-tab" role="tab" data-lid="${x.id}" aria-selected="${x.id === s.id}"
        title="${esc(x.label ? `${x.label} · ${x.ip}` : x.ip)}">
        <span class="lp-dot ${x.up === true ? "up" : x.up === false ? "down" : ""}${x.running ? "" : " off"}"></span>${esc(x.ip)}
        <button class="lp-x" data-close="${x.id}" title="Kapat">✕</button></div>`).join("");

    const pct = s.sent ? Math.round((100 * s.lost) / s.sent) : 0;
    lp.stat.innerHTML = s.sent
      ? `<b class="${s.up ? "txt-ok" : "txt-error"}">${s.up ? "Yanıt veriyor" : "Yanıt yok"}</b> · Giden ${s.sent} · Alınan ${s.received} · <span class="${s.lost ? "txt-error" : ""}">Kayıp ${s.lost} (%${pct})</span>${s.avgMs != null ? ` · ort. ${s.avgMs} ms` : ""}`
      : `<span class="muted">${s.running ? "Başlıyor…" : "Durduruldu"}</span>`;
    lp.toggle.textContent = s.running ? "Durdur" : "Devam";
    lp.toggle.title = s.running ? "Ctrl+C gibi: durdurur ve istatistiği yazar" : "Aynı adrese yeniden ping atmaya başlar";

    const atBottom = lp.con.scrollHeight - lp.con.scrollTop - lp.con.clientHeight < 40;
    if (full || lp.con.dataset.lid !== String(s.id)) {
      lp.con.dataset.lid = s.id;
      lp.con.innerHTML = s.lines.map(lineHtml).join("");
      lp.con.scrollTop = lp.con.scrollHeight;
    } else if (newLines.length) {
      lp.con.insertAdjacentHTML("beforeend", newLines.map(lineHtml).join(""));
      while (lp.con.childElementCount > LP_MAX_LINES) lp.con.firstElementChild.remove();
      if (atBottom) lp.con.scrollTop = lp.con.scrollHeight;     // kullanıcı yukarı kaydırdıysa yerinde kalsın
    }
  }

  lp.tabs.addEventListener("click", (e) => {
    const x = e.target.closest("[data-close]");
    if (x) { const s = live.find((v) => v.id === +x.dataset.close); if (s) closeLive(s); return; }
    const t = e.target.closest("[data-lid]");
    if (t) { activeLive = +t.dataset.lid; renderLive(true); }
  });
  lp.toggle.addEventListener("click", async () => {
    const s = live.find((x) => x.id === activeLive); if (!s) return;
    await liveAction(s.running ? "stop" : "resume", s);
    setTimeout(pollLive, 300);
  });
  lp.clear.addEventListener("click", () => {
    const s = live.find((x) => x.id === activeLive); if (!s) return;
    s.lines = []; renderLive(true);
  });
  lp.copy.addEventListener("click", async () => {
    const s = live.find((x) => x.id === activeLive); if (!s) return;
    try { await navigator.clipboard.writeText(s.lines.map((l) => `[${l.time}] ${l.text}`).join("\r\n")); toast("Çıktı kopyalandı"); }
    catch { toast("Kopyalanamadı"); }
  });
  lp.closeAll.addEventListener("click", () => { [...live].forEach(closeLive); });
  const addFromInput = () => { const v = lp.input.value.trim(); if (v) { openLive(v); lp.input.value = ""; } };
  lp.add.addEventListener("click", addFromInput);
  lp.input.addEventListener("keydown", (e) => { if (e.key === "Enter") addFromInput(); });

  el.export.addEventListener("click", () => {
    const list = visibleRows();
    if (!list.length) { toast("Dışa aktarılacak satır yok."); return; }
    const headers = ["ODA ADI", "Yatak ADI", "YATAK ID", "IP", "MAC (Excel)", "Ping", "SSH", "Cihaz MAC", "MAC kaynağı", "Üretici", "Durum"];
    const data = list.map((r) => [
      rooms[r.room].title, r.yatak, r.yatakId, r.ip, r.mac,
      cell(r, "ping").text, cell(r, "ssh").text, cell(r, "mac").text, cell(r, "mac").source || "",
      cell(r, "vendor").text, cell(r, "status").text + (r.changed ? " (değişti)" : ""),
    ]);
    const base = (fileName || "PingKontrol").replace(/\.[^.]+$/, "");
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    downloadCsv(`${base}_sonuc_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.csv`, headers, data);
    el.status.textContent = `${list.length} satır dışa aktarıldı`;
  });

  // ── Durum çubuğu ────────────────────────────────────────────
  function updateStatus() {
    const parts = [];
    if (running) parts.push(`${done}/${total} tamamlandı`);
    else if (lastRunInfo) parts.push(lastRunInfo);
    if (el.monitor.checked) parts.push(`İzleme açık · her ${cfg.monitorIntervalMin} dk`);
    if (cfg.oui) parts.push(cfg.oui);
    el.status.textContent = parts.length ? parts.join("  ·  ") : "Hazır";
  }

  function updateUi() {
    el.start.innerHTML = running ? `${ICONS.stop} <span>Durdur</span>` : `${ICONS.play} <span>Kontrolü başlat</span>`;
    el.start.classList.toggle("danger", running);
    el.start.classList.toggle("primary", !running);
    el.bar.style.width = total ? `${Math.round((done / total) * 100)}%` : "0";
    updateStatus();
  }

  syncOptionDeps();
  render();

  return {
    root,
    onShow: loadSettings,
    isBusy: () => running,
    setDevices,
  };
}
