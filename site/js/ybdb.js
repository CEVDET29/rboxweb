// YBDB Odalar modülü: SQL Server'daki oda / yatak kayıtları ve doluluk (salt okunur). WPF YbdbView karşılığı.
import { api } from "./api.js";
import { $, esc, debounce, toast, unitColor, ICONS } from "./util.js";
import { createCihazEditor } from "./ybdbcihaz.js";

const DASH = "—";

const ODA_COLS = [
  { key: "id", label: "ID", val: (o) => o.id, num: true },
  { key: "adi", label: "Oda", val: (o) => o.adi },
  { key: "bolumAdi", label: "Bölüm", val: (o) => o.bolumAdi },
  { key: "doluluk", label: "Doluluk", val: (o) => (o.yatakSayisi ? o.doluSayisi / o.yatakSayisi : -1) },
];

const YATAK_COLS = [
  { key: "durum", label: "Durum", val: (y) => y.durum },
  { key: "hastaAdi", label: "Hasta", val: (y) => y.hastaAdi ?? "" },
  { key: "hastaId", label: "Hasta ID", val: (y) => y.hastaId ?? "", num: true },
  { key: "yatakAdi", label: "Yatak", val: (y) => y.yatakAdi },
  { key: "yatakId", label: "Yatak ID", val: (y) => y.yatakId, num: true },
  { key: "odaAdi", label: "Oda", val: (y) => y.odaAdi },
  { key: "bolumAdi", label: "Bölüm", val: (y) => y.bolumAdi },
  { key: "basamak", label: "Basamak", val: (y) => y.basamak ?? "", num: true },
];

const tr = (s) => String(s ?? "").toLocaleLowerCase("tr");

function compare(a, b, numeric) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "tr", { numeric });
}

