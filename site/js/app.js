// Kabuk: giriş şifresi → ajan bağlantısı → modül sekmeleri, tema, kompakt görünüm, ortak cihaz listesi.
import { PASSWORD_SHA256 } from "./config.js";
import { agent, discover, setToken, checkToken, api, loopbackPermission } from "./api.js";
import { $, esc, sha256Hex, storeGet, storeSet, sessionGet, sessionSet, toast, debounce, ICONS } from "./util.js";
import { createPing } from "./ping.js";
import { createYbdb } from "./ybdb.js";
import { createUpdate } from "./update.js";
import { createControl } from "./control.js";
import { createFiles } from "./files.js";
import { createPort } from "./port.js";
import { SITE } from "./version.js";

const MODULES = [
  { id: "ping", title: "Ping Kontrol", icon: ICONS.ping, sub: "Excel listesindeki cihazlara ping, SSH portu ve MAC kontrolü" },
  { id: "update", title: "Cihaz Güncelleme", icon: ICONS.update, sub: "SSH ile toplu güncelleme, sürüm kontrolü ve tek cihaz ayarları" },
  { id: "control", title: "Cihaz Kontrol", icon: ICONS.control, sub: "Cihazların anlık durumu ve toplu işlemler" },
  { id: "ybdb", title: "YBDB Odalar", icon: ICONS.ybdb, sub: "Oda, yatak ve doluluk durumu" },
  { id: "files", title: "Dosyalar", icon: ICONS.files, sub: "Güncelleme dosyalarını bu hastane için düzenle" },
  { id: "port", title: "Port Kontrol", icon: ICONS.port, sub: "Portu dinleyen uygulama, uygulamanın portları ve uzak bilgisayarda port durumu" },
];

const screens = { gate: $("#gate"), connect: $("#connect"), app: $("#app") };
function show(name) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
}

// ── 1) Giriş şifresi ──────────────────────────────────────────
async function passwordOk() {
  if (!PASSWORD_SHA256) return true;                       // şifre tanımlı değil
  return sessionGet("rbox.auth") === PASSWORD_SHA256;
}

$("#gateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const h = await sha256Hex($("#gatePass").value);
  if (h === PASSWORD_SHA256) { sessionSet("rbox.auth", h); $("#gateErr").textContent = ""; await connectFlow(); }
  else { $("#gateErr").textContent = "Şifre yanlış."; $("#gatePass").select(); }
});

// ── 2) Ajan bağlantısı ────────────────────────────────────────
let scanTimer = null;

async function connectFlow() {
  clearTimeout(scanTimer);
  show("connect");
  $("#cnNone").hidden = false;
  $("#cnCode").hidden = true;
  const perm = await loopbackPermission();
  $("#cnScan").textContent = perm === "prompt"
    ? "Aranıyor… Tarayıcı \"yerel ağ / bu cihazdaki uygulamalar\" için izin sorarsa İzin ver'e basın."
    : "Aranıyor…";

  const info = await discover();
  if (!info) {
    $("#cnScan").textContent = "Ajan bulunamadı. Çalıştırdıysanız birkaç saniye içinde otomatik yeniden denenecek.";
    showConnectHelp(await loopbackPermission());
    scanTimer = setTimeout(connectFlow, 3000);
    return;
  }
  $("#cnHelp").hidden = true;
  if (await checkToken()) return enterApp();

  $("#cnNone").hidden = true;
  $("#cnCode").hidden = false;
  $("#cnMachine").textContent = info.machine;
  $("#cnErr").textContent = storeGet("rbox.token") ? "Kayıtlı kod artık geçerli değil (ajan yeniden başlatılmış olabilir)." : "";
  $("#cnToken").value = "";
  $("#cnToken").focus();
}

$("#cnRetry").addEventListener("click", connectFlow);

