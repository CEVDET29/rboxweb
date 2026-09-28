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
| YBDB Odalar | ✅ tamam (SQL Server bağlantısı, doluluk özeti, oda / yatak tabloları, oda seçince süzme, arama, sıralama) |
| Cihaz Güncelleme | ✅ tamam (toplu güncelleme, versiyon kontrol, TTY mesajı, tek cihaz JsonSettings / dhcpcd). Adımlar WPF'teki `UpdateCoordinator` ile aynı kod |
| Cihaz Kontrol | ✅ tamam (oda gruplu cihaz kartları: sıcaklık, bellek, depolama + genişletme, SerialWorker + sürüm, **USB seri aygıtlar** (USB0/USB1: üretici ve ürün), ağ / Wi-Fi, MAC kontrolü; toplu ve tek cihaz yeniden başlatma, otomatik yenileme, karttan "Güncelle") |
| Dosyalar | ✅ tamam (updateFiles klasörünü listele / tarayıcıda düzenle / yükle / indir / adı değiştir / sil, "beklenen dosyalar" listesi, zip ile dışa-içe aktarma) |

**Tüm web modülleri tamamlandı.**

**Ortak cihaz listesi:** Excel, üst banttaki "Cihaz listesi" düğmesinden (ya da sayfaya sürükleyerek) tek yerden yüklenir;
Ping Kontrol ve Cihaz Güncelleme aynı listeyi kullanır. Bir işlem sürerken liste değiştirilemez.

**updateFiles klasörü:** Cihaz Güncelleme'nin cihaza gönderdiği dosyalar hastaneye özeldir, repoya konmaz. Klasör şu sırayla seçilir:
1. `--work "..."` (ya da `agent.json` içinde `"workFolder"`)
2. **Dosyalar** sekmesinden kaydedilen klasör ("Klasörü değiştir")
3. **WPF klasörü** varsa o: `C:\Rasyomed\RboxTools\updateFiles` (WPF uygulamasıyla aynı dosyalar, ek kurulum gerekmez)
4. `%AppData%\RboxAgent\updateFiles`

Dosyalar sekmesi klasörü listeler; metin dosyalarını (JsonSettings.txt, dhcpcd.txt, .sh, .service…) tarayıcıda düzenler
(satır sonu ve BOM korunur, JSON doğrulanır, 4 sık düzenlenen dosya boş kaydedilemez), yükler, indirir, siler ve
klasörü zip olarak dışa/içe aktarır (başka hastaneye taşımak için; zip-slip korumalı). Her yol klasörün içinde kalmak zorundadır.
JsonSettings / serialdevices.json / dhcpcd / wpa_supplicant seçeneklerine (Cihaz Güncelleme) çift tıklamak ya da kalem düğmesi
dosyayı **sunucuda** Notepad++ / Not Defteri ile açar; dosya yoksa "yok" rozeti çıkar.

YBDB parolası ajanda yalnızca bellekte tutulur; "Şifreyi hatırla" açıksa DPAPI ile şifreli saklanır. Tarayıcıya geri gönderilmez.

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

## Masaüstü (WPF) sürümünü hastaneye indirmek

"Ajan bulunamadı" ekranındaki **Komutu kopyala** düğmesine **hızlıca 3 kez** tıklayınca ajan komutu yerine
masaüstü sürümü komutu kopyalanır. PowerShell'e yapıştırılınca `tools/install-desktop.ps1` çalışır:

- Sürüm `C:\Rasyomed\RboxTools` içine kopyalanır (yol yoksa oluşturulur; `updateFiles`, ayarlar gibi hastaneye özel
  dosyalara dokunulmaz, uygulama açıksa önce kapatmak gerekir).
- Herhangi bir hata olursa aynı içerik **İndirilenler\RboxTools** klasörüne konur.

Zip'i hazırlamak ve yayınlamak (yalnızca sürüm değişince):

1. `tools\publish-desktop.ps1` → `dist\RboxTools-desktop.zip` (Release, framework-dependent, ~6 MB).
2. GitHub → Releases → **Draft a new release** → tag: `desktop` → zip'i ekle → **Set as a pre-release** işaretle → Publish.
   (Pre-release işaretlenmezse bu release "latest" olur ve `start-agent.ps1`'in indirdiği `RboxAgent.zip` bulunamaz.)
   Güncellemek için aynı release'te zip'i silip yenisini yükleyin.

> Not: Tarayıcılar `https` sayfadan `http://127.0.0.1` adresine bağlanmaya izin verir (Chrome/Edge/Firefox). Chrome ilk
> bağlantıda "yerel ağdaki cihazlara erişim" izni sorabilir; izin verin. Safari bunu engelleyebilir; Chrome/Edge kullanın.
