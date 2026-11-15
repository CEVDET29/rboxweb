// TTY paneli: cihazın sanal konsolunu (tty1 / tty2) ~1 sn arayla, renkleriyle gösterir; TTY1'e tuş gönderilebilir.
// WPF TtyWindow karşılığı. Okuma / yazma ajandadır (/api/control/tty/*: /dev/vcsa + TIOCSTI, sudo ile; cihazda python3 gerekir).
// Cihaz başına tek panel (açıksa öne gelir). Panel başlığından sürüklenir, sağ alt köşeden genişletilir.
// Solda açılıp kapanan dosya paneli (ttyfiles.js; WPF RemoteFilesPanel karşılığı).
import { api } from "./api.js";
import { esc, ICONS, storeGet, storeSet } from "./util.js";
import { createFilesPanel } from "./ttyfiles.js";

/** VGA öznitelik sırası (0 siyah, 1 mavi, 2 yeşil, 3 camgöbeği, 4 kırmızı, 5 eflatun, 6 kahve, 7 açık gri, +8 parlak). */
const VGA = ["#000000", "#0000AA", "#00AA00", "#00AAAA", "#AA0000", "#AA00AA", "#AA5500", "#AAAAAA",
  "#555555", "#5555FF", "#55FF55", "#55FFFF", "#FF5555", "#FF55FF", "#FFFF55", "#FFFFFF"];

// Linux konsolunun tuş dizileri (WPF TtyWindow.KeySequence ile aynı)
const NAV = {
  Enter: "\r", Backspace: "\x7f", Escape: "\x1b", ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D",
  Home: "\x1b[1~", Insert: "\x1b[2~", Delete: "\x1b[3~", End: "\x1b[4~", PageUp: "\x1b[5~", PageDown: "\x1b[6~",
  F1: "\x1b[[A", F2: "\x1b[[B", F3: "\x1b[[C", F4: "\x1b[[D", F5: "\x1b[[E", F6: "\x1b[17~", F7: "\x1b[18~", F8: "\x1b[19~",
  F9: "\x1b[20~", F10: "\x1b[21~", F11: "\x1b[23~", F12: "\x1b[24~",
};

/** Klavye olayı → konsola gidecek baytlar (metin). null: tuş gönderilmez (tarayıcıya bırakılır). */
export function keySequence(e) {
  const { key, ctrlKey: ctrl, altKey: alt, shiftKey: shift } = e;
  const altGr = e.getModifierState?.("AltGraph") || (ctrl && alt);   // Windows'ta AltGr = Ctrl+Alt (@, {, [ …)
  if (key === "Tab") return shift ? "\x1b[Z" : "\t";
  let s = NAV[key];
  if (s == null) {
    if (key.length !== 1) return null;                               // Shift, Control, CapsLock …
    if (ctrl && !altGr) {
      const c = key.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) s = String.fromCharCode(c - 64);         // Ctrl+A … Ctrl+Z, Ctrl+[ \ ] ^ _
      else if (key === " ") s = "\0";
      else return null;
    } else s = key;
  }
  // Alt+tuş: bash meta (ESC + tuş), ör. Alt+R = ESC 'r'
  return alt && !altGr ? "\x1b" + s : s;
}

const b64 = (s) => { let bin = ""; for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b); return btoa(bin); };
const hhmmss = () => new Date().toLocaleTimeString("tr-TR");

const panels = new Map();                 // ip → panel
let zTop = 900;

/** Cihazın TTY panelini açar (açıksa öne getirir). name: başlıkta görünen ad. */
export function openTty(ip, name) {
  const p = panels.get(ip);
  if (p) { p.front(); return; }
  panels.set(ip, createPanel(ip, name));
}