// Ajan penceresi açık olduğu hâlde bulunamıyorsa çoğunlukla tarayıcı engelliyordur (Chrome/Edge 142+ yerel ağ izni,
// ya da kurum politikası). İzni nasıl açacağını ve son çare olarak arayüzü ajanın kendisinden açmayı gösterir.
function showConnectHelp(perm) {
  if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) { $("#cnHelp").hidden = true; return; }
  const local = "http://127.0.0.1:47800/" + (launchToken ? `#code=${launchToken}` : "");
  const denied = perm === "denied"
    ? `<p><b>Tarayıcı bu sitenin bilgisayardaki uygulamalara erişimini engelliyor.</b> Adres çubuğunun solundaki simgeye
       tıklayın → <b>Site ayarları</b> → <b>Yerel ağ erişimi</b> (ya da <b>Bu cihazdaki uygulamalar</b>) → <b>İzin ver</b>,
       sonra sayfayı yenileyin. Ayar kilitliyse kurum politikası engelliyordur; aşağıdaki yolu kullanın.</p>`
    : `<p>Ajan penceresi açık ve kod göründüğü hâlde bağlanmıyorsa tarayıcı erişimi engelliyor olabilir: adres çubuğunda
       izin sorusu ya da engel simgesi varsa <b>İzin ver</b>'e basın.</p>`;
  $("#cnHelp").innerHTML = denied +
    `<p>Olmazsa arayüzü ajandan açın (aynı arayüz, izin gerekmez):
     <a href="${esc(local)}" target="_blank" rel="noopener">http://127.0.0.1:47800/</a></p>`;
  $("#cnHelp").hidden = false;
}

// ── Ajanı başlatma yardımcıları ───────────────────────────────
// Tarayıcı program başlatamaz; bu yüzden hazır komutu kopyalatır ya da çift tıklanacak bir .bat indirtiriz.
// Depo, adresten bulunur: https://<kullanici>.github.io/<depo>/   (geliştirmede ?repo=KULLANICI/DEPO)
function detectRepo() {
  const q = new URLSearchParams(location.search).get("repo");
  if (q && /^[\w.-]+\/[\w.-]+$/.test(q)) return q;
  const m = location.hostname.match(/^([\w-]+)\.github\.io$/i);
  const repo = location.pathname.split("/").filter(Boolean)[0];
  return m && repo ? `${m[1]}/${repo}` : null;
}

function launchCommand(repo, token) {
  const url = `https://raw.githubusercontent.com/${repo}/main/tools/start-agent.ps1`;
  return `powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm ${url}))) -Repo ${repo} -Token ${token}"`;
}

// Bağlantı kodunu bu sayfa üretir ve komuta koyar: ajan bu kodla açılır, açık olan bu sayfa kendiliğinden bağlanır
// (ajanın yeni bir tarayıcı sekmesi açmasına gerek kalmaz). Aynı sayfa yüklemesinde aynı kod kullanılır.
let launchToken = null;
function ensureLaunchToken() {
  if (!launchToken) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";           // karışan karakterler yok
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    launchToken = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  }
  setToken(launchToken);
  return launchToken;
}

// Masaüstü (WPF) sürümünü C:\Rasyomed\RboxTools'a indirir; yol yoksa oluşturur, hata olursa İndirilenler'e koyar.
function desktopCommand(repo) {
  const url = `https://raw.githubusercontent.com/${repo}/main/tools/install-desktop.ps1`;
  return `powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm ${url}))) -Repo ${repo}"`;
}

const repo = detectRepo();
if (repo) {
  $("#cnLaunch").hidden = false;

  // Normal tıklama: ajan komutu. Hızlıca 3 tıklama (e.detail = ardışık tıklama sayısı): masaüstü sürümü komutu.
  $("#cnCopy").addEventListener("click", async (e) => {
    const desktop = e.detail >= 3;
    // Başarıda bildirim yok (istenmedi); yalnızca kopyalanamazsa haber verilir
    try { await navigator.clipboard.writeText(desktop ? desktopCommand(repo) : launchCommand(repo, ensureLaunchToken())); }
    catch { toast("Kopyalanamadı."); }
  });
}

