// TCP modülü: ajanın bulunduğu bilgisayarda bir portu dinler (sunucu) ya da listedeki cihazlara bağlanır (istemci);
// gelen bağlantıları ve veriyi canlı gösterir (karşıya hiçbir şey gönderilmez). İş ajandaki TcpSession'da (WPF ile
// aynı kod; JSON ayıklama ve biçimlendirme de orada). Sayfa yeni satırları saniyede bir yoklar (sürekli ping gibi).
import { api } from "./api.js";
import { $, $$, esc, storeGet, storeSet, toast, copyText, ipFilter, ICONS } from "./util.js";

const MAX_LINES = 3000;
const QUICK = [["2575", "HL7 2575"], ["4000", "4000"], ["5000", "5000"], ["6000", "6000"], ["7000", "7000"], ["8000", "8000"]];
const VIEWS = [["text", "Metin", "Gelen veriyi metin olarak göster (kontrol karakterleri <VT> <FS> gibi yazılır)"],
               ["hex", "Hex", "Gelen veriyi onaltılık (hex) döküm olarak göster"],
               ["json", "JSON", "Veri JSON ise: yanda her gelen JSON biçimlendirilmiş olarak gösterilir"]];

const fmtBytes = (n) => (n < 1024 ? `${n} bayt` : n < 1048576 ? `${(n / 1024).toFixed(1).replace(/\.0$/, "")} KB` : `${(n / 1048576).toFixed(1).replace(/\.0$/, "")} MB`);

// ── Cihaz süzgeci (WPF'teki TcpFilter ile aynı kural) ─────────
const remoteIp = (remote) => { const i = remote.lastIndexOf(":"); return i > 0 ? remote.slice(0, i) : remote; };
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** Satır seçili cihaza ait mi? Cihazın kendi satırları; oturumun genel satırları ve listede olmayan kaynaklar da gösterilir. */
function matches(l, ip, listIps) {
  const from = remoteIp(l.remote);
  if (from === ip) return true;
  if (l.kind === "data") return false;
  return from === "" || !listIps.has(from);
}