function createPanel(ip, name) {
  const el = document.createElement("div");
  el.className = "ttyp";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", `TTY ekranı · ${name}`);
  const n = panels.size;
  let showFiles = storeGet("rbox.tty.files") !== "0";
  let filesW = Math.max(260, Math.min(700, +storeGet("rbox.tty.filesW") || 400));
  const baseW = () => 690 + (showFiles ? filesW + 6 : 0);
  el.style.width = Math.min(baseW(), innerWidth - 32) + "px";
  el.style.left = Math.max(16, innerWidth - Math.min(baseW(), innerWidth - 32) - 24 - n * 28) + "px";
  el.style.top = 72 + n * 28 + "px";
  el.innerHTML = `
    <div class="ttyp-h">
      <span class="ttyp-t" title="${esc(name)}">${ICONS.screen}<b>${esc(name)}</b></span>
      <div class="seg mini" role="tablist"><button data-tty="1" title="TTY1 · konsol: ekrana tıklayıp yazın (Enter, oklar, Ctrl+harf, Alt+harf)">TTY1</button><button data-tty="2" title="TTY2 · swtui (yalnız izlenir)">TTY2</button></div>
      <button class="btn icon" data-x="files" aria-pressed="false" title="Dosya paneli">${ICONS.folder}</button>
      <button class="btn icon" data-x="clear" title="Konsolu temizle (TTY1'e Ctrl+L · yazılmakta olan komut silinmez)">${ICONS.eraser}</button>
      <button class="btn icon" data-x="pause" aria-pressed="false" title="Duraklat">${ICONS.pause}</button>
      <button class="btn icon" data-x="close" title="Kapat">${ICONS.xmark}</button>
    </div>
    <div class="ttyp-b"><div class="ttyp-fp"></div><div class="ttyp-split" title="Sürükleyerek panel genişliğini değiştirin"></div><div class="ttyp-m">
    <div class="ttyp-s" tabindex="0"><pre></pre></div>
    <div class="ttyp-in"><input type="text" class="mono-input" placeholder="Komut yazıp Enter (TTY1'e gönderilir)" autocomplete="off" spellcheck="false">
      <button class="btn ib" data-x="send" title="Gönder (sonuna Enter eklenir)">${ICONS.send}</button></div>
    <div class="ttyp-f sm">Yükleniyor…</div></div></div>`;
  document.body.append(el);

  const scr = el.querySelector(".ttyp-s"), pre = scr.querySelector("pre"), foot = el.querySelector(".ttyp-f");
  const inRow = el.querySelector(".ttyp-in"), input = inRow.querySelector("input");
  const pauseBtn = el.querySelector('[data-x="pause"]'), filesBtn = el.querySelector('[data-x="files"]'), clearBtn = el.querySelector('[data-x="clear"]');
  const fp = el.querySelector(".ttyp-fp"), split = el.querySelector(".ttyp-split");
  let tty = 2, paused = false, closed = false, frame = null, wake = null, files = null;

  const front = () => { el.style.zIndex = ++zTop; };
  front();

  function setFoot(text, err = false) { foot.textContent = text; foot.classList.toggle("err", err); }

  function applyMode() {
    for (const b of el.querySelectorAll("[data-tty]")) b.setAttribute("aria-selected", String(+b.dataset.tty === tty));
    inRow.classList.toggle("hid", tty !== 1);
    scr.title = tty === 1 ? "Tıklayıp yazın: tuşlar cihazdaki TTY1'e gider (Ctrl+V yapıştırır)" : "TTY2 yalnız izlenir";
    pauseBtn.setAttribute("aria-pressed", String(paused));
    pauseBtn.title = paused ? "Devam et" : "Duraklat";
    pauseBtn.innerHTML = paused ? ICONS.play : ICONS.pause;
    clearBtn.disabled = tty !== 1;
    filesBtn.setAttribute("aria-pressed", String(showFiles));
    filesBtn.title = showFiles ? "Dosya panelini gizle" : "Dosya panelini göster";
    fp.hidden = split.hidden = !showFiles;
    fp.style.width = filesW + "px";
    if (showFiles && !files) { files = createFilesPanel({ ip, runInTty }); fp.append(files.root); }
  }

  /** Dosya panelinden: TTY1'e geçer, komutu ve Enter'ı gönderir (WPF RunInTty). */
  function runInTty(cmd) {
    if (tty !== 1) { tty = 1; frame = null; pre.textContent = ""; scr.style.height = ""; setFoot("Yükleniyor…"); applyMode(); }
    queue(cmd + "\r");
    scr.focus();
  }

  // ── Çizim ───────────────────────────────────────────────────
  const span = (k, t) => {
    const a = k & 255, fg = a & 15, bg = (a >> 4) & 7;
    const style = k & 256 ? `color:${VGA[bg]};background:${VGA[fg]}`
      : (fg === 7 ? "" : `color:${VGA[fg]};`) + (bg ? `background:${VGA[bg]}` : "");
    return style ? `<span style="${style}">${esc(t)}</span>` : esc(t);
  };

  function draw() {
    const f = frame;
    const attrs = Uint8Array.from(atob(f.attrs || ""), (c) => c.charCodeAt(0));
    const cursor = f.tty === 1;
    let html = "";
    for (let y = 0; y < f.rows; y++) {
      const line = f.lines[y] ?? "";
      let run = "", cur = -1;
      for (let x = 0; x < f.cols; x++) {
        const k = (attrs[y * f.cols + x] ?? 7) | (cursor && x === f.cursorX && y === f.cursorY ? 256 : 0);
        if (k !== cur) { if (run) html += span(cur, run); run = ""; cur = k; }
        run += line[x] ?? " ";
      }
      html += span(cur, run) + (y < f.rows - 1 ? "\n" : "");
    }
    pre.innerHTML = html;
    fit();
    const mon = f.activeTty === f.tty ? " · monitörde açık" : f.activeTty ? ` · monitörde tty${f.activeTty} açık` : "";
    setFoot(`tty${f.tty} · ${f.cols}×${f.rows}${mon} · ${hhmmss()}`);
  }

  /** Ekran panele sığmıyorsa küçültülür (büyütülmez). */
  function fit() {
    pre.style.transform = "";
    const w = pre.scrollWidth, h = pre.scrollHeight, avail = scr.clientWidth - 16;
    const k = w > avail && w > 0 ? avail / w : 1;
    pre.style.transform = k < 1 ? `scale(${k})` : "";
    scr.style.height = Math.ceil(h * k) + 16 + "px";
  }
  new ResizeObserver(() => { if (frame) fit(); }).observe(el);

  // ── Okuma döngüsü ───────────────────────────────────────────
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });
  (async () => {
    while (!closed) {
      if (!paused && !document.hidden) {
        const want = tty;
        try {
          const f = await api("/api/control/tty/read", { method: "POST", body: { ip, tty: want } });
          if (closed) break;
          if (want === tty && !paused) { frame = f; draw(); }
        } catch (e) {
          if (closed) break;
          if (want === tty) setFoot((frame ? e.message : "Bağlanılamadı: " + e.message) + " · yeniden deneniyor…", true);
        }
      }
      await sleep(1000);
    }
  })();

  // ── TTY1'e tuş gönderme (kısa aralıkta basılanlar tek istekte) ─
  let pending = "", sending = false, flushT = 0;
  const queue = (s) => { pending += s; if (!flushT) flushT = setTimeout(flush, 40); };
  async function flush() {
    flushT = 0;
    if (sending || !pending || closed) return;
    sending = true;
    try {
      while (pending) {
        const cps = [...pending];                       // en fazla 1000 karakter (≤ 4096 bayt UTF-8)
        const part = cps.slice(0, 1000).join("");
        pending = cps.slice(1000).join("");
        await api("/api/control/tty/send", { method: "POST", body: { ip, tty: 1, data: b64(part) } });
      }
      setTimeout(() => wake?.(), 120);                   // ekranı hemen yeniden oku
    } catch (e) {
      pending = "";
      setFoot("Gönderilemedi: " + e.message, true);
    } finally {
      sending = false;
      if (pending) flush();
    }
  }

  scr.addEventListener("keydown", (e) => {
    if (tty !== 1 || e.isComposing) return;
    const k = e.key.toLowerCase(), mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    if (e.altKey && e.key === "F4") return;
    if (mod && k === "v") return;                                          // yapıştır: paste olayı
    if (mod && k === "c" && String(getSelection()).length) return;        // seçili metni kopyala
    const s = keySequence(e);
    if (s == null) return;
    e.preventDefault();
    queue(s);
  });
  scr.addEventListener("paste", (e) => {
    if (tty !== 1) return;
    e.preventDefault();
    const t = e.clipboardData?.getData("text") ?? "";
    if (t) queue(t.replace(/\r?\n/g, "\r"));
  });
  const sendLine = () => { if (tty === 1 && input.value) { queue(input.value + "\r"); input.value = ""; } };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendLine(); } });

  // ── Düğmeler, sürükleme ─────────────────────────────────────
  function close() {
    if (closed) return;
    closed = true;
    wake?.();
    files?.close();
    el.remove();
    panels.delete(ip);
    api("/api/control/tty/close", { method: "POST", body: { ip } }).catch(() => {});
  }

  el.addEventListener("pointerdown", front, true);
  el.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tty]");
    if (t) {
      const v = +t.dataset.tty;
      if (v !== tty) { tty = v; frame = null; pre.textContent = ""; scr.style.height = ""; setFoot("Yükleniyor…"); applyMode(); wake?.(); }
      if (tty === 1) scr.focus();
      return;
    }
    const b = e.target.closest("[data-x]");
    if (!b) return;
    if (b.dataset.x === "close") close();
    else if (b.dataset.x === "pause") { paused = !paused; applyMode(); if (paused) setFoot("Duraklatıldı" + (frame ? ` · tty${frame.tty}` : "")); else wake?.(); }
    else if (b.dataset.x === "send") sendLine();
    else if (b.dataset.x === "clear" && tty === 1) { queue("\x0c"); scr.focus(); }
    else if (b.dataset.x === "files") {
      showFiles = !showFiles; storeSet("rbox.tty.files", showFiles ? "1" : "0");
      const w = el.getBoundingClientRect().width + (showFiles ? filesW + 6 : -(filesW + 6));
      el.style.width = Math.max(320, Math.min(w, innerWidth - 32)) + "px";
      applyMode();
    }
  });

  // Dosya paneli genişliği: aradaki çizgi sürüklenir (kaydedilir)
  split.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    split.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = filesW, pw0 = el.getBoundingClientRect().width;
    const move = (m) => {
      filesW = Math.max(260, Math.min(900, w0 + m.clientX - x0));
      fp.style.width = filesW + "px";
      el.style.width = Math.min(innerWidth - 32, pw0 + filesW - w0) + "px";
    };
    const up = () => { split.removeEventListener("pointermove", move); split.removeEventListener("pointerup", up); storeSet("rbox.tty.filesW", String(Math.round(filesW))); };
    split.addEventListener("pointermove", move);
    split.addEventListener("pointerup", up);
  });

  const head = el.querySelector(".ttyp-h");
  head.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (m) => {
      el.style.left = Math.min(innerWidth - 80, Math.max(0, m.clientX - dx)) + "px";
      el.style.top = Math.min(innerHeight - 40, Math.max(0, m.clientY - dy)) + "px";
    };
    const up = () => { head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
  });

  applyMode();
  return { front: () => { front(); (tty === 1 ? scr : el.querySelector("[data-x=close]")).focus(); } };
}