// Kod kutusu: konsoldan kopyalanan boşlukları / fazlalıkları temizler. Ajanın kendi kodu 6 karakter (ABC-123),
// "Komutu kopyala" ile başlatılan ajanın kodu 12 karakter; ikisinde de tamamlanınca kendiliğinden bağlanır.
$("#cnToken").addEventListener("input", (e) => {
  const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  e.target.value = raw.length > 3 && raw.length <= 6 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
  if (raw.length === 6 || raw.length === 12) $("#cnCode").requestSubmit();
});

$("#cnCode").addEventListener("submit", async (e) => {
  e.preventDefault();
  // 6 karakterlik kod ajanda ABC-123 biçiminde tutulur; 12 karakterlik kodda tire yok
  const raw = $("#cnToken").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  setToken(raw.length === 6 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw);
  if (await checkToken()) { $("#cnErr").textContent = ""; enterApp(); }
  else $("#cnErr").textContent = "Kod hatalı. Ajan penceresindeki kodu kontrol edin.";
});

agent.onLost(() => {
  if (!screens.app.hidden) { toast("Ajan bağlantısı koptu."); connectFlow(); }
});

// ── 3) Uygulama ───────────────────────────────────────────────
const views = {};
let current = null;
let entered = false;
const devices = { rows: [], fileName: "" };

function enterApp() {
  show("app");
  $("#agentName").innerHTML = `${esc(agent.info.machine)} <b>· ajan ${esc(agent.info.version)}</b>`;
  $("#agentPill").title = `Ajan ${agent.info.version} · ${agent.info.machine}`;
  checkAgentVersion();
  if (entered) return;
  entered = true;

  const ctx = {
    pickDeviceList, loadDeviceFile, flushSsh: () => saveSsh.flush(), requireSsh,
    // Cihaz Kontrol kartındaki "Güncelle": Cihaz Güncelleme'ye geç ve yalnızca o cihazı işaretle
    openInUpdate: (ip) => { select("update"); views.update.focusTarget(ip); },
  };
  views.ping = createPing(ctx);
  views.ybdb = createYbdb();
  views.update = createUpdate(ctx);
  views.control = createControl(ctx);
  views.files = createFiles(ctx);
  views.port = createPort();
  renderListButton();
  loadSsh();

  $("#tabs").innerHTML = MODULES.map((m) =>
    `<button class="tab${m.soon ? " soon" : ""}" role="tab" data-m="${m.id}" aria-selected="false" title="${m.soon ? "Bu modül sonraki aşamada eklenecek" : m.title}">${m.icon}<span>${m.title}</span></button>`).join("");
  $("#tabs").addEventListener("click", (e) => { const t = e.target.closest("[data-m]"); if (t) select(t.dataset.m); });

  select(storeGet("rbox.module") in Object.fromEntries(MODULES.map((m) => [m.id, 1])) ? storeGet("rbox.module") : "ping");
}

function select(id) {
  const m = MODULES.find((x) => x.id === id);
  current = id;
  storeSet("rbox.module", id);
  $$tabs().forEach((t) => t.setAttribute("aria-selected", String(t.dataset.m === id)));
  $("#pageTitle").textContent = m.title;
  $("#pageSub").textContent = m.sub;

  const host = $("#view");
  [...host.children].forEach((c) => (c.hidden = true));
  let v = views[id];
  if (!v) {
    const root = document.createElement("div");
    root.innerHTML = `<section class="card"><div class="placeholder"><h2>${esc(m.title)}</h2>
      <p>Bu modül web sürümünde bir sonraki aşamada eklenecek.<br>Şimdilik WPF uygulamasını kullanmaya devam edin.</p></div></section>`;
    v = views[id] = { root };
  }
  if (!v.root.parentElement) host.append(v.root);
  v.root.hidden = false;
  v.onShow?.();
}
const $$tabs = () => [...document.querySelectorAll("#tabs .tab")];

// ── Ortak SSH kullanıcı / şifre (tüm modüller) ───────────────
// Tek yerde girilir; ajanda şifreli saklanır. Şifre tarayıcıya geri gönderilmez.
const ssh = { user: "pi", hasPass: false };
let sshPassDirty = false;

