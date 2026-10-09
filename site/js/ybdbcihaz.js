// YBDB Odalar → "Cihazlar" sekmesi: dbo.Cihaz'da ekle / güncelle / sil + toplu ekle (yalnızca Id, Adi, CTS, IP, Port, YatakId).
// Yazma ajandaki CihazRepository'de (WPF ile aynı kod). Düzen WPF ile aynı: solda form, ortada tablo, sağda toplu ekle.
import { api } from "./api.js";
import { $, $$, esc, toast, ipFilter, sortCompare, ICONS } from "./util.js";

const DASH = "—";
const COLS = [
  { key: "id", label: "Id", w: 60, num: true },
  { key: "adi", label: "Adi", w: null },
  { key: "cts", label: "CTS", w: 70 },
  { key: "ip", label: "IP", w: 135, mono: true },
  { key: "port", label: "Port", w: 80, mono: true },
  { key: "yatakId", label: "YatakId", w: 85, num: true },
];

// Adi türü → seçilince IP ve Port'a yazılan değerler (WPF ile aynı). Alfabetik sıra.
const PRESETS = {
  drager: ["172.16.154.145", "9100"], efficia: ["172.16.154.254", "4000"], MeksVent: ["172.16.154.254", "6002"],
  mindray: ["172.16.154.145", "4601"], nk: ["172.16.154.145", "7998"], philips: ["172.16.154.145", "24105"],
  tms: ["172.16.154.254", "6000"], v8800: ["172.16.154.254", "9101"],
};
const ADI_OPTS = Object.keys(PRESETS).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
const IP_OPTS = ["172.16.154.254", "172.16.154.145"];
const PORT_OPTS = ["4000", "5000", "6000", "7000", "8000"];

const tr = (s) => String(s ?? "").toLocaleLowerCase("tr");
const isIpv4 = (s) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s);
const isPort = (s) => /^\d{1,5}$/.test(s) && +s <= 65535;

/** Yazılmakta olan (yarım da olabilir) değer geçerli mi: port (≤65535), digits3 (≤3 rakam). IP kutuları util.js ipFilter'ı kullanır. */
function validPartial(kind, text) {
  if (text === "") return true;
  if (kind === "port") return /^\d{1,5}$/.test(text) && +text <= 65535;
  if (kind === "digits3") return /^\d{1,3}$/.test(text);
  return true;
}

/** Bir metin kutusuna yalnızca o türe uyan girişi (yazma / yapıştırma) kabul ettirir. */
function attachFilter(input, kind) {
  input.addEventListener("beforeinput", (e) => {
    if (e.data == null) return;                                   // silme / biçim: serbest
    const el = e.target, next = el.value.slice(0, el.selectionStart) + e.data + el.value.slice(el.selectionEnd);
    if (!validPartial(kind, next)) e.preventDefault();
  });
}

/** <input list> + <datalist>: listeden seçilir ya da metin kutusu gibi yazılır. */
function combo(id, label, opts, { mono, filter, title } = {}) {
  const dl = `${id}_dl`;
  return `<label class="field-label" for="${id}">${esc(label)}</label>
    <input type="text" id="${id}" list="${dl}" autocomplete="off"${mono ? ' class="mono-input"' : ""}${title ? ` title="${esc(title)}"` : ""} style="width:100%">
    <datalist id="${dl}">${opts.map((o) => `<option value="${esc(o)}">`).join("")}</datalist>`;
}

