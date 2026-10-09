// Port Kontrol modülü: ajanın çalıştığı bilgisayarda bir portu dinleyen uygulamayı / bir uygulamanın dinlediği
// portları bulur. (Uzak bilgisayar sorgusu arayüzden kaldırıldı; ajandaki kod duruyor.)
// Tüm iş ajandaki PortInspector'da (WPF ile aynı kod); burası yalnızca sonucu gösterir. Salt okunur.
// "Güvenlik duvarı · port izni" kartı ajandaki FirewallManager'ı kullanır: seçili TCP portları için
// "RasyoBOX TCP <port>" gelen izin kuralı ekler / kaldırır (ajan yönetici değilse Windows UAC sorar).
import { api } from "./api.js";
import { $, esc, storeGet, storeSet, toast, sortCompare, ICONS } from "./util.js";

const DASH = "—";
const QUICK = [
  ["", "Tüm dinlenen portlar"], ["1433", "SQL Server 1433"], ["sqlservr.exe", "sqlservr.exe"], ["22", "SSH 22"],
  ["3389", "RDP 3389"], ["7070", "AnyDesk 7070"], ["2575", "HL7 2575"], ["47800-47809", "Ajan 47800"],
];

// Güvenlik duvarı kartında her zaman gösterilen portlar (ajandaki FirewallManager.DefaultPorts ile aynı)
const FW_DEFAULT = [1433, 22, 8080, 8082, 8085, 6155, 8089, 9000, 9999, 9998, 9997];
const FW_SEV = { allowed: "sev-ok", blocked: "sev-error", partial: "sev-warn", none: "sev-warn" };

const EP_COLS = [
  { key: "protocol", label: "Protokol", w: 82 },
  { key: "localAddress", label: "Yerel adres", w: 150, mono: true },
  { key: "localPort", label: "Port", w: 72, mono: true, num: true },
  { key: "service", label: "Servis", w: 150 },
  { key: "state", label: "Durum", w: 120 },
  { key: "remoteAddress", label: "Uzak adres", w: 150, mono: true },
  { key: "remotePort", label: "Uzak port", w: 88, mono: true, num: true },
  { key: "remoteName", label: "Uzak bilgisayar", w: null },
  { key: "process", label: "Uygulama", w: 190 },
  { key: "pid", label: "PID", w: 72, mono: true, num: true },
];

const STATE_TR = { LISTEN: "Dinliyor", ESTABLISHED: "Bağlı", TIME_WAIT: "Kapanıyor", CLOSE_WAIT: "Kapanıyor", SYN_SENT: "Bağlanıyor", SYN_RCVD: "Bağlanıyor", FIN_WAIT1: "Kapanıyor", FIN_WAIT2: "Kapanıyor", LAST_ACK: "Kapanıyor", CLOSING: "Kapanıyor" };