function renderSsh() {
  const btn = $("#btnSsh");
  btn.innerHTML = `${ICONS.lock}<span>${ssh.hasPass ? "SSH " + esc(ssh.user) : "SSH girilmedi"}</span>`;
  btn.classList.toggle("warn", !ssh.hasPass);
}

async function loadSsh() {
  try {
    const s = await api("/api/settings/ssh");
    ssh.user = s.user; ssh.hasPass = s.hasPass;
    $("#sshUser").value = s.user;
    $("#sshPass").placeholder = s.hasPass ? "••••••••" : "";
  } catch { /* bağlantı yoksa düğme varsayılan kalır */ }
  renderSsh();
}

const saveSsh = debounce(async () => {
  const body = { user: $("#sshUser").value };
  if (sshPassDirty) body.pass = $("#sshPass").value;
  try {
    await api("/api/settings/ssh", { method: "PUT", body });
    ssh.user = body.user.trim() || "pi";
    if (sshPassDirty) {
      ssh.hasPass = body.pass.length > 0;
      $("#sshPass").value = ""; $("#sshPass").placeholder = ssh.hasPass ? "••••••••" : "";
      sshPassDirty = false;
    }
    renderSsh();
  } catch (e) { toast("SSH bilgisi kaydedilemedi: " + e.message); }
}, 500);

$("#sshUser").addEventListener("input", saveSsh);
$("#sshPass").addEventListener("input", () => { sshPassDirty = true; saveSsh(); });

const sshPop = $("#sshPop");
$("#btnSsh").addEventListener("click", (e) => {
  e.stopPropagation();
  sshPop.hidden = !sshPop.hidden;
  if (!sshPop.hidden) { $("#sshUser").focus(); $("#sshUser").select(); }
});
document.addEventListener("click", (e) => { if (!sshPop.hidden && !e.target.closest(".pop-wrap")) sshPop.hidden = true; });
sshPop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "Escape") { sshPop.hidden = true; saveSsh.flush(); } });
renderSsh();

/** SSH şifresi girilmemişse işlemi başlatmadan uyarır ve SSH kutusunu açar. */
async function requireSsh() {
  await saveSsh.flush();
  if (ssh.hasPass) return true;
  toast("SSH şifresi girilmemiş. Sağ üstteki SSH düğmesinden kullanıcı ve şifreyi girin.", 6000);
  sshPop.hidden = false; $("#sshPass").focus();
  return false;
}

// ── Ortak cihaz listesi (Excel) ──────────────────────────────
const fileInput = Object.assign(document.createElement("input"), { type: "file", accept: ".xlsx,.xls", hidden: true });
document.body.append(fileInput);
fileInput.addEventListener("change", () => { const f = fileInput.files?.[0]; fileInput.value = ""; if (f) loadDeviceFile(f); });

function pickDeviceList() { fileInput.click(); }

/** Üst banttaki ortak düğme: "Cihaz listesi <dosya adı>" (WPF'teki gibi). */
function renderListButton() {
  const name = devices.fileName;
  $("#btnList").innerHTML = `${ICONS.folder}<span>Cihaz listesi ${name ? `<b>${esc(name)}</b>` : ""}</span>` +
    (name ? `<span class="list-x" data-clear title="Cihaz listesini kaldır (Excel bağlantısını kes)">✕</span>` : "");
}
$("#btnList").addEventListener("click", (e) => {
  if (e.target.closest("[data-clear]")) { clearDeviceList(); return; }
  pickDeviceList();
});

/** Excel ile bağlantıyı keser: liste tüm modüllerden kalkar (dosyaya dokunulmaz). */
function clearDeviceList() {
  if (anyBusy()) { toast("Bir işlem sürerken cihaz listesi kaldırılamaz. İşlem bitince tekrar deneyin."); return; }
  devices.rows = []; devices.fileName = "";
  distributeDevices();
  renderListButton();
  toast("Cihaz listesi kaldırıldı");
}

