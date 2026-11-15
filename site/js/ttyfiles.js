// TTY panelinin dosya paneli (WPF RemoteFilesPanel karşılığı): cihazda gezinme, sık kullanılanlar, yükle / indir,
// yeni klasör, yeniden adlandır, sil, nano ile aç, .deb kur, "bu klasörde TTY1'i aç". İşlemler ajandadır
// (/api/control/files/*: WPF ile aynı RemoteFiles; SFTP, yetki yetmezse sudo).
import { api, blob } from "./api.js";
import { esc, toast, storeGet, storeSet, sortCompare, ICONS } from "./util.js";

const HOME = "/home/pi";
const DEFAULT_FAVS = ["/home/pi/", "/var/www/consoleApps/publish/", "/etc/", "/etc/systemd/system/"];
const TEXT_EXT = new Set(("txt conf cfg cnf ini config properties toml env py sh bash js ts json xml yaml yml service timer socket target " +
  "mount path network netdev link rules list desktop log md csv html htm css php sql lua c h cpp cs bak old orig sample local csproj sln slnx").split(" "));

const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const I = {
  back: svg('<path d="M19 12H5m0 0l6-6m-6 6l6 6"/>'),
  fwd: svg('<path d="M5 12h14m0 0l-6-6m6 6l-6 6"/>'),
  up: svg('<path d="M12 19V5m0 0l-6 6m6-6l6 6"/>'),
  home: svg('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>'),
  newDir: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6m-3-3h6"/>'),
  star: svg('<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  file: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'),
  link: svg('<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
};

const Q = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
const join = (dir, name) => (dir.endsWith("/") ? dir : dir + "/") + name;
const parent = (p) => { const t = p.replace(/\/+$/, ""); const i = t.lastIndexOf("/"); return i <= 0 ? "/" : t.slice(0, i); };
const isProtected = (p) => { const t = p.trim().replace(/\/+$/, ""); return !t || (t.match(/\//g) || []).length <= 1; };
const fmtSize = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} KB`
  : b < 1073741824 ? `${(b / 1048576).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} MB` : `${(b / 1073741824).toLocaleString("tr-TR", { maximumFractionDigits: 2 })} GB`;
const fmtDate = (ms) => { if (!ms) return ""; const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; };
function isText(e) {
  const n = e.name.replace(/^\.+/, ""), dot = n.lastIndexOf(".");
  return dot >= 0 ? TEXT_EXT.has(n.slice(dot + 1).toLowerCase()) : e.size < 262144 && !e.perms.includes("x");
}
const validName = (n) => n && n !== "." && n !== ".." && !/[/\\\x00-\x1f]/.test(n);
const readJson = (k, d) => { try { return JSON.parse(storeGet(k) ?? "") ?? d; } catch { return d; } };

/** ip: cihaz; runInTty(cmd): TTY1'e geçip komutu + Enter gönderir. */
export function createFilesPanel({ ip, runInTty }) {
  const root = document.createElement("div");
  root.className = "rf";
  root.tabIndex = -1;
  root.innerHTML = `
    <div class="rf-bar">
      <span class="btn-group"><button class="btn icon" data-a="back" title="Geri (Alt+Sol)">${I.back}</button><button class="btn icon" data-a="fwd" title="İleri (Alt+Sağ)">${I.fwd}</button><button class="btn icon" data-a="up" title="Üst klasör (cd ..) · Backspace">${I.up}</button><button class="btn icon" data-a="home" title="Ana klasör (${HOME}) · Alt+Home">${I.home}</button><button class="btn icon" data-a="refresh" title="Yenile (F5)">${ICONS.redo}</button></span>
      <span class="btn-group"><button class="btn icon" data-a="mkdir" title="Yeni klasör">${I.newDir}</button><button class="btn icon" data-a="upload" title="Yükle · bilgisayardan dosya seçin (ya da panele sürükleyin)">${ICONS.upload}</button><button class="btn icon" data-a="work" title="updateFiles'ten yükle · ajanın updateFiles klasöründeki dosyaları gönderir">${ICONS.folder}</button><button class="btn icon" data-a="download" title="Seçilenleri indir (birden çoksa / klasörse zip)">${ICONS.down}</button><button class="btn icon" data-a="rename" title="Yeniden adlandır (F2)">${ICONS.pencil}</button><button class="btn icon" data-a="delete" title="Seçilenleri sil (Delete)">${ICONS.trash}</button></span>
      <span class="btn-group"><button class="btn icon" data-a="fav" title="Bu konumu sık kullanılanlara ekle">${I.star}</button><button class="btn icon" data-a="hidden" aria-pressed="false" title="Gizli dosyaları göster">${I.eye}</button><button class="btn icon" data-a="cdtty" title="Bu klasörde TTY1'i aç (TTY1'e cd komutu gönderir)">${ICONS.term}</button></span>
    </div>
    <div class="rf-path" title="Klasöre gitmek için parçaya tıklayın · yol yazmak için boş yere tıklayın"><div class="rf-crumbs"></div>
      <input type="text" class="mono-input rf-pathbox" hidden spellcheck="false" autocomplete="off" title="Klasör yolu · Enter: git · Esc: vazgeç"></div>
    <div class="rf-favs"></div>
    <div class="rf-list"><table class="rf-t"><thead><tr><th data-s="name">Ad</th><th data-s="size">Boyut</th><th data-s="mtime">Değiştirilme</th><th data-s="perms">İzinler</th></tr></thead><tbody></tbody></table></div>
    <div class="rf-st sm"></div>
    <input type="file" multiple hidden class="rf-file">
    <div class="rf-menu" hidden></div>
    <div class="rf-work" hidden></div>`;

  const q = (s) => root.querySelector(s);
  const crumbs = q(".rf-crumbs"), pathBox = q(".rf-pathbox"), favsEl = q(".rf-favs"), tbody = q("tbody"), thead = q("thead"),
    st = q(".rf-st"), fileIn = q(".rf-file"), menu = q(".rf-menu"), workEl = q(".rf-work"), listEl = q(".rf-list");

  let path = null, all = [], busy = false, closed = false, anchor = null;
  const back = [], fwd = [], sel = new Set();
  let sort = readJson("rbox.rf.sort", { key: "name", desc: false });
  let showHidden = storeGet("rbox.rf.hidden") === "1";
  let favs = readJson("rbox.rf.favs", DEFAULT_FAVS);

  function status(t, err = false) { st.textContent = t || ""; st.classList.toggle("err", err); }
  const visible = () => {
    let v = all.filter((e) => showHidden || !e.name.startsWith("."));
    const k = sort.key, dir = sort.desc ? -1 : 1;
    v = [...v].sort((a, b) => (b.dir - a.dir) || sortCompare(k === "name" ? a.name.toLocaleLowerCase("tr") : a[k], k === "name" ? b.name.toLocaleLowerCase("tr") : b[k], dir));
    return v;
  };
  const selected = () => all.filter((e) => sel.has(e.path));

  // ── Çizim ───────────────────────────────────────────────────
  function render() {
    for (const th of thead.querySelectorAll("th")) th.innerHTML = th.textContent.replace(/[▲▼]/g, "") + (th.dataset.s === sort.key ? `<span class="arr">${sort.desc ? "▼" : "▲"}</span>` : "");
    const v = visible();
    tbody.innerHTML = v.length ? v.map((e) => `<tr data-p="${esc(e.path)}" class="${sel.has(e.path) ? "sel" : ""}" title="${esc(e.path)}">
      <td class="rf-n"><span class="rf-i${e.dir ? " d" : ""}">${e.dir ? ICONS.folder : e.link ? I.link : I.file}</span>${esc(e.name)}</td>
      <td class="rf-num">${e.dir ? "" : fmtSize(e.size)}</td><td class="mono">${fmtDate(e.mtime)}</td><td class="mono">${esc(e.perms)}</td></tr>`).join("")
      : `<tr><td colspan="4" class="empty">${path == null ? "Yükleniyor…" : "Klasör boş."}</td></tr>`;
    q('[data-a="back"]').disabled = !back.length || busy;
    q('[data-a="fwd"]').disabled = !fwd.length || busy;
    q('[data-a="up"]').disabled = !path || path === "/" || busy;
    const s = selected();
    q('[data-a="download"]').disabled = !s.length || busy;
    q('[data-a="rename"]').disabled = s.length !== 1 || busy;
    q('[data-a="delete"]').disabled = !s.length || busy;
    for (const a of ["home", "refresh", "mkdir", "upload", "work", "cdtty"]) q(`[data-a="${a}"]`).disabled = busy;
    const h = q('[data-a="hidden"]');
    h.setAttribute("aria-pressed", String(showHidden)); h.title = showHidden ? "Gizli dosyalar gösteriliyor (gizle)" : "Gizli dosyaları göster";
  }

  function renderPath() {
    if (!path) { crumbs.innerHTML = ""; return; }
    const parts = path.split("/").filter(Boolean);
    let acc = "";
    crumbs.innerHTML = `<button class="rf-c" data-go="/">/</button>` + parts.map((p) => {
      acc += "/" + p;
      return `<span class="rf-sep">›</span><button class="rf-c" data-go="${esc(acc)}">${esc(p)}</button>`;
    }).join("");
    crumbs.scrollLeft = crumbs.scrollWidth;
  }

  function renderFavs() {
    favsEl.innerHTML = favs.map((f) => `<span class="rf-fav" data-fav="${esc(f)}" title="${esc(f)}">${I.star}<span>${esc(f.replace(/\/+$/, "").split("/").pop() || "/")}</span><button class="rf-x" data-unfav="${esc(f)}" title="Sık kullanılanlardan çıkar">✕</button></span>`).join("");
    favsEl.hidden = !favs.length;
  }
  const saveFavs = () => storeSet("rbox.rf.favs", JSON.stringify(favs));

  // ── Ajan çağrıları ──────────────────────────────────────────
  const call = (op, body) => api(`/api/control/files/${op}`, { method: "POST", body: { ip, ...body } });

  /** Uzun işlem: düğmeler kilitlenir, durum satırı yazar; sonunda (istenirse) liste yenilenir. */
  async function run(label, work, done, refresh = true) {
    if (busy || closed) return false;
    busy = true; render(); status(label);
    try {
      await work();
      busy = false;
      if (refresh) await load(path, false);
      status(typeof done === "function" ? done() : done);
      return true;
    } catch (e) {
      busy = false; render(); status(e.message, true);
      return false;
    }
  }

  async function load(p, clearSel = true) {
    if (closed) return false;
    busy = true; render();
    try {
      const r = await call("list", { path: p });
      if (closed) return false;
      path = r.path; all = r.items;
      if (clearSel) sel.clear(); else for (const s of [...sel]) if (!all.some((e) => e.path === s)) sel.delete(s);
      busy = false; renderPath(); render();
      const n = all.length, hid = all.filter((e) => e.name.startsWith(".")).length;
      status(`${n} öğe` + (hid && !showHidden ? ` (${hid} gizli)` : ""));
      return true;
    } catch (e) {
      busy = false; render(); status(e.message, true);
      return false;
    }
  }

  async function navigate(p, record = true) {
    if (busy) return;
    const prev = path;
    if (await load(p) && record && prev && prev !== path) { back.push(prev); fwd.length = 0; render(); }
  }
  async function goBack() { if (!back.length || busy) return; const p = back.pop(); if (path) fwd.push(path); if (!(await load(p))) { fwd.pop(); back.push(p); } render(); }
  async function goFwd() { if (!fwd.length || busy) return; const p = fwd.pop(); if (path) back.push(path); if (!(await load(p))) { back.pop(); fwd.push(p); } render(); }
  const goUp = () => path && path !== "/" && navigate(parent(path));

  // ── İşlemler ────────────────────────────────────────────────
  function open(e) {
    if (e.dir) navigate(e.path);
    else if (isText(e)) nano(e);
    else download([e]);
  }
  function nano(e) {
    runInTty(`sudo nano ${Q(e.path)}`);
    status(`${e.name} TTY1'de nano ile açıldı · kaydet: Ctrl+O, Enter · çık: Ctrl+X`);
  }
  function install(e) {
    if (!confirm(`${e.name} paketi cihaza kurulsun mu?\n\nTTY1'de çalışacak komut:\nsudo apt install -y ${Q(e.path)}\n\nGereken bağımlılıklar da kurulur; ilerlemeyi TTY1 ekranında izleyin.`)) return;
    runInTty(`sudo apt install -y ${Q(e.path)}`);
    status(`${e.name} kuruluyor · TTY1'de izleyin`);
  }

  async function download(list = selected()) {
    if (!list.length) return;
    const name = list.length === 1 ? (list[0].dir ? list[0].name + ".zip" : list[0].name) : "dosyalar.zip";
    const items = JSON.stringify(list.map((e) => ({ path: e.path, dir: e.dir })));
    let b = null;
    const ok = await run("İndiriliyor…", async () => {
      b = await blob(`/api/control/files/download?ip=${encodeURIComponent(ip)}&items=${encodeURIComponent(items)}`);
    }, `${name} indirildi (tarayıcının İndirilenler klasörü).`, false);
    if (!ok || !b) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  async function mkdir() {
    if (!path || busy) return;
    const n = prompt("Yeni klasör adı:", "yeni klasör")?.trim();
    if (!n) return;
    if (!validName(n)) return status("Geçersiz ad: / ve kontrol karakterleri kullanılamaz.", true);
    const p = join(path, n);
    if (await run("Klasör oluşturuluyor…", () => call("mkdir", { path: p }), `${n} oluşturuldu.`)) { sel.clear(); sel.add(p); render(); }
  }

  async function rename() {
    const s = selected(); if (s.length !== 1 || busy) return;
    const e = s[0];
    if (isProtected(e.path)) return status(`${e.path} korumalı bir klasör, adı değiştirilemez.`, true);
    const n = prompt("Yeni ad:", e.name)?.trim();
    if (!n || n === e.name) return;
    if (!validName(n)) return status("Geçersiz ad: / ve kontrol karakterleri kullanılamaz.", true);
    const to = join(parent(e.path), n);
    if (await run("Yeniden adlandırılıyor…", () => call("rename", { path: e.path, to }), `${e.name} → ${n}`)) { sel.clear(); sel.add(to); render(); }
  }

  async function remove() {
    const s = selected(); if (!s.length || busy) return;
    const prot = s.find((e) => isProtected(e.path));
    if (prot) return status(`${prot.path} korumalı bir klasör, silinemez.`, true);
    const what = s.length === 1 ? `"${s[0].name}"${s[0].dir ? " klasörü ve içindekiler" : ""}` : `${s.length} öğe`;
    if (!confirm(`${what} cihazdan KALICI olarak silinsin mi?\n\nBu işlem geri alınamaz.`)) return;
    await run("Siliniyor…", () => call("delete", { paths: s.map((e) => e.path) }), `${s.length} öğe silindi.`);
  }

  async function upload(files) {
    if (!path || busy || !files.length) return;
    const dir = path;
    let names;
    try { names = (await call("exists", { path: dir, names: files.map((f) => f.name) })).names; }
    catch (e) { return status(e.message, true); }
    if (names.length && !confirm(`${dir} içinde şunlar zaten var, üzerine yazılsın mı?\n\n${names.slice(0, 10).join("\n")}${names.length > 10 ? `\n… +${names.length - 10}` : ""}`)) return;
    let i = 0;
    await run("Yükleniyor…", async () => {
      for (const f of files) {
        status(`Yükleniyor ${++i}/${files.length}: ${f.name}`);
        await api(`/api/control/files/upload?ip=${encodeURIComponent(ip)}&dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
      }
    }, () => `${files.length} dosya yüklendi → ${dir}`);
    sel.clear(); for (const f of files) sel.add(join(dir, f.name)); render();
  }

  // updateFiles'ten yükle: ajanın updateFiles klasörü listelenir, seçilenler doğrudan cihaza gönderilir
  async function openWork() {
    if (!path || busy) return;
    let r;
    try { r = await api("/api/files/list"); } catch (e) { return status(e.message, true); }
    const files = (r.files || []).filter((f) => !f.report);
    workEl.innerHTML = `<div class="rf-work-h"><b>updateFiles</b><span class="sm muted" title="${esc(r.folder)}">${esc(r.folder)}</span></div>
      <div class="rf-work-l">${files.length ? files.map((f) => `<label class="chk"><input type="checkbox" value="${esc(f.path)}"><span class="mono">${esc(f.path)}</span><span class="sm muted">${fmtSize(f.size)}</span></label>`).join("") : `<div class="empty">Klasör boş.</div>`}</div>
      <div class="rf-work-f"><span class="sm muted">Hedef: ${esc(path)}</span><button class="btn" data-w="cancel">Vazgeç</button><button class="btn primary" data-w="send" disabled>Gönder</button></div>`;
    workEl.hidden = false;
  }
  workEl.addEventListener("change", () => { workEl.querySelector('[data-w="send"]').disabled = !workEl.querySelector("input:checked"); });
  workEl.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-w]"); if (!b) return;
    if (b.dataset.w === "cancel") { workEl.hidden = true; return; }
    const names = [...workEl.querySelectorAll("input:checked")].map((i) => i.value);
    const base = names.map((n) => n.split(/[\\/]/).pop());
    let ex = [];
    try { ex = (await call("exists", { path, names: base })).names; } catch (err) { return status(err.message, true); }
    if (ex.length && !confirm(`${path} içinde şunlar zaten var, üzerine yazılsın mı?\n\n${ex.join("\n")}`)) return;
    workEl.hidden = true;
    const dir = path;
    await run("updateFiles'ten yükleniyor…", () => call("upload-work", { path: dir, names }), `${names.length} dosya yüklendi → ${dir}`);
  });

  // ── Sağ tık menüsü ──────────────────────────────────────────
  function showMenu(x, y) {
    const s = selected(), one = s.length === 1 ? s[0] : null;
    const items = [
      one && ["open", one.dir ? "Aç" : isText(one) ? "Aç (TTY1'de nano)" : "Aç (indir)"],
      one && !one.dir && ["nano", "nano ile aç (TTY1)"],
      one && !one.dir && /\.deb$/i.test(one.name) && ["install", "Kur (sudo apt install)"],
      s.length && ["download", "İndir"],
      one && ["rename", "Yeniden adlandır (F2)"],
      s.length && ["delete", "Sil (Delete)"],
      "-",
      ["copy", one ? "Yolu kopyala" : "Klasör yolunu kopyala"],
      ["mkdir", "Yeni klasör"],
      ["upload", "Yükle…"],
      ["cdtty", "Bu klasörde TTY1'i aç"],
    ].filter(Boolean);
    menu.innerHTML = items.map((i) => i === "-" ? `<hr>` : `<button data-m="${i[0]}">${i[1]}</button>`).join("");
    menu.hidden = false;
    const r = root.getBoundingClientRect();
    menu.style.left = Math.max(0, Math.min(x - r.left, r.width - menu.offsetWidth - 4)) + "px";
    menu.style.top = Math.max(0, Math.min(y - r.top, r.height - menu.offsetHeight - 4)) + "px";
  }
  const hideMenu = () => { menu.hidden = true; };
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-m]"); if (!b) return;
    hideMenu();
    const s = selected(), one = s[0];
    ({
      open: () => open(one), nano: () => nano(one), install: () => install(one), download: () => download(),
      rename, delete: remove, mkdir, upload: () => fileIn.click(), cdtty: () => runInTty(`cd ${Q(path)}`),
      copy: () => navigator.clipboard?.writeText(s.length === 1 ? one.path : path).then(() => toast("Yol kopyalandı")),
    })[b.dataset.m]?.();
  });
  const outside = (e) => { if (!menu.hidden && !menu.contains(e.target)) hideMenu(); };
  document.addEventListener("pointerdown", outside, true);

  // ── Olaylar ─────────────────────────────────────────────────
  root.querySelector(".rf-bar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-a]"); if (!b || b.disabled) return;
    const a = b.dataset.a;
    if (a === "back") goBack(); else if (a === "fwd") goFwd(); else if (a === "up") goUp();
    else if (a === "home") navigate(HOME); else if (a === "refresh") load(path ?? HOME, false);
    else if (a === "mkdir") mkdir(); else if (a === "upload") fileIn.click(); else if (a === "work") openWork();
    else if (a === "download") download(); else if (a === "rename") rename(); else if (a === "delete") remove();
    else if (a === "cdtty" && path) runInTty(`cd ${Q(path)}`);
    else if (a === "hidden") { showHidden = !showHidden; storeSet("rbox.rf.hidden", showHidden ? "1" : "0"); render(); }
    else if (a === "fav" && path) {
      const f = path.endsWith("/") ? path : path + "/";
      if (favs.includes(f)) return status(`${f} zaten sık kullanılanlarda.`);
      favs.push(f); saveFavs(); renderFavs(); status(`${f} sık kullanılanlara eklendi.`);
    }
  });
  favsEl.addEventListener("click", (e) => {
    const x = e.target.closest("[data-unfav]");
    if (x) { favs = favs.filter((f) => f !== x.dataset.unfav); saveFavs(); renderFavs(); return; }
    const f = e.target.closest("[data-fav]"); if (f) navigate(f.dataset.fav.length > 1 ? f.dataset.fav.replace(/\/+$/, "") : "/");
  });
  thead.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-s]"); if (!th) return;
    sort = sort.key === th.dataset.s ? { key: sort.key, desc: !sort.desc } : { key: th.dataset.s, desc: false };
    storeSet("rbox.rf.sort", JSON.stringify(sort)); render();
  });

  // Seçim: tık tek, Ctrl+tık ekle/çıkar, Shift+tık aralık
  tbody.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-p]"); if (!tr) return;
    const p = tr.dataset.p, v = visible().map((x) => x.path);
    if (e.shiftKey && anchor && v.includes(anchor)) {
      const [a, b] = [v.indexOf(anchor), v.indexOf(p)].sort((x, y) => x - y);
      if (!e.ctrlKey) sel.clear();
      v.slice(a, b + 1).forEach((x) => sel.add(x));
    } else if (e.ctrlKey || e.metaKey) { sel.has(p) ? sel.delete(p) : sel.add(p); anchor = p; }
    else { sel.clear(); sel.add(p); anchor = p; }
    render(); root.focus();
  });
  tbody.addEventListener("dblclick", (e) => {
    const tr = e.target.closest("tr[data-p]"); if (!tr || busy) return;
    const en = all.find((x) => x.path === tr.dataset.p); if (en) open(en);
  });
  listEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const tr = e.target.closest("tr[data-p]");
    if (tr && !sel.has(tr.dataset.p)) { sel.clear(); sel.add(tr.dataset.p); anchor = tr.dataset.p; render(); }
    else if (!tr) { sel.clear(); render(); }
    if (path && !busy) showMenu(e.clientX, e.clientY);
  });

  root.addEventListener("keydown", (e) => {
    if (e.target.closest("input")) return;
    const k = e.key;
    if (e.altKey && k === "ArrowLeft") goBack(); else if (e.altKey && k === "ArrowRight") goFwd();
    else if (e.altKey && k === "ArrowUp") goUp(); else if (e.altKey && k === "Home") navigate(HOME);
    else if (e.altKey || (e.ctrlKey && k !== "a")) return;
    else if (e.ctrlKey && k === "a") { visible().forEach((x) => sel.add(x.path)); render(); }
    else if (k === "Backspace") goUp(); else if (k === "F5") load(path ?? HOME, false);
    else if (k === "F2") rename(); else if (k === "Delete") remove();
    else if (k === "Escape") { hideMenu(); workEl.hidden = true; }
    else if (k === "Enter") { const s = selected(); if (s.length === 1) open(s[0]); }
    else if (k === "ArrowDown" || k === "ArrowUp") {
      const v = visible(); if (!v.length) return;
      let i = v.findIndex((x) => x.path === anchor);
      i = k === "ArrowDown" ? Math.min(v.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
      sel.clear(); sel.add(v[i].path); anchor = v[i].path; render();
      tbody.querySelector("tr.sel")?.scrollIntoView({ block: "nearest" });
    } else return;
    e.preventDefault();
  });

  // Yol: parçaya tıkla → git; boş yere tıkla → yazılabilir kutu
  q(".rf-path").addEventListener("click", (e) => {
    const c = e.target.closest("[data-go]");
    if (c) { navigate(c.dataset.go); return; }
    if (e.target === pathBox) return;
    crumbs.hidden = true; pathBox.hidden = false; pathBox.value = path ?? ""; pathBox.focus(); pathBox.select();
  });
  const endPath = () => { pathBox.hidden = true; crumbs.hidden = false; };
  pathBox.addEventListener("blur", endPath);
  pathBox.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") { e.preventDefault(); endPath(); root.focus(); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    let p = pathBox.value.trim();
    if (!p) return;
    if (p === "~" || p.startsWith("~/")) p = HOME + p.slice(1);
    if (!p.startsWith("/")) p = join(path ?? HOME, p);
    endPath();
    try {
      const r = await call("stat", { path: p });
      if (r.dir === true) navigate(p.length > 1 ? p.replace(/\/+$/, "") : "/");
      else if (r.dir === false) {
        await navigate(parent(p));
        const f = join(parent(p), p.split("/").pop());
        if (all.some((x) => x.path === f)) { sel.clear(); sel.add(f); anchor = f; render(); }
      } else status(`Bulunamadı: ${p}`, true);
    } catch (err) { status(err.message, true); }
  });

  // Yükleme: dosya seçici ya da sürükle-bırak (klasörler yüklenmez)
  fileIn.addEventListener("change", () => { const f = [...fileIn.files]; fileIn.value = ""; upload(f); });
  root.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); root.classList.add("drop-on"); } });
  root.addEventListener("dragleave", (e) => { if (!root.contains(e.relatedTarget)) root.classList.remove("drop-on"); });
  root.addEventListener("drop", (e) => {
    e.preventDefault(); root.classList.remove("drop-on");
    const items = [...(e.dataTransfer?.items || [])];
    const isDir = (i) => !!items[i]?.webkitGetAsEntry?.()?.isDirectory;
    const all2 = [...(e.dataTransfer?.files || [])];
    const files = all2.filter((_, i) => !isDir(i));
    const dirs = all2.length - files.length;
    if (dirs) toast(`${dirs} klasör atlandı: tarayıcıdan yalnızca dosya yüklenir (klasörü zip'leyin ya da updateFiles'ten yükleyin).`, 5000);
    upload(files);
  });

  renderFavs();
  render();
  navigate(HOME, false);

  return {
    root,
    close() {
      closed = true;
      document.removeEventListener("pointerdown", outside, true);
      api("/api/control/files/close", { method: "POST", body: { ip } }).catch(() => {});
    },
  };
}
