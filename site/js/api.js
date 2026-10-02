// Yerel ajanla (127.0.0.1) konuşan katman.
import { storeGet, storeSet } from "./util.js";

const FIRST_PORT = 47800;
const PORT_COUNT = 10;

let base = null;      // örn. http://127.0.0.1:47800
// Kod yalnızca çalışan ajan için geçerli (ajan kapanınca ölür); bu yüzden sekme kapansa da hatırlanması zararsız.
let token = storeGet("rbox.token") || "";
const listeners = new Set();

export const agent = {
  info: null,
  get connected() { return !!base; },
  /** Ajan oturumu düştüğünde (401 / bağlantı koptu) çağrılır. */
  onLost(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

function lost(reason) { listeners.forEach((fn) => fn(reason)); }

/**
 * Chrome/Edge 142+: herkese açık bir sitenin 127.0.0.1'e erişmesi kullanıcı iznine bağlı ("Yerel ağ erişimi";
 * 145+ "loopback-network"). İzin durumunu döndürür: "granted" | "prompt" | "denied" | null (tarayıcı bilmiyor).
 */
export async function loopbackPermission() {
  if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) return null;   // sayfa ajandan açıldıysa izin gerekmez
  for (const name of ["loopback-network", "local-network-access"]) {
    try { return (await navigator.permissions.query({ name })).state; } catch { /* bu adı tanımıyor */ }
  }
  return null;
}

async function hello(origin, withToken, timeoutMs = 2500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(origin + "/api/hello", {
      signal: ctl.signal,
      headers: withToken && token ? { "X-Rbox-Token": token } : {},
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.app === "RboxAgent" ? j : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Ajanı bulur. Sayfa ajandan sunuluyorsa önce kendi kaynağına bakar. */
export async function discover() {
  const candidates = [];
  if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname) && location.port) candidates.push(location.origin);
  for (let i = 0; i < PORT_COUNT; i++) candidates.push(`http://127.0.0.1:${FIRST_PORT + i}`);

  // İzin sorusu açıkken istek, kullanıcı yanıtlayana kadar bekler: ilk denemeyi kısa sürede kesersek
  // soru kapanır ve bağlantı hiç kurulamaz. Bu yüzden izin henüz verilmemişse ilk adreste uzun bekle.
  const firstWait = (await loopbackPermission()) === "prompt" ? 60000 : 2500;

  // Birden fazla ajan çalışıyorsa (ör. eskisi açık kalmış) kodumuzu kabul edeni seç; yoksa bulunan ilkini
  let first = null;
  for (const [i, origin] of [...new Set(candidates)].entries()) {
    const info = await hello(origin, true, i === 0 ? firstWait : 2500);
    if (!info) continue;
    if (info.authorized) { base = origin; agent.info = info; return info; }
    first ??= { origin, info };
  }
  base = first?.origin ?? null;
  agent.info = first?.info ?? null;
  return first?.info ?? null;
}

export function setToken(t) {
  token = (t || "").trim().toUpperCase();
  storeSet("rbox.token", token);
}

export async function checkToken() {
  if (!base) return false;
  const info = await hello(base, true);
  if (!info) { lost("Ajana ulaşılamıyor."); return false; }
  agent.info = info;
  return !!info.authorized;
}

async function raw(path, { method = "GET", body, headers = {}, signal } = {}) {
  if (!base) throw new Error("Ajan bağlı değil.");
  const isJson = body != null && !(body instanceof Blob) && !(body instanceof ArrayBuffer);
  let res;
  try {
    res = await fetch(base + path, {
      method,
      signal,
      headers: { "X-Rbox-Token": token, ...(isJson ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body == null ? undefined : isJson ? JSON.stringify(body) : body,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    lost("Ajanla bağlantı koptu.");
    throw new Error("Ajanla bağlantı koptu.");
  }
  if (res.status === 401) {
    lost("Bağlantı kodu geçersiz.");
    throw new Error("Bağlantı kodu geçersiz.");
  }
  return res;
}

export async function api(path, opts) {
  const res = await raw(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Hata ${res.status}`);
  return data;
}

/** Dosya indirme: yanıtı Blob olarak döner (kod başlığı gerektiği için doğrudan bağlantı kullanılamaz). */
export async function blob(path) {
  const res = await raw(path);
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `Hata ${res.status}`);
  }
  return res.blob();
}

/** Satır satır akan JSON (ndjson) okur; her satır için onMsg çağrılır. */
export async function stream(path, body, onMsg, signal) {
  const res = await raw(path, { method: "POST", body, signal });
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => ({}));       // ajan, akışı başlatmadan önce hatayı JSON olarak döner
    throw new Error(j.error || `Hata ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onMsg(JSON.parse(line));
    }
  }
}
