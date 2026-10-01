// YBDB Odalar → "Cihazlar" sekmesi: dbo.Cihaz tablosunda ekle / güncelle / sil (yalnızca Id, Adi, CTS, IP, Port, YatakId).
// Yazma ajandaki CihazRepository'de (WPF ile aynı kod): güncelleme / silme, satır okunduğu haliyle değilse yapılmaz.
import { api } from "./api.js";
import { $, esc, toast, ICONS } from "./util.js";

const DASH = "—";
const COLS = [
  { key: "id", label: "Id", w: 70, num: true },
  { key: "adi", label: "Adi", w: null },
  { key: "cts", label: "CTS", w: 120 },
  { key: "ip", label: "IP", w: 140, mono: true },
  { key: "port", label: "Port", w: 90, mono: true },
  { key: "yatakId", label: "YatakId", w: 90, num: true },
];
const isIpv4 = (s) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s);
const tr = (s) => String(s ?? "").toLocaleLowerCase("tr");

/** getYataklar(): YBDB verisindeki yatak listesi (yatakId → yatak / oda adı); yoksa []. */
export function createCihazEditor({ getYataklar }) {
  const root = document.createElement("div");
  root.className = "stack";

  let list = [], loaded = false, busy = false;
  let search = "", showDeleted = false, sort = { key: "id", dir: 1 };
  let selected = null;        // { original: kayıt | null (yeni), form: {...} }

  root.innerHTML = `
    <div class="cz-grid">
      <section class="card">
        <div class="card-h row" style="justify-content:space-between">
          <span>Cihaz tablosu <span class="sm muted" style="text-transform:none;letter-spacing:0;font-weight:500" id="czCount"></span></span>
          <span class="row tight" style="text-transform:none;letter-spacing:0;font-weight:500">
            <button class="btn" id="czReload">${ICONS.redo} Yenile</button>
            <button class="btn primary" id="czNew">${ICONS.plus} Yeni cihaz</button>
          </span>
        </div>
        <div class="card-b row" style="padding-bottom:8px">
          <input type="search" id="czSearch" placeholder="Ara: ad, IP, port, yatak…" style="width:300px;max-width:100%">
          <label class="chk" title="Hastane yazılımının silindi olarak işaretlediği (SilinmeTarihi dolu) satırlar"><input type="checkbox" id="czDeleted"> Silinmiş işaretlileri göster</label>
        </div>
        <div class="table-wrap" style="max-height:calc(100vh - 360px)"><table class="fixed" style="min-width:620px">
          <colgroup>${COLS.map((c) => `<col${c.w ? ` style="width:${c.w}px"` : ""}>`).join("")}</colgroup>
          <thead><tr id="czHead"></tr></thead><tbody id="czBody"></tbody></table></div>
      </section>

      <section class="card cz-form" id="czForm">
        <div class="card-h" id="czFormTitle">Cihaz</div>
        <div class="card-b">
          <p class="sm muted" id="czHint" style="margin:0">Düzenlemek için soldan bir cihaz seçin ya da "Yeni cihaz"a basın.</p>
          <div id="czFields" hidden>
            <label class="field-label" for="czAdi">Adi</label>
            <input type="text" id="czAdi" maxlength="200" style="width:100%">
            <label class="field-label" for="czCts">CTS</label>
            <input type="text" id="czCts" maxlength="50" style="width:100%">
            <div class="row" style="gap:10px;flex-wrap:nowrap">
              <div style="flex:1"><label class="field-label" for="czIp">IP</label><input type="text" id="czIp" maxlength="50" style="width:100%" class="mono-input"></div>
              <div style="width:110px"><label class="field-label" for="czPort">Port</label><input type="text" id="czPort" maxlength="50" style="width:100%" class="mono-input"></div>
            </div>
            <label class="field-label" for="czYatak">YatakId</label>
            <input type="text" id="czYatak" list="czYatakList" inputmode="numeric" style="width:100%" class="mono-input" placeholder="boş bırakılabilir">
            <datalist id="czYatakList"></datalist>
            <div class="sm muted" id="czYatakInfo" style="margin-top:4px;min-height:18px"></div>
            <div class="txt-error" id="czErr" style="margin-top:8px" hidden></div>
            <div class="row" style="margin-top:14px">
              <button class="btn primary" id="czSave">Kaydet</button>
              <button class="btn" id="czCancel">Vazgeç</button>
              <span class="spacer" style="flex:1"></span>
              <button class="btn danger" id="czDelete" title="Satırı veritabanından kalıcı olarak siler (DELETE)">${ICONS.trash} Sil</button>
            </div>
            <p class="sm muted" style="margin:12px 0 0">Yalnızca bu beş alan yazılır; tablodaki diğer sütunlara dokunulmaz (yeni kayıtta boş kalır).
              Siz açtıktan sonra başkası bu satırı değiştirdiyse kayıt yapılmaz.</p>
          </div>
        </div>
      </section>
    </div>`;

  const q = (id) => $("#" + id, root);
  const el = {
    count: q("czCount"), reload: q("czReload"), add: q("czNew"), search: q("czSearch"), deleted: q("czDeleted"),
    head: q("czHead"), body: q("czBody"), title: q("czFormTitle"), hint: q("czHint"), fields: q("czFields"),
    adi: q("czAdi"), cts: q("czCts"), ip: q("czIp"), port: q("czPort"), yatak: q("czYatak"), yatakList: q("czYatakList"),
    yatakInfo: q("czYatakInfo"), err: q("czErr"), save: q("czSave"), cancel: q("czCancel"), del: q("czDelete"),
  };
  const inputs = [el.adi, el.cts, el.ip, el.port, el.yatak];

  // ── Veri ────────────────────────────────────────────────────
  async function load(keepId) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api("/api/ybdb/cihaz");
      list = r.cihazlar; loaded = true;
      fillYatakList();
      if (keepId != null) {
        const k = list.find((x) => x.id === keepId);
        if (k) select(k, true); else clearForm();
      } else if (selected?.original) {
        // Seçili satır yeni listede de varsa formu tazele (değişiklik yoksa)
        const k = list.find((x) => x.id === selected.original.id);
        if (!k) clearForm(); else if (!isDirty()) select(k, true);
      }
      render();
    } catch (e) {
      toast(e.message, 5000);
    } finally { setBusy(false); }
  }

  function setBusy(b) {
    busy = b;
    [el.reload, el.add, el.save, el.cancel, el.del, ...inputs].forEach((x) => (x.disabled = b));
    if (!b) updateButtons();
  }

  const yatakMap = () => new Map(getYataklar().map((y) => [String(y.yatakId), y]));

  function fillYatakList() {
    el.yatakList.innerHTML = getYataklar().map((y) =>
      `<option value="${esc(y.yatakId)}">${esc(y.odaAdi)} · ${esc(y.yatakAdi)}</option>`).join("");
  }

  // ── Liste ───────────────────────────────────────────────────
  function visible() {
    const s = tr(search.trim()), ym = yatakMap();
    let v = list.filter((k) => (showDeleted || !k.silinmis) &&
      (!s || [k.id, k.adi, k.cts, k.ip, k.port, k.yatakId, ym.get(String(k.yatakId))?.yatakAdi, ym.get(String(k.yatakId))?.odaAdi]
        .some((x) => tr(x).includes(s))));
    const c = COLS.find((x) => x.key === sort.key);
    if (c) v = [...v].sort((a, b) => {
      const x = a[c.key], y = b[c.key];
      if (c.num) return ((x ?? -Infinity) - (y ?? -Infinity)) * sort.dir;
      return String(x ?? "").localeCompare(String(y ?? ""), "tr", { numeric: true }) * sort.dir;
    });
    return v;
  }

  function render() {
    el.head.innerHTML = COLS.map((c) => `<th data-k="${c.key}">${c.label}${sort.key === c.key ? `<span class="arr">${sort.dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("");
    if (!loaded) { el.body.innerHTML = `<tr><td colspan="6" class="empty">Bağlandıktan sonra listelenir.</td></tr>`; el.count.textContent = ""; return; }
    const v = visible(), ym = yatakMap();
    const del = list.filter((k) => k.silinmis).length;
    el.count.textContent = `· ${v.length} / ${list.length}${del && !showDeleted ? ` (${del} silinmiş işaretli gizli)` : ""}`;
    el.body.innerHTML = v.length ? v.map((k) => {
      const y = k.yatakId != null ? ym.get(String(k.yatakId)) : null;
      const yTip = k.yatakId == null ? "" : y ? `${y.odaAdi} · ${y.yatakAdi}` : "Bu YatakId Yatak tablosunda yok";
      return `<tr class="item${selected?.original?.id === k.id ? " sel" : ""}${k.silinmis ? " off" : ""}" data-id="${k.id}" style="cursor:pointer"
          title="${k.silinmis ? "Hastane yazılımı bu satırı silindi olarak işaretlemiş (SilinmeTarihi dolu)" : ""}">
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
    const tr = e.target.closest("tr[data-id]"); if (!tr || busy) return;
    const k = list.find((x) => x.id === +tr.dataset.id);
    if (k && confirmDiscard()) select(k);
  });
  el.search.addEventListener("input", () => { search = el.search.value; render(); });
  el.deleted.addEventListener("change", () => { showDeleted = el.deleted.checked; render(); });
  el.reload.addEventListener("click", () => { if (confirmDiscard()) { if (isDirty()) clearForm(); load(); } });
  el.add.addEventListener("click", () => { if (confirmDiscard()) select(null); });

  // ── Form ────────────────────────────────────────────────────
  const formValues = () => ({ adi: el.adi.value.trim(), cts: el.cts.value.trim(), ip: el.ip.value.trim(), port: el.port.value.trim(), yatak: el.yatak.value.trim() });

  function select(k, keepScroll) {
    selected = { original: k ? { ...k } : null };
    el.hint.hidden = true; el.fields.hidden = false;
    el.title.textContent = k ? `Cihaz · Id ${k.id}${k.silinmis ? " · silinmiş işaretli" : ""}` : "Yeni cihaz";
    el.adi.value = k?.adi ?? ""; el.cts.value = k?.cts ?? ""; el.ip.value = k?.ip ?? ""; el.port.value = k?.port ?? "";
    el.yatak.value = k?.yatakId ?? "";
    selected.start = JSON.stringify(formValues());
    showErr("");
    updateYatakInfo(); updateButtons(); render();
    if (!keepScroll) el.adi.focus();
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
    if (!/^\d+$/.test(v)) { el.yatakInfo.textContent = "YatakId bir sayı olmalı"; el.yatakInfo.className = "sm txt-error"; return; }
    const y = yatakMap().get(v);
    el.yatakInfo.textContent = y ? `${y.odaAdi} · ${y.yatakAdi}${y.bolumAdi ? ` (${y.bolumAdi})` : ""}` : (getYataklar().length ? "Bu Id Yatak tablosunda yok" : "");
    el.yatakInfo.className = y || !getYataklar().length ? "sm muted" : "sm txt-error";
  }

  inputs.forEach((i) => i.addEventListener("input", () => { updateButtons(); if (i === el.yatak) updateYatakInfo(); }));
  inputs.forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter" && !el.save.disabled) save(); }));
  el.cancel.addEventListener("click", () => { if (!selected) return; if (selected.original) select(selected.original, true); else clearForm(); });

  function showErr(m) { el.err.textContent = m || ""; el.err.hidden = !m; }

  async function save() {
    if (!selected || busy) return;
    const f = formValues();
    showErr("");
    if (f.yatak && !/^\d+$/.test(f.yatak)) return showErr("YatakId bir tam sayı olmalı (ya da boş).");
    if (f.ip && !isIpv4(f.ip) && !confirm(`"${f.ip}" geçerli bir IPv4 adresi değil. Yine de kaydedilsin mi?`)) return;
    if (f.yatak && getYataklar().length && !yatakMap().has(f.yatak) && !confirm(`YatakId ${f.yatak} Yatak tablosunda yok. Yine de kaydedilsin mi?`)) return;
    if (selected.original == null && !f.adi && !confirm("Adi boş. Yine de eklensin mi?")) return;

    const changed = { id: selected.original?.id ?? 0, adi: f.adi || null, cts: f.cts || null, ip: f.ip || null, port: f.port || null,
                      yatakId: f.yatak ? +f.yatak : null };
    setBusy(true);
    try {
      const r = await api("/api/ybdb/cihaz", { method: "POST", body: { original: selected.original, changed } });
      toast(selected.original ? `Cihaz ${r.id} güncellendi` : `Cihaz ${r.id} eklendi`);
      selected.start = JSON.stringify(formValues());     // kaydedildi: yenilemede "değişiklik var" sorulmasın
      setBusy(false);
      await load(r.id);
    } catch (e) {
      showErr(e.message);
      setBusy(false);
    }
  }

  async function remove() {
    const k = selected?.original; if (!k || busy) return;
    if (!confirm(`Cihaz ${k.id}${k.adi ? ` (${k.adi})` : ""} veritabanından KALICI olarak silinsin mi?\n\nBu işlem geri alınamaz.`)) return;
    showErr("");
    setBusy(true);
    try {
      await api("/api/ybdb/cihaz/delete", { method: "POST", body: { original: k } });
      toast(`Cihaz ${k.id} silindi`);
      selected = null; clearForm();
      setBusy(false);
      await load();
    } catch (e) {
      showErr(e.message);
      setBusy(false);
    }
  }

  el.save.addEventListener("click", save);
  el.del.addEventListener("click", remove);
  render();

  return {
    root,
    load,
    /** Bağlantı koptu / değişti: liste ve form temizlenir. */
    reset() { list = []; loaded = false; selected = null; clearForm(); },
    /** YBDB verisi yenilendi: yatak adları değişmiş olabilir. */
    yataklarChanged() { fillYatakList(); if (selected) updateYatakInfo(); render(); },
    isDirty,
  };
}
