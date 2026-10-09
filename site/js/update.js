// Cihaz Güncelleme modülü: SSH ile toplu güncelleme, versiyon kontrolü, TTY mesajı ve tek cihaz ayarları.
// WPF UpdateView / UpdateViewModel karşılığı. Adımların kendisi ajandadadır (UpdateCoordinator, WPF ile aynı kod).
import { api, stream } from "./api.js";
import { $, $$, esc, debounce, toast, copyText, ipFilter, sortCompare, ICONS } from "./util.js";

const DASH = "—";

// ── Seçenek tanımları (WPF UpdateView.xaml ile aynı metinler) ─────────────────
const SISTEM = [
  { k: "dll", label: ".dll güncelle" },
  { k: "service", label: "serialworker.service" },
  { k: "crontab", label: "Crontab" },
  { k: "jsonSettings", label: "JsonSettings", file: "JsonSettings.txt", tip: "Satırdaki YATAK ID değeri JsonSettings.json'a yazılır." },
  { k: "serialDevices", label: "serialdevices.json", file: "serialdevices.json",
    tip: "updateFiles\\serialdevices.json dosyasını cihaza kopyalar.\nHedef: /var/www/consoleApps/publish/serialdevices.json (root:root, 0644).\nDosya updateFiles'ta yoksa adım atlanır, diğer adımlar etkilenmez.\nNot: serialworker.service yeniden başlatılmaz — gerekiyorsa \".dll güncelle\"yi de seçin." },
  { k: "cleanup", label: "Dosya temizliği" },
  { k: "badLogsCleanup", label: "Hatalı Log'ları temizle",
    tip: "/var/www/consoleApps/publish/ içinde şunları siler:\n• \"\\Logs\" ve \"Logs\" klasörleri (içleriyle birlikte)\n• adı \"\\Logs\\ServiceLog_*.txt\" olan dosyalar\nDoğru log klasörü \"Log\" ve diğer dosyalara dokunulmaz." },
  { k: "expandFs", label: "Hafızayı genişlet (rootfs)" },
  { k: "rebootAfter", label: "Yeniden başlat" },
  { k: "webServer", label: "Web server",
    tip: "RasyoBOX web arayüzünü kurar.\nupdateFiles\\rasyobox-*.tar.gz (en yüksek sürümlü arşiv) cihazın /home/pi klasörüne kopyalanır,\naçılır ve 'sudo bash install.sh' çalıştırılır.\nArşivin içindeki klasör adı ne olursa olsun install.sh bulunup çalıştırılır.\nKurulum bitince arşiv ve açılan klasör cihazdan silinir." },
];
const AG = [
  { k: "dhcpcd", label: "dhcpcd", file: "dhcpcd.txt" },
  { k: "wpaSupplicant", label: "wpa_supplicant", file: "wpa_supplicant.txt" },
  { k: "rcLocal", label: "rc.local" },
];
const DOSYA = [
  { k: "bashRc", label: ".bashrc" },
  { k: "profile", label: ".profile" },
  { k: "nanoRc", label: ".nanorc" },
  { k: "netStatusBanner", label: "net_status_banner.sh" },
  { k: "netStatusService", label: "net-status-banner@tty1.svc", tip: "Servis net_status_banner.sh'ı çalıştırır; script cihazda yoksa onu da seçin." },
  { k: "netBannerLogin", label: "net_banner_login.sh" },
  { k: "rasyoClean", label: "rasyoclean.sh" },
  { k: "swHelpLogService", label: "sw -help ve logservice" },
];
const GROUPS = { sistem: SISTEM, ag: AG, dosya: DOSYA };
const ALL_KEYS = [...SISTEM, ...AG, ...DOSYA].map((o) => o.k);

const CONSPY_TIP = "conspy: başka bir tty'yi izlemeye yarayan araç.\n\napt-get: internet gerektirir. Cihaz internete çıkamıyorsa adım atlanır,\ndiğer güncellemeler etkilenmez.\n\nçevrimdışı: cihazdaki /home/pi/conspy_1.16-1_armhf.deb paketinden kurar.\nPaket cihazda yoksa updateFiles klasöründen gönderilir; iki yerde de yoksa uyarı verilir.";
const AUTOLOGIN_TIP = "tty1 konsolunda otomatik giriş.\nDisable: /etc/systemd/system/getty@tty1.service.d/autologin.conf silinir,\ndaemon-reload + getty@tty1 restart uygulanır (reboot gerekmez).\nEnable: autologin.conf yeniden oluşturulur.";

const COLUMNS = [
  { key: "ip", label: "IP", val: (r) => r.ip },
  { key: "yatakAdi", label: "Yatak adı", val: (r) => r.yatakAdi },
  { key: "yatakId", label: "Yatak ID", val: (r) => r.yatakId },
  { key: "status", label: "Durum", val: (r) => r.status },
  { key: "version", label: "Versiyon", val: (r) => r.version },
  { key: "wlan0", label: "wlan0", val: (r) => r.wlan0 },
  { key: "eth0", label: "eth0", val: (r) => r.eth0 },
];

// Dosya gönder: sık kullanılan hedef klasörler (WPF FileSender.PresetDirs ile aynı)
const SEND_DIRS = ["/home/pi", "/home/pi/Desktop", "/var/www/consoleApps/publish", "/usr/local/bin", "/etc/systemd/system", "/tmp"];

const isIpv4 = (s) => {
  if (!s) return false;
  const p = s.trim().split(".");
  return p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255);
};
const ipKey = (ip) => (isIpv4(ip) ? ip.split(".").reduce((a, x) => a * 256 + Number(x), 0) : Number.MAX_SAFE_INTEGER);
const kindToSev = (k) => (k === "error" ? "error" : k === "warn" ? "warn" : "info");