/** getYataklar(): YBDB yatak listesi (yatakId → oda / yatak adı). */
export function createCihazEditor({ getYataklar }) {
  const root = document.createElement("div");
  root.className = "cz3";

  let list = [], loaded = false, busy = false;
  let search = "", showDeleted = false, sort = { key: "id", dir: 1 };
  let selected = null;        // { original: kayıt | null (yeni), start }

  root.innerHTML = `
    <!-- Sol: düzenleme formu -->
    <section class="card cz-side">
      <div class="card-h" id="czFormTitle">Cihaz</div>
      <div class="card-b">
        <p class="sm muted" id="czHint" style="margin:0">Düzenlemek için ortadaki tablodan bir cihaz seçin ya da "Yeni cihaz"a basın.</p>
        <div id="czFields" hidden>
          <label class="field-label" for="czId">Id</label>
          <input type="text" id="czId" class="mono-input" style="width:100%" readonly>
          ${combo("czAdi", "Adi *", ADI_OPTS, { title: "Listeden tür seçince IP ve Port kendiliğinden dolar; başka ad da yazılabilir (boş olamaz)" })}
          ${combo("czCts", "CTS", ["1"])}
          <div class="row" style="gap:10px;flex-wrap:nowrap;align-items:flex-start">
            <div style="flex:1">${combo("czIp", "IP", IP_OPTS, { mono: true })}</div>
            <div style="width:120px">${combo("czPort", "Port", PORT_OPTS, { mono: true })}</div>
          </div>
          ${combo("czYatak", "YatakId", [], { mono: true, title: "1–999; boş bırakılabilir" })}
          <div class="sm muted" id="czYatakInfo" style="margin-top:4px;min-height:18px"></div>
          <div class="txt-error" id="czErr" style="margin-top:8px" hidden></div>
          <div class="row" style="margin-top:14px">
            <button class="btn primary" id="czSave">Kaydet</button>
            <button class="btn" id="czCancel">Vazgeç</button>
            <span class="spacer" style="flex:1"></span>
            <button class="btn danger" id="czDelete" title="Satırı veritabanından kalıcı olarak siler (DELETE)">${ICONS.trash} Sil</button>
          </div>
          <p class="sm muted" style="margin:12px 0 0">Yalnızca bu beş alan yazılır; diğer sütunlara dokunulmaz (yeni kayıtta boş kalır).
            Siz açtıktan sonra başkası satırı değiştirdiyse kayıt yapılmaz.</p>
        </div>
      </div>
    </section>

    <!-- Orta: tablo -->
    <section class="card">
      <div class="card-h row" style="justify-content:space-between">
        <span>Cihaz tablosu <span class="sm muted" style="text-transform:none;letter-spacing:0;font-weight:500" id="czCount"></span></span>
        <span class="row tight" style="text-transform:none;letter-spacing:0;font-weight:500">
          <button class="btn" id="czReload">${ICONS.redo} Yenile</button>
          <button class="btn primary" id="czNew">${ICONS.plus} Yeni cihaz</button>
        </span>
      </div>
      <div class="card-b row" style="padding-bottom:8px">
        <input type="search" id="czSearch" placeholder="Ara: ad, IP, port, yatak…" style="flex:1;min-width:180px">
        <label class="chk" title="Hastane yazılımının silindi olarak işaretlediği (SilinmeTarihi dolu) satırlar"><input type="checkbox" id="czDeleted"> Silinmiş işaretlileri göster</label>
      </div>
      <div class="table-wrap" style="max-height:calc(100vh - 360px + var(--gain, 0px))"><table class="fixed" style="min-width:560px">
        <colgroup>${COLS.map((c) => `<col${c.w ? ` style="width:${c.w}px"` : ""}>`).join("")}</colgroup>
        <thead><tr id="czHead"></tr></thead><tbody id="czBody"></tbody></table></div>
    </section>

    <!-- Sağ: toplu ekle -->
    <section class="card cz-side">
      <div class="card-h">Toplu ekle</div>
      <div class="card-b">
        ${combo("bkAdi", "Adi *", ADI_OPTS, { title: "Listeden tür seçince IP ve Port dolar" })}
        ${combo("bkIp", "IP", IP_OPTS, { mono: true })}
        ${combo("bkPort", "Port", PORT_OPTS, { mono: true })}
        <div class="row" style="gap:16px;flex-wrap:nowrap;align-items:flex-start;margin-top:8px">
          <div>
            <label class="field-label">YatakId aralığı *</label>
            <div class="row tight" style="flex-wrap:nowrap">
              <input type="text" id="bkFrom" class="mono-input" inputmode="numeric" style="width:60px" title="Başlangıç (1–999)">
              <span class="muted">–</span>
              <input type="text" id="bkTo" class="mono-input" inputmode="numeric" style="width:60px" title="Bitiş (1–999)">
            </div>
          </div>
          <div style="flex:1">${combo("bkCts", "CTS", ["", "1"], { title: "Boş (varsayılan) ya da 1" })}</div>
        </div>
        <label class="chk" style="margin-top:12px" title="Aralıkta bu adla zaten kaydı olan yataklara ikinci kayıt eklenmez">
          <input type="checkbox" id="bkSkip" checked> Aynı adlı cihazı olan yatakları atla</label>
        <div class="sm muted" id="bkPreview" style="margin-top:12px;white-space:pre-line;min-height:18px"></div>
        <div class="txt-error" id="bkErr" style="margin-top:8px" hidden></div>
        <button class="btn primary" id="bkAdd" style="margin-top:12px">${ICONS.plus} Toplu ekle</button>
        <p class="sm muted" style="margin:10px 0 0">Hepsi tek işlemde eklenir: biri hata verirse hiçbiri eklenmez.</p>
      </div>
    </section>`;

  const q = (id) => $("#" + id, root);
  const el = {
    title: q("czFormTitle"), hint: q("czHint"), fields: q("czFields"), id: q("czId"),
    adi: q("czAdi"), cts: q("czCts"), ip: q("czIp"), port: q("czPort"), yatak: q("czYatak"), yatakDl: q("czYatak_dl"),
    yatakInfo: q("czYatakInfo"), err: q("czErr"), save: q("czSave"), cancel: q("czCancel"), del: q("czDelete"),
    count: q("czCount"), reload: q("czReload"), add: q("czNew"), search: q("czSearch"), deleted: q("czDeleted"),
    head: q("czHead"), body: q("czBody"),
    bkAdi: q("bkAdi"), bkIp: q("bkIp"), bkPort: q("bkPort"), bkFrom: q("bkFrom"), bkTo: q("bkTo"), bkCts: q("bkCts"),
    bkSkip: q("bkSkip"), bkPreview: q("bkPreview"), bkErr: q("bkErr"), bkAdd: q("bkAdd"),
  };
  const formInputs = [el.adi, el.cts, el.ip, el.port, el.yatak];

  ipFilter(el.ip); attachFilter(el.port, "port"); attachFilter(el.yatak, "digits3");   // IP: tüm IP alanlarıyla aynı kural (util.js)
  ipFilter(el.bkIp); attachFilter(el.bkPort, "port"); attachFilter(el.bkFrom, "digits3"); attachFilter(el.bkTo, "digits3");

  // ── Veri ────────────────────────────────────────────────────
  const yatakMap = () => new Map(getYataklar().map((y) => [String(y.yatakId), y]));

  function fillYatakList() {
    el.yatakDl.innerHTML = getYataklar().filter((y) => y.yatakId >= 1 && y.yatakId <= 999)
      .map((y) => `<option value="${esc(y.yatakId)}">${esc(y.odaAdi)} · ${esc(y.yatakAdi)}</option>`).join("");
  }

  async function load(keepId) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api("/api/ybdb/cihaz");
      list = r.cihazlar; loaded = true;
      fillYatakList();
      if (keepId != null) { const k = list.find((x) => x.id === keepId); if (k) select(k, true); else clearForm(); }
      else if (selected?.original) { const k = list.find((x) => x.id === selected.original.id); if (!k) clearForm(); else if (!isDirty()) select(k, true); }
      render(); updateBulkPreview();
    } catch (e) { toast(e.message, 5000); }
    finally { setBusy(false); }
  }

  function setBusy(b) {
    busy = b;
    [el.reload, el.add, el.save, el.cancel, el.del, el.bkAdd, ...formInputs].forEach((x) => (x.disabled = b));
    if (!b) updateButtons();
  }

  // ── Liste ───────────────────────────────────────────────────
  function visible() {
    const s = tr(search.trim()), ym = yatakMap();
    let v = list.filter((k) => (showDeleted || !k.silinmis) &&
      (!s || [k.id, k.adi, k.cts, k.ip, k.port, k.yatakId, ym.get(String(k.yatakId))?.yatakAdi, ym.get(String(k.yatakId))?.odaAdi].some((x) => tr(x).includes(s))));
    const c = COLS.find((x) => x.key === sort.key);
    if (c) v = [...v].sort((a, b) => sortCompare(a[c.key], b[c.key], sort.dir) || a.id - b.id);
    return v;
  }

  function render() {
    el.head.innerHTML = COLS.map((c) => `<th data-k="${c.key}">${c.label}${sort.key === c.key ? `<span class="arr">${sort.dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("");
    if (!loaded) { el.body.innerHTML = `<tr><td colspan="6" class="empty">Bağlandıktan sonra listelenir.</td></tr>`; el.count.textContent = ""; return; }
    const v = visible(), ym = yatakMap(), del = list.filter((k) => k.silinmis).length;
    el.count.textContent = `· ${v.length} / ${list.length}${del && !showDeleted ? ` (${del} silinmiş işaretli gizli)` : ""}`;
    el.body.innerHTML = v.length ? v.map((k) => {
      const y = k.yatakId != null ? ym.get(String(k.yatakId)) : null;
      const yTip = k.yatakId == null ? "" : y ? `${y.odaAdi} · ${y.yatakAdi}` : "Bu YatakId Yatak tablosunda yok";
      return `<tr class="item${selected?.original?.id === k.id ? " sel" : ""}${k.silinmis ? " off" : ""}" data-id="${k.id}" style="cursor:pointer"
          title="${k.silinmis ? "Hastane yazılımı bu satırı silindi olarak işaretlemiş" : ""}">
        <td class="mono">${k.id}</td><td title="${esc(k.adi)}">${esc(k.adi) || DASH}</td><td title="${esc(k.cts)}">${esc(k.cts) || DASH}</td>
        <td class="mono">${esc(k.ip) || DASH}</td><td class="mono">${esc(k.port) || DASH}</td>
        <td class="mono${k.yatakId != null && !y && getYataklar().length ? " txt-error" : ""}" title="${esc(yTip)}">${k.yatakId ?? DASH}</td></tr>`;
    }).join("") : `<tr><td colspan="6" class="empty">${list.length ? "Aramaya uyan cihaz yok." : "Cihaz tablosu boş."}</td></tr>`;
  }

  el.head.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-k]"); if (!th) return;
    sort = sort.key === th.dataset.k ? { key: th.dataset.k, dir: -sort.dir } : { key: th.dataset.k, dir: 1 };
    render();
  });
  el.body.addEventListener("click", (e) => {
    const trEl = e.target.closest("tr[data-id]"); if (!trEl || busy) return;
    const k = list.find((x) => x.id === +trEl.dataset.id);
    if (k && confirmDiscard()) select(k);
  });
  el.search.addEventListener("input", () => { search = el.search.value; render(); });
  el.deleted.addEventListener("change", () => { showDeleted = el.deleted.checked; render(); });
  el.reload.addEventListener("click", () => { if (confirmDiscard()) { if (isDirty()) clearForm(); load(); } });
  el.add.addEventListener("click", () => { if (confirmDiscard()) select(null); });

  // ── Form ────────────────────────────────────────────────────
  const formValues = () => ({ adi: el.adi.value.trim(), cts: el.cts.value.trim(), ip: el.ip.value.trim(), port: el.port.value.trim(), yatak: el.yatak.value.trim() });

  function select(k, keepFocus) {
    selected = { original: k ? { ...k } : null };
    el.hint.hidden = true; el.fields.hidden = false;
    el.title.textContent = k ? `Cihaz · Id ${k.id}${k.silinmis ? " · silinmiş işaretli" : ""}` : "Yeni cihaz";
    el.id.value = k ? k.id : "(yeni)";
    el.adi.value = k?.adi ?? ""; el.cts.value = k?.cts ?? ""; el.ip.value = k?.ip ?? ""; el.port.value = k?.port ?? "";
    el.yatak.value = k?.yatakId ?? "";
    selected.start = JSON.stringify(formValues());
    showErr(""); updateYatakInfo(); updateButtons(); render();
    if (!keepFocus) el.adi.focus();
  }

  function clearForm() {
    selected = null;
    el.hint.hidden = false; el.fields.hidden = true; el.title.textContent = "Cihaz";
    render();
  }

  const isDirty = () => !!selected && JSON.stringify(formValues()) !== selected.start;
  const confirmDiscard = () => !isDirty() || confirm("Kaydedilmemiş değişiklikler var. Vazgeçilsin mi?");

  function updateButtons() {
    if (!selected) return;
    el.save.disabled = busy || (selected.original != null && !isDirty());
    el.del.hidden = selected.original == null;
  }

  function updateYatakInfo() {
    const v = el.yatak.value.trim();
    if (!v) { el.yatakInfo.textContent = "Yatağa bağlı değil"; el.yatakInfo.className = "sm muted"; return; }
    if (!/^\d+$/.test(v) || +v < 1 || +v > 999) { el.yatakInfo.textContent = "YatakId 1–999 arası bir sayı olmalı"; el.yatakInfo.className = "sm txt-error"; return; }
    const y = yatakMap().get(v);
    el.yatakInfo.textContent = y ? `${y.odaAdi} · ${y.yatakAdi}${y.bolumAdi ? ` (${y.bolumAdi})` : ""}` : (getYataklar().length ? "Bu Id Yatak tablosunda yok" : "");
    el.yatakInfo.className = y || !getYataklar().length ? "sm muted" : "sm txt-error";
  }

  // Adi değişince (tam eşleşen tür) IP/Port doldur — WPF'teki preset mantığı
  el.adi.addEventListener("input", () => { const p = PRESETS[el.adi.value.trim()]; if (p) { el.ip.value = p[0]; el.port.value = p[1]; } });
  formInputs.forEach((i) => i.addEventListener("input", () => { updateButtons(); if (i === el.yatak) updateYatakInfo(); }));
  formInputs.forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter" && !el.save.disabled) save(); }));
  el.cancel.addEventListener("click", () => { if (!selected) return; selected.original ? select(selected.original, true) : clearForm(); });

  function showErr(m) { el.err.textContent = m || ""; el.err.hidden = !m; }

  async function save() {
    if (!selected || busy) return;
    const f = formValues();
    showErr("");
    if (!f.adi) return showErr("Adi boş olamaz: listeden bir cihaz türü seçin ya da yazın.");
    if (f.port && !isPort(f.port)) return showErr("Port 0–65535 arası bir sayı olmalı (ya da boş).");
    if (f.yatak && (!/^\d+$/.test(f.yatak) || +f.yatak < 1 || +f.yatak > 999)) return showErr("YatakId 1–999 arası bir sayı olmalı (ya da boş).");
    if (f.ip && !isIpv4(f.ip) && !confirm(`"${f.ip}" geçerli bir IPv4 adresi değil. Yine de kaydedilsin mi?`)) return;
    if (f.yatak && getYataklar().length && !yatakMap().has(f.yatak) && !confirm(`YatakId ${f.yatak} Yatak tablosunda yok. Yine de kaydedilsin mi?`)) return;

    const changed = { id: selected.original?.id ?? 0, adi: f.adi || null, cts: f.cts || null, ip: f.ip || null, port: f.port || null, yatakId: f.yatak ? +f.yatak : null };
    setBusy(true);
    try {
      const r = await api("/api/ybdb/cihaz", { method: "POST", body: { original: selected.original, changed } });
      toast(selected.original ? `Cihaz ${r.id} güncellendi` : `Cihaz ${r.id} eklendi`);
      selected.start = JSON.stringify(formValues());
      setBusy(false); await load(r.id);
    } catch (e) { showErr(e.message); setBusy(false); }
  }

  async function remove() {
    const k = selected?.original; if (!k || busy) return;
    if (!confirm(`Cihaz ${k.id}${k.adi ? ` (${k.adi})` : ""} veritabanından KALICI olarak silinsin mi?\n\nBu işlem geri alınamaz.`)) return;
    showErr(""); setBusy(true);
    try {
      await api("/api/ybdb/cihaz/delete", { method: "POST", body: { original: k } });
      toast(`Cihaz ${k.id} silindi`); selected = null; clearForm();
      setBusy(false); await load();
    } catch (e) { showErr(e.message); setBusy(false); }
  }

  el.save.addEventListener("click", save);
  el.del.addEventListener("click", remove);

  // ── Toplu ekle ──────────────────────────────────────────────
  const short = (a) => a.length <= 8 ? a.join(", ") : a.slice(0, 8).join(", ") + ` … +${a.length - 8}`;

  /** Eklenecek / atlanacak yataklar; hata varsa {error}. */
  function planBulk() {
    const adi = el.bkAdi.value.trim();
    if (!adi) return { error: "Adi seçin ya da yazın." };
    const from = +el.bkFrom.value, to = +el.bkTo.value;
    if (!/^\d+$/.test(el.bkFrom.value) || from < 1 || from > 999) return { error: "Başlangıç YatakId 1–999 olmalı." };
    if (!/^\d+$/.test(el.bkTo.value) || to < 1 || to > 999) return { error: "Bitiş YatakId 1–999 olmalı." };
    if (to < from) return { error: "Bitiş, başlangıçtan küçük olamaz." };
    if (el.bkPort.value.trim() && !isPort(el.bkPort.value.trim())) return { error: "Port 0–65535 arası bir sayı olmalı." };
    const ym = yatakMap();
    const existing = el.bkSkip.checked
      ? new Set(list.filter((k) => !k.silinmis && k.yatakId >= from && k.yatakId <= to && tr(k.adi) === tr(adi)).map((k) => k.yatakId))
      : new Set();
    const range = []; for (let y = from; y <= to; y++) range.push(y);
    const add = range.filter((y) => !existing.has(y));
    const noBed = getYataklar().length ? add.filter((y) => !ym.has(String(y))) : [];
    return { adi, cts: el.bkCts.value.trim() || null, ip: el.bkIp.value.trim() || null, port: el.bkPort.value.trim() || null, from, to, add, skipped: range.filter((y) => existing.has(y)), noBed };
  }

  function updateBulkPreview() {
    el.bkErr.hidden = true;
    const p = planBulk();
    if (p.error) {
      const empty = !el.bkAdi.value && !el.bkFrom.value && !el.bkTo.value;
      el.bkPreview.textContent = empty ? "" : p.error;
      el.bkPreview.className = empty ? "sm muted" : "sm txt-error";
      el.bkAdd.disabled = busy || true;
      return;
    }
    const parts = [`${p.add.length} kayıt eklenecek (YatakId ${p.from}–${p.to}, CTS ${p.cts ?? "boş"})`];
    if (p.skipped.length) parts.push(`${p.skipped.length} yatak atlanacak: zaten ${p.adi} var (${short(p.skipped)})`);
    if (p.noBed.length) parts.push(`${p.noBed.length} YatakId Yatak tablosunda yok (${short(p.noBed)})`);
    el.bkPreview.textContent = parts.join("\n");
    el.bkPreview.className = p.add.length ? "sm muted" : "sm txt-error";
    el.bkAdd.disabled = busy || p.add.length === 0;
  }

  [el.bkAdi, el.bkIp, el.bkPort, el.bkFrom, el.bkTo, el.bkCts].forEach((i) => i.addEventListener("input", updateBulkPreview));
  el.bkSkip.addEventListener("change", updateBulkPreview);
  el.bkAdi.addEventListener("input", () => { const p = PRESETS[el.bkAdi.value.trim()]; if (p) { el.bkIp.value = p[0]; el.bkPort.value = p[1]; updateBulkPreview(); } });

  el.bkAdd.addEventListener("click", async () => {
    if (busy) return;
    const p = planBulk();
    if (p.error || !p.add.length) return;
    if (p.ip && !isIpv4(p.ip) && !confirm(`"${p.ip}" geçerli bir IPv4 adresi değil. Yine de eklensin mi?`)) return;
    let msg = `${p.add.length} yeni cihaz kaydı eklenecek:\n\nAdi: ${p.adi}\nIP: ${p.ip ?? "(boş)"}\nPort: ${p.port ?? "(boş)"}\nCTS: ${p.cts ?? "(boş)"}\nYatakId: ${p.from}–${p.to}`;
    if (p.skipped.length) msg += `\n\n${p.skipped.length} yatak atlanacak (zaten ${p.adi} var): ${short(p.skipped)}`;
    if (p.noBed.length) msg += `\n\nUyarı: ${p.noBed.length} YatakId Yatak tablosunda yok: ${short(p.noBed)}`;
    if (!confirm(msg + "\n\nDevam edilsin mi?")) return;

    const rows = p.add.map((y) => ({ id: 0, adi: p.adi, cts: p.cts, ip: p.ip, port: p.port, yatakId: y }));
    el.bkErr.hidden = true; setBusy(true);
    try {
      const r = await api("/api/ybdb/cihaz/bulk", { method: "POST", body: { rows } });
      toast(`${r.ids.length} kayıt eklendi`);
      setBusy(false); await load(selected?.original?.id);
      el.bkPreview.textContent = `${r.ids.length} kayıt eklendi (Id ${Math.min(...r.ids)}–${Math.max(...r.ids)}).`;
      el.bkPreview.className = "sm muted";
    } catch (e) { el.bkErr.textContent = "Hiçbir kayıt eklenmedi: " + e.message; el.bkErr.hidden = false; setBusy(false); }
  });

  render();

  return {
    root, load,
    reset() { list = []; loaded = false; selected = null; clearForm(); updateBulkPreview(); },
    yataklarChanged() { fillYatakList(); if (selected) updateYatakInfo(); render(); updateBulkPreview(); },
    isDirty,
  };
}