/** Bir modülde iş sürerken liste değiştirilemez (WPF ile aynı kural). */
const anyBusy = () => Object.values(views).some((v) => v.isBusy?.());

/** Listeyi, setDevices'ı olan tüm modüllere dağıtır. Modül sonradan oluşturulunca da çağrılır. */
function distributeDevices() {
  for (const v of Object.values(views)) v.setDevices?.(devices);
}

async function loadDeviceFile(file) {
  if (!/\.(xlsx|xls)$/i.test(file.name)) { toast("Yalnızca .xlsx veya .xls dosyaları."); return; }
  if (anyBusy()) { toast("Bir işlem sürerken cihaz listesi değiştirilemez. İşlem bitince tekrar deneyin."); return; }
  try {
    const res = await api("/api/excel", { method: "POST", body: await file.arrayBuffer(), headers: { "X-File-Name": encodeURIComponent(file.name) } });
    devices.rows = res.rows; devices.fileName = res.fileName;
    distributeDevices();
    renderListButton();
    toast(`${res.rows.length} cihaz yüklendi`);
  } catch (e) {
    toast("Excel okunamadı: " + e.message, 5000);
  }
}

// Sayfaya sürüklenen dosya (sayfanın herhangi bir yerinde çalışır)
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault();
  if (current === "files") return;                       // Dosyalar sekmesi bırakılan dosyaları kendisi yükler
  const f = e.dataTransfer?.files?.[0];
  if (f && !screens.app.hidden) loadDeviceFile(f);
});

// ── Tema ve görünüm ──────────────────────────────────────────
// Masaüstündeki temalarla aynı (WPF Themes/*.xaml). sw: menüdeki renk örneği (üst bant → vurgu).
const THEMES = [
  { id: "system", title: "Sistem", note: "tarayıcı ayarı", sw: "linear-gradient(135deg,#ECEEF5 50%,#0A1120 50%)" },
  { id: "light", title: "Açık", note: "açık", sw: "linear-gradient(135deg,#0B2753 50%,#2563EB 50%)" },
  { id: "dark", title: "Koyu", note: "koyu", sw: "linear-gradient(135deg,#071733 50%,#3B82F6 50%)" },
  { id: "ocean", title: "Okyanus", note: "açık", sw: "linear-gradient(135deg,#0B4F5C 50%,#0E8A96 50%)" },
  { id: "emerald", title: "Zümrüt", note: "koyu", sw: "linear-gradient(135deg,#062A22 50%,#10B981 50%)" },
  { id: "graphite", title: "Grafit", note: "koyu", sw: "linear-gradient(135deg,#17181B 50%,#F59E0B 50%)" },
];
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const themeChoice = () => { const t = storeGet("rbox.theme"); return THEMES.some((x) => x.id === t) ? t : "system"; };

function applyTheme(choice) {
  const eff = choice === "system" ? (darkQuery.matches ? "dark" : "light") : choice;
  document.documentElement.dataset.theme = eff;
  $("#btnTheme").innerHTML = ICONS.palette;
  $("#btnTheme").title = "Tema: " + THEMES.find((x) => x.id === choice).title;
  $("#themeList").innerHTML = THEMES.map((x) =>
    `<button class="theme-opt" role="menuitemradio" data-theme-id="${x.id}" aria-checked="${x.id === choice}">
      <span class="theme-sw" style="background:${x.sw}"></span>${x.title}<small>${x.note}</small></button>`).join("");
}
const themePop = $("#themePop");
$("#btnTheme").addEventListener("click", (e) => { e.stopPropagation(); themePop.hidden = !themePop.hidden; });
$("#themeList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-theme-id]"); if (!b) return;
  storeSet("rbox.theme", b.dataset.themeId);
  applyTheme(b.dataset.themeId);
  themePop.hidden = true;
});
document.addEventListener("click", (e) => { if (!themePop.hidden && !e.target.closest("#themePop, #btnTheme")) themePop.hidden = true; });
darkQuery.addEventListener("change", () => { if (themeChoice() === "system") applyTheme("system"); });
applyTheme(themeChoice());

