// TCP modülünün HL7 görünümü (WPF RboxTools Modules/Hl7/Hl7Panel + Hl7PanelViewModel + Hl7Waves ile aynı davranış):
// gelen veriden çözülen HL7 v2 mesajları. Dört görünüm: Mesajlar (liste + ayrıntı), Tablo (mesaj başına satır),
// Yataklar (yatak başına satır, yeni veri gelince güncellenir) ve Dalgalar (canlı dalga formları, merkezi monitör gibi).
// Mesajları tcp.js ekler (bağlantı başına birleştirilmiş veri); yandaki cihaz süzgecini de o verir (setFilter).
import { $, $$, esc, storeGet, storeSet, sortCompare, copyText, toast, ICONS } from "./util.js";
import { buildMessage, segmentRows, buildAck, isWaveMessage, fmtTr } from "./hl7core.js";

const MAX_MESSAGES = 2000;
const MAX_REPEAT_KEYS = 20000;

const KIND_LABEL = {
  all: ["Tümü", "Bütün cihazlar"],
  monitor: ["Hasta başı", "Hasta başı monitörler (türü tanımlanmamış cihazlar da: Eretna, Comen, EDAN …)"],
  vent: ["Ventilatör", "Ventilatörler"],
  infusion: ["İnfüzyon", "İnfüzyon pompaları"],
  perfusor: ["Perfüzör", "Perfüzörler (şırınga pompaları)"],
};
const VIEWS = [
  ["detail", "Mesajlar", "Mesaj listesi ve seçili mesajın ayrıntısı (ölçümler, alanlar, ham metin ve ACK)",
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>'],
  ["table", "Tablo", "Mesaj başına bir satır, her ölçüm bir sütun",
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/></svg>'],
  ["beds", "Yataklar", "Yatak başına bir satır; yeni veri gelince o yatağın satırı güncellenir",
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5"/><circle cx="7" cy="11" r="1.6"/></svg>'],
  ["waves", "Dalgalar", "Canlı dalga formları (EKG, Pleth, solunum, CO₂, ventilatör Paw / akış / hacim) monitördeki gibi kayar. Cihazın dalga gönderimi açık olmalı.",
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l2-6 4 12 3-9 2 3h5"/></svg>'],
];

// ── Dalga kanalı: halka tampon + oynatma imleci (WaveChannel) ─────
const BUFFER_SECONDS = 60, MAX_LIVE_LAG = 6, TARGET_SECONDS = 2;

function waveStyle(mn) {
  if (mn.startsWith("MDC_ECG_ELEC_POTL")) return ["#22C55E", 0, ["HR"]];
  if (mn.includes("PLETH")) return ["#22D3EE", 1, ["SpO₂", "PR"]];
  if (mn.includes("IMPED_TTHOR")) return ["#FACC15", 2, ["RR"]];
  if (mn.includes("CO2")) return ["#E5E7EB", 3, ["EtCO₂", "awRR"]];
  if (mn === "MDC_PRESS_AWAY") return ["#FB923C", 4, ["Ppeak", "PEEP"]];
  if (mn === "MDC_FLOW_AWAY") return ["#A78BFA", 5, ["MVe", "ftotal"]];
  if (mn === "MDC_VOL_AWAY") return ["#60A5FA", 6, ["VTe"]];
  if (mn.startsWith("MDC_PRESS_BLD")) return ["#F87171", 2, ["ABP-S", "ABP-D", "ABP-M"]];
  return ["#CBD5E1", 9, []];
}

class WaveChannel {
  constructor(mnemonic, name, short, unit, rate, replay) {
    Object.assign(this, { mnemonic, name, short, unit, replay });
    this.rate = rate > 0 ? rate : 1;
    this.buf = new Float64Array(Math.max(16, Math.floor(this.rate * BUFFER_SECONDS)));
    this.written = 0; this.cursor = 0; this.started = false;
    [this.color, this.order, this.valueShorts] = waveStyle(mnemonic);
    this.numbers = "";
    this.info = `${unit}${unit ? " · " : ""}${fmtTr(this.rate)} Hz`;
    // EKG ekran filtresi: 20 ms kayan ortalama (50 Hz şebeke paraziti ve katları silinir)
    this.firLen = mnemonic.startsWith("MDC_ECG_ELEC_POTL") ? Math.round(this.rate / 50) : 0;
    if (this.firLen >= 2) { this.fir = new Float64Array(this.firLen); this.firAt = 0; this.firCount = 0; this.firSum = 0; }
  }
  get oldest() { return Math.max(0, this.written - this.buf.length); }
  filter(v) {
    if (this.firLen < 2) return v;
    if (Number.isNaN(v)) { this.firCount = 0; this.firSum = 0; return v; }
    if (this.firCount === this.firLen) this.firSum -= this.fir[this.firAt]; else this.firCount++;
    this.fir[this.firAt] = v; this.firSum += v; this.firAt = (this.firAt + 1) % this.firLen;
    return this.firSum / this.firCount;
  }
  append(samples, replay) {
    if (replay) this.replay = true;
    const n = this.buf.length;
    for (const v of samples) this.buf[this.written++ % n] = this.filter(v);
  }
  at(i) { return i >= this.oldest && i < this.written ? this.buf[i % this.buf.length] : NaN; }
  /** İmleci geçen süre kadar ilerletir: canlıda ~2 sn tampon, hız ±%15; 6 sn'den geride kalırsa en yeniye atlar. */
  advance(sec) {
    if (!this.started) {
      if (this.written === 0 || (!this.replay && this.written - this.oldest < this.rate * TARGET_SECONDS)) return;
      this.cursor = this.oldest;
      this.started = true;
    }
    let speed = 1;
    if (!this.replay) {
      const buffered = (this.written - this.cursor) / this.rate;
      speed = Math.min(1.15, Math.max(0.85, 1 + (0.15 * (buffered - TARGET_SECONDS)) / TARGET_SECONDS * 2));
    }
    this.cursor = Math.min(this.written, this.cursor + sec * this.rate * speed);
    if (this.cursor < this.oldest) this.cursor = this.oldest;
    if (!this.replay && this.written - this.cursor > MAX_LIVE_LAG * this.rate) this.cursor = this.written - this.rate * TARGET_SECONDS;
  }
}

/** Dalga gönderen yatak (ya da yatağı olmayan cihaz). */
class WaveBed {
  constructor(key) { Object.assign(this, { key, title: "", sub: "", patient: "", sourceIp: "", kind: "monitor", channels: [] }); }
  get group() { return this.kind === "vent" ? "VENTİLATÖRLER" : this.kind === "infusion" || this.kind === "perfusor" ? "POMPALAR" : "HASTA BAŞI MONİTÖRLERİ"; }
  get groupOrder() { return this.kind === "vent" ? 1 : this.kind === "infusion" || this.kind === "perfusor" ? 2 : 0; }
  /** Kanal, örnekleme hızı belli ilk mesajla kurulur; hızsız mesaj yeni kanal açmaz (yoksa 1 Hz sanılırdı). */
  channel(o, replay) {
    let ch = this.channels.find((c) => c.mnemonic === o.mnemonic);
    if (ch) return ch;
    if (o.sampleRate <= 0) return null;
    ch = new WaveChannel(o.mnemonic, o.name, o.short, o.unit, o.sampleRate, replay);
    let at = 0;
    while (at < this.channels.length && this.channels[at].order <= ch.order) at++;
    this.channels.splice(at, 0, ch);
    this.layoutChanged = true;
    return ch;
  }
  setValues(values) {
    for (const ch of this.channels) ch.numbers = ch.valueShorts.filter((s) => values.has(s)).map((s) => `${s} ${values.get(s)}`).join("\n");
  }
}

// ── Dalga çizimi: canvas, ortak döngü (saniyede ~25 kare), yalnız görünenler ──
const views = new Set();
let raf = 0, lastT = 0;
const io = typeof IntersectionObserver === "function"
  ? new IntersectionObserver((entries) => { for (const e of entries) { const v = e.target._wave; if (v) v.visible = e.isIntersecting; } })
  : null;

function loop(t) {
  raf = requestAnimationFrame(loop);
  if (lastT && t - lastT < 38) return;
  const dt = lastT ? Math.min((t - lastT) / 1000, 0.25) : 0;
  lastT = t;
  const chans = new Set();
  for (const v of views) chans.add(v.ch);
  for (const ch of chans) ch.advance(dt);
  for (const v of views) if (v.visible) v.draw();
}
function hookLoop() {
  if (views.size && !raf) { lastT = 0; raf = requestAnimationFrame(loop); }
  else if (!views.size && raf) { cancelAnimationFrame(raf); raf = 0; }
}

class WaveView {
  constructor(canvas, ch, seconds) {
    Object.assign(this, { canvas, ch, seconds, visible: !io, lastStep: NaN, lo: NaN, hi: NaN });
    canvas._wave = this;
    this.ctx = canvas.getContext("2d");
  }
  attach() { views.add(this); io?.observe(this.canvas); hookLoop(); }
  detach() { views.delete(this); io?.unobserve(this.canvas); hookLoop(); }
  draw() {
    const ch = this.ch, cv = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (w < 4 || h < 4) return;
    // Tam piksel kaydırma: imleç sütun başına örnek sayısının katına yuvarlanır (kesirli adım çizgiyi titretir);
    // bir piksel ilerlemediyse yeniden çizilmez
    const perCol = (this.seconds * ch.rate) / w;
    const step = Math.floor(ch.cursor / perCol);
    if (step === this.lastStep && cv.width === w && cv.height === h) return;
    this.lastStep = step;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const end = step * perCol;
    const xs = [], vs = [];
    let lo = Infinity, hi = -Infinity;
    const add = (x, v) => { xs.push(x); vs.push(v); if (!Number.isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
    if (ch.written > 0) {
      for (let x = 0; x < w; x++) {
        const cx = x + 0.5;
        if (perCol < 1) {
          // Örnek piksel sayısından az (ventilatör 50 Hz): doğrusal ara değer
          const pos = end - (w - cx) * perCol, i0 = Math.floor(pos);
          const a = ch.at(i0), b = ch.at(i0 + 1), f = pos - i0;
          add(cx, Number.isNaN(a) ? b : Number.isNaN(b) ? a : a + (b - a) * f);
          continue;
        }
        const s0 = Math.floor(end - (w - x) * perCol);
        let s1 = Math.floor(end - (w - x - 1) * perCol);
        if (s1 <= s0) s1 = s0 + 1;
        if (perCol <= 6) {
          let sum = 0, k = 0;
          for (let i = s0; i < s1; i++) { const v = ch.at(i); if (!Number.isNaN(v)) { sum += v; k++; } }
          add(cx, k ? sum / k : NaN);
          continue;
        }
        // Çok sıkışık: sütunun en küçük ve en büyük örneği, geliş sırasıyla (sivri tepeler kaybolmasın)
        let mn = NaN, mx = NaN, imn = 0, imx = 0;
        for (let i = s0; i < s1; i++) {
          const v = ch.at(i);
          if (Number.isNaN(v)) continue;
          if (Number.isNaN(mn) || v < mn) { mn = v; imn = i; }
          if (Number.isNaN(mx) || v > mx) { mx = v; imx = i; }
        }
        if (Number.isNaN(mn)) { add(cx, NaN); continue; }
        if (imn <= imx) { add(cx, mn); if (mx !== mn) add(cx, mx); } else { add(cx, mx); add(cx, mn); }
      }
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    // Orta çizgi (soluk, noktalı)
    ctx.save();
    ctx.strokeStyle = "rgba(148,163,184,.18)"; ctx.lineWidth = 1; ctx.setLineDash([1, 3]);
    ctx.beginPath(); ctx.moveTo(0, Math.floor(h / 2) + 0.5); ctx.lineTo(w, Math.floor(h / 2) + 0.5); ctx.stroke();
    ctx.restore();
    if (lo > hi) return;
    // Dikey ölçek (eşikli): sığmazsa hemen genişler; belirgin küçülünce (%60 altı) yavaşça daralır
    const pad = Math.max((hi - lo) * 0.1, 1e-6), tlo = lo - pad, thi = hi + pad;
    if (Number.isNaN(this.lo)) { this.lo = tlo; this.hi = thi; }
    else if (lo < this.lo || hi > this.hi) { this.lo = Math.min(this.lo, tlo); this.hi = Math.max(this.hi, thi); }
    else if (thi - tlo < (this.hi - this.lo) * 0.6) { this.lo += (tlo - this.lo) * 0.05; this.hi += (thi - this.hi) * 0.05; }
    const range = Math.max(this.hi - this.lo, 1e-6), top = 2 * dpr, span = h - 4 * dpr;
    ctx.strokeStyle = ch.color;
    ctx.lineWidth = 1.6 * Math.max(1, dpr * 0.8);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < xs.length; i++) {
      const v = vs[i];
      if (Number.isNaN(v)) { pen = false; continue; }
      const y = top + ((this.hi - v) / range) * span;
      if (pen) ctx.lineTo(xs[i], y); else { ctx.moveTo(xs[i], y); pen = true; }
    }
    ctx.stroke();
  }
}

// ── Panel ─────────────────────────────────────────────────────────

/**
 * opts.onAck(on): "ACK gönder" değişti · opts.onLoad(): "Dosyadan yükle" · opts.onChange(): içerik değişti
 * (kopyala / temizle düğmeleri için).
 */
export function createHl7Panel(opts = {}) {
  const root = document.createElement("div");
  root.className = "h7";

  let view = VIEWS.some(([v]) => v === storeGet("rbox.hl7.view")) ? storeGet("rbox.hl7.view") : "detail";
  let kind = KIND_LABEL[storeGet("rbox.hl7.kind")] ? storeGet("rbox.hl7.kind") : "all";
  let layout = storeGet("rbox.hl7.layout") === "single" ? "single" : "grid";
  let processWaves = storeGet("rbox.hl7.waves") === "1";
  let ackOn = storeGet("rbox.hl7.ack") === "1";
  let tab = "obs";
  let shown = false;

  let all = [];                     // listeye giren mesajlar (dalga mesajları hariç)
  const seen = new Set();
  let next = 1, waveMessages = 0, skippedWaves = 0, ackCount = 0;
  let ip = null;                    // yandaki cihaz süzgeci
  let selected = null;
  const ackMap = new Map();         // "remote|kontrol no" → { time, ok } (ajanın gönderdiği onaylar)

  // Yataklar
  let beds = new Map(), bedCols = [], bedColKeys = new Map(), colKinds = new Map(), periodicCols = new Map();
  let bedSort = null, tableSort = null;   // { key, dir }
  // Dalgalar
  const waveBeds = new Map(), waveBedBySource = new Map(), vitals = new Map();
  let selectedWaveBed = null;
  let dirty = { list: true, detail: true, table: true, beds: true, waves: true };

  // ── Çubuk (TCP araç çubuğunda gösterilir) ──
  const bar = document.createElement("span");
  bar.className = "row tight h7-bar";
  bar.innerHTML = `
    <span class="seg mini" role="tablist" id="h7Views">
      ${VIEWS.map(([v, l, t, ic]) => `<button role="tab" data-v="${v}" title="${esc(t)}">${ic}${l}</button>`).join("")}
    </span>
    <label class="chk sm" title="İşaretliyken canlı dalga formları (EKG, Pleth, solunum, CO₂, ventilatör Paw / akış / hacim) çözülür ve Dalgalar görünümünde çizilir. Dalga verisi ölçümlerin onlarca katıdır; gerekmiyorsa kapalı tutun, dalga mesajları çözülmeden atlanır (ACK açıksa yine onaylanır). Dosyadan yüklenen kayıttaki ve demodaki dalgalar her zaman işlenir.">
      <input type="checkbox" id="h7Waves"> Dalgaları işle</label>
    <label class="chk sm" title="İşaretliyken ajan, gelen her HL7 mesajına anında kabul onayı (MLLP · MSA|AA, MSH-10 ile) gönderir. Onay alamayan cihaz (ör. Mindray, MSH-15 = AL) mesajı yeniden yollar ve bağlantıyı aralıklarla koparır. Demoda onay gönderilmez.">
      <input type="checkbox" id="h7Ack"> ACK gönder</label>
    <button class="btn mini" id="h7Load" title="Dosyadan yükle · kayıtlı HL7 verisini (bu programın TCP kopyası, eski aracın kayıtları, ham MLLP) okuyup buraya ekler; dalgalar gerçek hızında oynatılır">${ICONS.folder} Dosyadan yükle</button>
    <input type="file" id="h7File" multiple accept=".txt,.hl7,.log,.dat,text/plain" hidden>`;
  const bq = (id) => $("#" + id, bar);
  bq("h7Waves").checked = processWaves;
  bq("h7Ack").checked = ackOn;

  // ── Gövde ──
  const kindBar = () => `<span class="seg mini h7-kinds">${Object.entries(KIND_LABEL).map(([k, [l, t]]) =>
    `<button data-kind="${k}" title="${esc(t)}">${l} <span class="muted" data-kc="${k}">0</span></button>`).join("")}</span>`;
  const layoutBar = () => `<span class="seg mini h7-layout">
      <button data-layout="grid" title="Bütün yatakların dalgaları kart kart, aynı anda (merkezi monitör gibi)">Tüm yataklar</button>
      <button data-layout="single" title="Listeden seçilen yatağın dalgaları büyük">Tek yatak</button></span>`;

  root.innerHTML = `
    <div class="h7-detail" data-view="detail">
      <section class="card">
        <div class="card-h">HL7 mesajları</div>
        <div class="card-b"><div class="h7-list" id="h7List" role="listbox"></div></div>
      </section>
      <section class="card">
        <div class="card-h row" style="justify-content:space-between">Ayrıntı
          <span class="seg mini" id="h7Tabs">
            <button data-tab="obs" title="OBX satırları: parametre, değer, birim, referans aralığı">Ölçümler</button>
            <button data-tab="fields" title="Tüm segmentlerin dolu alanları ve bileşenleri (MSH-9, PV1-3.3 …)">Alanlar</button>
            <button data-tab="raw" title="Mesajın ham metni ve bu mesaja dönülecek onay (ACK)">Ham</button>
          </span></div>
        <div class="card-b"><div class="h7-pane" id="h7Detail"></div></div>
      </section>
    </div>
    <section class="card" data-view="table">
      <div class="card-h h7-head"><span>HL7 · tüm mesajlar</span><span class="h7-status" id="h7TStatus"></span><span class="spacer"></span>${kindBar()}</div>
      <div class="card-b"><div class="table-wrap h7-tablewrap" id="h7Table"></div></div>
    </section>
    <section class="card" data-view="beds">
      <div class="card-h h7-head"><span>HL7 · yataklar</span><span class="h7-status" id="h7BStatus"></span><span class="spacer"></span>${kindBar()}</div>
      <div class="card-b">
        <div class="table-wrap h7-tablewrap" id="h7Beds"></div>
        <p class="sm muted" style="margin:10px 0 0">Basınçlar sistolik/diyastolik (ortalama). Tansiyon (NIBP) yalnızca ölçüldüğünde ayrı mesajla gelir; son ölçüm, saatiyle birlikte yeni ölçüme kadar satırda kalır. Diğer değerler her mesajda yenilenir; mesajda gelmeyen değer silinir. Turuncu: referans aralığı dışında.</p>
      </div>
    </section>
    <div data-view="waves">
      <section class="card" id="h7WGrid">
        <div class="card-h h7-head"><span>Dalgalar · tüm yataklar</span><span class="h7-status" id="h7WCount"></span><span class="spacer"></span>${layoutBar()}</div>
        <div class="card-b"><div class="h7-wscroll" id="h7WCards"></div></div>
      </section>
      <div class="h7-wsingle" id="h7WSingle">
        <section class="card">
          <div class="card-h">Dalga gönderenler</div>
          <div class="card-b"><div class="h7-list" id="h7WList" role="listbox"></div></div>
        </section>
        <section class="card">
          <div class="card-h h7-head"><span>Dalga formları</span><span class="h7-status" id="h7WTitle"></span><span class="spacer"></span>${layoutBar()}</div>
          <div class="card-b">
            <div class="h7-monitor" id="h7WBig"></div>
            <p class="sm muted" style="margin:10px 0 0">Son 8 saniye, cihazın gönderdiği örnek hızında sağdan sola kayar; dikey ölçek otomatik. Cihaz dalgayı parça parça yollar (EKG 1 sn, ventilatör 0,4 sn); canlıda ~2 sn geriden, kesintisiz oynatılır. Dosyadan yüklenen kayıt gerçek hızında oynatılır. Yanındaki sayılar yatağın son ölçüm mesajından.</p>
          </div>
        </section>
      </div>
    </div>`;
  const q = (id) => $("#" + id, root);
  const el = {
    list: q("h7List"), detail: q("h7Detail"), tabs: q("h7Tabs"), table: q("h7Table"), beds: q("h7Beds"),
    tStatus: q("h7TStatus"), bStatus: q("h7BStatus"), wGrid: q("h7WGrid"), wCards: q("h7WCards"), wCount: q("h7WCount"),
    wSingle: q("h7WSingle"), wList: q("h7WList"), wBig: q("h7WBig"), wTitle: q("h7WTitle"),
  };

  // ── Yardımcılar ──
  const visible = () => (ip ? all.filter((m) => m.sourceIp === ip) : all);
  const passesKind = (m) => kind === "all" || m.kind === kind;
  const sevClass = (s) => (s ? `sev-${s}` : "");

  function wavesHint() {
    return processWaves
      ? "Henüz dalga formu gelmedi. Cihazın (ya da merkezi sistemin) HL7 çıkışında dalga gönderimi açık olmalı (Mindray: CONTINUOUS WAVEFORM)."
      : "Dalga işleme kapalı. Canlı dalgaları görmek için HL7 çubuğundaki \"Dalgaları işle\" seçeneğini işaretleyin"
        + (skippedWaves > 0 ? ` (${skippedWaves} dalga mesajı atlandı).` : ".");
  }

  // ── Mesaj ekleme ──
  /** items: [{ msg, source, received }]. replay: dosyadan (dalgalar baştan gerçek hızında). skipWaves: dalga mesajlarını çözme. */
  function add(items, { replay = false, skipWaves = false } = {}) {
    if (!items.length) return;
    const vis = visible();
    const follow = !selected || selected === vis.at(-1);
    let listChanged = false, wavesChanged = false;
    const fresh = [];
    for (const it of items) {
      if (skipWaves && isWaveMessage(it.msg)) { skippedWaves++; continue; }
      let vm;
      try { vm = buildMessage(it.msg, next++, it.source, it.received || new Date()); }
      catch (e) { console.warn("HL7 mesajı çözülemedi · " + it.source, e); continue; }
      if (seen.size > MAX_REPEAT_KEYS) seen.clear();
      vm.isRepeat = seen.has(vm.repeatKey);
      seen.add(vm.repeatKey);
      applyAck(vm);
      if (vm.isWaveform) {
        waveMessages++;
        try { feedWaves(vm, replay); wavesChanged = true; } catch (e) { console.warn("HL7 dalga", e); }
        continue;
      }
      listChanged = true;
      all.push(vm);
      fresh.push(vm);
      try { updateBed(vm); } catch (e) { console.warn("HL7 yatak satırı", e); }
      try { feedWaves(vm, replay); wavesChanged = true; } catch (e) { console.warn("HL7 dalga", e); }
    }
    let gone = [];
    if (all.length > MAX_MESSAGES) {
      gone = all.splice(0, all.length - MAX_MESSAGES);
      if (selected && gone.includes(selected)) selected = null;
    }
    if (wavesChanged) dirty.waves = true;
    if (!listChanged) { renderStatus(); if (shown && view === "waves") renderWaves(); opts.onChange?.(); return; }
    let newSel = false;
    if (follow) { const v = visible(); if (v.length && v.at(-1) !== selected) { selected = v.at(-1); newSel = true; } }
    Object.assign(dirty, { table: true, beds: true, detail: dirty.detail || newSel });
    if (shown && view === "detail" && !dirty.list) appendList(fresh, gone);
    else dirty.list = true;
    changed();
  }

  function changed() {
    renderStatus();
    renderView();
    opts.onChange?.();
  }

  // ── ACK (ajan gönderir; sayfa durumunu gösterir) ──
  function applyAck(vm) {
    const a = ackMap.get(vm.source + "|" + vm.controlId);
    if (!a) return false;
    vm.ackOk = a.ok;
    vm.ackState = a.ok ? `ACK gönderildi ${a.time}` : "ACK gönderilemedi (bağlantı kapalı)";
    return true;
  }
  function markAcks(list, count) {
    if (count != null) ackCount = count;
    if (!list?.length) { renderStatus(); return; }
    for (const a of list) {
      ackMap.set(a.remote + "|" + a.control, a);
      if (ackMap.size > 5000) ackMap.delete(ackMap.keys().next().value);
    }
    let touched = false;
    for (let i = all.length - 1, n = 0; i >= 0 && n < 400; i--, n++) {
      const m = all[i];
      if (!m.ackOk && applyAck(m)) {
        touched = true;
        const row = el.list.querySelector(`[data-i="${m.index}"]`);
        if (row && m.ackOk && !row.querySelector(".h7-ackok")) row.querySelector(".h7-tags")?.insertAdjacentHTML("afterbegin", `<span class="h7-ackok" title="${esc(m.ackState)}">${ICONS.check}</span>`);
      }
    }
    if (touched && selected?.ackState) dirty.detail = true;
    renderStatus();
    if (shown && view === "detail" && dirty.detail) renderDetail();
  }

  // ── Dalgalar ──
  function feedWaves(m, replay) {
    if (!m.isWaveform) {
      if (!m.observations.length) return;
      let vals = vitals.get(m.bedKey);
      if (!vals) vitals.set(m.bedKey, (vals = new Map()));
      for (const o of m.observations) if (o.hasValue) vals.set(o.short, o.value);
      waveBeds.get(m.bedKey)?.setValues(vals);
      return;
    }
    if (m.isRepeat) return;
    const located = m.message.first("PV1") != null;
    let bed;
    if (!located) { bed = waveBedBySource.get(m.source); if (!bed) return; }
    else {
      bed = waveBeds.get(m.bedKey);
      if (!bed) {
        bed = new WaveBed(m.bedKey);
        bed.sourceIp = m.sourceIp; bed.kind = m.kind;
        waveBeds.set(m.bedKey, bed);
        bed.layoutChanged = true;
      }
      waveBedBySource.set(m.source, bed);
      if (bed.title !== m.title) { bed.title = m.title; bed.layoutChanged = true; }
      if (m.patient) bed.patient = m.patient;
      bed.sub = [m.deviceType || m.device, m.sourceIp].filter(Boolean).join(" · ");
    }
    for (const o of m.observations) {
      if (!o.isWave) continue;
      const ch = bed.channel(o, replay);
      if (!ch) continue;
      if (o.sampleRate <= 0 && o.duration > 0) o.fitToDuration(o.duration, ch.rate);
      ch.append(o.samples, replay);
    }
    const v = vitals.get(m.bedKey);
    if (v) bed.setValues(v);
  }

  const waveBedList = () => [...waveBeds.values()]
    .filter((b) => !ip || b.sourceIp === ip)
    .sort((a, b) => a.groupOrder - b.groupOrder || sortCompare(a.title, b.title));

  // ── Yataklar (yatak başına satır) ──
  function resetBeds() {
    beds = new Map(); bedColKeys = new Map(); colKinds = new Map(); periodicCols = new Map();
    bedCols = [
      { key: "loc", header: "YATAK" }, { key: "dev", header: "CİHAZ" }, { key: "pat", header: "HASTA" },
      { key: "upd", header: "SON VERİ", mono: true }, { key: "src", header: "KAYNAK", mono: true },
    ];
  }
  function column(id, header, k) {
    const key = bedColKeys.get(id);
    if (key) { colKinds.get(key).add(k); return key; }
    const nk = "b" + bedColKeys.size;
    bedColKeys.set(id, nk);
    colKinds.set(nk, new Set([k]));
    bedCols.push({ key: nk, header, mono: true, metric: true });
    return nk;
  }
  function updateBed(m) {
    if (!m.observations.length || m.isWaveform) return;
    let r = beds.get(m.bedKey);
    if (!r) {
      r = { key: m.bedKey, src: m.sourceIp, loc: m.title, dev: "", pat: "", upd: "", kinds: new Set(), v: {}, sev: {}, ord: [m.sourceIp, m.location] };
      beds.set(m.bedKey, r);
    }
    r.pat = m.patient;
    r.upd = m.timeText;
    r.kinds.add(m.kind);
    if (m.deviceType) {
      const types = r.dev ? r.dev.split(" · ") : [];
      if (!types.includes(m.deviceType)) { types.push(m.deviceType); r.dev = types.join(" · "); }
    }
    const periodic = new Set();
    const set = (col, value, sev, aperiodic) => {
      r.v[col] = value;
      r.sev[col] = sev === "warn" || sev === "error" ? sev : "";
      if (!aperiodic) periodic.add(col);
    };
    const groups = new Map();
    for (const o of m.observations) if (o.group != null) { if (!groups.has(o.group)) groups.set(o.group, []); groups.get(o.group).push(o); }
    for (const [g, list] of groups) {
      const unit = list[0].unit;
      const col = column("g:" + g, g + (unit ? ` (${unit})` : ""), m.kind);
      const aperiodic = list.some((o) => o.isAperiodic);
      if (aperiodic) { const tc = column("t:" + g, g + " SAATİ", m.kind); r.v[tc] = list[0].timeText; }
      const part = (p) => list.find((o) => o.part === p && o.hasValue)?.value ?? null;
      const s = part("S"), d = part("D"), mean = part("M");
      const text = s != null && d != null ? `${s}/${d}` + (mean != null ? ` (${mean})` : "") : mean ?? s ?? d ?? "";
      const worst = list.some((o) => o.severity === "error") ? "error" : list.some((o) => o.severity === "warn") ? "warn" : "";
      set(col, text, worst, aperiodic);
    }
    for (const o of m.observations) {
      if (o.group != null) continue;
      const col = column("m:" + o.key, o.short + (o.unit ? ` (${o.unit})` : ""), m.kind);
      set(col, o.value, o.severity, o.isAperiodic);
    }
    if (periodic.size) {
      // Cihaz başına: aynı yataktaki ventilatör mesajı monitörün değerlerini (ya da tersi) silmesin
      const pkey = m.bedKey + "|" + (m.deviceId || m.device);
      const prev = periodicCols.get(pkey);
      if (prev) for (const c of prev) if (!periodic.has(c)) { delete r.v[c]; delete r.sev[c]; }
      periodicCols.set(pkey, periodic);
    }
  }
  const bedRows = () => [...beds.values()]
    .filter((r) => (!ip || r.src === ip) && (kind === "all" || r.kinds.has(kind)));
  const bedColVisible = (c) => !c.metric || kind === "all" || colKinds.get(c.key)?.has(kind);
  resetBeds();

  // ── Durum satırları ──
  function counts() {
    const list = visible();
    const bedsOf = (k) => new Set(list.filter((m) => k === "all" || m.kind === k).map((m) => m.bedKey)).size;
    return Object.fromEntries(Object.keys(KIND_LABEL).map((k) => [k, bedsOf(k)]));
  }
  function statusText() {
    const list = visible();
    const parts = [];
    if (list.length) {
      const nBeds = new Set(list.map((m) => m.bedKey)).size;
      const nObs = list.reduce((s, m) => s + m.observations.length, 0);
      const reps = list.filter((m) => m.isRepeat).length;
      parts.push(`${list.length} mesaj · ${nBeds} yatak · ${nObs} ölçüm` + (reps ? ` · ${reps} tekrar` : "") + (ackCount ? ` · ${ackCount} ACK` : ""));
    }
    if (waveMessages) parts.push(`${waveMessages} dalga mesajı`);
    if (skippedWaves) parts.push(`${skippedWaves} dalga mesajı atlandı`);
    return parts.join(" · ");
  }
  function renderStatus() {
    const s = statusText();
    el.tStatus.textContent = s;
    const n = bedRows().length;
    el.bStatus.textContent = n ? `${n} yatak` + (ackCount ? ` · ${ackCount} ACK gönderildi` : "") : "";
    const c = counts();
    for (const span of $$("[data-kc]", root)) span.textContent = c[span.dataset.kc];
    for (const b of $$("[data-kind]", root)) b.setAttribute("aria-selected", String(b.dataset.kind === kind));
  }

  // ── Görünüm ──
  function renderView() {
    for (const sec of $$(":scope > [data-view]", root)) sec.hidden = sec.dataset.view !== view;
    $$("[data-v]", bar).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.v === view)));
    if (!shown) { stopWaves(); return; }
    if (view === "detail") { if (dirty.list) renderList(); if (dirty.detail) renderDetail(); }
    else if (view === "table" && dirty.table) throttled(renderTable);
    else if (view === "beds" && dirty.beds) throttled(renderBeds);
    if (view === "waves") renderWaves(); else stopWaves();
  }

  // Tablo ve yatak tablosu canlı veride en çok 2 sn'de bir baştan çizilir (çok sütunlu, binlerce hücre)
  let lastBig = 0, bigTimer = 0;
  function throttled(fn) {
    const wait = 2000 - (Date.now() - lastBig);
    if (wait <= 0) { clearTimeout(bigTimer); bigTimer = 0; lastBig = Date.now(); fn(); return; }
    if (!bigTimer) bigTimer = setTimeout(() => { bigTimer = 0; if (shown) renderView(); }, wait);
  }

  // Mesaj listesi
  const msgRow = (m) => `<div class="h7-msg" role="option" data-i="${m.index}" aria-selected="${m === selected}">
      <div class="h7-mh"><b>${esc(m.title)}</b><span class="h7-tags">
        ${m.ackOk ? `<span class="h7-ackok" title="${esc(m.ackState)}">${ICONS.check}</span>` : ""}
        ${m.isRepeat ? `<span class="badge sev-warn h7-rep" title="Tekrar: aynı mesaj (aynı kontrol no ve ölçüm zamanı) daha önce geldi. Gönderen onay (ACK) alamayınca yeniden yollar.">tekrar</span>` : ""}
        ${m.hasWarning ? `<i class="h7-wdot" title="Referans aralığı dışında ölçüm var"></i>` : ""}
        <span class="h7-n" title="Mesaj sırası (MSH-10 kontrol no ayrıntıda)">${m.index}</span></span></div>
      <div class="sm muted h7-ell">${esc(m.listSub)}</div>
      <div class="mono h7-sum h7-ell">${esc(m.summary)}</div></div>`;
  const EMPTY_LIST = `<div class="h7-empty">Henüz HL7 mesajı yok. Başlat'a basın; gelen verideki her MSH … &lt;FS&gt; mesajı burada çözülür (ör. Mindray merkezi monitör, port 2575 ya da merkezde tanımlı port).</div>`;
  function renderList() {
    dirty.list = false;
    const list = visible();
    el.list.innerHTML = list.length ? list.map(msgRow).join("") : EMPTY_LIST;
    el.list.scrollTop = el.list.scrollHeight;
  }
  function appendList(fresh, gone) {
    const atEnd = el.list.scrollHeight - el.list.scrollTop - el.list.clientHeight < 60;
    for (const m of gone) el.list.querySelector(`[data-i="${m.index}"]`)?.remove();
    const add = fresh.filter((m) => !ip || m.sourceIp === ip);
    if (!add.length) return;
    el.list.querySelector(".h7-empty")?.remove();
    el.list.insertAdjacentHTML("beforeend", add.map(msgRow).join(""));
    if (dirty.detail) markSelection();
    if (atEnd) el.list.scrollTop = el.list.scrollHeight;
  }
  function markSelection() {
    for (const r of $$(".h7-msg[aria-selected='true']", el.list)) r.setAttribute("aria-selected", "false");
    if (selected) el.list.querySelector(`[data-i="${selected.index}"]`)?.setAttribute("aria-selected", "true");
  }

  // Ayrıntı
  function renderDetail() {
    dirty.detail = false;
    $$("[data-tab]", el.tabs).forEach((b) => { b.setAttribute("aria-selected", String(b.dataset.tab === tab)); b.disabled = !selected; });
    const m = selected;
    if (!m) { el.detail.innerHTML = `<div class="h7-empty light">Soldan bir mesaj seçin.</div>`; return; }
    const parts = m.detailParts.map(([l, v]) => `<span class="muted">${esc(l)}</span> ${v ? `<span>${esc(v)}</span>` : `<i class="muted">yok</i>`}`).join(` <span class="muted">·</span> `);
    const head = `<div class="h7-dhead">
        <div class="h7-dtitle">${esc(m.detailTitle)} <span class="h7-parts"><span class="muted">(</span>${parts}<span class="muted">)</span></span></div>
        <div class="h7-dmeta"><div class="sm muted" title="MSH-7 · mesaj zamanı">${esc(m.dateText)}</div>
          ${m.ackState ? `<div class="sm ${m.ackOk ? "txt-ok" : "txt-error"}">${esc(m.ackState)}</div>` : ""}</div></div>
      <div class="h7-info">${m.info.map((i) => `<span class="h7-chip" title="${esc(i.tip)}"><span class="muted">${esc(i.label)}</span><span class="mono">${esc(i.value)}</span></span>`).join("")}</div>`;
    let body = "";
    if (tab === "obs") {
      const row = (o) => `<tr class="item" title="${esc(o.tip)}">
          <td>${esc(o.name)}</td>
          <td>${o.hasValue ? `<b class="mono h7-val">${esc(o.value)}</b> <span class="sm muted">${esc(o.unit)}</span>` : `<i class="muted">yok</i>`}
            ${o.spark ? `<svg class="h7-spark" viewBox="0 0 220 30" width="220" height="30"><polyline points="${o.spark}"/></svg>` : ""}</td>
          <td class="mono">${esc(o.rangeText)}</td>
          <td>${o.stateText ? `<span class="badge ${sevClass(o.severity)}">${esc(o.stateText)}</span>` : ""}</td>
          <td class="mono">${esc(o.timeText)}</td>
          <td class="mono">${esc(o.codeText)}</td></tr>`;
      body = `<div class="table-wrap h7-obs"><table><thead><tr><th>Parametre</th><th>Değer</th><th>Referans</th><th>Durum</th><th>Zaman</th><th>MDC kodu</th></tr></thead>
        <tbody>${m.observations.map(row).join("") || `<tr><td colspan="6" class="muted">Ölçüm yok.</td></tr>`}</tbody></table></div>`;
    } else if (tab === "fields") {
      body = `<div class="h7-fields">${segmentRows(m.message).map((s) => `<div class="h7-seg"><div class="h7-segh">${esc(s.header)}</div>
        ${s.rows.map((r) => `<div class="h7-frow"><span class="mono h7-pos">${esc(r.pos)}</span><span class="sm h7-fname">${esc(r.name)}</span>
          <span><span class="mono">${esc(r.value)}</span>${r.comps ? `<div class="mono sm muted" title="Bileşenler (numara: değer); boş bileşenler yazılmaz">${esc(r.comps)}</div>` : ""}</span></div>`).join("")}</div>`).join("")}</div>`;
    } else {
      const ack = buildAck(m.message, m.received).replace(/\r$/, "").replace(/\r/g, "\n");
      body = `<pre class="h7-raw">${esc(m.message.segments.map((s) => s.raw).join("\n"))}</pre>
        <div class="row tight" style="margin:14px 0 6px;justify-content:space-between">
          <span><b class="h7-lbl">Onay (ACK)</b> <span class="sm muted">gönderen MSH-15 = AL ise bu mesaja &lt;VT&gt; … &lt;FS&gt;&lt;CR&gt; çerçevesinde dönülmesi beklenen yanıt</span></span>
          <button class="copy-ip" id="h7CopyAck" title="ACK'yı kopyala">${ICONS.copy}</button></div>
        <pre class="h7-raw h7-ack">${esc(ack)}</pre>`;
      el.detail._ack = ack;
    }
    el.detail.innerHTML = head + body;
  }

  // Tablo (mesaj başına satır)
  function sortRows(rows, sort, get) {
    if (!sort) return rows;
    return [...rows].sort((a, b) => sortCompare(get(a, sort.key), get(b, sort.key), sort.dir));
  }
  const th = (c, sort) => `<th data-sort="${c.key}"${c.title ? ` title="${esc(c.title)}"` : ""}>${esc(c.header)}${sort?.key === c.key ? `<span class="arr">${sort.dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`;
  function renderTable() {
    dirty.table = false;
    const list = visible().filter(passesKind);
    if (!list.length) { el.table.innerHTML = `<div class="empty">Henüz HL7 mesajı yok.</div>`; return; }
    const cols = [{ key: "n", header: "#" }, { key: "time", header: "ZAMAN" }, { key: "src", header: "KAYNAK" }, { key: "loc", header: "YATAK" }, { key: "pat", header: "HASTA" }];
    const metricCols = new Map();
    for (const m of list) for (const o of m.observations) {
      if (metricCols.has(o.key)) continue;
      const key = "m" + metricCols.size;
      metricCols.set(o.key, key);
      cols.push({ key, header: o.short + (o.unit ? ` (${o.unit})` : "") });
    }
    const rows = list.map((m) => {
      const r = { n: m.index, nText: m.index + (m.isRepeat ? " ↻" : ""), time: m.timeText, src: m.sourceIp, loc: m.location, pat: m.patient };
      for (const o of m.observations) { const k = metricCols.get(o.key); if (k && r[k] == null) r[k] = o.value; }
      return r;
    });
    const sorted = sortRows(rows, tableSort, (r, k) => r[k]);
    el.table.innerHTML = `<table><thead><tr>${cols.map((c) => th(c, tableSort)).join("")}</tr></thead><tbody>${sorted.map((r) =>
      `<tr class="item">${cols.map((c) => `<td class="${c.key === "loc" || c.key === "pat" ? "" : "mono"}">${esc(c.key === "n" ? r.nText : r[c.key] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }

  // Yataklar
  function renderBeds() {
    dirty.beds = false;
    const rows = bedRows();
    if (!rows.length) { el.beds.innerHTML = `<div class="empty">Henüz yatak verisi yok.</div>`; return; }
    const cols = bedCols.filter(bedColVisible);
    const def = [...rows].sort((a, b) => sortCompare(a.ord[0], b.ord[0]) || sortCompare(a.ord[1], b.ord[1]));
    const val = (r, k) => (k in r && typeof r[k] === "string" ? r[k] : r.v[k] ?? "");
    const sorted = sortRows(def, bedSort, val);
    el.beds.innerHTML = `<table><thead><tr>${cols.map((c) => th(c, bedSort)).join("")}</tr></thead><tbody>${sorted.map((r) =>
      `<tr class="item">${cols.map((c) => {
        const sev = c.metric ? r.sev[c.key] : "";
        return `<td class="${c.mono ? "mono" : ""}${sev ? " h7-" + sev : ""}">${esc(val(r, c.key))}</td>`;
      }).join("")}</tr>`).join("")}</tbody></table>`;
  }

  // Dalgalar
  let gridViews = [], singleViews = [], gridSig = "", singleSig = "";
  const chanRow = (ch, big) => big
    ? `<div class="h7-wrow big"><div class="h7-wlab"><b style="color:${ch.color}">${esc(ch.name)}</b><div class="h7-winfo">${esc(ch.info)}</div><div class="h7-wnum" data-num>${esc(ch.numbers)}</div></div><canvas class="h7-wave"></canvas></div>`
    : `<div class="h7-wrow"><div class="h7-wlab"><b style="color:${ch.color}">${esc(ch.short)}</b><div class="h7-wnum" data-num>${esc(ch.numbers)}</div></div><canvas class="h7-wave"></canvas></div>`;
  const bedSig = (list) => list.map((b) => b.key + ":" + b.title + ":" + b.channels.map((c) => c.mnemonic).join(",")).join("|");

  function stopWaves() {
    for (const v of [...gridViews, ...singleViews]) v.detach();
    gridViews = []; singleViews = []; gridSig = ""; singleSig = "";
  }

  function renderWaves() {
    dirty.waves = false;
    const list = waveBedList();
    if (selectedWaveBed && !list.includes(selectedWaveBed)) selectedWaveBed = null;
    if (!selectedWaveBed) selectedWaveBed = list[0] || null;
    el.wGrid.hidden = layout !== "grid";
    el.wSingle.hidden = layout !== "single";
    $$("[data-layout]", root).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.layout === layout)));
    el.wCount.textContent = `${list.length} cihaz · karta tıklayınca büyük açılır`;
    if (layout === "grid") {
      for (const v of singleViews) v.detach();
      singleViews = []; singleSig = "";
      const sig = bedSig(list);
      if (sig !== gridSig) {
        for (const v of gridViews) v.detach();
        gridViews = [];
        gridSig = sig;
        if (!list.length) el.wCards.innerHTML = `<div class="h7-empty light">${esc(wavesHint())}</div>`;
        else {
          const groups = [];
          for (const b of list) { let g = groups.at(-1); if (!g || g.name !== b.group) groups.push((g = { name: b.group, beds: [] })); g.beds.push(b); }
          el.wCards.innerHTML = groups.map((g) => `<div class="h7-wgroup"><div class="h7-wgh">${esc(g.name)} <span class="muted">${g.beds.length}</span></div>
            <div class="h7-wcards">${g.beds.map((b) => `<div class="h7-wcard" data-bed="${esc(b.key)}" title="Büyük aç (tek yatak)">
              <div class="h7-wch"><span class="h7-ell"><b>${esc(b.title)}</b> <span class="h7-wpat">${esc(b.patient)}</span></span><span class="h7-wsub">${esc(b.sub)}</span></div>
              ${b.channels.map((c) => chanRow(c, false)).join("")}</div>`).join("")}</div></div>`).join("");
          for (const b of list) {
            const card = el.wCards.querySelector(`[data-bed="${CSS.escape(b.key)}"]`);
            $$("canvas", card).forEach((cv, i) => { const v = new WaveView(cv, b.channels[i], 6); v.attach(); gridViews.push(v); });
          }
        }
      }
      // Sayılar (son ölçüm mesajından) ve alt başlıklar her turda
      for (const b of list) {
        const card = el.wCards.querySelector(`[data-bed="${CSS.escape(b.key)}"]`);
        if (!card) continue;
        $$("[data-num]", card).forEach((n, i) => { const t = b.channels[i]?.numbers ?? ""; if (n.textContent !== t) n.textContent = t; });
        const pat = $(".h7-wpat", card), sub = $(".h7-wsub", card);
        if (pat.textContent !== b.patient) pat.textContent = b.patient;
        if (sub.textContent !== b.sub) sub.textContent = b.sub;
      }
    } else {
      for (const v of gridViews) v.detach();
      gridViews = []; gridSig = "";
      const sig = bedSig(list) + "#" + (selectedWaveBed?.key ?? "");
      if (sig !== singleSig) {
        singleSig = sig;
        let html = "", gname = null;
        for (const b of list) {
          if (b.group !== gname) { gname = b.group; html += `<div class="h7-wgh">${esc(gname)} <span class="muted">${list.filter((x) => x.group === gname).length}</span></div>`; }
          html += `<div class="h7-msg" role="option" data-wbed="${esc(b.key)}" aria-selected="${b === selectedWaveBed}">
            <b class="h7-ell">${esc(b.title)}</b><div class="sm muted h7-ell">${esc(b.sub)}</div>
            <div class="h7-wchips">${b.channels.map((c) => `<span style="color:${c.color}">${esc(c.short)}</span>`).join("")}</div></div>`;
        }
        el.wList.innerHTML = html || `<div class="h7-empty light">${esc(wavesHint())}</div>`;
        for (const v of singleViews) v.detach();
        singleViews = [];
        const b = selectedWaveBed;
        el.wBig.innerHTML = b ? b.channels.map((c) => chanRow(c, true)).join("") : "";
        if (b) $$("canvas", el.wBig).forEach((cv, i) => { const v = new WaveView(cv, b.channels[i], 8); v.attach(); singleViews.push(v); });
      }
      const b = selectedWaveBed;
      el.wTitle.innerHTML = b ? `<span style="color:var(--text)">${esc(b.title)}</span> ${esc(b.sub)}` : "";
      if (b) $$("[data-num]", el.wBig).forEach((n, i) => { const t = b.channels[i]?.numbers ?? ""; if (n.textContent !== t) n.textContent = t; });
    }
  }

  // ── Olaylar ──
  bar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-v]");
    if (b) setView(b.dataset.v);
  });
  bq("h7Waves").addEventListener("change", (e) => {
    processWaves = e.target.checked; storeSet("rbox.hl7.waves", processWaves ? "1" : "0");
    dirty.waves = true; renderView();
  });
  bq("h7Ack").addEventListener("change", (e) => {
    ackOn = e.target.checked; storeSet("rbox.hl7.ack", ackOn ? "1" : "0");
    opts.onAck?.(ackOn);
  });
  bq("h7Load").addEventListener("click", () => bq("h7File").click());
  bq("h7File").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) await opts.onLoad?.(files);
  });

  root.addEventListener("click", (e) => {
    const k = e.target.closest("[data-kind]");
    if (k) { kind = k.dataset.kind; storeSet("rbox.hl7.kind", kind); Object.assign(dirty, { table: true, beds: true }); lastBig = 0; renderStatus(); renderView(); return; }
    const lay = e.target.closest("[data-layout]");
    if (lay) { layout = lay.dataset.layout; storeSet("rbox.hl7.layout", layout); renderView(); return; }
    const t = e.target.closest("[data-tab]");
    if (t && selected) { tab = t.dataset.tab; renderDetail(); return; }
    const s = e.target.closest("th[data-sort]");
    if (s) {
      const isBeds = !!s.closest("#h7Beds");
      const cur = isBeds ? bedSort : tableSort;
      const key = s.dataset.sort;
      const nextSort = cur?.key !== key ? { key, dir: 1 } : cur.dir > 0 ? { key, dir: -1 } : null;
      if (isBeds) { bedSort = nextSort; renderBeds(); } else { tableSort = nextSort; renderTable(); }
      return;
    }
    if (e.target.closest("#h7CopyAck")) {
      copyText(el.detail._ack.replace(/\n/g, "\r\n")).then(() => toast("ACK kopyalandı"), () => toast("Kopyalanamadı"));
      return;
    }
    const card = e.target.closest("[data-bed]");
    if (card) { selectedWaveBed = waveBeds.get(card.dataset.bed) || null; layout = "single"; storeSet("rbox.hl7.layout", layout); renderView(); return; }
    const wb = e.target.closest("[data-wbed]");
    if (wb) { selectedWaveBed = waveBeds.get(wb.dataset.wbed) || null; renderWaves(); return; }
    const r = e.target.closest(".h7-msg[data-i]");
    if (r) {
      const m = all.find((x) => String(x.index) === r.dataset.i);
      if (m && m !== selected) { selected = m; markSelection(); renderDetail(); }
    }
  });
  // Klavye: listede yukarı / aşağı
  el.list.tabIndex = 0;
  el.list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const list = visible(); const i = list.indexOf(selected);
    const n = list[Math.min(list.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!n || n === selected) return;
    e.preventDefault(); selected = n; markSelection(); renderDetail();
    el.list.querySelector(`[data-i="${n.index}"]`)?.scrollIntoView({ block: "nearest" });
  });

  function setView(v) {
    if (!VIEWS.some(([x]) => x === v)) return;
    view = v; storeSet("rbox.hl7.view", v);
    lastBig = 0;
    renderView();
  }

  /** Yandaki cihaz listesinde seçilen IP: yalnızca onun mesajları / yatakları / dalgaları; null = hepsi. */
  function setFilter(newIp) {
    ip = newIp || null;
    if (selected && ip && selected.sourceIp !== ip) selected = null;
    if (!selected) selected = visible().at(-1) || null;
    Object.assign(dirty, { list: true, detail: true, table: true, beds: true, waves: true });
    changed();
  }

  function clear() {
    all = []; seen.clear(); next = 1; ackCount = 0; ackMap.clear(); selected = null;
    waveMessages = 0; skippedWaves = 0;
    resetBeds();
    waveBeds.clear(); waveBedBySource.clear(); vitals.clear(); selectedWaveBed = null;
    stopWaves();
    Object.assign(dirty, { list: true, detail: true, table: true, beds: true, waves: true });
    changed();
  }

  /** Panoya: yatak görünümünde yatak tablosu, diğerlerinde süzgeçten geçen tüm ölçümler (sekmeyle ayrılmış). */
  function copyTextOut() {
    const lines = [];
    if (view === "beds") {
      const cols = bedCols.filter(bedColVisible);
      lines.push(cols.map((c) => c.header).join("\t"));
      for (const r of bedRows()) lines.push(cols.map((c) => (typeof r[c.key] === "string" ? r[c.key] : r.v[c.key] ?? "")).join("\t"));
      return lines.join("\r\n") + "\r\n";
    }
    lines.push(["#", "Zaman", "Kaynak", "Yatak", "Hasta", "Parametre", "MDC", "Değer", "Birim", "Referans", "Durum", "Ölçüm zamanı", "Cihaz", "Tekrar"].join("\t"));
    for (const m of visible()) for (const o of m.observations)
      lines.push([m.index, m.timeText, m.source, m.location, m.patient, o.name, o.mnemonic, o.value, o.unit, o.rangeText, o.stateText, o.timeText, m.device, m.isRepeat ? "evet" : ""].join("\t"));
    return lines.join("\r\n") + "\r\n";
  }

  renderStatus();
  renderView();

  return {
    root, bar, add, setFilter, clear, markAcks, setView,
    copyText: copyTextOut,
    get hasMessages() { return all.length > 0 || waveBeds.size > 0; },
    get processWaves() { return processWaves; },
    get ack() { return ackOn; },
    /** Panel görünür / gizli (TCP sekmesi ya da HL7 görünümü değişti): gizliyken dalga çizimi durur. */
    setShown(on) {
      if (on === shown) return;
      shown = on;
      if (on) Object.assign(dirty, { list: true, detail: true, table: true, beds: true, waves: true });
      renderView();
    },
  };
}