export function createTcp() {
  const root = document.createElement("div");
  root.className = "stack pstack";

  let session = null;        // { id, cursor, running, endpoint, active, total, bytes, mode }
  let lines = [];            // [{ time, remote, kind, text, hex, bytes, json }]
  let mode = storeGet("rbox.tcp.mode") === "connect" ? "connect" : "listen";
  let view = storeGet("rbox.tcp.view") || (storeGet("rbox.tcp.hex") === "1" ? "hex" : "text");
  if (!VIEWS.some(([v]) => v === view)) view = "text";
  let excelRows = [];
  let manual = storeGet("rbox.tcp.hosts", "").split("\n").filter((x) => IPV4.test(x));   // elle eklenen IP'ler
  // Cihaz listesi: istemcide Excel + elle eklenenler, dinleyicide porta bağlanan cihazlar (kendiliğinden eklenir).
  // devices, seçili modun listesini gösterir: [{ ip, label, manual, count, state, error }]
  let clientDevices = [], listenDevices = [];
  const listenActive = new Map();     // dinleyicide IP → açık bağlantı sayısı
  let devices = [];
  let listIps = new Set();
  let selected = "";         // "" = hepsi
  let pollTimer = null, polling = false, starting = false;

  root.innerHTML = `
    <section class="card">
      <div class="card-h row" style="justify-content:space-between">TCP
        <span class="tcp-state" id="tState"><i></i><span>Durduruldu</span></span></div>
      <div class="card-b">
        <!-- Tek satır: mod · bağlantı bilgileri · başlat/durdur | görünüm · kopyala · temizle (dar ekranda kayar) -->
        <div class="row tight">
          <span class="chips" id="tMode" role="radiogroup">
            <button class="chip" role="radio" data-mode="listen" title="Sunucu: ajanın bilgisayarı bir portu dinler; cihazlar buraya bağlanır">Dinleyici</button>
            <button class="chip" role="radio" data-mode="connect" title="Ajanın bilgisayarı listedeki cihazlara (Excel + elle eklenen IP'ler) girilen porttan bağlanır">İstemci</button>
          </span>
          <span class="tcp-info" id="tHint" tabindex="0">i</span>
          <span class="row tight" id="tListen">
            <label class="sm muted" for="tPort">Port</label>
            <input type="text" id="tPort" class="mono" style="width:96px" maxlength="5" inputmode="numeric" autocomplete="off" list="tPorts"
              title="Dinlenecek TCP portu (1-65535). Listeden sık kullanılanlar seçilebilir; Enter ile başlatılır.">
            <label class="sm muted" for="tBind" style="margin-left:6px">Adres</label>
            <select id="tBind" style="width:240px" title="Hangi ağ kartında dinleneceği. 0.0.0.0 = bu bilgisayarın tüm adresleri."></select>
            <button class="btn icon" id="tRefresh" title="Ağ kartı listesini yenile">${ICONS.redo}</button>
          </span>
          <span class="row tight" id="tConnect" hidden>
            <label class="sm muted" for="tCPort">Port</label>
            <input type="text" id="tCPort" class="mono" style="width:96px" maxlength="5" inputmode="numeric" autocomplete="off" list="tPorts"
              title="Cihazların portu (1-65535). Listeden sık kullanılanlar seçilebilir; Enter ile bağlanılır.">
            <span class="sm muted"><b id="tDevCount">0</b> cihaza bağlanılacak</span>
          </span>
          <datalist id="tPorts"></datalist>
          <button class="btn primary" id="tStart">${ICONS.play} Başlat</button>
          <button class="btn" id="tStop">${ICONS.stop} Durdur</button>
          <span class="spacer" style="flex:1"></span>
          <span class="chips" id="tView" role="radiogroup" title="Gelen verinin gösterimi">
            ${VIEWS.map(([v, l, t]) => `<button class="chip" role="radio" data-view="${v}" title="${esc(t)}">${l}</button>`).join("")}
          </span>
          <button class="btn" id="tCopy" title="Ekrandakini panoya kopyala (JSON görünümünde biçimlendirilmiş JSON'lar)">${ICONS.copy} Kopyala</button>
          <button class="btn" id="tClear" title="Ekranı temizle (bağlantı sürer)">${ICONS.trash} Temizle</button>
        </div>
      </div>
    </section>
    <div class="tcp-grid" id="tGrid">
      <section class="card tcp-dev">
        <div class="card-h">Cihazlar</div>
        <div class="card-b">
          <div class="row tight" id="tAddRow" style="flex-wrap:nowrap;margin-bottom:10px">
            <input type="text" id="tNewIp" class="mono" style="flex:1;min-width:0" autocomplete="off" placeholder="IP ekle…"
              title="Listeye IP ekle (ör. 172.16.154.20) · Enter. Çalışırken eklenirse hemen bağlanılır.">
            <button class="btn mini" id="tAddIp">${ICONS.plus} Ekle</button>
          </div>
          <div class="tcp-devlist" id="tDevs" role="listbox"
            title="Bir cihaza tıklayınca yalnızca onun verisi gösterilir; yeniden tıklayınca seçim kalkar ve tüm cihazların verisi görünür. Nokta: yeşil bağlı, gri bağlanıyor / bağlantı kapalı, kırmızı bağlanılamadı. Sayı: o cihazdan gelen veri parçası."></div>
          <p class="sm muted" id="tNoList" style="margin:10px 0 0"></p>
        </div>
      </section>
      <section class="card">
        <div class="card-h">Gelen veri <span class="tcp-filter" id="tFilter"></span></div>
        <div class="card-b"><div class="tcp-con" id="tCon"></div></div>
      </section>
      <section class="card" id="tJsonCard" hidden>
        <div class="card-h">JSON</div>
        <div class="card-b"><div class="tcp-con tcp-json" id="tJson"></div></div>
      </section>
    </div>`;

  const q = (id) => $("#" + id, root);
  const el = {
    mode: q("tMode"), listen: q("tListen"), connect: q("tConnect"),
    port: q("tPort"), bind: q("tBind"), refresh: q("tRefresh"), cport: q("tCPort"), devCount: q("tDevCount"),
    newIp: q("tNewIp"), addIp: q("tAddIp"), addRow: q("tAddRow"),
    start: q("tStart"), stop: q("tStop"), view: q("tView"), copy: q("tCopy"), clear: q("tClear"),
    hint: q("tHint"), state: q("tState"), grid: q("tGrid"), devs: q("tDevs"), noList: q("tNoList"), filter: q("tFilter"),
    con: q("tCon"), jsonCard: q("tJsonCard"), json: q("tJson"),
  };

  // Port listesi: sabit portlar + elle girilip başlatılmış portlar (son kullanılan başta, en fazla 10)
  const MAX_CUSTOM_PORTS = 10;
  let customPorts = storeGet("rbox.tcp.ports", "").split(",").filter((p) => /^\d{1,5}$/.test(p) && +p >= 1 && +p <= 65535 && !QUICK.some(([v]) => v === p));
  const renderPorts = () => {
    q("tPorts").innerHTML = [...QUICK, ...customPorts.map((p) => [p, p])].map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
  };
  const rememberPort = (port) => {
    const p = String(port);
    if (QUICK.some(([v]) => v === p)) return;
    customPorts = [p, ...customPorts.filter((x) => x !== p)].slice(0, MAX_CUSTOM_PORTS);
    storeSet("rbox.tcp.ports", customPorts.join(","));
    renderPorts();
  };
  renderPorts();

  el.port.value = storeGet("rbox.tcp.port", "");
  el.cport.value = storeGet("rbox.tcp.cport", "");

  // ── Adresler ────────────────────────────────────────────────
  async function loadAddresses() {
    const keep = el.bind.value || storeGet("rbox.tcp.bind", "0.0.0.0");
    try {
      const r = await api("/api/tcp/addresses");
      el.bind.innerHTML = r.addresses.map((a) => `<option value="${esc(a.address)}">${esc(a.label)}</option>`).join("");
    } catch (e) {
      el.bind.innerHTML = `<option value="0.0.0.0">Tüm ağ kartları (0.0.0.0)</option>`;
      toast(e.message, 4000);
    }
    el.bind.value = [...el.bind.options].some((o) => o.value === keep) ? keep : "0.0.0.0";
  }

  // ── Başlat / durdur / yoklama ───────────────────────────────
  const portOf = (input) => {
    const v = input.value.trim();
    const n = /^\d{1,5}$/.test(v) ? Number(v) : 0;
    return n >= 1 && n <= 65535 ? n : 0;
  };
  const canStart = () => mode === "listen" ? !!portOf(el.port) : !!portOf(el.cport) && clientDevices.length > 0;

  async function start() {
    if (!canStart() || session?.running || starting) return;
    starting = true; renderState();
    try {
      let body;
      if (mode === "listen") {
        body = { mode, port: portOf(el.port), bind: el.bind.value || "0.0.0.0" };
        storeSet("rbox.tcp.port", String(body.port));
        storeSet("rbox.tcp.bind", body.bind);
      } else {
        body = { mode, hosts: clientDevices.map((d) => d.ip), port: portOf(el.cport) };
        storeSet("rbox.tcp.cport", String(body.port));
      }
      const r = await api("/api/tcp/start", { method: "POST", body });
      rememberPort(body.port);
      if (mode === "listen") { listenDevices = []; listenActive.clear(); showDevices(); }   // yeni dinleme: liste baştan
      session = { id: r.id, cursor: 0, running: true, mode, port: body.port, endpoint: mode === "listen" ? `${body.bind}:${body.port}` : "", active: 0, total: 0, bytes: 0, hosts: [] };
      if (!pollTimer) pollTimer = setInterval(poll, 1000);
      await poll();
    } catch (e) {
      toast(e.message, 6000);
    } finally {
      starting = false; renderState();
    }
  }

  async function stop() {
    if (!session?.running) return;
    try { await api("/api/tcp/stop", { method: "POST", body: { id: session.id } }); } catch (e) { toast(e.message, 4000); }
    setTimeout(poll, 250);
  }

  async function poll() {
    if (polling || !session) return;
    polling = true;
    try {
      const u = await api("/api/tcp/poll", { method: "POST", body: { id: session.id, after: session.cursor } });
      if (u.gone) {
        session.running = false;
      } else {
        Object.assign(session, { running: u.running, endpoint: u.endpoint, active: u.active, total: u.total, bytes: u.bytes, hosts: u.hosts || [] });
        if (u.lines.length) {
          session.cursor = u.lines.at(-1).seq;
          append(u.lines);
        }
      }
      // Durdu ve son satırlar alındı: ajan oturumu kendisi siler, yoklama da biter
      if (!session.running && (u.gone || u.lines.length === 0)) { clearInterval(pollTimer); pollTimer = null; }
      applyHostStates();
      renderState();
    } catch { /* ajan geçici olarak yanıt vermedi: bir sonraki turda yeniden denenir */ }
    finally { polling = false; }
  }

  // ── Cihaz listesi ───────────────────────────────────────────
  function setDevices(d) {
    excelRows = d.rows;
    rebuildClient();
    return true;
  }

  /** Excel'deki oda · yatak adı (dinleyicide bağlanan cihazın yanında da gösterilir). */
  const excelLabel = (ip) => {
    const r = excelRows.find((x) => String(x.ip || "").trim() === ip);
    return r ? [r.oda, r.yatak].filter(Boolean).join(" · ") : "";
  };

  /** İstemci listesini Excel + elle eklenenlerden kurar; bağlantı durumu korunur, çalışıyorsa bağlantılar listeye uyar. */
  function rebuildClient() {
    const old = new Map(clientDevices.map((x) => [x.ip, x]));
    const seen = new Set();
    clientDevices = [];
    const add = (ip, label, isManual) => {
      if (!IPV4.test(ip) || seen.has(ip)) return;
      seen.add(ip);
      const o = old.get(ip);
      clientDevices.push({ ip, label, manual: isManual, count: 0, state: o?.state ?? null, error: o?.error ?? null });
    };
    for (const r of excelRows) add(String(r.ip || "").trim(), excelLabel(String(r.ip || "").trim()), false);
    for (const ip of manual) add(ip, "elle eklendi", true);
    syncHosts();
    showDevices();
  }

  /** Ekrandaki listeyi seçili modunkiyle doldurur (seçili cihaz listede yoksa seçim kalkar). */
  function showDevices() {
    devices = mode === "listen" ? listenDevices : clientDevices;
    listIps = new Set(devices.map((d) => d.ip));
    if (selected && !listIps.has(selected)) selected = "";
    recount();
    renderDevices();
    renderAll();
    renderState();
  }

  /** Dinleyicide bağlanan / veri gönderen cihazı listeye ekler, bağlantı durumunu günceller. */
  function trackListen(l) {
    const ip = remoteIp(l.remote);
    if (!ip) return false;
    let d = listenDevices.find((x) => x.ip === ip), added = false;
    if (!d) {
      d = { ip, label: excelLabel(ip), manual: false, count: 0, state: null, error: null };
      listenDevices.push(d);
      if (mode === "listen") listIps.add(ip);
      added = true;
    }
    if (l.kind === "connect") listenActive.set(ip, (listenActive.get(ip) || 0) + 1);
    else if (l.kind === "disconnect") listenActive.set(ip, Math.max(0, (listenActive.get(ip) || 0) - 1));
    const state = (listenActive.get(ip) || 0) > 0 ? "connected" : "closed";
    const changed = added || d.state !== state;
    d.state = state;
    return changed;
  }

  /** İstemci çalışırken liste değişti: eklenen cihaza bağlan, çıkarılanın bağlantısını kapat. */
  async function syncHosts() {
    if (!session?.running || session.mode !== "connect") return;
    const current = new Set(session.hosts.map((h) => h.host));
    const wanted = new Set(clientDevices.map((d) => d.ip));
    const calls = [
      ...[...wanted].filter((ip) => !current.has(ip)).map((ip) => ["add", ip]),
      ...[...current].filter((ip) => !wanted.has(ip)).map((ip) => ["remove", ip]),
    ];
    for (const [op, host] of calls) {
      try { await api(`/api/tcp/hosts/${op}`, { method: "POST", body: { id: session.id, host } }); } catch (e) { toast(e.message, 4000); }
    }
    if (calls.length) setTimeout(poll, 300);
  }

  function addIp() {
    const ip = el.newIp.value.trim();
    if (!IPV4.test(ip)) { toast("Geçerli bir IP girin (ör. 172.16.154.20)."); return; }
    el.newIp.value = "";
    if (clientDevices.some((d) => d.ip === ip)) { selected = ip; renderDevices(); renderAll(); return; }
    manual.push(ip);
    storeSet("rbox.tcp.hosts", manual.join("\n"));
    rebuildClient();
  }

  function removeIp(ip) {
    manual = manual.filter((x) => x !== ip);
    storeSet("rbox.tcp.hosts", manual.join("\n"));
    rebuildClient();
  }

  function applyHostStates() {
    const st = new Map((session?.running && session.mode === "connect" ? session.hosts : []).map((h) => [h.host, h]));
    let changed = false;
    for (const d of clientDevices) {
      const h = st.get(d.ip);
      const state = h?.state ?? null, error = h?.error ?? null;
      if (d.state !== state || d.error !== error) { d.state = state; d.error = error; changed = true; }
    }
    if (changed && mode === "connect") renderDevices();
  }

  function countLine(l) {
    if (l.kind !== "data") return;
    const from = remoteIp(l.remote);
    const d = devices.find((x) => x.ip === from);
    if (d) d.count++;
  }
  function recount() {
    devices.forEach((d) => (d.count = 0));
    lines.forEach(countLine);
  }

  const passes = (l) => !selected || matches(l, selected, listIps);

  function renderDevices() {
    const TIP = { connected: "Bağlı", connecting: "Bağlanıyor…", failed: "Bağlanılamadı", closed: "Bağlantı kapalı" };
    const item = (d) => `<div class="tcp-devrow" role="option" data-ip="${esc(d.ip)}" aria-selected="${selected === d.ip}"
        title="${esc(d.state ? TIP[d.state] + (d.error ? ": " + d.error : "") : "")}">
        ${d.state ? `<i class="tcp-dot ${d.state}"></i>` : ""}
        <div class="tcp-devtxt"><div class="mono">${esc(d.ip)}</div>${d.label ? `<div class="sm muted">${esc(d.label)}</div>` : ""}</div>
        <span class="badge">${d.count}</span>
        ${d.manual ? `<button class="copy-ip tcp-rm" data-rm="${esc(d.ip)}" title="Listeden çıkar">✕</button>` : ""}</div>`;
    el.devs.innerHTML = devices.map(item).join("");
    el.noList.hidden = devices.length > 0;
    el.noList.textContent = mode === "listen"
      ? "Bu porta bağlanan cihazlar burada kendiliğinden listelenir."
      : "Üst banttaki \"Cihaz listesi\" ile Excel yüklenince cihaz IP'leri burada listelenir; yukarıdan elle de IP ekleyebilirsiniz.";
    el.addRow.hidden = mode !== "connect";
    el.filter.textContent = selected ? `· yalnızca ${selected}` : "";
  }

  // Sayılar her yoklamada değişebilir; liste yeniden çizilmeden yalnızca rozetler güncellenir
  function updateCounts() {
    const badges = $$(".tcp-devrow .badge", el.devs);
    if (badges.length !== devices.length) { renderDevices(); return; }
    devices.forEach((d, i) => (badges[i].textContent = d.count));
  }

  // ── Görünüm ─────────────────────────────────────────────────
  const hint = () => mode === "listen"
    ? "Ajanın çalıştığı bilgisayar girilen portu dinler; bağlanan cihazlar soldaki listeye kendiliğinden eklenir, gönderdikleri veri aşağıda görünür. Başka bilgisayarlardan bağlantı gelmiyorsa Windows Güvenlik Duvarı bu portu engelliyor olabilir (ilk başlatmada Windows izin sorabilir)."
    : "Ajanın çalıştığı bilgisayar soldaki listedeki her cihaza (Excel'deki IP'ler ve elle eklenenler) girilen porttan aynı anda bağlanır ve gelen veriyi yazar; bağlantısı kurulamayan ya da kopan cihaza 3 sn'de bir yeniden bağlanmayı dener.";

  function renderState() {
    const run = !!session?.running;
    el.state.classList.toggle("on", run);
    let text = "Durduruldu";
    if (run) {
      const b = fmtBytes(session.bytes);
      text = session.mode === "connect"
        ? `${session.active} / ${session.hosts.length || clientDevices.length} cihaz bağlı · port ${session.port} · ${b}`
        : `Dinleniyor · ${session.endpoint} · ${session.active} açık bağlantı · ${listenDevices.length} cihaz · ${b}`;
    }
    el.state.lastElementChild.textContent = text;
    const busy = run || starting;
    el.start.disabled = busy || !canStart();
    el.stop.disabled = !run;
    [el.port, el.bind, el.refresh, el.cport].forEach((i) => (i.disabled = busy));
    el.devCount.textContent = clientDevices.length;
    $$("button", el.mode).forEach((b) => { b.disabled = busy; b.setAttribute("aria-checked", String(b.dataset.mode === mode)); });
    $$("button", el.view).forEach((b) => b.setAttribute("aria-checked", String(b.dataset.view === view)));
    el.listen.hidden = mode !== "listen";
    el.connect.hidden = mode !== "connect";
    el.hint.title = hint() + " Karşı tarafa hiçbir şey gönderilmez. Sayfa kapanırsa bağlantı birkaç dakika içinde kendiliğinden durur.";
    el.copy.disabled = el.clear.disabled = lines.length === 0;
    el.jsonCard.hidden = view !== "json";
    el.grid.classList.toggle("json", view === "json");
  }

  const head = (l) => (l.kind === "data" ? `← ${fmtBytes(l.bytes)}` : l.text);
  const lineHtml = (l) =>
    `<div class="tl ${l.kind}"><span class="t">${esc(l.time)}</span>${l.remote ? `<span class="r">${esc(l.remote)}</span>` : ""}<span class="h">${esc(head(l))}</span>` +
    (l.kind === "data" ? `<div class="b">${esc(view === "hex" ? l.hex : l.text)}</div>` : "") + `</div>`;

  const jsonHead = (l) => (l.kind === "data" ? (l.json.length > 1 ? `JSON (${l.json.length})` : "JSON") : l.text);
  const jsonHtml = (l) =>
    `<div class="tj" data-seq="${l.seq}"><div class="tjh"><span class="t">${esc(l.time)}</span>${l.remote ? `<span class="r">${esc(l.remote)}</span>` : ""}<span class="h">${esc(jsonHead(l))}</span>
      <button class="copy-ip" data-copyjson="${l.seq}" title="Bu JSON'u kopyala">${ICONS.copy}</button></div>` +
    l.json.map((j) => j.error ? `<div class="je">${esc(j.error)}</div><div class="jb bad">${esc(j.text)}</div>` : `<div class="jb">${esc(j.text)}</div>`).join("") + `</div>`;

  const EMPTY_CON = () => lines.length
    ? `<div class="tcp-empty">Seçili cihaza ait veri yok. Tüm cihazların verisini görmek için soldaki seçili cihaza yeniden tıklayın.</div>`
    : `<div class="tcp-empty">Henüz veri yok. Bağlantı bilgilerini girip Başlat'a basın; gelen veri burada görünür.</div>`;
  const EMPTY_JSON = `<div class="tcp-empty">Henüz JSON yok. Gelen verideki her { … } ya da [ … ] değeri burada biçimlendirilmiş olarak görünür; parçalı gelen JSON birleştirilir.</div>`;

  function renderAll() {
    const vis = lines.filter(passes);
    el.con.innerHTML = vis.length ? vis.map(lineHtml).join("") : EMPTY_CON();
    el.con.scrollTop = el.con.scrollHeight;
    if (view === "json") {
      const js = vis.filter((l) => l.json?.length);
      el.json.innerHTML = js.length ? js.map(jsonHtml).join("") : EMPTY_JSON;
      el.json.scrollTop = el.json.scrollHeight;
    }
  }

  const atBottom = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < 40;

  function append(newLines) {
    // Dinleyici: porta bağlanan yeni cihazlar listeye eklenir, bağlantı durumları güncellenir
    if (session?.mode === "listen") {
      let changed = false;
      for (const l of newLines) changed = trackListen(l) || changed;
      if (changed && mode === "listen") renderDevices();
    }
    lines.push(...newLines);
    newLines.forEach(countLine);
    let dropped = 0;
    if (lines.length > MAX_LINES) { dropped = lines.length - MAX_LINES; lines.splice(0, dropped); }

    const vis = newLines.filter(passes);
    // Düşen eski satırlar ya da ilk veri: baştan çizmek en basiti; yoksa yalnızca yeni satırlar eklenir
    if (dropped || !el.con.querySelector(".tl")) { renderAll(); updateCounts(); return; }
    const conEnd = atBottom(el.con);
    el.con.insertAdjacentHTML("beforeend", vis.map(lineHtml).join(""));
    if (conEnd) el.con.scrollTop = el.con.scrollHeight;    // kullanıcı yukarı kaydırıp okuyorsa yerinde kalsın

    if (view === "json") {
      const js = vis.filter((l) => l.json?.length);
      if (js.length) {
        const jEnd = atBottom(el.json);
        if (!el.json.querySelector(".tj")) el.json.innerHTML = "";
        el.json.insertAdjacentHTML("beforeend", js.map(jsonHtml).join(""));
        if (jEnd) el.json.scrollTop = el.json.scrollHeight;
      }
    }
    updateCounts();
  }

  const copyLine = (l) => {
    const h = `[${l.time}]${l.remote ? " " + l.remote : ""} ${head(l)}`;
    return l.kind === "data" ? h + "\r\n" + (view === "hex" ? l.hex : l.text).replace(/\n/g, "\r\n") : h;
  };
  const copyJson = (l) => `[${l.time}]${l.remote ? " " + l.remote : ""}\r\n` +
    l.json.map((j) => (j.error ? `// ${j.error}\r\n` : "") + j.text.replace(/\n/g, "\r\n")).join("\r\n");

  // ── Olaylar ─────────────────────────────────────────────────
  const digitsOnly = (input) => input.addEventListener("input", () => {
    const v = input.value.replace(/\D/g, "").slice(0, 5);
    if (v !== input.value) input.value = v;
    renderState();
  });
  digitsOnly(el.port);
  digitsOnly(el.cport);
  [el.port, el.cport].forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") start(); }));
  ipFilter(el.newIp);
  el.newIp.addEventListener("keydown", (e) => { if (e.key === "Enter") addIp(); });
  el.addIp.addEventListener("click", addIp);

  el.mode.addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]"); if (!b || session?.running || starting) return;
    mode = b.dataset.mode; storeSet("rbox.tcp.mode", mode); showDevices();
  });
  el.view.addEventListener("click", (e) => {
    const b = e.target.closest("[data-view]"); if (!b || b.dataset.view === view) return;
    view = b.dataset.view; storeSet("rbox.tcp.view", view); renderState(); renderAll();
  });
  el.devs.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]");
    if (rm) { removeIp(rm.dataset.rm); return; }
    const r = e.target.closest("[data-ip]"); if (!r) return;
    // Tek seçim; seçili cihaza yeniden tıklamak süzgeci kaldırır
    selected = r.dataset.ip === selected ? "" : r.dataset.ip;
    renderDevices(); renderAll();
  });
  el.json.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copyjson]"); if (!b) return;
    const l = lines.find((x) => String(x.seq) === b.dataset.copyjson); if (!l) return;
    try { await copyText(l.json.map((j) => j.text.replace(/\n/g, "\r\n")).join("\r\n\r\n")); toast("JSON kopyalandı"); }
    catch { toast("Kopyalanamadı"); }
  });
  el.refresh.addEventListener("click", loadAddresses);
  el.start.addEventListener("click", start);
  el.stop.addEventListener("click", stop);
  el.copy.addEventListener("click", async () => {
    const vis = lines.filter(passes);
    const text = view === "json"
      ? vis.filter((l) => l.json?.length).map(copyJson).join("\r\n\r\n")
      : vis.map(copyLine).join("\r\n");
    if (!text) { toast("Kopyalanacak bir şey yok"); return; }
    try { await copyText(text + "\r\n"); toast("Kopyalandı"); }
    catch { toast("Kopyalanamadı"); }
  });
  // Temizle: dinleyicide bağlantısı kapanmış cihazlar da listeden kalkar
  el.clear.addEventListener("click", () => {
    lines = [];
    listenDevices = listenDevices.filter((d) => (listenActive.get(d.ip) || 0) > 0);
    showDevices();
  });

  let loaded = false;
  rebuildClient();
  renderAll();
  renderState();

  return {
    root,
    setDevices,
    onShow() {
      if (!loaded) { loaded = true; loadAddresses(); }
      if (!session?.running) (mode === "listen" ? el.port : el.cport).focus();
    },
  };
}