export function createUpdate(ctx) {
  const root = document.createElement("div");
  root.className = "stack";

  // ── Durum ───────────────────────────────────────────────────
  let rows = [];
  let rooms = [];                          // [{title, idx, collapsed}]
  let seq = 0;
  let selected = new Set();                // seçili satır id'leri (silme / TTY hedefi)
  let lastClicked = null;
  let sort = { key: null, dir: 1 };
  let tab = "batch";
  let running = null;                      // null | "update" | "version"
  let runId = null, abortCtl = null;
  let done = 0, total = 1;
  let singleBusy = false;
  let sendGroups = [];                     // Dosya gönder: [{key, label, title, files:[{file, rel}]}]
  let sendUploading = false, sendAbort = false;
  let fileInfo = { workFolder: "", editable: [], files: [] };
  const opt = Object.fromEntries(ALL_KEYS.map((k) => [k, false]));
  Object.assign(opt, {
    conspy: "None", cronService: "None", autologin: "None",
    wlan0MaskOn: false, wlan0GatewayOn: false, eth0MaskOn: false, eth0GatewayOn: false,
    restartDhcpcd: false, restartWpa: false,
  });
  let cfg = {
    parallel: 10, sequentialIpFill: true, sendRemoteDir: "/home/pi", sendChmodSh: true, sendFixLineEndings: true, ttyText: "", wlan0Mask: "255.255.255.0", wlan0Gateway: "192.168.1.1", eth0Mask: "255.255.255.0", eth0Gateway: "192.168.1.1",
    singleTargetIp: "", singleServerIp: "", singleEth0Ip: "", singleEth0Mask: "", singleWlan0Ip: "", singleWlan0Mask: "",
  };
  const single = { doYatak: false, yatakId: 0, doServer: false, doEth0: false, doWlan0: false };

  const isBusy = () => running !== null;

  // ── İskelet ─────────────────────────────────────────────────
  const optionHtml = (o) => `
    <div class="opt" data-file="${o.file ?? ""}">
      <label ${o.file ? `data-dbl="${o.file}"` : ""} title="${esc((o.tip ? o.tip + "\n" : "") + (o.file ? `Çift tıklayın: updateFiles\\${o.file} dosyasını açar.` : ""))}">
        <input type="checkbox" data-opt="${o.k}"><span>${esc(o.label)}</span></label>
      ${o.file ? `<span class="missing" data-missing="${o.file}" hidden title="updateFiles klasöründe yok">yok</span>
        <button class="btn icon" data-open="${o.file}" title="updateFiles\\${esc(o.file)} dosyasını aç (sunucuda)">${ICONS.pencil}</button>` : ""}
    </div>`;

  const chips = (name, values) => `<span class="chips" role="radiogroup">${values.map(([v, t]) =>
    `<button type="button" class="chip" role="radio" data-radio="${name}" data-v="${v}" aria-checked="false">${t}</button>`).join("")}</span>`;

  root.innerHTML = `
    <div class="seg" role="tablist">
      <button role="tab" data-tab="batch" aria-selected="true">${ICONS.update} Toplu güncelleme</button>
      <button role="tab" data-tab="single" aria-selected="false">${ICONS.control} Tek cihaz · IP / dhcpcd</button>
    </div>

    <!-- ═════════ TOPLU GÜNCELLEME ═════════ -->
    <div class="upd-grid" id="uBatch">
      <div class="stack" style="min-width:0">
        <section class="card">
          <div class="card-h row" style="justify-content:space-between">CİHAZ LİSTESİ <span class="sm muted" style="text-transform:none;letter-spacing:0;font-weight:500" id="uSummary">Liste boş</span></div>
          <div class="card-b" style="padding-bottom:8px">
            <div class="row tight" style="justify-content:flex-end">
              <label class="chk" style="margin-right:auto" title="wlan0 ya da eth0 hücresine IP girince alttaki satırlar sıradaki IP'lerle dolar (.0 ve .255 atlanır).&#10;Elle girilmiş değerlere dokunulmaz; sıra orada durur. Otomatik doldurulan değerler soluk gösterilir."><input type="checkbox" id="uSeqFill"> IP'leri sıralı doldur</label>
              <input type="text" id="uNewIp" class="mono-input" placeholder="IP adresi" style="width:150px" autocomplete="off">
              <button class="btn" id="uAdd">${ICONS.plus} Ekle</button>
              <button class="btn icon" id="uDelete" title="Seçili satırları sil (Delete)">${ICONS.trash}</button>
              <button class="btn icon" id="uToggleRooms" title="Tüm odaları daralt / genişlet">${ICONS.chevrons}</button>
              <span style="width:8px"></span>
              <button class="link" id="uCheckAll">Tümünü işaretle</button>
              <button class="link" id="uUncheckAll" title="Tüm satırların işaretini kaldır">Temizle</button>
            </div>
          </div>
          <div class="table-wrap" id="uTableWrap" tabindex="0" style="max-height:440px;min-height:220px;resize:vertical">
            <table class="fixed" style="min-width:820px">
              <colgroup><col style="width:44px"><col style="width:160px"><col style="width:120px"><col style="width:84px"><col><col style="width:140px"><col style="width:135px"><col style="width:135px"></colgroup>
              <thead><tr id="uHead"></tr></thead><tbody id="uBody"></tbody>
            </table>
          </div>
          <div class="card-b sm muted" style="padding-top:8px">IP, YATAK ID, wlan0 ve eth0 hücrelerini düzenlemek için çift tıklayın. wlan0 / eth0 doluysa o cihazın dhcpcd.conf'u güncellenir. Soluk IP'ler sıralı doldurmayla yazıldı.</div>
        </section>

        <section class="card">
          <div class="card-h row" style="justify-content:space-between">GÜNLÜK
            <span class="row tight" style="text-transform:none;letter-spacing:0"><button class="link" id="uReport" title="updateFiles\\Güncelleme Raporu.txt (sunucuda açılır)">Raporu aç</button><button class="link" id="uClearLog">Temizle</button></span></div>
          <div class="card-b"><div class="logbox" id="uLog"></div></div>
        </section>
      </div>

      <div class="stack" style="min-width:0">
        <div class="opts-scroll">
          <section class="card" id="uSession">
            <div class="card-h row" style="justify-content:space-between">OTURUM
              <button class="link" id="uFolder" title="updateFiles klasörünü sunucuda aç" style="text-transform:none;letter-spacing:0">updateFiles</button></div>
            <div class="card-b row" style="justify-content:space-between">
              <div class="sm muted">SSH kullanıcı / şifre: üst banttaki <b>SSH</b> düğmesi (tüm modüller için ortak).</div>
              <div>
                <div class="field-label" title="Aynı anda güncellenecek / kontrol edilecek cihaz sayısı (1-100). Dosya kopyalayan güncellemelerde 10-20 önerilir.">Aynı anda</div>
                <div class="spin"><button class="btn icon" id="uParMinus" style="border-color:var(--border-strong)">−</button><b id="uPar">10</b><button class="btn icon" id="uParPlus" style="border-color:var(--border-strong)">+</button></div>
              </div>
            </div>
            <div class="card-b sm muted" style="padding-top:0" id="uFolderPath"></div>
          </section>

          <section class="card" id="uOptions">
            <div class="card-h row" style="justify-content:space-between">GÜNCELLEMELER
              <span class="row tight" style="text-transform:none;letter-spacing:0"><button class="link" id="uSelAll">Tümünü seç</button><button class="link" id="uSelNone" title="Tüm seçimleri kaldır (cron / autologin / conspy dahil)">Kaldır</button></span></div>
            <div class="card-b">
              <label class="chk grp" title="Bu gruptaki tüm güncellemeleri seç / kaldır"><input type="checkbox" data-group="sistem"> Sistem</label>
              <div class="optgrid">${SISTEM.map(optionHtml).join("")}</div>
              <div class="radio-row"><span class="lbl" title="${esc(CONSPY_TIP)}">conspy</span>${chips("conspy", [["None", "Kurma"], ["Apt", "apt-get (net)"], ["Offline", "çevrimdışı .deb"]])}</div>
              <hr class="divider">
              <label class="chk grp" title="Bu gruptaki tüm güncellemeleri seç / kaldır (cron ve autologin hariç)"><input type="checkbox" data-group="ag"> Ağ</label>
              <div class="optgrid">${AG.map(optionHtml).join("")}</div>
              <div class="radio-row"><span class="lbl">cron servisi</span>${chips("cronService", [["None", "Dokunma"], ["Enable", "Enable"], ["Disable", "Disable"]])}</div>
              <div class="radio-row"><span class="lbl" title="${esc(AUTOLOGIN_TIP)}">autologin</span>${chips("autologin", [["None", "Dokunma"], ["Enable", "Enable"], ["Disable", "Disable"]])}</div>
              <hr class="divider">
              <label class="chk grp" title="Bu gruptaki tüm güncellemeleri seç / kaldır"><input type="checkbox" data-group="dosya"> Dosyalar ve servisler</label>
              <div class="optgrid">${DOSYA.map(optionHtml).join("")}</div>
            </div>
          </section>

          <section class="card" id="uDhcp">
            <div class="card-h">DHCPCD · SATIR BAZLI</div>
            <div class="card-b">
              <div class="sm muted" style="margin-bottom:12px">Tablodaki wlan0 / eth0 hücresi dolu olan cihazlarda uygulanır. Mask ve GW işaretli değilse mevcut satıra dokunulmaz.</div>
              <div class="field-grid">
                <b>wlan0</b><label class="chk"><input type="checkbox" data-opt="wlan0MaskOn"> Mask</label><input type="text" class="mono-input" data-cfg="wlan0Mask">
                <span></span><label class="chk"><input type="checkbox" data-opt="wlan0GatewayOn"> GW</label><input type="text" class="mono-input" data-cfg="wlan0Gateway">
                <b>eth0</b><label class="chk"><input type="checkbox" data-opt="eth0MaskOn"> Mask</label><input type="text" class="mono-input" data-cfg="eth0Mask">
                <span></span><label class="chk"><input type="checkbox" data-opt="eth0GatewayOn"> GW</label><input type="text" class="mono-input" data-cfg="eth0Gateway">
              </div>
              <div class="row" style="margin-top:14px;gap:18px">
                <label class="chk"><input type="checkbox" data-opt="restartDhcpcd"> Restart dhcpcd.service</label>
                <label class="chk"><input type="checkbox" data-opt="restartWpa"> Restart wpa_supplicant</label>
              </div>
            </div>
          </section>

          <section class="card">
            <div class="card-h row" style="justify-content:space-between">TTY MESAJI <span class="sm muted" style="text-transform:none;letter-spacing:0;font-weight:500" id="uTtyTarget">Listeden bir cihaz seçin</span></div>
            <div class="card-b row" style="align-items:stretch;flex-wrap:nowrap">
              <textarea id="uTty" rows="3" data-cfg="ttyText" style="flex:1;min-width:0;padding:8px;border-radius:9px;border:1px solid var(--border-strong);background:var(--surface);color:inherit;font:inherit;resize:vertical"></textarea>
              <div class="stack" style="gap:6px;align-content:start"><button class="btn primary" id="uTtySend" style="min-width:84px;justify-content:center">Gönder</button><button class="btn" id="uTtyClear" style="justify-content:center">Temizle</button></div>
            </div>
          </section>

          <!-- Dosya gönder: bu bilgisayardan seçilen dosya / klasörler işaretli cihazlarda bir klasöre -->
          <section class="card" id="uSend">
            <div class="card-h row" style="justify-content:space-between">DOSYA GÖNDER <span class="sm muted" style="text-transform:none;letter-spacing:0;font-weight:500" id="uSendSummary">Dosya seçilmedi</span></div>
            <div class="card-b stack" style="gap:10px">
              <div class="row tight">
                <button class="btn" id="uSendFiles">${ICONS.upload} Dosya seç</button>
                <button class="btn" id="uSendFolder">${ICONS.folder} Klasör seç</button>
                <button class="link" id="uSendClear">Temizle</button>
                <input type="file" id="uSendFileIn" multiple hidden>
                <input type="file" id="uSendDirIn" webkitdirectory multiple hidden>
              </div>
              <div class="send-list" id="uSendList"></div>
              <div><div class="sm muted" style="margin-bottom:4px">Cihazdaki hedef klasör</div>
                <input type="text" class="mono-input" id="uSendDir" list="uSendDirs" data-cfg="sendRemoteDir" style="width:100%" autocomplete="off"
                  title="Yoksa oluşturulur. Aynı adlı dosyaların üzerine yazılır; sistem klasörlerine sudo ile yazılır.">
                <datalist id="uSendDirs">${SEND_DIRS.map((d) => `<option value="${d}">`).join("")}</datalist></div>
              <div class="row" style="gap:6px 16px">
                <label class="chk" title="Kopyalanan .sh dosyalarına chmod +x uygulanır."><input type="checkbox" id="uSendChmod"> .sh dosyalarını çalıştırılabilir yap</label>
                <label class="chk" title="Metin dosyalarında (.sh .service .conf .txt .json .py ... ve #! ile başlayanlar) CRLF → LF, UTF-8 BOM silinir.&#10;Aksi halde Windows'ta kaydedilmiş script Linux'ta çalışmaz."><input type="checkbox" id="uSendCrlf"> Windows satır sonlarını düzelt</label>
              </div>
              <button class="btn primary" id="uSendRun" style="justify-content:center">${ICONS.upload} <span>İşaretli cihazlara gönder</span></button>
            </div>
          </section>
        </div>

        <section class="card">
          <div class="card-b">
            <div class="row" id="uProgWrap" style="margin-bottom:12px;flex-wrap:nowrap" hidden>
              <div class="progress" style="flex:1"><div id="uBar"></div></div><b class="sm" id="uProg"></b>
            </div>
            <div class="row" style="flex-wrap:nowrap">
              <button class="btn" id="uVersion" style="flex:1;justify-content:center" title="İşaretli cihazlarda SerialWorkerServiceVol61.dll sürümünü okur">${ICONS.version} <span>Versiyon kontrol</span></button>
              <button class="btn primary" id="uStart" style="flex:1.3;justify-content:center;padding:0 14px;height:40px">${ICONS.play} <span>Güncellemeyi başlat</span></button>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- ═════════ TEK CİHAZ ═════════ -->
    <div class="upd-single" id="uSingle" hidden>
      <div class="stack">
        <section class="card">
          <div class="card-h">HEDEF CİHAZ</div>
          <div class="card-b">
            <label class="field-label" for="sIp">IP adresi</label>
            <input type="text" id="sIp" class="mono-input" data-cfg="singleTargetIp" style="width:100%" autocomplete="off">
            <div class="sm muted" style="margin-top:10px">Kullanıcı ve şifre üst banttaki SSH düğmesinden alınır.</div>
          </div>
        </section>

        <section class="card">
          <div class="card-h">JSONSETTINGS.JSON</div>
          <div class="card-b">
            <div class="row" style="margin-bottom:10px;flex-wrap:nowrap"><label class="chk" style="width:110px"><input type="checkbox" data-single="doYatak"> Yatak ID</label>
              <select id="sYatak" data-single-val="yatakId" style="width:110px">${Array.from({ length: 100 }, (_, i) => `<option>${i}</option>`).join("")}</select></div>
            <div class="row" style="flex-wrap:nowrap"><label class="chk" style="width:110px"><input type="checkbox" data-single="doServer"> Server IP</label>
              <input type="text" class="mono-input" data-cfg="singleServerIp" style="flex:1;min-width:0"></div>
          </div>
        </section>

        <section class="card">
          <div class="card-h">DHCPCD.CONF · STATİK IP</div>
          <div class="card-b">
            <div class="row" style="flex-wrap:nowrap;margin-bottom:4px"><span style="width:88px"></span><span class="field-label" style="flex:1">IP adresi</span><span class="field-label" style="width:140px">Ağ maskesi</span></div>
            <div class="row" style="flex-wrap:nowrap;margin-bottom:10px"><label class="chk" style="width:88px"><input type="checkbox" data-single="doEth0"> eth0</label>
              <input type="text" class="mono-input" data-cfg="singleEth0Ip" style="flex:1;min-width:0">
              <input type="text" class="mono-input" data-cfg="singleEth0Mask" style="width:140px" title="255.255.255.0 veya /24 biçiminde; boşsa CIDR yazılmaz"></div>
            <div class="row" style="flex-wrap:nowrap"><label class="chk" style="width:88px"><input type="checkbox" data-single="doWlan0"> wlan0</label>
              <input type="text" class="mono-input" data-cfg="singleWlan0Ip" style="flex:1;min-width:0">
              <input type="text" class="mono-input" data-cfg="singleWlan0Mask" style="width:140px" title="255.255.255.0 veya /24 biçiminde; boşsa CIDR yazılmaz"></div>
          </div>
        </section>

        <button class="btn primary" id="sApply" style="width:100%;justify-content:center;height:40px">${ICONS.send} Uygula (SSH)</button>
      </div>

      <section class="card">
        <div class="card-h row" style="justify-content:space-between">İŞLEM GÜNLÜĞÜ <button class="link" id="sClear" style="text-transform:none;letter-spacing:0">Temizle</button></div>
        <div class="card-b"><div class="logbox" id="sLog" style="height:420px"></div></div>
      </section>
    </div>`;

  const q = (id) => $("#" + id, root);
  const el = {
    batch: q("uBatch"), single: q("uSingle"), summary: q("uSummary"), newIp: q("uNewIp"), head: q("uHead"), body: q("uBody"),
    wrap: q("uTableWrap"), log: q("uLog"), sLog: q("sLog"), par: q("uPar"), folderPath: q("uFolderPath"),
    progWrap: q("uProgWrap"), bar: q("uBar"), prog: q("uProg"), version: q("uVersion"), start: q("uStart"),
    ttyTarget: q("uTtyTarget"), tty: q("uTty"), options: q("uOptions"), dhcp: q("uDhcp"), session: q("uSession"),
  };

  // IP / maske alanları: ortak giriş kuralı (util.js ipFilter)
  ipFilter(el.newIp);
  ipFilter(q("sIp"));
  for (const k of ["wlan0Gateway", "eth0Gateway", "singleServerIp", "singleEth0Ip", "singleWlan0Ip"]) ipFilter($(`[data-cfg="${k}"]`, root));
  for (const k of ["wlan0Mask", "eth0Mask", "singleEth0Mask", "singleWlan0Mask"]) ipFilter($(`[data-cfg="${k}"]`, root), "mask");

  // ── Günlük ──────────────────────────────────────────────────
  const MAX_LOG = 5000;
  function addLog(box, { time, ip, message, kind }) {
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const d = document.createElement("div");
    d.className = `logline ${kind || "info"}`;
    d.innerHTML = `<span class="t">${esc(time)}</span>${ip ? `<span class="ip">${esc(ip)}</span>` : ""}<span class="m">${esc(message)}</span>`;
    box.append(d);
    while (box.childElementCount > MAX_LOG) box.firstElementChild.remove();
    if (near) box.scrollTop = box.scrollHeight;
  }
  const now = () => new Date().toLocaleTimeString("tr-TR");
  const log = (message, kind = "info", ip = "") => addLog(el.log, { time: now(), ip, message, kind });
  q("uClearLog").addEventListener("click", () => { el.log.innerHTML = ""; });
  q("sClear").addEventListener("click", () => { el.sLog.innerHTML = ""; });

  // ── Ayarlar (ajanda saklanır) ───────────────────────────────
  const saveSettings = debounce(async () => {
    try { await api("/api/update/settings", { method: "PUT", body: cfg }); }
    catch (e) { toast("Ayarlar kaydedilemedi: " + e.message); }
  }, 600);

  async function loadSettings() {
    try { cfg = { ...cfg, ...(await api("/api/update/settings")) }; } catch { return; }
    $$("[data-cfg]", root).forEach((i) => { i.value = cfg[i.dataset.cfg] ?? ""; });
    el.par.textContent = cfg.parallel;
    q("uSeqFill").checked = cfg.sequentialIpFill !== false;
    q("uSendChmod").checked = cfg.sendChmodSh !== false;
    q("uSendCrlf").checked = cfg.sendFixLineEndings !== false;
    try {
      fileInfo = await api("/api/update/info");
      el.folderPath.textContent = fileInfo.workFolder;
      const have = new Set(fileInfo.files.map((f) => f.name.toLowerCase()));
      $$("[data-missing]", root).forEach((s) => { s.hidden = have.has(s.dataset.missing.toLowerCase()); });
    } catch { /* bilgi yoksa işaretler gizli kalır */ }
  }

  root.addEventListener("input", (e) => {
    const c = e.target.closest("[data-cfg]");
    if (c) { cfg[c.dataset.cfg] = c.value; saveSettings(); }
  });

  function setPar(v) { cfg.parallel = Math.min(100, Math.max(1, v)); el.par.textContent = cfg.parallel; saveSettings(); }
  q("uParMinus").addEventListener("click", () => setPar(cfg.parallel - 1));
  q("uParPlus").addEventListener("click", () => setPar(cfg.parallel + 1));

  // ── Sekmeler ────────────────────────────────────────────────
  function setTab(t) {
    tab = t;
    $$("[data-tab]", root).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    el.batch.hidden = tab !== "batch"; el.single.hidden = tab !== "single";
  }
  root.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]");
    if (t) setTab(t.dataset.tab);
  });

  // ── Seçenekler ──────────────────────────────────────────────
  function groupState(name) {
    const n = GROUPS[name].filter((o) => opt[o.k]).length;
    return n === 0 ? false : n === GROUPS[name].length ? true : null;
  }

  function syncOptionsUi() {
    $$("input[data-opt]", root).forEach((i) => { i.checked = !!opt[i.dataset.opt]; });
    $$("input[data-group]", root).forEach((i) => {
      const s = groupState(i.dataset.group);
      i.checked = s === true; i.indeterminate = s === null;
    });
    $$(".chip", root).forEach((c) => c.setAttribute("aria-checked", String(opt[c.dataset.radio] === c.dataset.v)));
    // Mask / GW kutuları yalnızca işaretliyken düzenlenebilir
    const dis = (k, on) => { const i = $(`[data-cfg="${k}"]`, root); if (i) i.disabled = !on; };
    dis("wlan0Mask", opt.wlan0MaskOn); dis("wlan0Gateway", opt.wlan0GatewayOn);
    dis("eth0Mask", opt.eth0MaskOn); dis("eth0Gateway", opt.eth0GatewayOn);
    // Tek cihaz sekmesi
    $$("input[data-single]", root).forEach((i) => { i.checked = !!single[i.dataset.single]; });
    dis("singleServerIp", single.doServer); dis("singleEth0Ip", single.doEth0); dis("singleEth0Mask", single.doEth0);
    dis("singleWlan0Ip", single.doWlan0); dis("singleWlan0Mask", single.doWlan0);
    q("sYatak").disabled = !single.doYatak;
    q("sYatak").value = String(single.yatakId);
  }

  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.opt) opt[t.dataset.opt] = t.checked;
    else if (t.dataset.group) {
      // Karışık durumdayken tıklanınca hepsi seçilir (WPF ile aynı)
      const v = t.indeterminate || t.checked;
      GROUPS[t.dataset.group].forEach((o) => { opt[o.k] = v; });
    } else if (t.dataset.single) single[t.dataset.single] = t.checked;
    else if (t.dataset.singleVal) single[t.dataset.singleVal] = Number(t.value);
    else return;
    syncOptionsUi();
  });

  root.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) { opt[chip.dataset.radio] = chip.dataset.v; syncOptionsUi(); }
  });

  q("uSelAll").addEventListener("click", () => { ALL_KEYS.forEach((k) => (opt[k] = true)); syncOptionsUi(); });
  q("uSelNone").addEventListener("click", () => {
    ALL_KEYS.forEach((k) => (opt[k] = false));
    opt.cronService = opt.autologin = opt.conspy = "None";
    syncOptionsUi();
  });

  // ── Dosyayı sunucuda aç (çift tıklama / kalem düğmesi) ──────
  async function openOnServer(kind, name) {
    try { await api("/api/update/open", { method: "POST", body: { kind, name } }); }
    catch (e) { toast(e.message, 4000); }
  }
  root.addEventListener("click", (e) => { const b = e.target.closest("[data-open]"); if (b) openOnServer("file", b.dataset.open); });
  root.addEventListener("dblclick", (e) => {
    const l = e.target.closest("[data-dbl]"); if (!l) return;
    e.preventDefault();
    // Çift tıklama kutuyu iki kez değiştirdi (net etki yok); yine de durumu arayüzle eşitle
    syncOptionsUi();
    openOnServer("file", l.dataset.dbl);
  });
  q("uFolder").addEventListener("click", () => openOnServer("folder"));
  q("uReport").addEventListener("click", () => openOnServer("report"));

  // ── Cihaz listesi ───────────────────────────────────────────
  const roomOf = (title) => {
    const key = (title || "").trim().toLocaleLowerCase("tr");
    let i = rooms.findIndex((r) => r.key === key);
    if (i < 0) { rooms.push({ key, title: (title || "").trim() || "(Oda belirtilmemiş)", idx: rooms.length, collapsed: false }); i = rooms.length - 1; }
    return i;
  };

  const newRow = (ip, oda, yatakId, yatakAdi) => ({
    id: seq++, ip, ipSort: ipKey(ip), room: roomOf(oda), yatakAdi: (yatakAdi || "").trim(), yatakId: yatakId || "",
    wlan0: "", eth0: "", wlan0Auto: false, eth0Auto: false, checked: false, status: "", statusSev: "none", lastMessage: "", version: "", versionSev: "none", updating: false,
  });

  function setDevices(devices) {
    if (isBusy()) return false;
    rows = []; rooms = []; seq = 0; selected = new Set(); lastClicked = null;
    let added = 0, skipped = 0;
    for (const r of devices.rows) {
      const ip = (r.ip || "").trim();
      if (!isIpv4(ip) || rows.some((x) => x.ip === ip)) { skipped++; continue; }
      // YATAK ID yalnızca sayı olabilir (JsonSettings'e yazılır); sayı değilse boş bırakılır
      const yatakId = /^\d+$/.test((r.yatakId || "").trim()) ? r.yatakId.trim() : "";
      rows.push(newRow(ip, r.oda, yatakId, r.yatak));
      added++;
    }
    if (devices.rows.length === 0) log("Cihaz listesi kaldırıldı.");
    else log(skipped === 0 ? `${added} cihaz yüklendi.` : `${added} cihaz yüklendi (${skipped} satır geçersiz / tekrarlı IP, atlandı).`);
    render();
    return true;
  }

  /**
   * Cihaz Kontrol'deki "Güncelle" düğmesi: yalnızca bu IP işaretli kalır, satır seçilir ve odası açılır.
   * (Diğer işaretler kaldırılır ki yanlışlıkla başka cihazlar da güncellenmesin.)
   */
  function focusTarget(ip) {
    const r = rowByIp(ip);
    if (!r) { log("Bu IP güncelleme listesinde yok.", "warn", ip); return; }
    if (isBusy()) log("İşlem sürerken işaretler değiştirilemez; satır yalnızca seçildi.", "warn", ip);
    else { rows.forEach((x) => { x.checked = x === r; }); log("Cihaz Kontrol'den seçildi; yalnızca bu cihaz işaretli.", "info", ip); }
    setTab("batch");
    rooms[r.room].collapsed = false;
    selected = new Set([r.id]); lastClicked = r.id;
    render();
    $(`tr[data-id="${r.id}"]`, el.body)?.scrollIntoView({ block: "nearest" });
  }

  function addIp() {
    const ip = el.newIp.value.trim();
    if (!isIpv4(ip)) return log("Geçerli bir IP girin.", "error");
    if (rows.some((r) => r.ip === ip)) return log("Bu IP zaten listede.", "error");
    const r = newRow(ip, "", "", "");
    rows.push(r); selected = new Set([r.id]); lastClicked = r.id;
    el.newIp.value = "";
    log("IP eklendi.");
    render();
  }
  q("uAdd").addEventListener("click", addIp);
  el.newIp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addIp(); } });

  function deleteSelected() {
    if (selected.size === 0) return log("Bir öğe seçin.", "error");
    if (isBusy()) return log("İşlem sürerken satır silinemez.", "warn");
    rows = rows.filter((r) => !selected.has(r.id));
    selected = new Set();
    log("Seçili IP(ler) silindi.");
    render();
  }
  q("uDelete").addEventListener("click", deleteSelected);
  el.wrap.addEventListener("keydown", (e) => {
    if (e.key === "Delete" && !e.target.closest("input")) { e.preventDefault(); deleteSelected(); }
  });

  q("uToggleRooms").addEventListener("click", () => {
    const anyOpen = rooms.some((r) => !r.collapsed);
    rooms.forEach((r) => { r.collapsed = anyOpen; });
    render();
  });
  q("uCheckAll").addEventListener("click", () => { if (!isBusy()) { rows.forEach((r) => (r.checked = true)); render(); } });
  q("uUncheckAll").addEventListener("click", () => { if (!isBusy()) { rows.forEach((r) => (r.checked = false)); render(); } });

  // ── Tablo ───────────────────────────────────────────────────
  function visibleRows() {
    const col = COLUMNS.find((c) => c.key === sort.key);
    return [...rows].sort((a, b) => {
      if (a.room !== b.room) return a.room - b.room;
      if (!col) return a.id - b.id;
      return sortCompare(col.val(a), col.val(b), sort.dir) || a.id - b.id;
    });
  }

  const badge = (text, sev, tip) => text ? `<span class="badge sev-${sev}" title="${esc(tip ?? text)}">${esc(text)}</span>` : "";

  function render() {
    const checked = rows.filter((r) => r.checked).length;
    el.summary.textContent = rows.length === 0 ? "Liste boş" : `${rows.length} cihaz · ${checked} işaretli`;

    const allState = checked === 0 ? false : checked === rows.length ? true : null;
    el.head.innerHTML = `<th style="cursor:default"><input type="checkbox" id="uAllBox" ${allState ? "checked" : ""} ${isBusy() ? "disabled" : ""} title="Tümünü işaretle / kaldır"></th>` +
      COLUMNS.map((c) => `<th data-k="${c.key}">${c.label}${sort.key === c.key ? `<span class="arr">${sort.dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("");
    const allBox = $("#uAllBox", el.head); if (allBox) allBox.indeterminate = allState === null;

    if (rows.length === 0) {
      el.body.innerHTML = `<tr><td class="empty" colspan="8">Cihaz listesi yüklenmedi.<br>Excel'i üst banttaki "Cihaz listesi" düğmesinden seçin ya da pencereye sürükleyin; tek tek IP de ekleyebilirsiniz.</td></tr>`;
      updateUi();
      return;
    }

    let html = "", last = -1;
    for (const r of visibleRows()) {
      const room = rooms[r.room];
      if (r.room !== last) {
        last = r.room;
        const m = rows.filter((x) => x.room === r.room);
        const mc = m.filter((x) => x.checked).length;
        // Oda kutusu: satırlardaki kutuyla aynı sütunda; karışıksa yarı dolu (indeterminate, aşağıda atanır)
        html += `<tr class="group" data-room="${r.room}" style="cursor:pointer">
          <td><input type="checkbox" data-roomcheck="${r.room}" ${mc === m.length ? "checked" : ""} data-mixed="${mc > 0 && mc < m.length ? 1 : 0}"
            ${isBusy() ? "disabled" : ""} title="Bu odadaki tüm cihazları işaretle / kaldır"></td><td colspan="7">
          <span class="gchip" style="background:${["#3B82F6", "#10B981", "#F59E0B", "#A855F7", "#EC4899", "#14B8A6", "#EF4444", "#84CC16"][r.room % 8]}"></span>${room.collapsed ? "▸" : "▾"} ${esc(room.title)}
          <span class="gcount">${m.length} cihaz · ${mc} işaretli</span></td></tr>`;
      }
      if (room.collapsed) continue;
      html += `<tr class="item${selected.has(r.id) ? " sel" : ""}" data-id="${r.id}">
        <td><input type="checkbox" data-check ${r.checked ? "checked" : ""} ${isBusy() ? "disabled" : ""}></td>
        <td class="mono edit" data-edit="ip"><span class="ipcell">${esc(r.ip)}<button class="copy-ip" data-copy title="IP adresini kopyala">${ICONS.copy}</button></span></td>
        <td title="${esc(r.yatakAdi)}">${esc(r.yatakAdi) || DASH}</td>
        <td class="mono edit" data-edit="yatakId">${esc(r.yatakId) || `<span class="txt-muted">${DASH}</span>`}</td>
        <td>${badge(r.status, r.statusSev, r.lastMessage || r.status)}</td>
        <td>${badge(r.version, r.versionSev)}</td>
        <td class="mono edit${r.wlan0Auto ? " auto-ip" : ""}" data-edit="wlan0"${r.wlan0Auto ? ' title="Sıralı doldurmayla yazıldı"' : ""}>${esc(r.wlan0)}</td>
        <td class="mono edit${r.eth0Auto ? " auto-ip" : ""}" data-edit="eth0"${r.eth0Auto ? ' title="Sıralı doldurmayla yazıldı"' : ""}>${esc(r.eth0)}</td></tr>`;
    }
    el.body.innerHTML = html;
    $$("input[data-mixed='1']", el.body).forEach((i) => { i.indeterminate = true; });
    updateUi();
  }

  let raf = 0;
  const scheduleRender = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };

  el.head.addEventListener("click", (e) => {
    if (e.target.id === "uAllBox") {
      if (isBusy()) return;
      const on = e.target.checked || e.target.indeterminate;
      rows.forEach((r) => (r.checked = on)); render(); return;
    }
    const th = e.target.closest("th[data-k]"); if (!th) return;
    sort = sort.key === th.dataset.k ? { key: th.dataset.k, dir: -sort.dir } : { key: th.dataset.k, dir: 1 };
    render();
  });

  el.body.addEventListener("click", (e) => {
    if (e.target.matches("input[data-roomcheck]")) {
      // Tıklamadan sonra checked: hiçbiri / karışık → true (hepsini işaretle), hepsi → false
      if (isBusy()) return;
      const room = +e.target.dataset.roomcheck, on = e.target.checked;
      rows.forEach((x) => { if (x.room === room) x.checked = on; });
      render();
      return;
    }
    const g = e.target.closest("tr.group");
    if (g) { const room = rooms[+g.dataset.room]; room.collapsed = !room.collapsed; render(); return; }

    const tr = e.target.closest("tr.item"); if (!tr) return;
    const id = +tr.dataset.id;
    const copyBtn = e.target.closest("[data-copy]");
    if (copyBtn) { copyIp(rows.find((r) => r.id === id).ip, copyBtn); return; }
    if (e.target.matches("input[data-check]")) {
      rows.find((r) => r.id === id).checked = e.target.checked;
      render();
      return;
    }
    if (e.target.closest("input.cell-edit")) return;

    // Satır seçimi: tıkla = tek, Ctrl = ekle/çıkar, Shift = aralık
    const order = visibleRows().filter((r) => !rooms[r.room].collapsed).map((r) => r.id);
    if (e.shiftKey && lastClicked != null && order.includes(lastClicked)) {
      const [a, b] = [order.indexOf(lastClicked), order.indexOf(id)].sort((x, y) => x - y);
      selected = new Set(order.slice(a, b + 1));
    } else if (e.ctrlKey || e.metaKey) {
      selected.has(id) ? selected.delete(id) : selected.add(id);
      lastClicked = id;
    } else { selected = new Set([id]); lastClicked = id; }
    render();
  });

  // Hücre düzenleme (çift tıklama): geçersiz değer reddedilir ve eski değer döner
  el.body.addEventListener("dblclick", (e) => {
    if (e.target.closest("[data-copy]")) return;          // kopyala düğmesine hızlı iki tıklama
    const td = e.target.closest("td[data-edit]"); if (!td || isBusy()) return;
    const r = rows.find((x) => x.id === +td.closest("tr").dataset.id);
    const field = td.dataset.edit;
    const input = document.createElement("input");
    input.type = "text"; input.className = "cell-edit mono-input"; input.value = r[field];
    if (field === "ip" || field === "wlan0" || field === "eth0") ipFilter(input);
    td.textContent = ""; td.append(input); input.focus(); input.select();

    let finished = false;
    const finish = (commit) => {
      if (finished) return; finished = true;
      if (commit) {
        const v = input.value.trim();
        let ok = true;
        if (field === "ip") ok = isIpv4(v) && !rows.some((x) => x !== r && x.ip === v);
        else if (field === "yatakId") ok = v === "" || /^\d+$/.test(v);
        else ok = v === "" || isIpv4(v);
        if (ok) {
          const changed = r[field] !== v;
          r[field] = v;
          if (field === "ip") r.ipSort = ipKey(v);
          if (field === "wlan0" || field === "eth0") {
            r[field + "Auto"] = false;                      // elle girildi
            if (changed && cfg.sequentialIpFill !== false) fillIpsDown(r, field);
          }
        } else toast("Geçersiz değer");
      }
      render();
    };
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") finish(true); else if (ev.key === "Escape") finish(false); });
    input.addEventListener("blur", () => finish(true));
  });

  // ── wlan0 / eth0 sıralı doldurma ────────────────────────────
  q("uSeqFill").addEventListener("change", (e) => { cfg.sequentialIpFill = e.target.checked; saveSettings(); });

  const ipToInt = (ip) => ip.split(".").reduce((a, x) => a * 256 + Number(x), 0);
  const intToIp = (n) => [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join(".");
  /** Sıradaki adres; son baytı 0 veya 255 olanlar (ağ / yayın) atlanır. Adres alanı biterse null. */
  const nextHostIp = (n) => {
    do { if (n >= 0xFFFFFFFF) return null; n++; } while (n % 256 === 0 || n % 256 === 255);
    return n;
  };

  /**
   * Tablo sırasıyla (oda grupları ve sıralama dahil) satırın altındakileri doldurur. Boş ya da daha önce
   * otomatik doldurulmuş hücreler yazılır; elle girilmiş ilk değerde durulur. Kaynak silindiyse otomatikler de silinir.
   * (WPF UpdateViewModel.FillIpsDown ile aynı davranış.)
   */
  function fillIpsDown(from, field) {
    const auto = field + "Auto";
    const start = from[field];
    let next = isIpv4(start) ? nextHostIp(ipToInt(start)) : null;
    const order = visibleRows();
    let filled = 0;
    for (const r of order.slice(order.indexOf(from) + 1)) {
      if (r[field] && !r[auto]) break;
      const value = next != null ? intToIp(next) : "";
      r[field] = value; r[auto] = value !== "";
      if (value) filled++;
      if (next != null) next = nextHostIp(next);
    }
    if (filled) log(`${field}: alttaki ${filled} satır ${start} sonrasından sırayla dolduruldu.`);
  }

  async function copyIp(ip, btn) {
    try {
      await copyText(ip);
      btn.classList.add("done"); btn.innerHTML = ICONS.check;
      setTimeout(() => { btn.classList.remove("done"); btn.innerHTML = ICONS.copy; }, 1200);
      toast("IP kopyalandı: " + ip);
    } catch { toast("Kopyalanamadı"); }
  }

  // ── İşlem çalıştırma ────────────────────────────────────────
  function updateUi() {
    const busy = isBusy();
    el.progWrap.hidden = !busy;
    el.bar.style.width = total ? `${Math.round((done / total) * 100)}%` : "0";
    el.prog.textContent = `${done} / ${total}`;

    el.version.disabled = running === "update" || running === "send";
    const send = q("uSendRun");
    send.querySelector("span").textContent = running === "send" ? (sendUploading ? "Yükleme iptal" : "İptal") : "İşaretli cihazlara gönder";
    send.classList.toggle("danger", running === "send"); send.classList.toggle("primary", running !== "send");
    send.disabled = busy && running !== "send";
    ["uSendFiles", "uSendFolder", "uSendClear", "uSendDir", "uSendChmod", "uSendCrlf"].forEach((k) => { q(k).disabled = busy; });
    el.version.querySelector("span").textContent = running === "version" ? "İptal" : "Versiyon kontrol";
    if (running === "update") {
      el.start.innerHTML = `${ICONS.stop} <span>İptal</span>`; el.start.classList.remove("primary"); el.start.classList.add("danger"); el.start.disabled = false;
    } else {
      el.start.innerHTML = `${ICONS.play} <span>Güncellemeyi başlat</span>`; el.start.classList.add("primary"); el.start.classList.remove("danger"); el.start.disabled = busy;
    }
    [el.options, el.dhcp].forEach((c) => c.querySelectorAll("input, button").forEach((i) => { if (!i.closest("#uSession")) i.disabled = busy || i.dataset.keepDisabled === "1"; }));
    if (!busy) syncOptionsUi();
    q("uNewIp").disabled = q("uAdd").disabled = busy;

    const sel = rows.find((r) => r.id === lastClicked && selected.has(r.id));
    el.ttyTarget.textContent = sel ? `Hedef: ${sel.ip}` : "Listeden bir cihaz seçin";
  }

  const rowById = (id) => rows.find((r) => r.id === id);
  const rowByIp = (ip) => rows.find((r) => r.ip.toLowerCase() === String(ip).toLowerCase());

  function onMessage(m) {
    switch (m.type) {
      case "start": runId = m.runId; total = m.total; break;
      case "log": {
        addLog(el.log, m);
        const r = m.ip ? rowByIp(m.ip) : null;
        if (r) {
          r.lastMessage = m.message;
          if (r.updating) { r.status = m.message; r.statusSev = kindToSev(m.kind); }
        }
        break;
      }
      case "targetStart": { const r = rowById(m.id); if (r) { r.updating = true; r.status = "Başlatılıyor"; r.statusSev = "info"; } break; }
      case "targetResult": { const r = rowById(m.id); if (r) { r.updating = false; r.status = m.ok ? "Başarılı" : "Hata"; r.statusSev = m.ok ? "ok" : "error"; } break; }
      case "targetCancelled": { const r = rowById(m.id); if (r) { r.updating = false; r.status = "İptal edildi"; r.statusSev = "warn"; } break; }
      case "version": { const r = rowById(m.id); if (r) { r.version = m.text; r.versionSev = m.sev; } break; }
      case "progress": done = Math.max(done, m.done); total = m.total; break;   // paralel işlerde sıra karışabilir
    }
    scheduleRender();
  }

  async function run(kind, path, body) {
    running = kind; runId = null; done = 0; total = body.targets.length;
    abortCtl = new AbortController();
    updateUi(); render();
    try {
      await stream(path, body, onMessage, abortCtl.signal);
    } catch (e) {
      if (e.name !== "AbortError") log("İşlem kesildi: " + e.message, "error");
    } finally {
      rows.forEach((r) => { r.updating = false; });
      running = null; runId = null; abortCtl = null;
      updateUi(); render();
    }
  }

  function buildOptions() {
    const o = { conspy: opt.conspy, cronService: opt.cronService, autologin: opt.autologin,
      restartDhcpcd: opt.restartDhcpcd, restartWpa: opt.restartWpa };
    for (const k of ALL_KEYS) o[k] = opt[k];
    // Ajandaki UpdateOptions adları
    o.installNanoRc = opt.nanoRc; o.createNetStatusBannerService = opt.netStatusService;
    delete o.nanoRc; delete o.netStatusService;
    // dhcpcd satır bazlı: null = kutu seçili değil, "" = seçili ama boş
    o.wlan0Mask = opt.wlan0MaskOn ? cfg.wlan0Mask.trim() : null;
    o.wlan0Gateway = opt.wlan0GatewayOn ? cfg.wlan0Gateway.trim() : null;
    o.eth0Mask = opt.eth0MaskOn ? cfg.eth0Mask.trim() : null;
    o.eth0Gateway = opt.eth0GatewayOn ? cfg.eth0Gateway.trim() : null;
    return o;
  }

  const toTarget = (r) => ({ id: r.id, ip: r.ip, yatakId: r.yatakId === "" ? null : Number(r.yatakId), wlan0: r.wlan0 || null, eth0: r.eth0 || null });

  async function startUpdate() {
    if (isBusy()) return;
    if (rows.length === 0) return log("Listede IP yok.", "error");
    const targets = rows.filter((r) => r.checked);
    if (targets.length === 0) return log("İşaretli satır yok.", "warn");

    const anyRowDhcpcd = targets.some((t) => t.wlan0 || t.eth0);
    const anyFeature = ALL_KEYS.some((k) => opt[k]);
    if (!anyFeature && !anyRowDhcpcd && opt.cronService === "None" && opt.autologin === "None" && opt.conspy === "None")
      return log("En az bir güncelleme seçin.", "error");
    if (opt.jsonSettings && targets.some((t) => t.yatakId === "") &&
        !confirm("Yatak ID boş olan satırlar var. JsonSettings güncellenecek. Devam edilsin mi?")) return;

    if (ctx.requireSsh && !(await ctx.requireSsh())) return;
    targets.forEach((t) => { t.status = "Sırada"; t.statusSev = "muted"; });
    await run("update", "/api/update/run", { targets: targets.map(toTarget), options: buildOptions(), parallel: cfg.parallel });
  }

  async function startVersion() {
    if (running === "version") { cancel(); return; }
    if (isBusy()) return;
    const targets = rows.filter((r) => r.checked);
    if (targets.length === 0) return log("Versiyon kontrol için işaretli cihaz yok.", "warn");
    if (ctx.requireSsh && !(await ctx.requireSsh())) return;
    await run("version", "/api/update/version", { targets: targets.map(toTarget), parallel: cfg.parallel });
  }

  function cancel() {
    if (!runId) return;
    log("İptal ediliyor... (süren adımlar bitince durur)", "warn");
    api("/api/update/cancel?id=" + runId, { method: "POST" }).catch(() => {});
  }

  el.start.addEventListener("click", () => (running === "update" ? cancel() : startUpdate()));
  el.version.addEventListener("click", startVersion);

  // ── Dosya gönder ────────────────────────────────────────────
  // Seçilenler ajana tek tek yüklenir (geçici klasör), sonra ajan işaretli cihazlara kopyalar (WPF FileSender ile aynı).

  const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
  const sendFiles = () => {
    const m = new Map();                   // aynı hedef yola düşen dosyadan sonuncusu kalır
    sendGroups.forEach((g) => g.files.forEach((f) => m.set(f.rel, f)));
    return [...m.values()];
  };

  function renderSend() {
    const files = sendFiles();
    q("uSendSummary").textContent = files.length ? `${files.length} dosya, ${fmtSize(files.reduce((a, f) => a + f.file.size, 0))}` : "Dosya seçilmedi";
    q("uSendList").innerHTML = sendGroups.length
      ? sendGroups.map((g, i) => `<div class="send-item" title="${esc(g.title)}"><span>${esc(g.label)}</span>
          <button class="copy-ip" data-sendrm="${i}" title="Listeden çıkar" ${isBusy() ? "disabled" : ""}>✕</button></div>`).join("")
      : `<div class="send-empty">Dosya / klasör seçin ya da buraya sürükleyin</div>`;
  }

  function addSendGroups(files) {
    // files: [{file, rel}] — rel "klasor/alt/dosya" ya da "dosya"; üst klasöre göre gruplanır
    const byTop = new Map();
    for (const f of files) {
      const top = f.rel.includes("/") ? f.rel.split("/")[0] + "/" : f.rel;
      if (!byTop.has(top)) byTop.set(top, []);
      byTop.get(top).push(f);
    }
    for (const [top, fs] of byTop) {
      const i = sendGroups.findIndex((g) => g.key === top);
      const size = fmtSize(fs.reduce((a, f) => a + f.file.size, 0));
      const g = { key: top, files: fs, label: top.endsWith("/") ? `${top} (${fs.length} dosya, ${size})` : `${top} (${size})`, title: fs.map((f) => f.rel).join("\n") };
      if (i >= 0) sendGroups[i] = g; else sendGroups.push(g);
    }
    renderSend();
  }

  q("uSendFiles").addEventListener("click", () => q("uSendFileIn").click());
  q("uSendFolder").addEventListener("click", () => q("uSendDirIn").click());
  q("uSendFileIn").addEventListener("change", (e) => { addSendGroups([...e.target.files].map((file) => ({ file, rel: file.name }))); e.target.value = ""; });
  q("uSendDirIn").addEventListener("change", (e) => { addSendGroups([...e.target.files].map((file) => ({ file, rel: file.webkitRelativePath || file.name }))); e.target.value = ""; });
  q("uSendClear").addEventListener("click", () => { if (!isBusy()) { sendGroups = []; renderSend(); } });
  q("uSendList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sendrm]"); if (!b || isBusy()) return;
    sendGroups.splice(+b.dataset.sendrm, 1); renderSend();
  });
  q("uSendChmod").addEventListener("change", (e) => { cfg.sendChmodSh = e.target.checked; saveSettings(); });
  q("uSendCrlf").addEventListener("change", (e) => { cfg.sendFixLineEndings = e.target.checked; saveSettings(); });

  // Sürükle-bırak: klasörler alt klasörleriyle okunur (sayfanın Excel bırakma alanına gitmez)
  const card = q("uSend");
  card.addEventListener("dragover", (e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); e.stopPropagation(); card.classList.add("drop"); } });
  card.addEventListener("dragleave", (e) => { if (!card.contains(e.relatedTarget)) card.classList.remove("drop"); });
  card.addEventListener("drop", async (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault(); e.stopPropagation(); card.classList.remove("drop");
    if (isBusy()) return;
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    const out = [];
    const readAll = (reader) => new Promise((res, rej) => {
      const acc = [];
      const next = () => reader.readEntries((batch) => { if (!batch.length) res(acc); else { acc.push(...batch); next(); } }, rej);
      next();
    });
    async function walk(entry, prefix) {
      if (entry.isFile) out.push({ file: await new Promise((res, rej) => entry.file(res, rej)), rel: prefix + entry.name });
      else if (entry.isDirectory) for (const c of await readAll(entry.createReader())) await walk(c, prefix + entry.name + "/");
    }
    try { for (const en of entries) await walk(en, ""); }
    catch (err) { toast("Dosyalar okunamadı: " + err.message); }
    if (out.length) addSendGroups(out);
  });

  async function startSend() {
    if (running === "send") { if (sendUploading) sendAbort = true; else cancel(); return; }
    if (isBusy()) return;
    const files = sendFiles();
    if (!files.length) return log("Gönderilecek dosya seçin.", "error");
    const targets = rows.filter((r) => r.checked);
    if (!targets.length) return log("Dosya göndermek için cihaz işaretleyin.", "warn");
    const dir = q("uSendDir").value.trim();
    if (!dir.startsWith("/") || dir === "/") return log("Cihazdaki hedef klasörü / ile başlayan bir yol olarak yazın (ör. /home/pi).", "error");
    const what = q("uSendSummary").textContent;
    if (!confirm(`${what}, işaretli ${targets.length} cihazda\n${dir}\nklasörüne kopyalanacak. Aynı adlı dosyaların üzerine yazılır.\n\nDevam edilsin mi?`)) return;
    if (ctx.requireSsh && !(await ctx.requireSsh())) return;

    // 1) Dosyaları ajana yükle
    const stageId = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    running = "send"; sendUploading = true; sendAbort = false; done = 0; total = files.length;
    updateUi(); renderSend();
    log(`Dosyalar ajana yükleniyor (${what})...`);
    let uploaded = false;
    try {
      for (const f of files) {
        if (sendAbort) throw new Error("İptal edildi.");
        await api(`/api/update/send/stage?id=${stageId}`, { method: "POST", body: f.file, headers: { "X-File-Name": encodeURIComponent(f.rel) } });
        done++; updateUi();
      }
      uploaded = true;
    } catch (e) {
      log("Dosyalar ajana yüklenemedi: " + e.message, sendAbort ? "warn" : "error");
      api(`/api/update/send/discard?id=${stageId}`, { method: "POST" }).catch(() => {});
    } finally {
      sendUploading = false; running = null;
      updateUi();
    }
    if (!uploaded) { renderSend(); return; }

    // 2) Cihazlara gönder (toplu güncellemeyle aynı akış ve tablo durumları)
    targets.forEach((t) => { t.status = "Sırada"; t.statusSev = "muted"; });
    await run("send", "/api/update/send/run", {
      stageId, targets: targets.map(toTarget), remoteDir: dir,
      chmodSh: q("uSendChmod").checked, fixLineEndings: q("uSendCrlf").checked, parallel: cfg.parallel,
    });
    renderSend();
  }
  q("uSendRun").addEventListener("click", startSend);
  renderSend();

  // ── TTY mesajı ──────────────────────────────────────────────
  q("uTtyClear").addEventListener("click", () => { el.tty.value = ""; cfg.ttyText = ""; saveSettings(); });
  q("uTtySend").addEventListener("click", async () => {
    const sel = rows.find((r) => r.id === lastClicked && selected.has(r.id));
    if (!sel) return log("Listeden bir cihaz seçin.", "error");
    if (!el.tty.value.trim()) return log("Gönderilecek metin boş.", "error");
    if (ctx.requireSsh && !(await ctx.requireSsh())) return;
    q("uTtySend").disabled = true;
    log("TTY0'a mesaj gönderiliyor...", "info", sel.ip);
    try {
      const r = await api("/api/update/tty", { method: "POST", body: { ip: sel.ip, text: el.tty.value } });
      log(r.message, r.ok ? "success" : "error", sel.ip);
    } catch (e) { log("Hata: " + e.message, "error", sel.ip); }
    finally { q("uTtySend").disabled = false; }
  });

  // ── Tek cihaz ───────────────────────────────────────────────
  q("sApply").addEventListener("click", async () => {
    if (singleBusy) return;
    const body = {
      targetIp: cfg.singleTargetIp.trim(),
      doYatak: single.doYatak, yatakId: single.yatakId,
      doServer: single.doServer, serverIp: cfg.singleServerIp,
      doEth0: single.doEth0, eth0Ip: cfg.singleEth0Ip, eth0Mask: cfg.singleEth0Mask,
      doWlan0: single.doWlan0, wlan0Ip: cfg.singleWlan0Ip, wlan0Mask: cfg.singleWlan0Mask,
    };
    const both = (message, kind = "info") => {
      addLog(el.sLog, { time: now(), ip: "", message, kind });
      log(message, kind, body.targetIp);              // WPF'te olduğu gibi ana günlüğe de yazılır
    };
    if (ctx.requireSsh && !(await ctx.requireSsh())) return;
    singleBusy = true; q("sApply").disabled = true; saveSettings.flush();
    try {
      await stream("/api/update/single", body, (m) => {
        if (m.type === "log") { addLog(el.sLog, m); log(m.message, m.kind, body.targetIp); }
      });
    } catch (e) { both(e.message, "error"); }
    finally { singleBusy = false; q("sApply").disabled = false; }
  });

  syncOptionsUi();
  render();

  return {
    root,
    onShow: loadSettings,
    isBusy,
    setDevices,
    focusTarget,
  };
}
