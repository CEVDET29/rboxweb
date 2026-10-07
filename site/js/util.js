export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Bekleyen çağrıyı geciktirir; flush() bekleyeni hemen çalıştırır (ör. kaydetmeden önce başlatma). */
export function debounce(fn, ms) {
  let t, pending = null;
  const d = (...a) => {
    pending = a;
    clearTimeout(t);
    t = setTimeout(() => { const p = pending; pending = null; fn(...p); }, ms);
  };
  d.flush = async () => {
    if (!pending) return;
    clearTimeout(t);
    const p = pending; pending = null;
    await fn(...p);
  };
  return d;
}

let toastTimer;
/** Panoya kopyalar. Pano API'si izin / odak yüzünden reddederse eski yöntemle (execCommand) dener; olmazsa hata fırlatır. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* aşağıda eski yöntem */ }
  const ta = Object.assign(document.createElement("textarea"), { value: text });
  ta.style.cssText = "position:fixed;opacity:0";
  document.body.append(ta); ta.select();
  const ok = document.execCommand("copy"); ta.remove();
  if (!ok) throw new Error("Kopyalanamadı");
}

export function toast(msg, ms = 2600) {
  let el = $(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.append(el); }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function storeGet(key, fallback = null) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
export function storeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* özel pencere vb. */ }
}

export function sessionGet(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
export function sessionSet(key, v) { try { v == null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, v); } catch { } }

/** Excel'in doğrudan açabileceği CSV: ";" ayraç (Türkçe Excel), UTF-8 BOM. */
export function downloadCsv(fileName, headers, rows) {
  const sep = ";";
  const cell = (v) => {
    const s = String(v ?? "");
    return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers, ...rows].map((r) => r.map(cell).join(sep));
  const blob = new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ── IP alanları için giriş kuralı (WPF Common/IpInput.cs ile aynı) ──
// Yalnızca rakam ve nokta, en fazla 4 oktet, her oktet 0–255 (uymayacaksa giriş yapılmaz). Oktetlerin baştaki
// sıfırları atılır: "02.03.200.01" → "2.3.200.1" ("0" tek başına kalır; 0.0.0.0 geçerli).
// Maske alanında ayrıca "/24" ya da "24" (CIDR 0–32) yazılabilir.

/** Oktetlerin baştaki sıfırlarını atar; caret: imleç konumu, yeni konumu da döner. Maskedeki "/024" → "/24". */
export function normalizeIp(text, caret = text.length) {
  let out = "", newCaret = -1, segStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (i === caret) newCaret = out.length;
    const c = text[i];
    if (c === "." || c === "/") { out += c; segStart = out.length; continue; }
    // Bu oktette şimdiye kadar yalnızca "0" varsa ve ardından rakam geliyorsa o sıfır atılır
    if (/\d/.test(c) && out.length - segStart === 1 && out[segStart] === "0") {
      out = out.slice(0, segStart);
      if (newCaret > segStart) newCaret--;
    }
    out += c;
  }
  return { text: out, caret: newCaret < 0 ? out.length : newCaret };
}

/** Yazılmakta olan (yarım da olabilir: "172.16.") IPv4 geçerli mi (baştaki sıfırlar atılmış hâliyle). */
export function isPartialIp(text) {
  if (text === "") return true;
  if (!/^[\d.]*$/.test(text)) return false;
  const parts = text.split(".");
  if (parts.length > 4) return false;
  return parts.every((p, i) => (p === "" ? i === parts.length - 1 && i > 0 : p.length <= 3 && +p <= 255));
}

/** Ağ maskesi: IPv4 biçimi ya da CIDR ("/24", "24"). */
export function isPartialMask(text) {
  if (text.startsWith("/")) { const n = text.slice(1); return n === "" || (/^\d{1,2}$/.test(n) && +n <= 32); }
  return isPartialIp(text);
}

/** Metin kutusuna yalnızca kurala uyan girişi (yazma / yapıştırma) kabul ettirir. kind: "ip" | "mask". */
export function ipFilter(input, kind = "ip") {
  const ok = (t) => (kind === "mask" ? isPartialMask(t) : isPartialIp(t));
  input.addEventListener("beforeinput", (e) => {
    const paste = e.inputType === "insertFromPaste" || e.inputType === "insertFromDrop";
    if (e.data == null && !paste) return;                               // silme / biçim: serbest
    const el = e.target;
    // Yapıştırmada baştaki / sondaki boşluk ve satır sonu atılır (Excel hücresinden kopyalama)
    const data = paste ? (e.data ?? e.dataTransfer?.getData("text/plain") ?? "").trim() : e.data;
    // Kayıtlı değer zaten kurala uymuyorsa (eski ayar) düzeltmeye izin ver: yalnızca karakter türü denetlenir
    if (!ok(normalizeIp(el.value).text)) { if (!/^[\d./]*$/.test(data)) e.preventDefault(); return; }
    const start = el.selectionStart, raw = el.value.slice(0, start) + data + el.value.slice(el.selectionEnd);
    const n = normalizeIp(raw, start + data.length);
    if (!ok(n.text)) { e.preventDefault(); return; }
    if (paste || n.text !== raw) {
      // Kırpılmış / sıfırları atılmış metni kendimiz yaz
      e.preventDefault();
      el.value = n.text;
      el.setSelectionRange(n.caret, n.caret);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
}

/** Oda / yoğun bakım (bölüm) renkleri; WPF'teki UnitColors ile aynı sıra. */
export const UNIT_COLORS = ["#3B82F6", "#10B981", "#F59E0B", "#A855F7", "#EC4899", "#14B8A6", "#EF4444", "#84CC16"];
export const unitColor = (i) => (i < 0 ? "transparent" : UNIT_COLORS[i % UNIT_COLORS.length]);

export const ICONS = {
  ping: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l3-8 4 16 3-8h6"/></svg>',
  update: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  control: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  ybdb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>',
  files: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.9 1.4-1.8l-.4-1.2A1.5 1.5 0 0 1 14.4 16H17a4 4 0 0 0 4-4c0-5-4-9-9-9z"/><circle cx="7.5" cy="11" r="1.2" fill="currentColor"/><circle cx="10" cy="7" r="1.2" fill="currentColor"/><circle cx="14.5" cy="7" r="1.2" fill="currentColor"/><circle cx="17" cy="11" r="1.2" fill="currentColor"/></svg>',
  port: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="12" rx="2"/><path d="M8 7V4h8v3M7 12v3M10.3 12v3M13.7 12v3M17 12v3"/></svg>',
  tcp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/></svg>',
  chip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3m0 0l-4 4m4-4l4 4M4 21h16"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  chevrons: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 8l5-5 5 5M7 16l5 5 5-5"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/></svg>',
  version: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/><path d="M12 8v4l2 2"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  term: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-6-6-6M12 19h8"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
};