// ── Sürüm bilgisi ────────────────────────────────────────────
// Arayüz: pages.yml her yayında version.js'i doldurur (boşsa yerel çalışma). Logonun altında gösterilir; tarayıcı
// eski sürümü önbellekten verdiyse tarih eski kalır. Sayfa açıkken yeni yayın çıkarsa "Yeni sürüm · yenile" belirir.
$("#siteVer").textContent = SITE.date ? `· web ${SITE.date}` : "· web (yerel)";
$("#siteVer").title = SITE.commit ? `Arayüz yayını ${SITE.date} (commit ${SITE.commit})` : "Arayüz yerelden çalışıyor (GitHub yayını değil)";

async function checkSiteUpdate() {
  if (!SITE.commit) return;
  try {
    const v = await (await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" })).json();
    if (v.commit && v.commit !== SITE.commit) {
      $("#siteUpdate").hidden = false;
      $("#siteUpdate").title = `Yeni arayüz yayınlandı (${v.date}). Tıklayınca sayfa yeniden yüklenir.`;
    }
  } catch { /* çevrimdışı / dosya yok */ }
}
$("#siteUpdate").addEventListener("click", () => location.reload());
setInterval(checkSiteUpdate, 5 * 60 * 1000);
addEventListener("focus", checkSiteUpdate);

/** GitHub'daki son ajan sürümü (yalnızca github.io'dan açılınca; depo adresten çıkarılır). */
let latestAgent = null;
async function checkAgentVersion() {
  const pill = $("#agentPill");
  const cur = agent.info?.version;
  if (!cur || !location.hostname.endsWith(".github.io")) return;
  try {
    if (!latestAgent) {
      const owner = location.hostname.split(".")[0], repo = location.pathname.split("/").filter(Boolean)[0];
      if (!repo) return;
      const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
      if (!r.ok) return;
      latestAgent = String((await r.json()).tag_name || "").replace(/^v/, "");
    }
    const older = compareVer(cur, latestAgent) < 0;
    pill.classList.toggle("old", older);
    pill.title = older
      ? `Ajan ${cur} eski: GitHub'da ${latestAgent} var. Ajan penceresini kapatıp başlatma komutunu yeniden çalıştırın (yeni sürüm iner).`
      : `Ajan ${cur} · güncel · ${agent.info.machine}`;
    if (older) toast(`Ajan güncel değil (${cur} → ${latestAgent}). Ajan penceresini kapatıp başlatma komutunu yeniden çalıştırın.`, 8000);
  } catch { /* GitHub'a ulaşılamadı: sessiz geç */ }
}
function compareVer(a, b) {
  const pa = String(a).split(/[.+-]/).map((x) => parseInt(x, 10) || 0), pb = String(b).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

$("#btnCompact").addEventListener("click", () => {
  const on = document.body.classList.toggle("compact");
  storeSet("rbox.compact", on ? "1" : "0");
});
if (storeGet("rbox.compact") === "1") document.body.classList.add("compact");

$("#btnLogout").addEventListener("click", () => { sessionSet("rbox.auth", null); setToken(""); location.reload(); });

// ── Başlangıç ────────────────────────────────────────────────
// Ajan tarayıcıyı ".../#code=ABC-123" ile açar: kodu al, adresten sil (geçmişte/paylaşımda kalmasın).
{
  const m = location.hash.match(/[#&]code=([A-Za-z0-9-]{4,12})/);
  if (m) {
    setToken(m[1]);
    history.replaceState(null, "", location.pathname + location.search);
  }
}

(async () => {
  if (await passwordOk()) await connectFlow();
  else { show("gate"); $("#gatePass").focus(); }
})();

$("#sshForget").addEventListener("click", async () => {
  try {
    await api("/api/settings/ssh", { method: "PUT", body: { user: $("#sshUser").value, pass: "" } });
    ssh.hasPass = false; sshPassDirty = false;
    $("#sshPass").value = ""; $("#sshPass").placeholder = "";
    renderSsh();
  } catch (e) { toast("Şifre silinemedi: " + e.message); }
});