export function createPort() {
  const root = document.createElement("div");
  root.className = "stack pstack";

  let report = null, busy = false;
  let epSearch = "", epSort = { key: null, dir: 1 };
  // Eski kayıtlardaki "@ bilgisayar" (uzak) sorguları gösterilmez
  let history = storeGet("rbox.port.history", "").split("\n")
    .filter((h) => h && !h.split("\t")[1]).map((h) => h.split("\t")[0]);

  root.innerHTML = `
    <div class="ptop">
    <section class="card">
      <div class="card-h">Sorgu</div>
      <div class="card-b">
        <div class="row" style="align-items:flex-end">
          <div><label class="field-label" for="pQuery">Port ya da uygulama</label>
            <input type="text" id="pQuery" style="width:320px" autocomplete="off" placeholder="ör. 1433 · 80,443 · 8000-8010 · sqlservr.exe"></div>
          <button class="btn primary" id="pRun">${ICONS.play} Sorgula</button>
          <span class="spacer" style="flex:1"></span>
          <span class="sm muted" id="pState"></span>
        </div>
        <div class="row tight" style="margin-top:12px"><span class="sm muted">Hızlı:</span><span class="chips" id="pQuick"></span></div>
        <div class="row tight" style="margin-top:8px" id="pHistRow" hidden><span class="sm muted">Son sorgular:</span><span class="chips" id="pHist"></span></div>
        <p class="sm muted" style="margin:10px 0 0">Ajanın çalıştığı bilgisayarda portu dinleyen uygulama, sürüm, hizmet, kullanıcı, bağlantılar ve güvenlik duvarı kuralları gösterilir.
          Uygulama adı girilirse (ör. sqlservr.exe) o uygulamanın dinlediği portlar gösterilir.</p>
      </div>
    </section>
    <section class="card">
      <div class="card-h row" style="justify-content:space-between"><span>Güvenlik duvarı · port izni</span><span class="sm muted" id="fwState" style="text-transform:none;letter-spacing:0;font-weight:400"></span></div>
      <div class="card-b">
        <div class="fwgrid" id="fwPorts"></div>
        <div class="row tight" style="margin-top:12px">
          <label class="row tight" style="cursor:pointer"><input type="checkbox" id="fwAll"><span class="sm">Tümü</span></label>
          <input type="text" id="fwAdd" placeholder="Port ekle" title="Listeye port ekle (1–65535), Enter" style="width:110px" inputmode="numeric" autocomplete="off" maxlength="5">
          <button class="btn icon" id="fwAddBtn" title="Portu listeye ekle">${ICONS.plus}</button>
          <span class="spacer"></span>
          <button class="btn icon" id="fwRefresh" title="Durumu yenile">${ICONS.redo}</button>
          <button class="btn" id="fwRemove" title="Seçili portların yalnızca 'RasyoBOX TCP &lt;port&gt;' kuralını siler">${ICONS.trash} Kuralı kaldır</button>
          <button class="btn primary" id="fwAllow">${ICONS.check} <span id="fwAllowTxt">İzin ver</span></button>
        </div>
        <p class="sm muted" id="fwNote" style="margin:10px 0 0"></p>
      </div>
    </section>
    </div>
    <div id="pOut" class="stack pstack"></div>`;

  const q = (id) => $("#" + id, root);
  const el = { query: q("pQuery"), run: q("pRun"), state: q("pState"), out: q("pOut"),
               quick: q("pQuick"), hist: q("pHist"), histRow: q("pHistRow") };

  el.quick.innerHTML = QUICK.map(([v, l]) => `<button class="chip" data-q="${esc(v)}">${esc(l)}</button>`).join("");
  el.quick.addEventListener("click", (e) => {
    const b = e.target.closest("[data-q]"); if (!b) return;
    el.query.value = b.dataset.q; run();
  });
  el.hist.addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]"); if (!b) return;
    el.query.value = history[Number(b.dataset.i)]; run();
  });
  function renderHistory() {
    el.histRow.hidden = history.length === 0;
    el.hist.innerHTML = history.map((h, i) => `<button class="chip" data-i="${i}">${esc(h || "tümü")}</button>`).join("");
  }
  function remember(qq) {
    history = [qq, ...history.filter((x) => x !== qq)].slice(0, 8);
    storeSet("rbox.port.history", history.join("\n"));
    renderHistory();
  }
  renderHistory();

  el.run.addEventListener("click", run);
  el.query.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });

  async function run() {
    if (busy) return;
    const query = el.query.value.trim();
    busy = true; el.run.disabled = true;
    el.state.textContent = "Sorgulanıyor…";
    try {
      report = await api("/api/port/inspect", { method: "POST", body: { query, host: "" } });
      el.state.textContent = `${new Date().toLocaleTimeString("tr-TR")} · ${(report.elapsedMs / 1000).toFixed(1)} sn`;
      if (report.ok) remember(query);
      epSearch = ""; epSort = { key: null, dir: 1 };
      render();
    } catch (e) {
      el.state.textContent = "";
      toast(e.message, 5000);
    } finally {
      busy = false; el.run.disabled = false;
    }
  }

  // ── Görünüm ─────────────────────────────────────────────────
  const kv = (label, value, cls = "") => value === "" || value == null ? "" :
    `<div class="pkv"><div class="tk">${esc(label)}</div><div class="pv ${cls}">${value}</div></div>`;

  function render() {
    const r = report;
    if (!r) { el.out.innerHTML = ""; return; }
    let h = "";

    // Özet notlar
    const notes = r.notes.map((n) => `<li>${esc(n)}</li>`).join("");
    h += `<section class="card"><div class="card-h">${r.mode === "remote" ? "Uzak bilgisayar" : "Bu sunucu"}${r.ok ? "" : " · sorgu yapılamadı"}</div>
      <div class="card-b">${notes ? `<ul class="pnotes${r.ok ? "" : " err"}">${notes}</ul>` : ""}${machine(r)}</div></section>`;

    if (r.processes.length) {
      const cards = `<div class="card-b pprocs">${r.processes.map(proc).join("")}</div>`;
      // Boş sorguda (tüm dinlenen portlar) onlarca uygulama olur: ayrıntılar katlı gelir, tablo yeterli özet verir
      h += r.ports.length || r.names.length || r.mode !== "local"
        ? `<section class="card"><div class="card-h">Uygulamalar (${r.processes.length})</div>${cards}</section>`
        : `<section class="card"><details><summary class="card-h psum">Uygulamalar (${r.processes.length}) · ayrıntıları göster</summary>${cards}</details></section>`;
    }
    if (r.sqlInstances.length) h += sqlTable(r.sqlInstances);
    if (r.remotePorts.length) h += remoteTable(r.remotePorts);
    if (r.mode === "local" && r.ok) {
      h += `<section class="card"><div class="card-h row" style="justify-content:space-between">
          <span>${r.ports.length || r.names.length ? "Portlar ve bağlantılar" : "Dinlenen portlar"} (<span id="pEpCount">${r.endpoints.length}</span>)</span>
          <input type="search" id="pEpSearch" placeholder="Süz: port, adres, uygulama…" style="width:280px;text-transform:none;letter-spacing:0;font-weight:400"></div>
        <div class="card-b" style="padding:10px 0 0"><div class="table-wrap" style="max-height:calc(100vh - 300px + var(--gain, 0px));min-height:120px">
          <table class="fixed" style="min-width:1300px"><colgroup>${EP_COLS.map((c) => `<col${c.w ? ` style="width:${c.w}px"` : ""}>`).join("")}</colgroup>
          <thead><tr id="pEpHead"></tr></thead><tbody id="pEpBody"></tbody></table></div></div></section>`;
    }
    if (r.firewall) h += firewall(r.firewall);
    el.out.innerHTML = h;

    const s = $("#pEpSearch", el.out);
    if (s) {
      s.value = epSearch;
      s.addEventListener("input", () => { epSearch = s.value; renderEndpoints(); });
      $("#pEpHead", el.out).addEventListener("click", (e) => {
        const th = e.target.closest("th[data-k]"); if (!th) return;
        epSort = epSort.key === th.dataset.k ? { key: th.dataset.k, dir: -epSort.dir } : { key: th.dataset.k, dir: 1 };
        renderEndpoints();
      });
      renderEndpoints();
    }
  }

  function machine(r) {
    const m = r.machine; if (!m) return "";
    const os = m.os ? esc(m.os) + (m.osSource ? ` <span class="sm muted">(${esc(m.osSource)})</span>` : "") : "";
    return `<div class="pgrid">
      ${kv("Bilgisayar adı", esc(m.name))}
      ${kv(m.isLocal ? "Etki alanı" : "Çalışma grubu / etki alanı", esc(m.domain))}
      ${kv("DNS adı", esc(m.dnsName))}
      ${kv("IP adresi", esc(m.address), "mono")}
      ${kv(m.isLocal ? "IPv4 adresleri" : "Diğer adresler", esc(m.addresses), "mono")}
      ${kv("İşletim sistemi", os)}
      ${kv("Mimari", esc(m.osArch))}
      ${kv("Açık kalma süresi", esc(m.uptime))}
      ${m.isLocal ? kv("Ajanı çalıştıran", esc(m.user) + (m.isAdmin ? ' <span class="badge sev-ok">yönetici</span>' : ' <span class="badge sev-warn" title="Bazı sistem süreçlerinin yolu / kullanıcısı okunamayabilir">yönetici değil</span>')) : ""}
      ${m.isLocal ? "" : kv("Ping", m.pingMs != null ? `${m.pingMs} ms · TTL ${m.ttl}` : '<span class="txt-error">yanıt yok</span>')}
      ${kv("MAC", esc(m.mac) + (m.vendor && m.vendor !== "Bilinmiyor" ? ` <span class="sm muted">${esc(m.vendor)}</span>` : ""), "mono")}
    </div>`;
  }

  function proc(p) {
    const svc = p.services.map((s) =>
      `<div>${esc(s.displayName)} <span class="mono sm muted">(${esc(s.name)})</span> <span class="badge ${s.state === "Çalışıyor" ? "sev-ok" : "sev-warn"}">${esc(s.state)}</span> <span class="sm muted">başlangıç: ${esc(s.startMode)}</span></div>`).join("");
    const title = p.description && p.description !== p.name ? `<span class="muted" style="font-weight:400"> · ${esc(p.description)}</span>` : "";
    return `<div class="pproc">
      <div class="ph"><b>${esc(p.name)}</b>${title}<span class="badge sev-info" style="margin-left:auto">PID ${p.pid}</span></div>
      <div class="pgrid">
        ${kv("Dinlediği portlar", p.listening ? esc(p.listening) : '<span class="muted">yok</span>', "mono")}
        ${kv("Açık bağlantı", String(p.connections))}
        ${kv("Ürün", esc([p.product, p.company && p.company !== p.product ? p.company : ""].filter(Boolean).join(" · ")))}
        ${kv("Sürüm", esc(p.version), "mono")}
        ${kv("Kullanıcı", esc(p.user))}
        ${kv("Başlangıç", esc(p.started))}
        ${kv("Bellek", p.memoryMb ? `${p.memoryMb} MB` : "")}
        ${kv("Üst süreç", p.parentPid ? `PID ${p.parentPid}` : "", "mono")}
      </div>
      ${p.path ? `<div class="pkv wide"><div class="tk">Dosya yolu</div><div class="pv mono sel">${esc(p.path)}</div></div>` : ""}
      ${p.commandLine && p.commandLine.replace(/"/g, "").trim() !== p.path ? `<div class="pkv wide"><div class="tk">Komut satırı</div><div class="pv mono sel">${esc(p.commandLine)}</div></div>` : ""}
      ${p.httpUrls ? `<div class="pkv wide"><div class="tk">http.sys adresleri</div><div class="pv mono sel">${esc(p.httpUrls)}</div></div>` : ""}
      ${svc ? `<div class="pkv wide"><div class="tk">Windows hizmeti</div><div class="pv">${svc}</div></div>` : ""}
    </div>`;
  }

  function remoteTable(list) {
    const rows = list.map((p) => `<tr class="item">
      <td class="mono">${p.port}</td><td>${esc(p.service) || DASH}</td>
      <td><span class="badge ${p.open ? "sev-ok" : p.state.startsWith("Kapalı") ? "sev-error" : "sev-warn"}" title="${esc(p.state)}">${esc(p.state)}</span></td>
      <td class="mono">${p.timeMs != null ? p.timeMs + " ms" : DASH}</td>
      <td class="mono" title="${esc(p.banner)}">${esc(p.banner) || DASH}</td>
      <td title="${esc(p.tls)}">${esc(p.tls) || DASH}</td></tr>`).join("");
    return `<section class="card"><div class="card-h">Portlar (${list.filter((p) => p.open).length} açık / ${list.length})</div>
      <div class="card-b" style="padding:10px 0 0"><div class="table-wrap" style="max-height:none;min-height:0">
      <table class="fixed" style="min-width:1000px"><colgroup><col style="width:80px"><col style="width:180px"><col style="width:260px"><col style="width:80px"><col><col style="width:360px"></colgroup>
      <thead><tr><th>Port</th><th>Servis</th><th>Durum</th><th>Süre</th><th>Tanıtım / sunucu</th><th>TLS sertifikası</th></tr></thead><tbody>${rows}</tbody></table></div></div></section>`;
  }

  function sqlTable(list) {
    const rows = list.map((s) => `<tr class="item"><td>${esc(s.server)}</td><td>${esc(s.instance)}</td><td>${esc(s.product) || DASH}</td>
      <td class="mono">${esc(s.version)}</td><td class="mono">${esc(s.tcpPort) || '<span class="txt-error">TCP kapalı</span>'}</td></tr>`).join("");
    return `<section class="card"><div class="card-h">SQL Server örnekleri (SQL Browser)</div>
      <div class="card-b" style="padding:10px 0 0"><div class="table-wrap" style="max-height:none;min-height:0">
      <table class="fixed"><colgroup><col><col style="width:180px"><col style="width:200px"><col style="width:160px"><col style="width:120px"></colgroup>
      <thead><tr><th>Sunucu</th><th>Örnek</th><th>Ürün</th><th>Sürüm</th><th>TCP port</th></tr></thead><tbody>${rows}</tbody></table></div></div></section>`;
  }

  function firewall(fw) {
    const rows = fw.rules.map((x) => `<tr class="item${x.enabled ? "" : " off"}">
      <td title="${esc(x.name)}">${esc(x.name)}</td>
      <td><span class="badge ${x.enabled ? "sev-ok" : "sev-muted"}">${x.enabled ? "Etkin" : "Kapalı"}</span></td>
      <td><span class="badge ${x.action === "İzin ver" ? "sev-ok" : "sev-error"}">${esc(x.action)}</span></td>
      <td>${esc(x.protocol)}</td><td class="mono" title="${esc(x.ports)}">${esc(x.ports)}</td>
      <td title="${esc(x.program)}">${esc(x.program)}</td><td>${esc(x.profiles)}</td><td class="mono" title="${esc(x.remote)}">${esc(x.remote)}</td></tr>`).join("");
    return `<section class="card"><div class="card-h">Güvenlik duvarı · gelen kurallar</div>
      <div class="card-b" style="padding-bottom:8px"><span class="${fw.anyProfileOff ? "txt-error" : "sm muted"}">${esc(fw.profiles)}</span></div>
      ${fw.rules.length ? `<div class="table-wrap" style="max-height:420px;min-height:0">
      <table class="fixed" style="min-width:1100px"><colgroup><col><col style="width:90px"><col style="width:100px"><col style="width:80px"><col style="width:130px"><col style="width:170px"><col style="width:170px"><col style="width:140px"></colgroup>
      <thead><tr><th>Kural</th><th>Durum</th><th>Eylem</th><th>Protokol</th><th>Port</th><th>Program</th><th>Profil</th><th>Uzak adres</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="card-b" style="padding-top:0"><span class="warnbox w" style="display:inline-block;margin:0">Bu port / uygulama için özel bir gelen kuralı yok: başka bilgisayarlardan bağlantı engellenebilir.</span></div>`}
    </section>`;
  }

  function renderEndpoints() {
    const head = $("#pEpHead", el.out), body = $("#pEpBody", el.out);
    if (!head) return;
    head.innerHTML = EP_COLS.map((c) => `<th data-k="${c.key}">${c.label}${epSort.key === c.key ? `<span class="arr">${epSort.dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("");
    const t = epSearch.trim().toLocaleLowerCase("tr");
    let list = report.endpoints;
    if (t) list = list.filter((e) => EP_COLS.some((c) => String(e[c.key] ?? "").toLocaleLowerCase("tr").includes(t)) || (STATE_TR[e.state] ?? "").toLocaleLowerCase("tr").includes(t));
    if (epSort.key) {
      const c = EP_COLS.find((x) => x.key === epSort.key);
      list = [...list].sort((a, b) => sortCompare(c.num && !a[c.key] ? "" : a[c.key], c.num && !b[c.key] ? "" : b[c.key], epSort.dir));
    }
    $("#pEpCount", el.out).textContent = t ? `${list.length} / ${report.endpoints.length}` : String(report.endpoints.length);
    body.innerHTML = list.length ? list.map((e) => {
      const listen = e.state === "LISTEN" || e.protocol.startsWith("UDP");
      const st = e.protocol.startsWith("UDP") ? "UDP" : (STATE_TR[e.state] ?? e.state);
      return `<tr class="item">
        <td>${esc(e.protocol)}</td><td class="mono" title="${esc(e.localAddress)}">${esc(e.localAddress)}</td><td class="mono">${e.localPort}</td>
        <td title="${esc(e.service)}">${esc(e.service) || ""}</td>
        <td><span class="badge ${listen ? "sev-ok" : e.state === "ESTABLISHED" ? "sev-info" : "sev-muted"}">${esc(st)}</span></td>
        <td class="mono" title="${esc(e.remoteAddress)}">${esc(e.remoteAddress)}</td><td class="mono">${e.remotePort || ""}</td>
        <td title="${esc(e.remoteName)}">${esc(e.remoteName)}</td>
        <td title="${esc(e.process)}${e.via ? " (http.sys üzerinden)" : ""}">${esc(e.process) || (e.pid === 0 ? '<span class="muted">—</span>' : "")}${e.via ? ' <span class="src">http.sys</span>' : ""}</td>
        <td class="mono">${e.pid || ""}</td></tr>`;
    }).join("") : `<tr><td colspan="${EP_COLS.length}" class="empty">${report.endpoints.length ? "Süzgece uyan satır yok." : "Bu sorguya uyan port ya da bağlantı yok."}</td></tr>`;
  }

  // ── Güvenlik duvarı · port izni ─────────────────────────────
  const fw = { ports: q("fwPorts"), all: q("fwAll"), add: q("fwAdd"), addBtn: q("fwAddBtn"), refresh: q("fwRefresh"),
               remove: q("fwRemove"), allow: q("fwAllow"), allowTxt: q("fwAllowTxt"), state: q("fwState"), note: q("fwNote") };
  let fwCustom = storeGet("rbox.fw.ports", "").split(",").map(Number).filter((p) => p > 0 && p <= 65535 && !FW_DEFAULT.includes(p));
  let fwStatus = null, fwBusy = false, fwLoaded = false;
  const fwOff = new Set();                       // seçili olmayan portlar (varsayılan: hepsi seçili)
  const fwList = () => [...FW_DEFAULT, ...fwCustom];
  const fwChecked = () => fwList().filter((p) => !fwOff.has(p));

  function fwRender() {
    const byPort = new Map((fwStatus?.ports ?? []).map((x) => [x.port, x]));
    fw.ports.innerHTML = fwList().map((p) => {
      const s = byPort.get(p);
      const custom = !FW_DEFAULT.includes(p);
      const badge = s ? `<span class="badge ${FW_SEV[s.state] ?? "sev-muted"}">${esc(s.label)}</span>` : `<span class="badge sev-muted">…</span>`;
      return `<label class="fwt${fwOff.has(p) ? " off" : ""}" title="${esc(s ? s.tooltip : "")}">
        <input type="checkbox" data-p="${p}"${fwOff.has(p) ? "" : " checked"}>
        <span class="fwp"><b class="mono">${p}</b><small>${esc(s?.service || "TCP")}${s?.own ? " · RasyoBOX" : ""}</small></span>
        ${badge}${custom ? `<button class="fwx" data-x="${p}" title="Listeden çıkar (kurala dokunmaz)">×</button>` : ""}
      </label>`;
    }).join("");
    const n = fwChecked().length, all = fwList().length;
    fw.all.checked = n === all; fw.all.indeterminate = n > 0 && n < all;
    fw.allowTxt.textContent = n === all ? "İzin ver" : `İzin ver (${n})`;
    fw.allow.disabled = fw.remove.disabled = fwBusy || n === 0;
    fw.refresh.disabled = fwBusy;
    if (fwStatus) {
      fw.state.textContent = fwStatus.error ? "" : fwStatus.profiles;
      fw.state.className = fwStatus.activeProfileOff ? "sm txt-error" : "sm muted";
    }
  }

  function fwSetNote(text, cls = "muted") { fw.note.className = "sm " + cls; fw.note.textContent = text; }
  function fwDefaultNote() {
    if (!fwStatus) return;
    if (fwStatus.error) return fwSetNote(fwStatus.error, "txt-error");
    const base = "Seçili portlar için tüm ağ profillerinde gelen TCP bağlantısına izin veren 'RasyoBOX TCP <port>' kuralı eklenir.";
    fwSetNote(fwStatus.activeProfileOff ? "Etkin ağda güvenlik duvarı KAPALI: portlar şu an engellenmiyor. " + base
      : fwStatus.isAdmin ? base : base + " Ajan yönetici olarak çalışmadığı için Windows yönetici izni (UAC) soracak.",
      fwStatus.activeProfileOff ? "txt-error" : "muted");
  }

  async function fwLoad() {
    if (fwBusy) return;
    fwBusy = true; fwRender();
    try {
      fwStatus = await api("/api/firewall/status", { method: "POST", body: { ports: fwList() } });
      fwLoaded = true;
      fwDefaultNote();
    } catch (e) {
      fwSetNote(e.message, "txt-error");
    } finally {
      fwBusy = false; fwRender();
    }
  }

  async function fwAct(kind) {
    const ports = fwChecked();
    if (fwBusy || !ports.length) return;
    if (kind === "remove" && !confirm(`${ports.length} port için 'RasyoBOX TCP <port>' kuralı silinsin mi?\n\n${ports.join(", ")}\n\nBaşka kurallara dokunulmaz.`)) return;
    fwBusy = true; fwRender();
    fwSetNote(fwStatus && !fwStatus.isAdmin
      ? "Windows yönetici izni bekleniyor… UAC penceresi görünmüyorsa görev çubuğunda yanıp sönen kalkan simgesine tıklayın."
      : "Güvenlik duvarı güncelleniyor…");
    try {
      const r = await api("/api/firewall/" + kind, { method: "POST", body: { ports } });
      if (r.status) {
        // Yanıt yalnızca seçili portları içerir: diğer portların durumu korunur
        const map = new Map((fwStatus?.ports ?? []).map((x) => [x.port, x]));
        r.status.ports.forEach((x) => map.set(x.port, x));
        fwStatus = { ...r.status, ports: [...map.values()] };
      }
      fwSetNote(r.message, r.ok ? "txt-ok" : "txt-error");
      toast(r.message, 4000);
    } catch (e) {
      fwSetNote(e.message, "txt-error");
    } finally {
      fwBusy = false; fwRender();
    }
  }

  function fwAddPort() {
    const p = Number(fw.add.value.trim());
    if (!Number.isInteger(p) || p < 1 || p > 65535) { toast("Port 1–65535 arasında olmalı."); return; }
    fw.add.value = "";
    fwOff.delete(p);
    if (!fwList().includes(p)) {
      fwCustom.push(p);
      storeSet("rbox.fw.ports", fwCustom.join(","));
      if (fwLoaded) fwLoad();
    }
    fwRender();
  }

  fw.ports.addEventListener("click", (e) => {
    const x = e.target.closest("[data-x]");
    if (!x) return;
    e.preventDefault();
    const p = Number(x.dataset.x);
    fwCustom = fwCustom.filter((v) => v !== p); fwOff.delete(p);
    storeSet("rbox.fw.ports", fwCustom.join(","));
    fwRender();
  });
  fw.ports.addEventListener("change", (e) => {
    const cb = e.target.closest("input[data-p]"); if (!cb) return;
    const p = Number(cb.dataset.p);
    cb.checked ? fwOff.delete(p) : fwOff.add(p);
    fwRender();
  });
  fw.all.addEventListener("change", () => {
    // Karışık durumda tıklama hepsini seçer (Ping tablosundaki gibi)
    if (fwChecked().length === fwList().length) fwList().forEach((p) => fwOff.add(p)); else fwOff.clear();
    fwRender();
  });
  fw.add.addEventListener("beforeinput", (e) => { if (e.data && /\D/.test(e.data)) e.preventDefault(); });
  fw.add.addEventListener("keydown", (e) => { if (e.key === "Enter") fwAddPort(); });
  fw.addBtn.addEventListener("click", fwAddPort);
  fw.refresh.addEventListener("click", fwLoad);
  fw.allow.addEventListener("click", () => fwAct("allow"));
  fw.remove.addEventListener("click", () => fwAct("remove"));
  fwRender();

  return {
    root,
    onShow() { if (!report) el.query.focus(); if (!fwLoaded) fwLoad(); },
    isBusy: () => busy,
  };
}
