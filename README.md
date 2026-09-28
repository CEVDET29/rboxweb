# RasyoBOX Araçları — Web

WPF uygulamasıyla (`../RboxTools`) aynı işleri yapan web sürümü. Arayüz GitHub Pages'te durur; ping, ARP, SSH ve SQL
gibi ağ işlemlerini hastane sunucusunda çalışan küçük **ajan** yapar (tarayıcı bunları yapamaz).

```
Tarayıcı (github.io'dan gelen arayüz) ─► http://127.0.0.1:47800 ─► RboxAgent.exe ─► cihazlar / SQL
```

| Klasör | İçerik |
|---|---|
| `site/` | Arayüz: HTML/CSS/JS (derleme yok). GitHub Pages'e olduğu gibi yüklenir. |
| `agent/` | Ajan (.NET 8, yalnızca `HttpListener`; ASP.NET Core gerekmez). WPF'ten kopyalanan iş mantığı `Modules/` altında. |
| `tools/` | `publish-agent.ps1` (zip üretir), `start-agent.ps1` (hastanede indir+çalıştır), `set-password.ps1` |

## Durum

| Modül | Web'de |
|---|---|
| Ping Kontrol | ✅ tamam (Excel, ping, SSH portu, ARP/SSH ile MAC, üretici, izleme modu, filtre/arama/sıralama, CSV) |
| Cihaz Güncelleme, Cihaz Kontrol, YBDB Odalar, Dosyalar | ⏳ sıradaki aşamalar |

## Güvenlik

- Ajan yalnızca `127.0.0.1` dinler; Host ve Origin (CORS) doğrulanır.
- Her açılışta konsolda **tek seferlik bağlantı kodu** gösterilir. Kod olmadan hiçbir API (ping, excel, ayar) çalışmaz;
  8 hatalı denemeden sonra 1 dk kilitlenir.
- Web giriş şifresi (`site/js/config.js`) yalnızca bir kolaylıktır. Statik sitede gerçek koruma olamaz.
  Asıl koruma ajan kodudur. Varsayılan şifreyi `tools\set-password.ps1` ile değiştirin.
- SSH parolası ajanda DPAPI ile şifrelenip `%AppData%\RboxAgent\settings.json` içinde durur; tarayıcıya geri gönderilmez.
- **Repoya hastaneye ait hiçbir şey koymayın:** IP listeleri, Excel dosyaları, güncelleme dosyaları, parolalar, hasta verisi.
  GitHub Pages siteleri (repo private olsa bile) herkese açıktır.

## Geliştirme (bu bilgisayarda)

```powershell
cd agent
dotnet run -- --token TEST-01 --site ..\site      # http://127.0.0.1:47800 (giriş şifresi: config.js)
```

`--site` verilirse ajan arayüzü kendisi de sunar; GitHub'a gerek kalmadan deneme yapılır.

## Yayınlama

1. GitHub'da yeni repo aç (ör. `KULLANICI/rboxweb`), bu klasörü repo kökü olarak yükle.
2. Settings → Pages → Source: **GitHub Actions**. `site/` değişince otomatik yayınlanır:
   `https://KULLANICI.github.io/rboxweb/`
3. Ajan için: `git tag v0.1.0 && git push --tags` → Actions `RboxAgent.zip` ve `RboxAgent-selfcontained.zip` üretir.
4. Hastane sunucusunda (AnyDesk ile):
   ```powershell
   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/KULLANICI/rboxweb/main/tools/start-agent.ps1))) -Repo KULLANICI/rboxweb
   ```
   Ajan tarayıcıyı `.../#code=KOD` adresiyle açar; sayfa kodu adresten alıp kendiliğinden bağlanır (kopyala-yapıştır yok).
   Kurulum yok; `.NET 8` yoksa betik uyarır. Ajan elle başlatılırsa kod, ajan penceresinden sayfaya yazılır.

Elle çalıştırmak için: `RboxAgent.exe --origin https://KULLANICI.github.io`

> Not: Tarayıcılar `https` sayfadan `http://127.0.0.1` adresine bağlanmaya izin verir (Chrome/Edge/Firefox). Chrome ilk
> bağlantıda "yerel ağdaki cihazlara erişim" izni sorabilir; izin verin. Safari bunu engelleyebilir; Chrome/Edge kullanın.
