// Kabuk: giriş şifresi → ajan bağlantısı → modül sekmeleri, tema, kompakt görünüm, ortak cihaz listesi.
import { PASSWORD_SHA256 } from "./config.js";
import { agent, discover, setToken, checkToken, api } from "./api.js";
import { $, esc, sha256Hex, storeGet, storeSet, sessionGet, sessionSet, toast, ICONS } from "./util.js";
import { createPing } from "./ping.js";

const MODULES = [
  { id: "ping", title: "Ping Kontrol", icon: ICONS.ping, sub: "Excel listesindeki cihazlara ping, SSH portu ve MAC kontrolü" },
  { id: "update", title: "Cihaz Güncelleme", icon: ICONS.update, sub: "SSH ile toplu güncelleme, sürüm kontrolü ve tek cihaz ayarları", soon: true },
  { id: "control", title: "Cihaz Kontrol", icon: ICONS.control, sub: "Cihazların anlık durumu ve toplu işlemler", soon: true },
  { id: "ybdb", title: "YBDB Odalar", icon: ICONS.ybdb, sub: "Oda, yatak ve doluluk durumu", soon: true },
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
  $("#cnErr").textContent = sessionGet("rbox.token") ? "Kayıtlı kod artık geçerli değil (ajan yeniden başlatılmış olabilir)." : "";
  $("#cnToken").value = "";
  $("#cnToken").focus();
}

$("#cnRetry").addEventListener("click", connectFlow);

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

  const ctx = { pickDeviceList, loadDeviceFile };
  views.ping = createPing(ctx);

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

$("#btnLogout").addEventListener("click", () => { sessionSet("rbox.auth", null); sessionSet("rbox.token", null); location.reload(); });

// ── Başlangıç ────────────────────────────────────────────────
(async () => {
  if (await passwordOk()) await connectFlow();
  else { show("gate"); $("#gatePass").focus(); }
})();