export function createYbdb() {
  const root = document.createElement("div");
  root.className = "stack";

  let data = null;                 // { odalar, yataklar, bolumler, zaman }
  let busy = false;
  let connected = false;
  let passDirty = false;
  let selectedOda = null;          // seçili odanın id'si
  let odaSearch = "", yatakSearch = "", sadeceBos = false;
  let sortOda = { key: null, dir: 1 }, sortYatak = { key: null, dir: 1 };
  let cfg = { server: "", user: "RasyoUser", remember: false, hasPass: false };

  root.innerHTML = `
    <section class="card">
      <div class="card-h">Bağlantı</div>
      <div class="card-b">
        <div class="row" style="align-items:flex-end">
          <div><label class="field-label" for="yServer">Sunucu</label><input type="text" id="yServer" style="width:220px" autocomplete="off"></div>
          <div><label class="field-label" for="yUser">Kullanıcı</label><input type="text" id="yUser" style="width:160px" autocomplete="off"></div>
          <div><label class="field-label" for="yPass">Şifre</label><input type="password" id="yPass" style="width:170px" autocomplete="new-password"></div>
          <label class="chk" style="height:34px" title="Şifre bu bilgisayarda ajan tarafından şifreli saklanır"><input type="checkbox" id="yRemember"> Şifreyi hatırla</label>
          <button class="btn primary" id="yConnect">Bağlan</button>
          <span class="spacer" style="flex:1"></span>
          <span class="badge sev-muted" id="yState">Bağlı değil</span>
          <span class="sm muted" id="yLast">Son güncelleme: ${DASH}</span>
          <button class="btn" id="yRefresh" disabled>${ICONS.redo} Yenile (F5)</button>
        </div>
        <div class="txt-error" id="yErr" style="margin-top:8px" hidden></div>
      </div>
    </section>

    <div class="seg" role="tablist" id="ySeg">
      <button role="tab" data-ytab="oda" aria-selected="true">${ICONS.ybdb} Odalar ve yataklar</button>
      <button role="tab" data-ytab="cihaz" aria-selected="false">${ICONS.control} Cihazlar</button>
    </div>

    <div class="stack" id="yOdaView">
    <section class="card" id="ySummary" hidden>
      <div class="card-b row" style="gap:32px;padding-top:16px;align-items:center">
        <div class="card-h" style="padding:0">Doluluk</div>
        <div style="min-width:260px;max-width:360px;flex:1">
          <div class="row" style="justify-content:space-between;margin-bottom:6px">
            <span><b id="yDolu"></b> <span class="muted">/ <span id="yToplam"></span> yatak dolu</span></span>
            <b style="color:var(--ok-text)" id="yPct"></b>
          </div>
          <div class="progress"><div id="yBar"></div></div>
        </div>
        <span class="muted">Odalar <b style="font-size:18px;color:var(--text)" id="yOda"></b></span>
        <span class="muted">Toplam yatak <b style="font-size:18px;color:var(--text)" id="yTop2"></b></span>
        <span class="muted">Boş yatak <b style="font-size:18px;color:var(--ok-text)" id="yBos"></b></span>
        <span class="row tight" id="yLegend" style="margin-left:auto"></span>
      </div>
    </section>

    <div class="ybdb-grid">
      <section class="card">
        <div class="card-h row" style="justify-content:space-between">ODALAR <span class="sm muted" style="text-transform:none;letter-spacing:0;font-weight:500" id="yOdaCount">Bağlandıktan sonra listelenir</span></div>
        <div class="card-b" style="padding-bottom:8px"><input type="search" id="yOdaSearch" placeholder="Oda ara: ad, bölüm, ID…" style="width:100%"></div>
        <div class="table-wrap" style="max-height:calc(100vh - 380px)"><table class="fixed" style="min-width:420px">
          <colgroup><col style="width:56px"><col><col style="width:110px"><col style="width:150px"></colgroup>
          <thead><tr id="yOdaHead"></tr></thead><tbody id="yOdaBody"></tbody></table></div>
      </section>

      <section class="card">
        <div class="card-h row" style="justify-content:space-between"><span id="yYatakTitle">YATAKLAR · TÜMÜ</span>
          <span class="row tight" style="text-transform:none;letter-spacing:0;font-weight:500"><span class="sm muted" id="yYatakOzet">Bağlandıktan sonra listelenir</span>
          <button class="btn" id="yAll" hidden style="height:28px">Tüm odaları göster</button></span></div>
        <div class="card-b row" style="padding-bottom:8px">
          <input type="search" id="yYatakSearch" placeholder="Yatak ara: hasta, yatak, oda…  (Ctrl+F)" style="width:340px;max-width:100%">
          <label class="chk"><input type="checkbox" id="yBosOnly"> Sadece boş yataklar</label>
        </div>
        <div class="table-wrap" style="max-height:calc(100vh - 380px)"><table class="fixed" style="min-width:900px">
          <colgroup><col style="width:70px"><col><col style="width:80px"><col style="width:80px"><col style="width:80px"><col style="width:135px"><col style="width:100px"><col style="width:80px"></colgroup>
          <thead><tr id="yYatakHead"></tr></thead><tbody id="yYatakBody"></tbody></table></div>
      </section>
    </div>
    </div>
    <div id="yCihazView" hidden></div>`;

  const q = (id) => $("#" + id, root);
  const el = {
    server: q("yServer"), user: q("yUser"), pass: q("yPass"), remember: q("yRemember"),
    connect: q("yConnect"), refresh: q("yRefresh"), state: q("yState"), last: q("yLast"), err: q("yErr"),
    summary: q("ySummary"), legend: q("yLegend"),
    odaCount: q("yOdaCount"), odaSearch: q("yOdaSearch"), odaHead: q("yOdaHead"), odaBody: q("yOdaBody"),
    title: q("yYatakTitle"), ozet: q("yYatakOzet"), all: q("yAll"), yatakSearch: q("yYatakSearch"),
    bosOnly: q("yBosOnly"), yatakHead: q("yYatakHead"), yatakBody: q("yYatakBody"),
  };

  // ── Cihazlar sekmesi (dbo.Cihaz: ekle / güncelle / sil) ─────────
  let ytab = "oda";
  const cz = createCihazEditor({ getYataklar: () => data?.yataklar ?? [] });
  q("yCihazView").append(cz.root);
  q("ySeg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ytab]"); if (!b || b.dataset.ytab === ytab) return;
    ytab = b.dataset.ytab;
    root.querySelectorAll("[data-ytab]").forEach((x) => x.setAttribute("aria-selected", String(x.dataset.ytab === ytab)));
    q("yOdaView").hidden = ytab !== "oda";
    q("yCihazView").hidden = ytab !== "cihaz";
    if (ytab === "cihaz" && connected) cz.load();
  });

  // ── Bağlantı ────────────────────────────────────────────────
  function setState(text, sev) {
    el.state.textContent = text;
    el.state.className = `badge sev-${sev}`;
  }

  function setBusy(b) {
    busy = b;
    el.connect.disabled = b;
    el.refresh.disabled = b || !connected;
    [el.server, el.user, el.pass, el.remember].forEach((i) => (i.disabled = b));
  }

  function showError(msg) {
    el.err.textContent = msg || "";
    el.err.hidden = !msg;
  }

  async function loadSettings() {
    try { cfg = await api("/api/ybdb/settings"); } catch { return; }
    if (!el.server.value) el.server.value = cfg.server;
    if (!el.user.value) el.user.value = cfg.user;
    el.remember.checked = cfg.remember;
    el.pass.placeholder = cfg.hasPass ? "••••••••" : "";
    if (cfg.connected) {
      connected = true;
      setState(`Bağlı · ${cfg.connectedServer}`, "ok");
      el.refresh.disabled = busy;
      if (!data) refresh();
    }
  }

  async function connect() {
    if (busy) return;
    showError("");
    if (!el.server.value.trim()) return showError("Sunucu adresi boş olamaz.");
    if (!el.user.value.trim()) return showError("Kullanıcı adı boş olamaz.");

    setBusy(true);
    setState("Bağlanıyor…", "warn");
    try {
      const body = { server: el.server.value, user: el.user.value, remember: el.remember.checked };
      if (passDirty) body.pass = el.pass.value;
      const r = await api("/api/ybdb/connect", { method: "POST", body });
      connected = true;
      passDirty = false;
      cfg.hasPass = el.remember.checked && (cfg.hasPass || !!body.pass);
      el.pass.value = ""; el.pass.placeholder = cfg.hasPass ? "••••••••" : "";
      setState(`Bağlı · ${r.server}`, "ok");
      cz.reset();
      setBusy(false);
      await refresh();
    } catch (e) {
      connected = false;
      setState("Bağlantı hatası", "error");
      showError(e.message);
      setBusy(false);
    }
  }

  async function refresh() {
    if (busy || !connected) return;
    showError("");
    setBusy(true);
    try {
      data = await api("/api/ybdb/data");
      if (selectedOda != null && !data.odalar.some((o) => o.id === selectedOda)) selectedOda = null;   // oda artık yok
      el.last.textContent = `Son güncelleme: ${data.zaman}`;
      renderAll();
      cz.yataklarChanged();
      if (ytab === "cihaz") { setBusy(false); await cz.load(); }
    } catch (e) {
      showError(e.message);
    } finally {
      setBusy(false);
    }
  }

  el.connect.addEventListener("click", connect);
  el.refresh.addEventListener("click", refresh);
  el.pass.addEventListener("input", () => { passDirty = true; });
  [el.server, el.user, el.pass].forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); }));

  // ── Filtre / sıralama ───────────────────────────────────────
  function visibleOdalar() {
    if (!data) return [];
    const s = tr(odaSearch.trim());
    let list = data.odalar.filter((o) => !s || [o.adi, o.bolumAdi, o.id].some((v) => tr(v).includes(s)));
    const c = ODA_COLS.find((x) => x.key === sortOda.key);
    if (c) list = [...list].sort((a, b) => compare(c.val(a), c.val(b), c.num) * sortOda.dir);
    return list;
  }

  function visibleYataklar() {
    if (!data) return [];
    const s = tr(yatakSearch.trim());
    let list = data.yataklar.filter((y) =>
      (selectedOda == null || y.odaId === selectedOda) &&
      (!sadeceBos || y.hastaId == null) &&
      (!s || [y.hastaAdi, y.hastaId, y.yatakAdi, y.odaAdi, y.bolumAdi].some((v) => tr(v).includes(s))));
    const c = YATAK_COLS.find((x) => x.key === sortYatak.key);
    if (c) list = [...list].sort((a, b) => compare(c.val(a), c.val(b), c.num) * sortYatak.dir);
    return list;
  }

  // ── Çizim ───────────────────────────────────────────────────
  const chip = (renk, text, soft) => {
    const c = unitColor(renk);
    return renk < 0
      ? esc(text) || DASH
      : `<span class="badge" style="background:${c}2E;color:var(--text)"><span class="gchip" style="background:${c};margin-right:6px"></span>${esc(text)}</span>`;
  };

  function headHtml(cols, sort) {
    return cols.map((c) => `<th data-k="${c.key}">${c.label}${sort.key === c.key ? `<span class="arr">${sort.dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("");
  }

  function renderSummary() {
    if (!data) { el.summary.hidden = true; return; }
    const toplam = data.yataklar.length;
    const dolu = data.yataklar.filter((y) => y.hastaId != null).length;
    const pct = toplam ? Math.round((100 * dolu) / toplam) : 0;
    el.summary.hidden = false;
    q("yDolu").textContent = dolu; q("yToplam").textContent = toplam; q("yPct").textContent = `%${pct}`;
    q("yBar").style.width = pct + "%";
    q("yOda").textContent = data.odalar.length; q("yTop2").textContent = toplam; q("yBos").textContent = toplam - dolu;
    el.legend.innerHTML = data.bolumler.map((b) =>
      `<span class="badge" style="background:${unitColor(b.renk)}2E"><span class="gchip" style="background:${unitColor(b.renk)};margin-right:6px"></span>${esc(b.ad)}</span>`).join("");
  }

  function renderOdalar() {
    el.odaHead.innerHTML = headHtml(ODA_COLS, sortOda);
    if (!data) { el.odaBody.innerHTML = `<tr><td class="empty" colspan="4">Bağlandıktan sonra listelenir.</td></tr>`; return; }
    const list = visibleOdalar();
    const total = data.odalar.length;
    el.odaCount.textContent = list.length === total ? `${total} oda` : `${list.length} / ${total} oda gösteriliyor`;
    el.odaBody.innerHTML = list.length ? list.map((o) => {
      const pct = o.yatakSayisi ? Math.round((100 * o.doluSayisi) / o.yatakSayisi) : 0;
      return `<tr class="item" data-id="${esc(o.id)}" style="cursor:pointer${o.id === selectedOda ? ";background:var(--row-selected)" : ""}">
        <td class="mono">${esc(o.id)}</td>
        <td title="${esc(o.adi)}">${chip(o.renk, o.adi)}</td>
        <td title="${esc(o.bolumAdi)}">${esc(o.bolumAdi) || DASH}</td>
        <td>${o.yatakSayisi ? `<div class="row tight" style="flex-wrap:nowrap"><span style="min-width:44px">${o.doluSayisi} / ${o.yatakSayisi}</span>
          <div class="progress" style="width:70px"><div style="width:${pct}%"></div></div></div>` : DASH}</td></tr>`;
    }).join("") : `<tr><td class="empty" colspan="4">Aramaya uyan oda yok.</td></tr>`;
  }

  function renderYataklar() {
    el.yatakHead.innerHTML = headHtml(YATAK_COLS, sortYatak);
    const oda = data?.odalar.find((o) => o.id === selectedOda);
    el.title.textContent = selectedOda == null ? "YATAKLAR · TÜMÜ" : `YATAKLAR · ${(oda?.adi ?? "").toLocaleUpperCase("tr")}`;
    el.all.hidden = selectedOda == null;
    if (!data) { el.yatakBody.innerHTML = `<tr><td class="empty" colspan="8">Bağlandıktan sonra listelenir.</td></tr>`; el.ozet.textContent = "Bağlandıktan sonra listelenir"; return; }

    const list = visibleYataklar();
    const dolu = list.filter((y) => y.hastaId != null).length;
    el.ozet.textContent = `${list.length} yatak  ·  ${dolu} dolu  ·  ${list.length - dolu} boş`;
    el.yatakBody.innerHTML = list.length ? list.map((y) => {
      const isDolu = y.hastaId != null;
      return `<tr class="item">
        <td><span class="badge ${isDolu ? "sev-info" : "sev-ok"}">${esc(y.durum)}</span></td>
        <td title="${esc(y.hastaAdi ?? "")}">${y.hastaAdi ? `<b>${esc(y.hastaAdi)}</b>` : `<span class="txt-muted">${DASH}</span>`}</td>
        <td class="mono">${esc(y.hastaId) || DASH}</td>
        <td title="${esc(y.yatakAdi)}">${esc(y.yatakAdi)}</td>
        <td class="mono">${esc(y.yatakId)}</td>
        <td title="${esc(y.odaAdi)}">${chip(y.renk, y.odaAdi)}</td>
        <td title="${esc(y.bolumAdi)}">${esc(y.bolumAdi) || DASH}</td>
        <td class="mono">${esc(y.basamak) || DASH}</td></tr>`;
    }).join("") : `<tr><td class="empty" colspan="8">Filtreye uyan yatak yok.</td></tr>`;
  }

  function renderAll() { renderSummary(); renderOdalar(); renderYataklar(); }

  // ── Etkileşim ───────────────────────────────────────────────
  el.odaBody.addEventListener("click", (e) => {
    const tr_ = e.target.closest("tr[data-id]"); if (!tr_) return;
    selectedOda = tr_.dataset.id === selectedOda ? null : tr_.dataset.id;
    renderOdalar(); renderYataklar();
  });
  el.all.addEventListener("click", () => { selectedOda = null; renderOdalar(); renderYataklar(); });

  el.odaHead.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-k]"); if (!th) return;
    sortOda = sortOda.key === th.dataset.k ? { key: th.dataset.k, dir: -sortOda.dir } : { key: th.dataset.k, dir: 1 };
    renderOdalar();
  });
  el.yatakHead.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-k]"); if (!th) return;
    sortYatak = sortYatak.key === th.dataset.k ? { key: th.dataset.k, dir: -sortYatak.dir } : { key: th.dataset.k, dir: 1 };
    renderYataklar();
  });

  el.odaSearch.addEventListener("input", debounce(() => { odaSearch = el.odaSearch.value; renderOdalar(); }, 120));
  el.yatakSearch.addEventListener("input", debounce(() => { yatakSearch = el.yatakSearch.value; renderYataklar(); }, 120));
  el.bosOnly.addEventListener("change", () => { sadeceBos = el.bosOnly.checked; renderYataklar(); });

  document.addEventListener("keydown", (e) => {
    if (root.offsetParent === null) return;                       // modül görünür değil
    if (e.key === "F5") { e.preventDefault(); refresh(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); el.yatakSearch.focus(); el.yatakSearch.select(); }
  });

  renderAll();

  return { root, onShow: loadSettings };
}
