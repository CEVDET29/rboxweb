// Dosyalar modülü: Cihaz Güncelleme'nin cihaza gönderdiği dosyalar (updateFiles) — listele, düzenle, yükle, indir, sil, zip.
// Bu dosyalar hastaneye özeldir: yalnızca bu bilgisayardaki ajanla konuşulur, hiçbir yere gönderilmez.
import { api, blob } from "./api.js";
import { $, $$, esc, toast, ICONS } from "./util.js";

const DASH = "—";

/** Cihaz Güncelleme adımlarının aradığı dosyalar (UpdateCoordinator ile aynı adlar; Resources\ alt klasörü de aranır). */
const KNOWN = [
  { names: ["JsonSettings.txt"], use: "JsonSettings", note: "cihazın JsonSettings.json dosyası (YATAK ID satır bazlı değişir)" },
  { names: ["serialdevices.json"], use: "serialdevices.json" },
  { names: ["dhcpcd.txt"], use: "dhcpcd" },
  { names: ["wpa_supplicant.txt"], use: "wpa_supplicant" },
  { names: ["rclocal.txt"], use: "rc.local" },
  { names: [".bashrc", ".bashrc.txt"], use: ".bashrc" },
  { names: [".profile", ".profile.txt"], use: ".profile" },
  { names: [".nanorc", "Resources/.nanorc", "nanorc", "Resources/nanorc"], use: ".nanorc" },
  { names: ["net_status_banner.sh"], use: "net_status_banner.sh" },
  { names: ["net-status-banner@tty1.service", "Resources/net-status-banner@tty1.service"], use: "net-status-banner@tty1.svc" },
  { names: ["net_banner_login.sh"], use: "net_banner_login.sh" },
  { names: ["rasyoclean.sh"], use: "rasyoclean.sh" },
  { names: ["sw.bash", "Resources/sw.bash"], use: "sw -help ve logservice" },
  { names: ["serialworker.service", "Resources/serialworker.service"], use: "sw -help ve logservice" },
  { names: ["serialworker-serial.service", "Resources/serialworker-serial.service"], use: "sw -help ve logservice" },
  { names: ["serialworker_service.txt"], use: "serialworker.service" },
  { names: ["crontab.txt"], use: "Crontab" },
  { names: ["SerialWorkerServiceVol61.dll"], use: ".dll güncelle" },
  { pattern: /^rasyobox-.*\.tar\.gz$/i, label: "rasyobox-*.tar.gz", use: "Web server", note: "en yüksek sürümlü arşiv kullanılır" },
  { names: ["conspy_1.16-1_armhf.deb", "Resources/conspy_1.16-1_armhf.deb"], use: "conspy (çevrimdışı .deb)" },
];

const SOURCES = { cli: "Komut satırı", saved: "Kayıtlı", wpf: "WPF klasörü", default: "Varsayılan" };

const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1).replace(".", ",") + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B");
const base = (p) => p.split("/").pop();
const isJsonFile = (p) => /\.json$/i.test(p) || /^JsonSettings\.txt$/i.test(base(p));

