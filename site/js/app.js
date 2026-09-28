// Kabuk: giriş şifresi → ajan bağlantısı → modül sekmeleri, tema, kompakt görünüm, ortak cihaz listesi.
import { PASSWORD_SHA256 } from "./config.js";
import { agent, discover, setToken, checkToken, api } from "./api.js";
import { $, esc, sha256Hex, storeGet, storeSet, sessionGet, sessionSet, toast, debounce, ICONS } from "./util.js";
import { createPing } from "./ping.js";
import { createYbdb } from "./ybdb.js";

const MODULES = [
  { id: "ping", title: "Ping Kontrol", icon: ICONS.ping, sub: "Excel listesindeki cihazlara ping, SSH portu ve MAC kontrolü" },
  { id: "update", title: "Cihaz Güncelleme", icon: ICONS.update, sub: "SSH ile toplu güncelleme, sürüm kontrolü ve tek cihaz ayarları", soon: true },
  { id: "control", title: "Cihaz Kontrol", icon: ICONS.control, sub: "Cihazların anlık durumu ve toplu işlemler", soon: true },
  { id: "ybdb", title: "YBDB Odalar", icon: ICONS.ybdb, sub: "Oda, yatak ve doluluk durumu" },
  { id: "files", title: "Dosyalar", icon: ICONS.files, sub: "Güncelleme dosyalarını bu hastane için düzenle", soon: true },
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
  $("#cnScan").textContent = "Aranıyor…";

  const info = await discover();
  if (!info) {
    $("#cnScan").textContent = "Ajan bulunamadı. Çalıştırdıysanız birkaç saniye içinde otomatik yeniden denenecek.";
    scanTimer = setTimeout(connectFlow, 3000);
    return;
  }
  if (await checkToken()) return enterApp();

  $("#cnNone").hidden = true;
  $("#cnCode").hidden = false;
  $("#cnMachine").textContent = info.machine;
  $("#cnErr").textContent = storeGet("rbox.token") ? "Kayıtlı kod artık geçerli değil (ajan yeniden başlatılmış olabilir)." : "";
  $("#cnToken").value = "";
  $("#cnToken").focus();
}

$("#cnRetry").addEventListener("click", connectFlow);

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

// Kod kutusu: konsoldan kopyalanan boşlukları / fazlalıkları temizler, ABC-123 biçimine getirir,
// 6 karakter tamamlanınca kendiliğinden bağlanır.
$("#cnToken").addEventListener("input", (e) => {
  const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  e.target.value = raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
  if (raw.length === 6) $("#cnCode").requestSubmit();
});

$("#cnCode").addEventListener("submit", async (e) => {
  e.preventDefault();
  setToken($("#cnToken").value);
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
  $("#agentName").textContent = agent.info.machine;
  $("#agentPill").title = `Ajan ${agent.info.version} · ${agent.info.machine}`;
  if (entered) return;
  entered = true;

  const ctx = { pickDeviceList, loadDeviceFile, flushSsh: () => saveSsh.flush() };
  views.ping = createPing(ctx);
  views.ybdb = createYbdb();
  loadSsh();

  $("#tabs").innerHTML = MODULES.map((m) =>
    `<button class="tab${m.soon ? " soon" : ""}" role="tab" data-m="${m.id}" aria-selected="false"${m.soon ? ' title="Bu modül sonraki aşamada eklenecek"' : ""}>${m.icon}<span>${m.title}</span></button>`).join("");
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

// ── Ortak cihaz listesi (Excel) ──────────────────────────────
const fileInput = Object.assign(document.createElement("input"), { type: "file", accept: ".xlsx,.xls", hidden: true });
document.body.append(fileInput);
fileInput.addEventListener("change", () => { const f = fileInput.files?.[0]; fileInput.value = ""; if (f) loadDeviceFile(f); });

function pickDeviceList() { fileInput.click(); }

async function loadDeviceFile(file) {
  if (!/\.(xlsx|xls)$/i.test(file.name)) { toast("Yalnızca .xlsx veya .xls dosyaları."); return; }
  try {
    const res = await api("/api/excel", { method: "POST", body: await file.arrayBuffer(), headers: { "X-File-Name": encodeURIComponent(file.name) } });
    devices.rows = res.rows; devices.fileName = res.fileName;
    if (views.ping.setDevices(devices)) toast(`${res.rows.length} cihaz yüklendi`);
  } catch (e) {
    toast("Excel okunamadı: " + e.message, 5000);
  }
}

// Sayfaya sürüklenen dosya (Ping kartı dışında da çalışsın)
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f && !screens.app.hidden) loadDeviceFile(f); });

// ── Tema ve görünüm ──────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("#btnTheme").innerHTML = t === "dark" ? ICONS.sun : ICONS.moon;
  $("#btnTheme").title = t === "dark" ? "Açık temaya geç" : "Koyu temaya geç";
}
$("#btnTheme").addEventListener("click", () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  storeSet("rbox.theme", t); applyTheme(t);
});
applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");

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
