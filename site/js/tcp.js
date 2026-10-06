// TCP Dinleyici modülü: ajanın bulunduğu bilgisayarda bir portu dinler; bağlanan cihazları ve gönderdikleri veriyi
// canlı gösterir (karşıya hiçbir şey gönderilmez). Dinleme ajandaki TcpListenSession'da (WPF ile aynı kod);
// sayfa yeni satırları saniyede bir yoklar (sürekli ping gibi).
import { api } from "./api.js";
import { $, esc, storeGet, storeSet, toast, copyText, ICONS } from "./util.js";

const MAX_LINES = 3000;
const QUICK = [["2575", "HL7 2575"], ["4000", "4000"], ["5000", "5000"], ["6000", "6000"], ["7000", "7000"], ["8000", "8000"]];

const fmtBytes = (n) => (n < 1024 ? `${n} bayt` : n < 1048576 ? `${(n / 1024).toFixed(1).replace(/\.0$/, "")} KB` : `${(n / 1048576).toFixed(1).replace(/\.0$/, "")} MB`);

export function createTcp() {
  const root = document.createElement("div");
  root.className = "stack pstack";

  let session = null;        // { id, cursor, running, endpoint, active, total, bytes }
  let lines = [];            // [{ time, remote, kind, text, hex, bytes }]
  let hex = storeGet("rbox.tcp.hex") === "1";
  let pollTimer = null, polling = false, starting = false;

  root.innerHTML = `
    <section class="card">
      <div class="card-h row" style="justify-content:space-between">Dinleyici
        <span class="tcp-state" id="tState"><i></i><span>Durduruldu</span></span></div>
      <div class="card-b">
        <div class="row" style="align-items:flex-end">
          <div><label class="field-label" for="tPort">Port</label>
            <input type="text" id="tPort" class="mono" style="width:120px" maxlength="5" inputmode="numeric" autocomplete="off"
              title="Dinlenecek TCP portu (1-65535). Enter ile başlatılır."></div>
          <div><label class="field-label" for="tBind">Adres</label>
            <div class="row tight"><select id="tBind" style="width:300px" title="Hangi ağ kartında dinleneceği. 0.0.0.0 = bu bilgisayarın tüm adresleri."></select>
              <button class="btn icon" id="tRefresh" title="Ağ kartı listesini yenile">${ICONS.redo}</button></div></div>
          <button class="btn primary" id="tStart">${ICONS.play} Başlat</button>
          <button class="btn" id="tStop">${ICONS.stop} Durdur</button>
          <span class="spacer" style="flex:1"></span>
          <span class="chips" role="radiogroup" title="Gelen verinin gösterimi">
            <button class="chip" id="tText" role="radio" title="Metin (kontrol karakterleri <VT> <FS> gibi yazılır)">Metin</button>
            <button class="chip" id="tHex" role="radio" title="Onaltılık (hex) döküm">Hex</button>
          </span>
          <button class="btn" id="tCopy" title="Ekrandaki tüm satırları panoya kopyala">${ICONS.copy} Kopyala</button>
          <button class="btn" id="tClear" title="Ekranı temizle (dinleme sürer)">${ICONS.trash} Temizle</button>
        </div>
        <div class="row tight" style="margin-top:12px"><span class="sm muted">Hızlı:</span><span class="chips" id="tQuick"></span></div>
        <p class="sm muted" style="margin:10px 0 0">Ajanın çalıştığı bilgisayar girilen portu dinler; bağlanan cihazlar ve gönderdikleri veri aşağıda görünür.
          Karşı tarafa hiçbir şey gönderilmez. Başka bilgisayarlardan bağlantı gelmiyorsa Windows Güvenlik Duvarı bu portu engelliyor olabilir
          (ilk başlatmada Windows izin sorabilir). Sayfa kapanırsa dinleme birkaç dakika içinde kendiliğinden durur.</p>
      </div>
    </section>
    <section class="card">
      <div class="card-h">Gelen veri</div>
      <div class="card-b"><div class="tcp-con" id="tCon"></div></div>
    </section>`;

  const q = (id) => $("#" + id, root);
  const el = {
    port: q("tPort"), bind: q("tBind"), refresh: q("tRefresh"), start: q("tStart"), stop: q("tStop"),
    text: q("tText"), hex: q("tHex"), copy: q("tCopy"), clear: q("tClear"), quick: q("tQuick"), state: q("tState"), con: q("tCon"),
  };

  el.port.value = storeGet("rbox.tcp.port", "");
  el.quick.innerHTML = QUICK.map(([v, l]) => `<button class="chip" data-p="${v}">${esc(l)}</button>`).join("");

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
  const portValue = () => {
    const v = el.port.value.trim();
    const n = /^\d{1,5}$/.test(v) ? Number(v) : 0;
    return n >= 1 && n <= 65535 ? n : 0;
  };

  async function start() {
    const port = portValue();
    if (!port || session?.running || starting) return;
    starting = true; renderState();
    try {
      const bind = el.bind.value || "0.0.0.0";
      const r = await api("/api/tcp/start", { method: "POST", body: { port, bind } });
      storeSet("rbox.tcp.port", String(port));
      storeSet("rbox.tcp.bind", bind);
      session = { id: r.id, cursor: 0, running: true, endpoint: `${bind}:${port}`, active: 0, total: 0, bytes: 0 };
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
        Object.assign(session, { running: u.running, endpoint: u.endpoint, active: u.active, total: u.total, bytes: u.bytes });
        if (u.lines.length) {
          session.cursor = u.lines.at(-1).seq;
          append(u.lines);
        }
      }
      // Durdu ve son satırlar alındı: ajan oturumu kendisi siler, yoklama da biter
      if (!session.running && (u.gone || u.lines.length === 0)) { clearInterval(pollTimer); pollTimer = null; }
      renderState();
    } catch { /* ajan geçici olarak yanıt vermedi: bir sonraki turda yeniden denenir */ }
    finally { polling = false; }
  }

  // ── Görünüm ─────────────────────────────────────────────────
  function renderState() {
    const run = !!session?.running;
    el.state.classList.toggle("on", run);
    el.state.lastElementChild.textContent = run
      ? `Dinleniyor · ${session.endpoint} · ${session.active} açık bağlantı · toplam ${session.total} · ${fmtBytes(session.bytes)}`
      : "Durduruldu";
    el.start.disabled = run || starting || !portValue();
    el.stop.disabled = !run;
    el.port.disabled = el.bind.disabled = el.refresh.disabled = run || starting;
    el.quick.querySelectorAll("button").forEach((b) => (b.disabled = run || starting));
    el.text.setAttribute("aria-checked", String(!hex));
    el.hex.setAttribute("aria-checked", String(hex));
    el.copy.disabled = el.clear.disabled = lines.length === 0;
  }

  const head = (l) => (l.kind === "data" ? `← ${fmtBytes(l.bytes)}` : l.text);
  const lineHtml = (l) =>
    `<div class="tl ${l.kind}"><span class="t">${esc(l.time)}</span>${l.remote ? `<span class="r">${esc(l.remote)}</span>` : ""}<span class="h">${esc(head(l))}</span>` +
    (l.kind === "data" ? `<div class="b">${esc(hex ? l.hex : l.text)}</div>` : "") + `</div>`;

  function renderAll() {
    el.con.innerHTML = lines.length ? lines.map(lineHtml).join("")
      : `<div class="tcp-empty">Henüz veri yok. Portu girip Başlat'a basın; bağlanan cihazların gönderdiği veri burada görünür.</div>`;
    el.con.scrollTop = el.con.scrollHeight;
  }

  function append(newLines) {
    const atBottom = el.con.scrollHeight - el.con.scrollTop - el.con.clientHeight < 40;
    if (lines.length === 0) el.con.innerHTML = "";
    lines.push(...newLines);
    el.con.insertAdjacentHTML("beforeend", newLines.map(lineHtml).join(""));
    if (lines.length > MAX_LINES) {
      const drop = lines.length - MAX_LINES;
      lines.splice(0, drop);
      for (let i = 0; i < drop; i++) el.con.firstElementChild?.remove();
    }
    if (atBottom) el.con.scrollTop = el.con.scrollHeight;    // kullanıcı yukarı kaydırıp okuyorsa yerinde kalsın
  }

  const copyLine = (l) => {
    const h = `[${l.time}]${l.remote ? " " + l.remote : ""} ${head(l)}`;
    return l.kind === "data" ? h + "\r\n" + (hex ? l.hex : l.text).replace(/\n/g, "\r\n") : h;
  };

  // ── Olaylar ─────────────────────────────────────────────────
  el.port.addEventListener("input", () => {
    const v = el.port.value.replace(/\D/g, "").slice(0, 5);
    if (v !== el.port.value) el.port.value = v;
    renderState();
  });
  el.port.addEventListener("keydown", (e) => { if (e.key === "Enter") start(); });
  el.quick.addEventListener("click", (e) => {
    const b = e.target.closest("[data-p]"); if (!b || session?.running) return;
    el.port.value = b.dataset.p; renderState();
  });
  el.refresh.addEventListener("click", loadAddresses);
  el.start.addEventListener("click", start);
  el.stop.addEventListener("click", stop);
  const setHex = (v) => { if (hex === v) return; hex = v; storeSet("rbox.tcp.hex", v ? "1" : "0"); renderAll(); renderState(); };
  el.text.addEventListener("click", () => setHex(false));
  el.hex.addEventListener("click", () => setHex(true));
  el.copy.addEventListener("click", async () => {
    try { await copyText(lines.map(copyLine).join("\r\n") + "\r\n"); toast("Kopyalandı"); }
    catch { toast("Kopyalanamadı"); }
  });
  el.clear.addEventListener("click", () => { lines = []; renderAll(); renderState(); });

  let loaded = false;
  renderAll();
  renderState();

  return {
    root,
    onShow() {
      if (!loaded) { loaded = true; loadAddresses(); }
      if (!session?.running) el.port.focus();
    },
  };
}