export function createFiles(ctx) {
  const root = document.createElement("div");
  root.className = "stack";

  let info = { folder: "", source: "default", wpfFolder: "", wpfExists: false, defaultFolder: "", files: [] };
  let editing = null;                      // { path, orig, eol, bom, isNew }
  let pendingUploadName = null;            // "Beklenen dosyalar" satırındaki "Yükle": yüklenen dosya bu adla kaydedilir

  root.innerHTML = `
    <section class="card">
      <div class="card-h row" style="justify-content:space-between">KLASÖR <span class="badge sev-info" id="fSource"></span></div>
      <div class="card-b">
        <div class="row">
          <span class="mono" id="fPath" style="flex:1;min-width:240px;overflow-wrap:anywhere"></span>
          <button class="btn" id="fOpen" title="Klasörü bu bilgisayarda (sunucuda) açar">${ICONS.folder} Sunucuda aç</button>
          <button class="btn" id="fChange">Klasörü değiştir</button>
        </div>
        <div class="row" id="fChangeBox" style="margin-top:12px" hidden>
          <input type="text" id="fPathInput" class="mono-input" style="flex:1;min-width:280px" placeholder="C:\\Rasyomed\\RboxTools\\updateFiles" autocomplete="off">
          <button class="btn primary" id="fSave">Kaydet</button>
          <button class="btn" id="fAuto" title="Klasör seçimini temizle: WPF klasörü varsa o, yoksa varsayılan kullanılır">Otomatik</button>
          <button class="btn" id="fUseWpf" hidden></button>
        </div>
        <div class="txt-error sm" id="fErr" style="margin-top:8px" hidden></div>
        <div class="sm muted" style="margin-top:10px">Bu klasördeki dosyalar hastaneye özeldir: yalnızca bu bilgisayardaki ajanla konuşulur, hiçbir yere gönderilmez. GitHub'a koymayın.</div>
      </div>
    </section>

    <section class="card">
      <div class="card-h row" style="justify-content:space-between">BEKLENEN DOSYALAR <span class="sm muted" style="text-transform:none;letter-spacing:0;font-weight:500" id="fKnownSum"></span></div>
      <div class="table-wrap" style="max-height:340px"><table class="fixed" style="min-width:760px">
        <colgroup><col style="width:270px"><col><col style="width:130px"><col style="width:190px"></colgroup>
        <thead><tr><th style="cursor:default">Dosya</th><th style="cursor:default">Kullanıldığı yer</th><th style="cursor:default">Durum</th><th style="cursor:default"></th></tr></thead>
        <tbody id="fKnown"></tbody></table></div>
    </section>

    <section class="card" id="fAllCard">
      <div class="card-h row" style="justify-content:space-between">TÜM DOSYALAR <span class="sm muted" style="text-transform:none;letter-spacing:0;font-weight:500" id="fCount"></span></div>
      <div class="card-b row" style="padding-bottom:8px">
        <button class="btn" id="fUpload">${ICONS.upload} Dosya yükle</button>
        <input type="text" id="fNewName" placeholder="yeni-dosya.txt" style="width:200px" autocomplete="off">
        <button class="btn" id="fNew">${ICONS.plus} Yeni dosya</button>
        <span class="spacer" style="flex:1"></span>
        <button class="btn" id="fZip" title="Klasörün tamamını zip olarak indirir (günlük dosyası hariç): başka bir hastaneye taşımak için">${ICONS.down} Zip indir</button>
        <button class="btn" id="fImport" title="Zip'in içindekileri klasöre açar (var olan dosyaların üzerine yazar)">Zip yükle</button>
      </div>
      <div class="table-wrap" style="max-height:420px"><table class="fixed" style="min-width:720px">
        <colgroup><col><col style="width:90px"><col style="width:140px"><col style="width:190px"></colgroup>
        <thead><tr><th style="cursor:default">Dosya</th><th style="cursor:default">Boyut</th><th style="cursor:default">Değişiklik</th><th style="cursor:default"></th></tr></thead>
        <tbody id="fAll"></tbody></table></div>
      <div class="card-b sm muted" style="padding-top:8px">Dosyaları bu kartın üzerine sürükleyip bırakarak da yükleyebilirsiniz.</div>
    </section>

    <section class="card" id="fEditCard" hidden>
      <div class="card-h row" style="justify-content:space-between"><span>DÜZENLE · <span id="fEditName" style="text-transform:none;letter-spacing:0"></span></span>
        <span class="row tight" style="text-transform:none;letter-spacing:0"><span class="badge sev-muted" id="fJson" hidden></span><span class="sm muted" id="fStat"></span></span></div>
      <div class="card-b">
        <textarea class="editor" id="fEditor" spellcheck="false"></textarea>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="fSaveFile">Kaydet (Ctrl+S)</button>
          <button class="btn" id="fRevert">Geri al</button>
          <button class="btn" id="fClose">Kapat</button>
          <span class="sm muted" id="fInfo"></span>
        </div>
      </div>
    </section>`;

  const el = {
    source: $("#fSource", root), path: $("#fPath", root), changeBox: $("#fChangeBox", root), pathInput: $("#fPathInput", root),
    useWpf: $("#fUseWpf", root), err: $("#fErr", root), known: $("#fKnown", root), knownSum: $("#fKnownSum", root),
    all: $("#fAll", root), count: $("#fCount", root), newName: $("#fNewName", root),
    editCard: $("#fEditCard", root), editName: $("#fEditName", root), editor: $("#fEditor", root),
    stat: $("#fStat", root), json: $("#fJson", root), infoLine: $("#fInfo", root),
  };

  const fileInput = Object.assign(document.createElement("input"), { type: "file", multiple: true, hidden: true });
  const zipInput = Object.assign(document.createElement("input"), { type: "file", accept: ".zip", hidden: true });
  root.append(fileInput, zipInput);

  const showErr = (m) => { el.err.textContent = m || ""; el.err.hidden = !m; };

  // ── Listeleme ───────────────────────────────────────────────
  async function load() {
    try { info = await api("/api/files/list"); } catch (e) { toast(e.message, 4000); return; }
    render();
  }

  const find = (p) => info.files.find((f) => f.path.toLowerCase() === p.toLowerCase());

  function knownRow(k) {
    const hit = k.pattern ? info.files.find((f) => k.pattern.test(base(f.path))) : k.names.map(find).find(Boolean);
    const label = k.label ?? k.names[0];
    const upName = k.names?.[0] ?? "";
    return `<tr class="item">
      <td class="mono" title="${esc(k.names ? k.names.join("  |  ") : label)}">${esc(label)}</td>
      <td title="${esc(k.note ?? "")}">${esc(k.use)}</td>
      <td>${hit ? `<span class="badge sev-ok" title="${esc(hit.path)}">var · ${fmtSize(hit.size)}</span>` : `<span class="badge sev-warn">yok</span>`}</td>
      <td class="actions" style="text-align:right">
        ${hit?.text ? `<button class="btn mini" data-edit="${esc(hit.path)}">Düzenle</button>` : ""}
        <button class="btn mini" data-known-upload="${esc(upName)}" title="${upName ? `Seçilen dosya ${esc(upName)} adıyla kaydedilir` : "Dosya seçin"}">Yükle</button>
      </td></tr>`;
  }

  function render() {
    el.path.textContent = info.folder;
    el.source.textContent = SOURCES[info.source] ?? info.source;
    el.pathInput.disabled = el.changeBox.querySelector("#fSave").disabled = info.source === "cli";
    // WPF klasörü var ve şu an başka bir klasör kullanılıyorsa hızlı seçenek
    const wpfPath = info.wpfFolder;
    el.useWpf.hidden = !(info.wpfExists && info.folder.toLowerCase() !== wpfPath.toLowerCase() && info.source !== "cli");
    el.useWpf.textContent = "WPF klasörünü kullan";
    el.useWpf.title = wpfPath;

    const present = KNOWN.filter((k) => (k.pattern ? info.files.some((f) => k.pattern.test(base(f.path))) : k.names.some(find))).length;
    el.knownSum.textContent = `${present} / ${KNOWN.length} dosya var`;
    el.known.innerHTML = KNOWN.map(knownRow).join("");

    el.count.textContent = `${info.files.length} dosya`;
    el.all.innerHTML = info.files.length === 0
      ? `<tr><td class="empty" colspan="4">Klasör boş. Dosya yükleyin, yeni dosya oluşturun ya da bir zip paketini yükleyin.</td></tr>`
      : info.files.map((f) => `<tr class="item">
          <td class="mono" title="${esc(f.path)}">${esc(f.path)}${f.report ? ' <span class="badge sev-muted">günlük</span>' : ""}</td>
          <td>${fmtSize(f.size)}</td><td>${esc(f.modified)}</td>
          <td class="actions" style="text-align:right">
            ${f.text ? `<button class="btn mini" data-edit="${esc(f.path)}">Düzenle</button>` : ""}
            <button class="btn mini" data-download="${esc(f.path)}">İndir</button>
            <button class="btn mini" data-rename="${esc(f.path)}">Adı değiştir</button>
            <button class="btn mini" data-delete="${esc(f.path)}" style="color:var(--error-text)">Sil</button>
          </td></tr>`).join("");
  }

  // ── Klasör seçimi ───────────────────────────────────────────
  $("#fOpen", root).addEventListener("click", async () => {
    try { await api("/api/update/open", { method: "POST", body: { kind: "folder" } }); } catch (e) { toast(e.message, 4000); }
  });
  $("#fChange", root).addEventListener("click", () => {
    el.changeBox.hidden = !el.changeBox.hidden;
    if (!el.changeBox.hidden) { el.pathInput.value = info.folder; el.pathInput.focus(); el.pathInput.select(); }
  });
  async function saveFolder(path) {
    showErr("");
    try {
      await api("/api/update/workfolder", { method: "PUT", body: { path } });
      el.changeBox.hidden = true;
      closeEditor(true);
      await load();
    } catch (e) { showErr(e.message); }
  }
  $("#fSave", root).addEventListener("click", () => saveFolder(el.pathInput.value));
  el.pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveFolder(el.pathInput.value); });
  $("#fAuto", root).addEventListener("click", () => saveFolder(""));
  el.useWpf.addEventListener("click", () => saveFolder(info.wpfFolder));

  // ── Yükleme ─────────────────────────────────────────────────
  async function uploadFiles(files, forceName) {
    let n = 0;
    for (const f of files) {
      const name = forceName || f.name;
      if (find(name) && !confirm(`${name} zaten var. Üzerine yazılsın mı?`)) continue;
      try {
        await api(`/api/files/upload?path=${encodeURIComponent(name)}&overwrite=1`, { method: "POST", body: f });
        n++;
      } catch (e) { toast(`${name}: ${e.message}`, 5000); }
    }
    if (n) toast(`${n} dosya yüklendi`);
    await load();
  }

  $("#fUpload", root).addEventListener("click", () => { pendingUploadName = null; fileInput.click(); });
  fileInput.addEventListener("change", () => {
    const files = [...fileInput.files]; fileInput.value = "";
    const forced = pendingUploadName; pendingUploadName = null;
    if (files.length) uploadFiles(files, files.length === 1 ? forced : null);
  });

  // Sürükle-bırak (Dosyalar sekmesinde Excel yüklemesine dönüşmesin: olay burada durdurulur)
  root.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); $("#fAllCard", root).classList.add("dropzone-active"); });
  root.addEventListener("dragleave", (e) => { if (!root.contains(e.relatedTarget)) $("#fAllCard", root).classList.remove("dropzone-active"); });
  root.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation();
    $("#fAllCard", root).classList.remove("dropzone-active");
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) uploadFiles(files, null);
  });

  // ── Zip ─────────────────────────────────────────────────────
  $("#fZip", root).addEventListener("click", async () => {
    try {
      const b = await blob("/api/files/zip");
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(b), download: "updateFiles.zip" });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) { toast(e.message, 4000); }
  });
  $("#fImport", root).addEventListener("click", () => zipInput.click());
  zipInput.addEventListener("change", async () => {
    const f = zipInput.files?.[0]; zipInput.value = "";
    if (!f) return;
    if (!confirm(`${f.name} klasöre açılsın mı? Aynı adlı dosyaların üzerine yazılır.`)) return;
    try {
      const r = await api("/api/files/import", { method: "POST", body: f });
      toast(`${r.count} dosya içe aktarıldı`);
    } catch (e) { toast(e.message, 6000); }
    await load();
  });

  // ── Tablo işlemleri ─────────────────────────────────────────
  root.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-edit],[data-download],[data-rename],[data-delete],[data-known-upload]");
    if (!t) return;
    if (t.dataset.edit) return openEditor(t.dataset.edit);
    if (t.dataset.knownUpload !== undefined) { pendingUploadName = t.dataset.knownUpload || null; fileInput.click(); return; }
    if (t.dataset.download) {
      try {
        const b = await blob("/api/files/download?path=" + encodeURIComponent(t.dataset.download));
        const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(b), download: base(t.dataset.download) });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      } catch (err) { toast(err.message, 4000); }
      return;
    }
    if (t.dataset.rename) {
      const to = prompt("Yeni ad (alt klasör için Resources/ad biçimi):", t.dataset.rename);
      if (!to || to === t.dataset.rename) return;
      try { await api("/api/files/rename", { method: "POST", body: { from: t.dataset.rename, to: to.trim() } }); await load(); }
      catch (err) { toast(err.message, 4000); }
      return;
    }
    if (t.dataset.delete) {
      if (!confirm(`${t.dataset.delete} silinsin mi? Bu işlem geri alınamaz.`)) return;
      if (editing?.path === t.dataset.delete) closeEditor(true);
      try { await api("/api/files?path=" + encodeURIComponent(t.dataset.delete), { method: "DELETE" }); await load(); }
      catch (err) { toast(err.message, 4000); }
    }
  });

  // ── Düzenleyici ─────────────────────────────────────────────
  const dirty = () => editing && el.editor.value !== editing.orig;

  function updateEditorInfo() {
    if (!editing) return;
    const v = el.editor.value;
    const lines = v === "" ? 0 : v.split("\n").length;
    el.infoLine.textContent = `${lines} satır · ${v.length} karakter · satır sonu ${editing.eol === "crlf" ? "CRLF" : "LF"}${editing.bom ? " · BOM" : ""}`;
    el.stat.textContent = dirty() ? "kaydedilmemiş değişiklik var" : editing.savedAt ? `Kaydedildi ${editing.savedAt}` : "";
    if (isJsonFile(editing.path)) {
      let ok = true, msg = "Geçerli JSON";
      if (v.trim() === "") { ok = false; msg = "Boş"; }
      else { try { JSON.parse(v); } catch (err) { ok = false; msg = "Geçersiz JSON: " + err.message; } }
      el.json.hidden = false; el.json.textContent = msg; el.json.className = `badge sev-${ok ? "ok" : "error"}`;
    } else el.json.hidden = true;
  }
  el.editor.addEventListener("input", updateEditorInfo);

  async function openEditor(path, isNew = false) {
    if (dirty() && !confirm("Kaydedilmemiş değişiklikler var. Atılsın mı?")) return;
    if (isNew) editing = { path, orig: "", eol: "lf", bom: false, isNew: true };
    else {
      try {
        const r = await api("/api/files/read?path=" + encodeURIComponent(path));
        editing = { path: r.path, orig: r.text, eol: r.eol, bom: r.bom };
        el.editor.value = r.text;
      } catch (e) { toast(e.message, 5000); return; }
    }
    if (isNew) el.editor.value = "";
    el.editName.textContent = editing.path;
    el.editCard.hidden = false;
    updateEditorInfo();
    el.editCard.scrollIntoView({ behavior: "smooth", block: "start" });
    el.editor.focus();
  }

  function closeEditor(force = false) {
    if (!force && dirty() && !confirm("Kaydedilmemiş değişiklikler var. Kapatılsın mı?")) return;
    editing = null; el.editCard.hidden = true; el.editor.value = "";
  }

  async function saveFile() {
    if (!editing) return;
    const text = el.editor.value;
    if (isJsonFile(editing.path) && text.trim() !== "") {
      try { JSON.parse(text); }
      catch (err) { if (!confirm(`JSON geçersiz görünüyor (${err.message}).\n\nYine de kaydedilsin mi?`)) return; }
    }
    try {
      await api("/api/files/write", { method: "PUT", body: { path: editing.path, text, eol: editing.eol, bom: editing.bom } });
      editing.orig = text; editing.isNew = false; editing.savedAt = new Date().toLocaleTimeString("tr-TR");
      updateEditorInfo();
      await load();
    } catch (e) { toast(e.message, 6000); }
  }

  $("#fSaveFile", root).addEventListener("click", saveFile);
  $("#fRevert", root).addEventListener("click", () => { if (editing) { el.editor.value = editing.orig; updateEditorInfo(); } });
  $("#fClose", root).addEventListener("click", () => closeEditor());
  el.editor.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveFile(); } });

  // Yeni dosya
  function newFile() {
    const name = el.newName.value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!name || name.includes("..") || name.includes(":")) return toast("Geçerli bir dosya adı girin.");
    if (find(name)) return toast("Bu adla bir dosya zaten var.");
    el.newName.value = "";
    openEditor(name, true);
  }
  $("#fNew", root).addEventListener("click", newFile);
  el.newName.addEventListener("keydown", (e) => { if (e.key === "Enter") newFile(); });

  render();
  return { root, onShow: load, isBusy: () => false };
}
